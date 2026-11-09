/**
 * 视频节点的媒体编辑动作编排：上传 / 替换、抽帧、分离音频、片段截取、
 * 画面裁剪、下载与保存到资产库。
 *
 * 客户端优先、服务端兜底的任务生命周期统一交给 useMediaEditTask；本 hook 只
 * 负责把各动作的产物投影成派生节点写回画布，并保证换源后旧产物不落盘。
 * 节点组件只消费 handler 与 busy 状态，不直接接触文件 API 或客户端管线。
 */
"use client";

import type { FrameSelection } from "@noxrea/shared";
import type { CropRectPx } from "@noxrea/shared/crop-rect";
import { storageKeyOf } from "@noxrea/shared/url";
import { useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";

import { useAppFeedback } from "@/components/ui/use-app-feedback";
import { addAsset } from "@/entities/asset";
import {
  captureFrame as captureFrameApi,
  cropVideo as cropVideoApi,
  detachAudio as detachAudioApi,
  type DetachAudioResult,
  extractClip as extractClipApi,
  readCapturedFrame,
  readDetachAudioResult,
  readEditResultKey,
} from "@/features/canvas/api/file-api";
import {
  tryClipOnClient,
  tryCropOnClient,
  tryDetachAudioOnClient,
} from "@/features/canvas/editing/client-media/client-video";
import { useMediaEditTask } from "@/features/canvas/editing/use-media-edit-task";
import { markDirtyImmediate, useCanvasStore } from "@/features/canvas/stores/canvas-store";
import type { VideoNodeData } from "@/features/canvas/types";
import {
  commitDerivedNodes,
  createAudioNodeFromRef,
  createImageNodeFromRef,
  createVideoNodeFromRef,
  DERIVED_BASE_GAP_Y,
  useNodeUpload,
} from "@/features/canvas/upload";
import { EventNames } from "@/lib/constants";
import { downloadManagedFile } from "@/lib/utils/download";
import { formatTime } from "@/lib/utils/format";
import { nodeRectOf } from "@/lib/utils/image-utils";

export interface UseVideoNodeActionsOptions {
  id: string;
  /** 持久化源（data.src）：媒体编辑动作只接受存储 key。 */
  src: string;
  label: string;
  naturalWidth: number;
  naturalHeight: number;
  hasAudio?: boolean;
  videoRef: { current: HTMLVideoElement | null };
  /** 全屏预览是节点 UI 状态，由节点组件提供稳定回调。 */
  onPreview: () => void;
}

export function useVideoNodeActions({
  id,
  src,
  label,
  naturalWidth,
  naturalHeight,
  hasAudio,
  videoRef,
  onPreview,
}: UseVideoNodeActionsOptions) {
  const { t } = useTranslation();
  const { notification } = useAppFeedback();
  // 本地处理忙状态：抽帧 / 分离音频 / 片段截取 / 画面裁剪互斥共用（同一节点
  // 同一时刻只跑一个）。busy 形状与任务编排（守卫 / 取消 / 客户端失败切服务端
  // 兜底）统一由 useMediaEditTask 提供（specs/client-video-editing.md 降级契约）
  const { busy, runEditTask, cancelActive, expectSource } = useMediaEditTask(id);

  // 换源替换 / 卸载：中止进行中的本地处理任务（抽帧请求 / 客户端管线）——
  // 旧源的产物不得写入已换成新源的节点
  useEffect(() => () => cancelActive(), [cancelActive, src]);

  /**
   * 回填音轨结论到节点数据。
   * skipHistory：探测属于渲染副产物，不该占用撤销栈。
   */
  const commitHasAudio = useCallback(
    (value: boolean) => {
      if (hasAudio === value) return;
      useCanvasStore.getState().updateNodeData(
        id,
        { hasAudio: value } as Partial<VideoNodeData>,
        undefined,
        { skipHistory: true },
      );
    },
    [hasAudio, id],
  );

  const captureFrame = useCallback(async (selection: FrameSelection) => {
    const videoKey = storageKeyOf(src);
    if (!videoKey) {
      // 确认不自关契约的兜底：源已失效或不是存储 key（外部 URL）时抽帧无从
      // 进行——关掉仍打开的帧截取面板，不留无响应的确认键（抽帧是只接受
      // 存储 key 的服务端操作，不需要本地视频元素）
      useCanvasStore.getState().setFrameCaptureNodeId(null);
      return;
    }
    runEditTask({
      kind: "capture",
      // 抽帧被接受：关闭帧截取面板（面板不在确认时自关——busy 守卫拒绝时面板
      // 保持打开、播放位置原样保留可重试，与截取面板的「确认不自关」契约一致）
      onAccept: () => useCanvasStore.getState().setFrameCaptureNodeId(null),
      // 纯服务端任务（无客户端管线）：不提供取消入口，但支持换源中止
      serverTask: async ({ signal }) => {
        const res = await captureFrameApi(videoKey, selection, signal);
        return readCapturedFrame(res, signal, {
          notification,
          t,
          errorKey: "error.capture_frame.capture_failed",
          nodeId: id,
        });
      },
      onSuccess: async (frame) => {
        // 源已被替换：旧源的抽帧产物不再写入
        if (!expectSource(src)) return;
        const { width: nw, height: nh, time: capturedTime } = frame;
        const frameLabel = `${label || t("common.frame")} #${Math.round(capturedTime * 10) / 10}s`;
        // 投影只暴露持久化 key；响应 url 不进入节点构建
        createImageNodeFromRef({
          sourceId: id,
          ref: frame.key,
          naturalWidth: nw,
          naturalHeight: nh,
          labelSuffix: frameLabel,
          storeApi: useCanvasStore.getState(),
          extraNodeData: { source: "derived" },
          labelOverride: frameLabel,
        });
      },
      errorKey: "error.capture_frame.capture_failed",
      logLabel: "Frame capture failed:",
    });
  }, [src, label, id, t, notification, runEditTask, expectSource]);

  /**
   * 分离音频：优先走客户端管线（纯重封装，零解码，specs/client-video-editing.md），
   * 探测不支持或管线失败自动回退服务端。两个产物都作为派生节点连回源节点。
   *
   * 连线策略：两个产物节点都直接连回原视频（原视频 → 静音视频、原视频 → 音频），
   * 与宫格切分一致，不做链式挂接、也不迁移源节点的旧边。
   *
   * 历史栈：先用 write:false 仅构建两个节点，再由 commitDerivedNodes 在同一
   * 批量守卫内写入节点与连线——只压一条「分离前」快照，撤销一次即整体删除
   * 两个派生节点及其连线。
   */
  const handleDetachAudio = useCallback(async () => {
    const videoKey = storageKeyOf(src);
    if (!videoKey) return;
    runEditTask({
      kind: "detach",
      // 客户端管线：用户取消静默复位；不支持（非 ISO-BMFF 容器 / 非 AAC 音轨 /
      // 无音轨）/ 管线失败回退服务端；其余异常向上抛。
      // 客户端产物补齐派生节点所需的 mime / ext，与服务端响应同形
      clientTask: async ({ signal, onProgress }) => {
        const result = await tryDetachAudioOnClient(videoKey, { signal, onProgress });
        return {
          audio: { ...result.audio, mime: "audio/mp4", ext: ".m4a" },
          video: { ...result.video, mime: "video/mp4", ext: ".mp4" },
        } satisfies DetachAudioResult;
      },
      serverTask: async ({ signal }) => {
        const res = await detachAudioApi(videoKey, signal);
        return readDetachAudioResult(res, signal, {
          notification,
          t,
          errorKey: "detach.failed",
          nodeId: id,
          // 确认无音轨后同步禁用入口，避免用户反复点击撞同一个错误
          onErrorCode: (code) => {
            if (code === "detach_audio.no_audio_track") commitHasAudio(false);
          },
        });
      },
      onSuccess: async (detached) => {
        // 源已被替换：旧源的派生产物不再写入（各编辑动作 onSuccess 同一守卫）
        if (!expectSource(src)) return;
        const { audio, video } = detached;
        const v = videoRef.current;
        const nw = v?.videoWidth || naturalWidth || 0;
        const nh = v?.videoHeight || naturalHeight || 0;
        const store = useCanvasStore.getState();

        // 1. 仅构建两个节点（write:false 不写 store），随后同批写入
        const mutedNode = createVideoNodeFromRef({
          sourceId: id,
          ref: video.key,
          naturalWidth: nw,
          naturalHeight: nh,
          labelSuffix: t("detach.mutedSuffix"),
          storeApi: store,
          extraNodeData: { source: "derived" },
          options: { write: false },
        });
        // 音频节点排在静音视频正下方，避免同批产物重叠
        const audioNode = createAudioNodeFromRef({
          sourceId: id,
          ref: audio.key,
          labelSuffix: t("detach.audioSuffix"),
          storeApi: store,
          extraNodeData: { source: "derived" },
          positionOverride: {
            x: mutedNode.position.x,
            y:
              mutedNode.position.y +
              nodeRectOf(mutedNode).height +
              DERIVED_BASE_GAP_Y,
          },
          options: { write: false },
        });

        // 2. 两个产物节点都直接连回原视频，节点与边同批写入。
        commitDerivedNodes(id, [mutedNode, audioNode], store);

        commitHasAudio(true);
        markDirtyImmediate();
      },
      errorKey: "detach.failed",
      logLabel: "Audio detach failed:",
    });
  }, [
    src,
    t,
    commitHasAudio,
    naturalWidth,
    naturalHeight,
    id,
    notification,
    runEditTask,
    expectSource,
    videoRef,
  ]);

  /** 节点内上传 / 替换：走统一上传管道（失败自动回滚并提示） */
  const handleUpload = useNodeUpload(id, { accept: "video/*", clearFields: ["hasAudio"] });

  /**
   * 截取片段：优先走客户端管线（WebCodecs 硬件编码，specs/client-video-editing.md），
   * 探测不支持或管线失败自动回退服务端；产物作为派生视频节点连回源节点。
   *
   * 历史栈策略与分离音频一致：write:false 仅构建节点，再由 commitDerivedNodes
   * 在同一批量守卫内写入节点与连线，撤销一次即整体删除。
   */
  const handleExtractClip = useCallback(async (start: number, end: number) => {
    const videoKey = storageKeyOf(src);
    if (!videoKey) return;
    runEditTask({
      kind: "clip",
      // 退出截取模式：选区已被接受，面板随之卸载（与音频截取确认同一约定）
      onAccept: () => useCanvasStore.getState().setClipCaptureNodeId(null),
      // 客户端管线：用户取消静默复位；不支持 / 管线失败回退服务端；其余异常向上抛。
      // 产物投影为与服务端响应同形的存储 key（节点 src 持久化值域），onSuccess 单一形状消费
      clientTask: async ({ signal, onProgress }) =>
        (await tryClipOnClient(videoKey, { start, end }, { signal, onProgress })).key,
      serverTask: async ({ signal }) => {
        const res = await extractClipApi(videoKey, start, end, signal);
        // 单产物响应只取持久化值域 key；url 是渲染期派生物，不得写入节点
        return readEditResultKey(res, signal, {
          notification,
          t,
          errorKey: "error.clip.extract_failed",
          nodeId: id,
        });
      },
      onSuccess: (key) => {
        // 源已被替换：旧源的派生产物不再写入
        if (!expectSource(src)) return;
        const v = videoRef.current;
        const nw = v?.videoWidth || naturalWidth || 0;
        const nh = v?.videoHeight || naturalHeight || 0;
        const store = useCanvasStore.getState();
        const range = `${formatTime(start)}-${formatTime(end)}`;

        const clipNode = createVideoNodeFromRef({
          sourceId: id,
          ref: key,
          naturalWidth: nw,
          naturalHeight: nh,
          labelSuffix: t("clip.suffix", { range }),
          storeApi: store,
          extraNodeData: { source: "derived" },
          options: { write: false },
        });

        commitDerivedNodes(id, [clipNode], store);

        markDirtyImmediate();
      },
      errorKey: "error.clip.extract_failed",
      logLabel: "Clip extraction failed:",
    });
  }, [
    src,
    t,
    naturalWidth,
    naturalHeight,
    id,
    notification,
    runEditTask,
    expectSource,
    videoRef,
  ]);

  /**
   * 裁剪画面：优先走客户端管线（WebCodecs 硬件编码，specs/client-video-editing.md），
   * 探测不支持或管线失败自动回退服务端；产物作为派生视频节点连回源节点
   * （历史栈策略与片段截取一致）。
   */
  const handleCropVideoApply = useCallback(async (rect: CropRectPx) => {
    const videoKey = storageKeyOf(src);
    if (!videoKey) {
      // 源已失效或不是存储 key（外部 URL）：裁剪无从进行，关掉仍打开的裁剪面板
      // 而不是留一个无响应的确认键（croppingNodeId 的宿主校验兜底见 CanvasSurface）
      useCanvasStore.getState().setCroppingNodeId(null);
      return;
    }
    runEditTask({
      kind: "crop",
      // 裁剪被接受：关闭裁剪面板（面板不在确认时自关——busy 拒绝时面板保持
      // 打开、选区原样保留可重试，与截取面板的「确认不自关」契约一致）
      onAccept: () => useCanvasStore.getState().setCroppingNodeId(null),
      // 客户端管线：用户取消静默复位；不支持 / 管线失败回退服务端；其余异常向上抛。
      // 产物投影为与服务端响应同形的存储 key（裁剪尺寸取调用方 rect，与服务端路径一致）
      clientTask: async ({ signal, onProgress }) =>
        (await tryCropOnClient(videoKey, rect, { signal, onProgress })).key,
      serverTask: async ({ signal }) => {
        const res = await cropVideoApi(videoKey, rect, signal);
        // 单产物响应只取持久化值域 key；url 是渲染期派生物，不得写入节点
        return readEditResultKey(res, signal, {
          notification,
          t,
          errorKey: "error.crop.failed",
          nodeId: id,
        });
      },
      onSuccess: (key) => {
        // 源已被替换：旧源的派生产物不再写入
        if (!expectSource(src)) return;
        const store = useCanvasStore.getState();
        const size = `${rect.width}×${rect.height}`;

        const cropNode = createVideoNodeFromRef({
          sourceId: id,
          ref: key,
          naturalWidth: rect.width,
          naturalHeight: rect.height,
          labelSuffix: t("crop.suffix", { size }),
          storeApi: store,
          extraNodeData: { source: "derived" },
          options: { write: false },
        });

        commitDerivedNodes(id, [cropNode], store);

        markDirtyImmediate();
      },
      errorKey: "error.crop.failed",
      logLabel: "Video crop failed:",
    });
  }, [src, t, id, notification, runEditTask, expectSource]);

  const handleDownload = useCallback(() => {
    void downloadManagedFile(src, label);
  }, [src, label]);

  const handleSaveToAssets = useCallback(async () => {
    if (!src) return;
    const node = useCanvasStore.getState().nodes.find((n) => n.id === id);
    const d = node?.data as VideoNodeData | undefined;
    // 缩略图不再在保存时生成：素材库读取时通过 fileKey?w= 由后端按需抽帧
    await addAsset({
      name: label || t("node.video"),
      type: "other",
      mediaType: "video",
      fileKey: src,
      sourceType: d?.source,
      description: "",
      prompt: d?.genSettings?.prompt ?? "",
    });
  }, [src, label, id, t]);

  // Listen for node action events from NodeToolbar
  useEffect(() => {
    function onNodeAction(e: Event) {
      const detail = (e as CustomEvent).detail;
      if (detail.nodeId !== id) return;
      switch (detail.action) {
        case "download": handleDownload(); break;
        case "save-asset": void handleSaveToAssets(); break;
        case "preview-fullscreen": if (src) onPreview(); break;
        case "capture-frame": {
          void captureFrame(detail.selection);
          break;
        }
        case "detach-audio":
          void handleDetachAudio();
          break;
        case "extract-clip":
          void handleExtractClip(detail.start as number, detail.end as number);
          break;
        case "crop-video":
          // 打开画面裁剪面板（复用 croppingNodeId，与图片裁剪互斥天然成立）；
          // 编辑面板互斥由 store 的 setter 统一收口
          if (src) useCanvasStore.getState().setCroppingNodeId(id);
          break;
        case "crop-video-apply":
          void handleCropVideoApply(detail.rect as CropRectPx);
          break;
      }
    }
    window.addEventListener(EventNames.CANVAS_NODE_ACTION, onNodeAction);
    return () => window.removeEventListener(EventNames.CANVAS_NODE_ACTION, onNodeAction);
  }, [id, src, onPreview, handleDownload, handleSaveToAssets, captureFrame, handleDetachAudio, handleExtractClip, handleCropVideoApply]);

  return { busy, commitHasAudio, handleUpload };
}
