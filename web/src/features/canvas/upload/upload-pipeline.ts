/**
 * 画布素材统一上传管道。
 *
 * 拖入画布、节点内替换、生成面板参考区、裁剪 / 宫格切分 / 标注、
 * 全景截图、导演截图、资产库上传等全部入口共用这一条链路：
 *
 *   类型校验 → 本地预览 + 尺寸探测 → 建占位节点（乐观 UI）
 *   → 并发上传（失败自动重试）→ 进度回写 → 成功原地落库
 *   → 失败按 sink 策略回滚 → 统一提示
 *
 * 关键约定：
 * - 占位节点与连线同批写入，只产生一条撤销记录；进度回写、结果替换、
 *   失败移除全部 skipHistory，避免一次操作留下多条撤销记录。
 * - 每个占位带 version，异步回调前校验 version 与节点是否仍存在，
 *   不匹配说明节点已被撤销 / 删除，直接放弃写入。
 * - 所有 blob: 预览 URL 由管道统一释放，无论成功、失败还是节点被移除。
 * - replace sink 成功走 NODE_UPDATE_DATA 事件并 immediate，保持原有
 *   「上传完成即落盘」语义；失败回滚到上传前的 data / style 快照。
 */
"use client";

import { createAudioNode, createEdge, createImageNode, createVideoNode } from "@/features/canvas/node-defaults";
import { markDirtyImmediate, useCanvasStore } from "@/features/canvas/stores/canvas-store";
import type { AnyEdge, AnyNode, UploadState } from "@/features/canvas/types";
import {
  AUDIO_NODE_HEIGHT,
  AUDIO_NODE_WIDTH,
  DEFAULT_NODE_CONTENT_HEIGHT,
  DEFAULT_NODE_WIDTH,
  EventNames,
} from "@/lib/constants";
import { showGlobalMessage } from "@/lib/global-message";
import { showGlobalNotification } from "@/lib/global-notification";
import i18n from "@/lib/i18n/config";
import { computeNodeSize, loadMediaDimensions } from "@/lib/utils/image-utils";
import {
  getUploadErrorDetail,
  runWithConcurrency,
  UPLOAD_CONCURRENCY,
  UPLOAD_MAX_RETRIES,
  uploadWithRetry,
  type UploadResult,
} from "@/lib/utils/upload";

import { resolveDerivedLabel, resolveDerivedPosition } from "./derived-node";
import type { MediaKind, UploadAnchor, UploadHandle, UploadItem, UploadPlan, UploadSummary } from "./types";

const IMAGE_EXTS = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "avif"];
const VIDEO_EXTS = ["mp4", "webm", "mov", "avi", "mkv", "m4v"];
const AUDIO_EXTS = ["mp3", "wav", "ogg", "m4a", "aac", "flac"];

/** 版本号序列：防异步回调竞态（撤销 / 重置后旧回调自动失效） */
let _versionSeq = Date.now();
function nextVersion(): number {
  return ++_versionSeq;
}

/**
 * 判定媒体类型：优先用 MIME，缺失时退回扩展名。
 * 部分来源（粘贴、某些文件管理器）不带 MIME，仅按 MIME 判定会误杀。
 */
export function detectMediaKind(blob: Blob, filename?: string): MediaKind | null {
  const type = blob.type;
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("video/")) return "video";
  if (type.startsWith("audio/")) return "audio";

  const dot = filename ? filename.lastIndexOf(".") : -1;
  if (!filename || dot < 0) return null;
  const ext = filename.slice(dot + 1).toLowerCase();
  if (IMAGE_EXTS.includes(ext)) return "image";
  if (VIDEO_EXTS.includes(ext)) return "video";
  if (AUDIO_EXTS.includes(ext)) return "audio";
  return null;
}

function toFile(item: UploadItem): File {
  if (item.blob instanceof File) return item.blob;
  return new File([item.blob], item.filename, { type: item.blob.type || "image/png" });
}

function createPlaceholderNode(kind: MediaKind, position: { x: number; y: number }): AnyNode {
  if (kind === "audio") return createAudioNode(position, "");
  if (kind === "video") return createVideoNode(position, "");
  return createImageNode(position, "");
}

/** 已完成准备（本地预览 / 尺寸 / 占位）的单个上传任务 */
interface Prepared {
  /** 在 plan.items 中的下标，用于 onProgress 回传 */
  itemIndex: number;
  item: UploadItem;
  kind: MediaKind;
  file: File;
  label: string;
  nw: number;
  nh: number;
  version: number;
  previewUrl?: string;
  /** create / derived sink 新建的占位节点 */
  node?: AnyNode;
  /** replace sink 的目标节点 ID 与上传前快照 */
  replaceId?: string;
  snapshot?: { data: Record<string, unknown>; style?: Record<string, unknown> };
}

