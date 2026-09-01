/**
 * 图像与媒体处理工具集。
 * 提供显示尺寸换算、媒体自然尺寸读取、画布导出上传，
 * 以及宫格切分、翻转旋转等图片加工能力。
 */
"use client";

import { createEdge,createImageNode } from "@/features/canvas/node-defaults";
import type { AnyEdge } from "@/features/canvas/types";
import type { AnyNode, ImageNode } from "@/features/canvas/types";
import { apiUpload } from "@/lib/api/client";
import { NODE_DISPLAY_MAX, NODE_TITLE_HEIGHT } from "@/lib/constants";
import { getUploadErrorDetail, runWithConcurrency, UPLOAD_CONCURRENCY, UPLOAD_MAX_RETRIES, uploadWithRetry } from "@/lib/utils/upload";

/**
 * 纯函数：计算 NODE_DISPLAY_MAX 等比缩放后的显示尺寸（长边约束）。
 *
 * 返回 { scale, displayW, displayH }，不含标题栏高度（titleH 由调用方酌情添加）。
 *
 * @param naturalW  图片自然宽度
 * @param naturalH  图片自然高度
 * @param max       可选，长边最大像素值，默认 NODE_DISPLAY_MAX(600)
 */
export function computeThumbScale(
  naturalW: number,
  naturalH: number,
  max?: number,
): { scale: number; displayW: number; displayH: number } {
  const limit = max ?? NODE_DISPLAY_MAX;
  const longSide = Math.max(naturalW, naturalH);
  const scale = longSide > limit ? limit / longSide : 1;
  return {
    scale,
    displayW: Math.round(naturalW * scale),
    displayH: Math.round(naturalH * scale),
  };
}

// ── 派生节点位置常量 ──
// 从已有节点加工派生出的新节点（裁剪/标注/截图/宫格切分/全景多视角等）
// 统一放在源节点右侧，共用以下基准间隙与相邻间隙，保证各处逻辑一致。

/** 派生节点相对源节点的水平基准间隙（px） */
const DERIVED_BASE_GAP_X = 60;
/** 相邻派生节点之间的间隙（px） */
const DERIVED_CELL_GAP = 12;

/**
 * 计算节点的显示尺寸（等比缩放 + 标题栏高度）。
 *
 * 所有创建/更新图片/视频节点的路径应统一使用此函数，
 * 避免遗漏 titleH 导致的图片区域压缩。
 */
export function computeNodeSize(naturalW: number, naturalH: number): { width: number; height: number } {
  const { displayW, displayH } = computeThumbScale(naturalW, naturalH);
  return { width: displayW, height: displayH + NODE_TITLE_HEIGHT };
}

/**
 * 对节点应用 NODE_DISPLAY_MAX 等比缩放，并预留 titleH(24px) 标题栏高度。
 *
 * 所有创建图片节点的路径都应通过此函数统一计算显示尺寸，
 * 避免遗漏 titleH 导致的图片区域压缩。
 *
 * @param node        已创建的 ImageNode（通常通过 createImageNode）
 * @param naturalW    图片自然宽度
 * @param naturalH    图片自然高度
 * @param label       可选，设置 label 和 alt
 * @returns 被修改后的 node（方便链式调用）
 */
export function applyThumbnailSettings(
  node: ImageNode,
  naturalW: number,
  naturalH: number,
  label?: string,
): ImageNode {
  // 零尺寸保护：fallback 300
  const nw = naturalW > 0 ? naturalW : 300;
  const nh = naturalH > 0 ? naturalH : 300;
  const { width, height } = computeNodeSize(nw, nh);

  node.data.naturalWidth = naturalW;
  node.data.naturalHeight = naturalH;
  if (label !== undefined) {
    node.data.label = label;
    node.data.alt = label;
  }
  node.style = { width, height };
  return node;
}