/** 锚点落位游标：多个节点沿锚点一侧依次排开 */
interface AnchorCursor {
  side: "left" | "right";
  gap: number;
  x: number;
  y: number;
  h: number;
}

function anchorPosition(cursor: AnchorCursor, dw: number, dh: number): { x: number; y: number } {
  const y = cursor.y + Math.max(0, (cursor.h - dh) / 2);
  if (cursor.side === "left") {
    const x = cursor.x - dw;
    cursor.x = x - cursor.gap;
    return { x, y };
  }
  const x = cursor.x;
  cursor.x = x + dw + cursor.gap;
  return { x, y };
}

function emptyHandle(): UploadHandle {
  return { nodeIds: [], settled: Promise.resolve({ succeeded: 0, failed: 0, results: [] }) };
}

function nodeKindOf(node: AnyNode): MediaKind | null {
  if (node.type === "image-node") return "image";
  if (node.type === "video-node") return "video";
  if (node.type === "audio-node") return "audio";
  return null;
}

function findNode(id: string): AnyNode | undefined {
  return useCanvasStore.getState().getNodes().find((n) => n.id === id);
}

/** 该节点的上传态是否仍归属本次上传（节点存在且 version 匹配） */
function isCurrentUpload(node: AnyNode | undefined, version: number): node is AnyNode {
  if (!node) return false;
  return (node.data as { upload?: UploadState }).upload?.version === version;
}

/**
 * 执行一批上传。
 *
 * @returns 占位节点 ID（准备阶段结束即就绪，用于乐观 UI）与全部结束后的汇总 Promise
 */
export async function runMediaUpload(plan: UploadPlan): Promise<UploadHandle> {
  const sink = plan.sink;
  const source = plan.source ?? (sink.kind === "derived-node" ? "derived" : "upload");
  const store = useCanvasStore.getState();

  // ── replace sink 前置校验：目标节点必须存在 ──
  let replaceTarget: AnyNode | undefined;
  if (sink.kind === "replace-node") {
    replaceTarget = store.getNodes().find((n) => n.id === sink.nodeId);
    if (!replaceTarget) return emptyHandle();
  }

  // ── 1) 类型校验 + 本地预览 + 尺寸探测 ──
  const prepared: Prepared[] = [];
  let ignored = 0;

  for (let i = 0; i < plan.items.length; i++) {
    const item = plan.items[i];
    const kind = item.nodeType ?? detectMediaKind(item.blob, item.filename);
    if (!kind) {
      ignored++;
      continue;
    }
    if (replaceTarget && kind !== nodeKindOf(replaceTarget)) {
      // 类型与当前节点不匹配（如往音频节点里塞图片）：整批拒绝并提示
      showGlobalMessage().error(i18n.t("file.unsupportedType"));
      return emptyHandle();
    }

    const needsPreview = sink.kind !== "raw" && kind !== "audio";
    const previewUrl = needsPreview ? (item.previewUrl ?? URL.createObjectURL(item.blob)) : undefined;

    let nw = item.naturalWidth ?? 0;
    let nh = item.naturalHeight ?? 0;
    if (needsPreview && previewUrl && !(nw > 0 && nh > 0)) {
      const dims = await loadMediaDimensions(previewUrl, kind === "video");
      nw = dims.w;
      nh = dims.h;
    }
    if (kind !== "audio") {
      nw = nw || (kind === "video" ? 1280 : DEFAULT_NODE_WIDTH);
      nh = nh || (kind === "video" ? 720 : DEFAULT_NODE_CONTENT_HEIGHT);
    }

    prepared.push({
      itemIndex: i,
      item,
      kind,
      file: toFile(item),
      label: item.label ?? item.filename,
      nw,
      nh,
      version: nextVersion(),
      previewUrl,
      replaceId: replaceTarget?.id,
    });
  }

  if (prepared.length === 0) {
    if (ignored > 0) showGlobalMessage().error(i18n.t("file.unsupportedType"));
    return emptyHandle();
  }
  if (ignored > 0) {
    // 混合拖放：支持的文件照常上传，被忽略的只提示一次（不列具体文件名）
    showGlobalMessage().error(i18n.t("file.ignoredSome"));
  }

  // ── 2) 建占位节点 / 记录替换快照 ──
  const newNodes: AnyNode[] = [];
  const newEdges: AnyEdge[] = [];
  let cursor: AnchorCursor | null = null;

  if (sink.kind === "create-node" && sink.anchor) {
    const anchor = sink.anchor;
    const a = store.getNodes().find((n) => n.id === anchor.nodeId);
    if (a) {
      cursor = {
        side: anchor.side,
        gap: anchor.gap,
        x: anchor.side === "left"
          ? a.position.x - anchor.gap
          : a.position.x + ((a.style?.width as number) || DEFAULT_NODE_WIDTH) + anchor.gap,
        y: a.position.y,
        h: (a.style?.height as number) || DEFAULT_NODE_WIDTH,
      };
    }
  }

  const sourceNode = sink.kind === "derived-node" ? store.getNodes().find((n) => n.id === sink.sourceId) : undefined;

  for (const p of prepared) {
    const upload: UploadState = { uploading: true, progress: 0, version: p.version, previewUrl: p.previewUrl };

    if (sink.kind === "replace-node") {
      const target = store.getNodes().find((n) => n.id === sink.nodeId);
      if (!target) {
        p.replaceId = undefined;
        continue;
      }
      p.snapshot = { data: { ...target.data }, style: { ...(target.style ?? {}) } };
      const data: Record<string, unknown> = { upload, source };
      if (p.kind !== "audio") {
        data.naturalWidth = p.nw;
        data.naturalHeight = p.nh;
      }
      store.updateNodeData(
        sink.nodeId,
        data,
        p.kind === "audio"
          ? { width: AUDIO_NODE_WIDTH, height: AUDIO_NODE_HEIGHT }
          : computeNodeSize(p.nw, p.nh),
        { skipHistory: true },
      );
      continue;
    }

    // raw：只上传拿远程地址，不创建任何画布节点
    if (sink.kind === "raw") continue;

    const node = createPlaceholderNode(p.kind, resolvePosition(p, sink, cursor, sourceNode));

    if (sink.kind === "derived-node") {
      p.label = p.item.label ?? resolveDerivedLabel(sourceNode, p.item.labelSuffix ?? "");
    }

    if (p.kind === "audio") {
      Object.assign(node.data, { label: p.label, alt: p.label, source, upload, ...(p.item.extraData ?? {}) });
      node.style = { width: AUDIO_NODE_WIDTH, height: AUDIO_NODE_HEIGHT };
    } else {
      Object.assign(node.data, {
        label: p.label,
        alt: p.label,
        source,
        upload,
        naturalWidth: p.nw,
        naturalHeight: p.nh,
        ...(p.item.extraData ?? {}),
      });
      node.style = computeNodeSize(p.nw, p.nh);
    }

    p.node = node;
    newNodes.push(node);

    if (sink.kind === "derived-node") {
      if (sink.connect !== false && sourceNode) newEdges.push(createEdge(sink.sourceId, node.id));
    } else if (sink.kind === "create-node" && sink.connectTo) {
      newEdges.push(
        sink.connectDir === "in"
          ? createEdge(sink.connectTo, node.id)
          : createEdge(node.id, sink.connectTo),
      );
    }
  }

  // 占位节点与连线同批写入，只产生一条历史记录
  if (newNodes.length > 0) store.addNodes(newNodes);
  if (newEdges.length > 0) store.setEdges([...useCanvasStore.getState().edges, ...newEdges]);

  // ── 3) 并发上传（失败自动重试，业务错误不重试）──
  return { nodeIds: newNodes.map((n) => n.id), settled: runUploads(plan, prepared, source) };
}

/** 决定占位节点落位：显式位置 > 派生默认（源节点右侧）> 锚点旁 > 原点 */
function resolvePosition(
  p: Prepared,
  sink: UploadPlan["sink"],
  cursor: AnchorCursor | null,
  sourceNode: AnyNode | undefined,
): { x: number; y: number } {
  if (p.item.position) return p.item.position;
  if (sink.kind === "derived-node") return resolveDerivedPosition(sourceNode);
  if (cursor) {
    const { width, height } = p.kind === "audio"
      ? { width: AUDIO_NODE_WIDTH, height: AUDIO_NODE_HEIGHT }
      : computeNodeSize(p.nw, p.nh);
    return anchorPosition(cursor, width, height);
  }
  return { x: 0, y: 0 };
}