/**
 * 创建 Canvas -> 执行绘制 -> 导出 Blob。
 *
 * 提取的是 createElement("canvas") + getContext("2d") + toBlob 的公共管线，
 * 具体的绘制逻辑由 draw 回调处理，不强求统一。
 *
 * @param width   canvas 宽度
 * @param height  canvas 高度
 * @param draw    绘制回调，接收 (ctx, canvas)
 * @param type    导出 MIME 类型，默认 "image/png"
 * @param quality 导出质量（0-1），仅对 image/jpeg 生效
 */
export function canvasToBlob(
  width: number,
  height: number,
  draw: (ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement) => void,
  type?: string,
  quality?: number,
): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  draw(ctx, canvas);
  return new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!), type || "image/png", quality));
}

/**
 * 异步加载图片/视频的真实显示尺寸。
 *
 * 适用于需要在节点创建前获取媒体原始宽高的场景。
 *
 * @param url      媒体 URL
 * @param isVideo  是否为视频（影响加载方式）
 * @returns { w, h } 宽高，失败时返回 0
 */
export function loadMediaDimensions(url: string, isVideo: boolean): Promise<{ w: number; h: number }> {
  return new Promise((resolve) => {
    if (isVideo) {
      const v = document.createElement("video");
      v.preload = "metadata";
      v.onloadedmetadata = () => resolve({ w: v.videoWidth || 1152, h: v.videoHeight || 768 });
      v.onerror = () => resolve({ w: 0, h: 0 });
      v.src = url;
    } else {
      const img = new window.Image();
      img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
      img.onerror = () => resolve({ w: 0, h: 0 });
      img.src = url;
    }
  });
}

/**
 * 上传图片 Blob -> 返回 URL。
 * 纯上传，无节点操作，可安全地在循环中调用。
 */
export async function uploadBlob(blob: Blob, filename?: string, source?: "upload" | "derived"): Promise<string | null> {
  const fd = new FormData();
  fd.append("file", blob, filename || `region_${Date.now()}.png`);
  const qs = source ? `&source=${source}` : "";
  const res = await apiUpload<{ url: string }>(`/api/files/upload?category=images${qs}`, fd);
  if (res.code !== 200 || !res.data?.url) return null;
  return res.data.url;
}

// ── Store 依赖注入接口 ──
// lib/ 层不应直接引用 stores，通过此接口由调用方注入所需操作。
export interface CanvasStoreApi {
  nodes: AnyNode[];
  edges: AnyEdge[];
  addNodes: (nodes: AnyNode[]) => void;
  setEdges: (edges: AnyEdge[]) => void;
}

/**
 * 派生节点 label：默认「原图名 + 后缀」并保留扩展名，labelOverride 优先。
 */
function resolveDerivedLabel(
  origNode: AnyNode | undefined,
  labelSuffix: string,
  labelOverride?: string,
): string {
  if (labelOverride !== undefined) return labelOverride;
  const origData = origNode?.data as { alt?: string; label?: string } | undefined;
  const origName = origData?.alt || origData?.label || "image";
  const dotIdx = origName.lastIndexOf(".");
  const base = dotIdx > 0 ? origName.slice(0, dotIdx) : origName;
  const ext = dotIdx > 0 ? origName.slice(dotIdx) : "";
  return `${base}${labelSuffix}${ext}`;
}

/**
 * 派生节点位置：默认放在源节点右侧，positionOverride 优先。
 */
function resolveDerivedPosition(
  origNode: AnyNode | undefined,
  positionOverride?: { x: number; y: number },
): { x: number; y: number } {
  if (positionOverride) return positionOverride;
  return {
    x: (origNode?.position.x || 0) + ((origNode?.style?.width as number) || 600) + DERIVED_BASE_GAP_X,
    y: origNode?.position.y || 0,
  };
}

/**
 * 从已有 URL 创建 ImageNode -> 写入 store -> 连线到源节点。
 * 适合：宫格切分、截图发送到画布等。
 *
 * @param storeApi  由调用方注入的 store 操作接口
 */
export async function createNodeFromUrl(
  sourceId: string,
  url: string,
  naturalW: number,
  naturalH: number,
  labelSuffix: string,
  storeApi: CanvasStoreApi,
  extraNodeData?: Record<string, unknown>,
  positionOverride?: { x: number; y: number },
  labelOverride?: string,
): Promise<AnyNode | null> {
  const origNode = storeApi.nodes.find((n) => n.id === sourceId);

  const { x, y } = resolveDerivedPosition(origNode, positionOverride);
  const label = resolveDerivedLabel(origNode, labelSuffix, labelOverride);

  const newNode = createImageNode({ x, y }, url);
  applyThumbnailSettings(newNode, naturalW, naturalH, label);
  if (extraNodeData) Object.assign(newNode.data, extraNodeData);

  storeApi.addNodes([newNode]);
  const newEdge = createEdge(sourceId, newNode.id);
  storeApi.setEdges([...storeApi.edges, newEdge]);

  return newNode;
}

/**
 * 上传裁切/变换后的图片 Blob -> 创建新节点 -> 建连线 -> 批量添加。
 *
 * uploadBlob + createNodeFromUrl 的便捷包装。
 *
 * @param sourceId        原图节点 ID
 * @param blob            处理后的图片 Blob
 * @param labelSuffix     节点 label 后缀，如 " (cropped)" / "(2-1)"
 * @param storeApi        由调用方注入的 store 操作接口
 * @param extraNodeData   可选，额外写入 node.data 的字段
 * @param positionOverride  节点位置（不传则默认放在原图节点右侧）
 * @param labelOverride    可选，直接指定完整 label（覆盖「原图名+后缀」的默认拼接）
 * @returns 新创建的节点，或 null（失败时）
 */
export async function uploadAndAddNode(
  sourceId: string,
  blob: Blob,
  labelSuffix: string,
  storeApi: CanvasStoreApi,
  extraNodeData?: Record<string, unknown>,
  positionOverride?: { x: number; y: number },
  source?: "upload" | "derived",
  labelOverride?: string,
): Promise<AnyNode | null> {
  const url = await uploadBlob(blob, undefined, source);
  if (!url) return null;

  const nw = (extraNodeData?.naturalWidth as number) || 0;
  const nh = (extraNodeData?.naturalHeight as number) || 0;

  return createNodeFromUrl(
    sourceId,
    url,
    nw,
    nh,
    labelSuffix,
    storeApi,
    extraNodeData,
    positionOverride,
    labelOverride,
  );
}

// ── 乐观派生节点上传 ──
// 裁剪 / 标注 / 宫格切分等「本地加工产物」的统一落库链路。
// 与拖放素材上传（use-file-drop）共用同一套 data.upload 协议：先建占位节点
// （本地 blob 预览）让画布立刻有反馈，再并发上传，成功原地替换 src、失败移除节点。
// 节点层无需区分来源，ImageNode 的上传态 UI（模糊预览 + 进度条）自动生效。

/** 乐观上传派生节点所需的 store 能力（CanvasStoreApi 的超集） */
export interface DerivedUploadStoreApi extends CanvasStoreApi {
  updateNodeData: (
    nodeId: string,
    data: Record<string, unknown>,
    style?: Record<string, unknown>,
    options?: { skipHistory?: boolean },
  ) => void;
  removeNodes: (nodeIds: string[], options?: { skipHistory?: boolean }) => void;
  /** 取最新节点列表：异步上传回调需重新读取，用于校验节点是否仍存在（未被撤销 / 删除） */
  getNodes: () => AnyNode[];
}

/** 单个待上传的派生节点产物 */
export interface DerivedNodeInput {
  /** 本地加工得到的图片数据 */
  blob: Blob;
  naturalWidth: number;
  naturalHeight: number;
  filename?: string;
  labelSuffix?: string;
  labelOverride?: string;
  position?: { x: number; y: number };
}