async function runUploads(
  plan: UploadPlan,
  prepared: Prepared[],
  source: "upload" | "derived",
): Promise<UploadSummary> {
  const results = await runWithConcurrency(
    prepared.map((p) => async () =>
      uploadWithRetry(
        p.file,
        (pct) => {
          plan.onProgress?.(p.itemIndex, pct);
          const targetId = p.node?.id ?? p.replaceId;
          if (!targetId) return;
          if (!isCurrentUpload(findNode(targetId), p.version)) return;
          useCanvasStore.getState().updateNodeData(
            targetId,
            { upload: { uploading: true, progress: pct, version: p.version, previewUrl: p.previewUrl } },
            undefined,
            { skipHistory: true },
          );
        },
        UPLOAD_MAX_RETRIES,
        source,
      ),
    ),
    plan.concurrency ?? UPLOAD_CONCURRENCY,
  );

  const sink = plan.sink;
  const summaryResults: Array<UploadResult | null | undefined> = new Array(plan.items.length);
  let succeeded = 0;
  let failed = 0;
  let reason: string | undefined;
  const failedNodeIds: string[] = [];

  results.forEach((r, i) => {
    const p = prepared[i];
    // 上传结束即释放预览 URL：成功已换服务端 URL，失败节点被移除 / 回滚
    if (p.previewUrl) URL.revokeObjectURL(p.previewUrl);

    const targetId = p.node?.id ?? p.replaceId;
    if (!targetId) {
      // 无落库目标（raw sink）：只记录结果
      if (r.status === "fulfilled") {
        succeeded++;
        summaryResults[p.itemIndex] = r.value;
      } else {
        failed++;
        summaryResults[p.itemIndex] = null;
        reason = reason ?? getUploadErrorDetail(r.reason);
      }
      return;
    }

    const node = findNode(targetId);
    if (!isCurrentUpload(node, p.version)) {
      // 节点已被撤销 / 删除，放弃写入（结果仍计入成功，文件已上云）
      if (r.status === "fulfilled") {
        succeeded++;
        summaryResults[p.itemIndex] = r.value;
      } else {
        failed++;
        summaryResults[p.itemIndex] = null;
        reason = reason ?? getUploadErrorDetail(r.reason);
        if (p.node) failedNodeIds.push(p.node.id);
      }
      return;
    }

    if (r.status === "fulfilled") {
      succeeded++;
      summaryResults[p.itemIndex] = r.value;
      if (p.node) {
        const data: Record<string, unknown> = {
          src: r.value.url,
          label: p.label,
          alt: p.label,
          upload: undefined,
          source,
        };
        if (p.kind !== "audio") {
          data.naturalWidth = p.nw;
          data.naturalHeight = p.nh;
        }
        useCanvasStore.getState().updateNodeData(targetId, data, undefined, { skipHistory: true });
      } else {
        // 原地替换：走事件通道 + immediate，保持「上传完成立即落盘」语义
        const clear: Record<string, undefined> = {};
        if (sink.kind === "replace-node") {
          for (const f of sink.clearFields ?? []) clear[f] = undefined;
        }
        const data: Record<string, unknown> = {
          ...(node.data as Record<string, unknown>),
          src: r.value.url,
          label: p.label,
          alt: p.label,
          upload: undefined,
          source,
          ...clear,
        };
        if (p.kind !== "audio") {
          data.naturalWidth = p.nw;
          data.naturalHeight = p.nh;
        }
        window.dispatchEvent(
          new CustomEvent(EventNames.NODE_UPDATE_DATA, {
            detail: {
              nodeId: targetId,
              data,
              style: p.kind === "audio"
                ? { width: AUDIO_NODE_WIDTH, height: AUDIO_NODE_HEIGHT }
                : computeNodeSize(p.nw, p.nh),
              immediate: true,
            },
          }),
        );
      }
      return;
    }

    failed++;
    summaryResults[p.itemIndex] = null;
    reason = reason ?? getUploadErrorDetail(r.reason);
    if (p.node) {
      failedNodeIds.push(p.node.id);
    } else if (p.snapshot) {
      // 替换失败：回滚到上传前的 data / style，避免节点尺寸停留在待上传文件的值
      useCanvasStore.getState().updateNodeData(
        targetId,
        { ...p.snapshot.data, upload: undefined },
        p.snapshot.style,
        { skipHistory: true },
      );
    }
  });

  // 失败清理：removeNodes 会级联删除其关联边
  if (failedNodeIds.length > 0) {
    useCanvasStore.getState().removeNodes(failedNodeIds, { skipHistory: true });
  }

  markDirtyImmediate();

  if (!plan.silent && failed > 0) {
    const t = i18n.t;
    showGlobalNotification().error({
      title: t("file.uploadFailed"),
      description: succeeded === 0
        ? reason ?? t("file.uploadFailedAll")
        : reason
          ? `${failed}/${prepared.length} - ${reason}`
          : `${failed}/${prepared.length}`,
      duration: 4,
    });
  }

  return { succeeded, failed, reason, results: summaryResults };
}

/**
 * 上传单个 Blob 并只取结果（不碰画布）。
 * 供头像裁剪、导演视图截图等「只需要一个远程地址」的场景使用。
 */
export async function uploadOne(
  blob: Blob,
  filename: string,
  source?: "upload" | "derived",
): Promise<UploadResult | null> {
  const { settled } = await runMediaUpload({
    items: [{ blob, filename }],
    sink: { kind: "raw" },
    source,
    silent: true,
  });
  const { results } = await settled;
  return results[0] ?? null;
}