/** 乐观上传句柄：nodeIds 立即返回，settled 在所有上传结束后 resolve */
export interface OptimisticDerivedHandle {
  nodeIds: string[];
  settled: Promise<{ failed: number; reason?: string }>;
}

/**
 * 乐观创建派生节点：先批量建占位节点与连线，再并发上传。
 *
 * 与 uploadAndAddNode 的区别：
 * - uploadAndAddNode：等上传完成后才出现节点，失败则静默无节点；
 * - 本函数：节点立即上画布（显示本地预览与进度），上传失败再移除并回传失败原因。
 *
 * 历史栈：占位节点与连线同批写入，只产生一条历史记录；后续进度回写、
 * 结果替换、失败移除全部 skipHistory，避免一次操作留下多条撤销记录。
 *
 * @param sourceId  源节点 ID（新节点连线到它）
 * @param items     待创建的产物列表
 * @param storeApi  由调用方注入的 store 操作接口
 * @param options.extraNodeData  额外写入 node.data 的字段
 * @param options.concurrency    上传并发数，默认 UPLOAD_CONCURRENCY
 * @param options.source         文件归属标记，默认 "derived"
 */
export function createOptimisticDerivedNodes(
  sourceId: string,
  items: DerivedNodeInput[],
  storeApi: DerivedUploadStoreApi,
  options?: {
    extraNodeData?: Record<string, unknown>;
    concurrency?: number;
    source?: "upload" | "derived";
  },
): OptimisticDerivedHandle {
  const origNode = storeApi.nodes.find((n) => n.id === sourceId);
  const extraNodeData = options?.extraNodeData;
  const source = options?.source ?? "derived";
  const concurrency = options?.concurrency ?? UPLOAD_CONCURRENCY;

  const newNodes: AnyNode[] = [];
  const newEdges: AnyEdge[] = [];
  const pending: { nodeId: string; version: number; previewUrl: string; blob: Blob; filename: string }[] = [];

  for (const item of items) {
    const label = resolveDerivedLabel(origNode, item.labelSuffix ?? "", item.labelOverride);
    const position = resolveDerivedPosition(origNode, item.position);

    const node = createImageNode(position, "");
    applyThumbnailSettings(node, item.naturalWidth, item.naturalHeight, label);
    if (extraNodeData) Object.assign(node.data, extraNodeData);

    // 版本号用于异步回调时校验：节点被撤销 / 重置后 version 不匹配则放弃写入
    const version = Date.now();
    const previewUrl = URL.createObjectURL(item.blob);
    Object.assign(node.data, {
      upload: { uploading: true, progress: 0, version, previewUrl },
      source,
    });

    newNodes.push(node);
    newEdges.push(createEdge(sourceId, node.id));
    pending.push({
      nodeId: node.id,
      version,
      previewUrl,
      blob: item.blob,
      filename: item.filename ?? `derived_${version}.png`,
    });
  }

  if (newNodes.length > 0) {
    storeApi.addNodes(newNodes);
    storeApi.setEdges([...storeApi.edges, ...newEdges]);
  }

  const nodeIds = pending.map((p) => p.nodeId);

  const settled = (async (): Promise<{ failed: number; reason?: string }> => {
    if (pending.length === 0) return { failed: 0 };

    const results = await runWithConcurrency(
      pending.map((p) => async () => {
        const file = new File([p.blob], p.filename, { type: p.blob.type || "image/png" });
        return uploadWithRetry(
          file,
          "images",
          (pct) => {
            // 进度回写前校验：节点可能已被撤销 / 删除
            const cur = storeApi.getNodes().find((n) => n.id === p.nodeId);
            if (!cur) return;
            const upload = (cur.data as { upload?: { version?: number } }).upload;
            if (upload?.version !== p.version) return;
            storeApi.updateNodeData(
              p.nodeId,
              { upload: { uploading: true, progress: pct, version: p.version, previewUrl: p.previewUrl } },
              undefined,
              { skipHistory: true },
            );
          },
          UPLOAD_MAX_RETRIES,
          source,
        );
      }),
      concurrency,
    );

    let failed = 0;
    let reason: string | undefined;
    const failedIds: string[] = [];

    results.forEach((r, i) => {
      const p = pending[i];
      // 上传结束即释放预览 URL：成功则已换服务端 URL，失败则节点被移除
      URL.revokeObjectURL(p.previewUrl);

      if (r.status === "fulfilled") {
        const cur = storeApi.getNodes().find((n) => n.id === p.nodeId);
        const upload = (cur?.data as { upload?: { version?: number } } | undefined)?.upload;
        if (!cur || upload?.version !== p.version) return; // 已被撤销 / 删除，放弃写入
        storeApi.updateNodeData(p.nodeId, { src: r.value.url, upload: undefined }, undefined, { skipHistory: true });
      } else {
        failed++;
        failedIds.push(p.nodeId);
        reason = reason ?? getUploadErrorDetail(r.reason);
      }
    });

    // 失败清理：removeNodes 会级联删除其关联边
    if (failedIds.length > 0) {
      storeApi.removeNodes(failedIds, { skipHistory: true });
    }

    return { failed, reason };
  })();

  return { nodeIds, settled };
}

// ── 派生节点网格布局 ──
// 宫格切分、全景多视角截图等批量派生节点统一使用此布局，
// 保证各处"源节点右侧网格"的基准点与步进逻辑一致。

export interface DerivedGridLayout {
  baseX: number;
  baseY: number;
  stepX: number;
  stepY: number;
  cols: number;
  displayW: number;
  displayH: number;
}

/**
 * 计算派生节点网格布局。
 *
 * 基准点 = 源节点右侧 + 60px；水平步进 = 单格显示宽度 + 间隙；
 * 垂直步进 = 单格显示高度 + 标题栏(NODE_TITLE_HEIGHT) + 间隙，避免下一行压住 title。
 * 宫格切分、全景多视角截图等批量派生节点统一通过此函数计算位置，
 * 保证在画布上排列紧凑整齐且各处逻辑一致。
 *
 * @param sourceNode    源节点（用于定位网格基准点，可为空）
 * @param cellNaturalW  单个派生节点的自然宽度
 * @param cellNaturalH  单个派生节点的自然高度
 * @param cols          网格每行放置的节点数
 */
export function computeDerivedGrid(
  sourceNode: { position: { x: number; y: number }; style?: { width?: number | string } } | undefined,
  cellNaturalW: number,
  cellNaturalH: number,
  cols: number,
): DerivedGridLayout {
  const { displayW, displayH } = computeThumbScale(cellNaturalW, cellNaturalH);
  return {
    baseX: (sourceNode?.position.x || 0) + ((sourceNode?.style?.width as number) || 600) + DERIVED_BASE_GAP_X,
    baseY: sourceNode?.position.y || 0,
    stepX: displayW + DERIVED_CELL_GAP,
    // 纵向需计入标题栏高度，避免下一行节点压住上一行的 title
    stepY: displayH + NODE_TITLE_HEIGHT + DERIVED_CELL_GAP,
    cols,
    displayW,
    displayH,
  };
}

/**
 * 根据网格布局与索引计算节点位置（行优先，从左到右）。
 *
 * @param layout computeDerivedGrid 的返回值
 * @param index  节点在批量创建顺序中的索引（0 起）
 */
export function gridPositionAt(layout: DerivedGridLayout, index: number): { x: number; y: number } {
  const col = index % layout.cols;
  const row = Math.floor(index / layout.cols);
  return { x: layout.baseX + col * layout.stepX, y: layout.baseY + row * layout.stepY };
}
