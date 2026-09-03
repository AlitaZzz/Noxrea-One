/**
 * 视频节点（video-node）渲染组件。
 * 内置轻量播放器（播放/暂停、静音、进度条拖拽），支持视频上传与拖入、
 * 生成中状态展示，以及「截取当前帧生成图片节点」操作。
 */
"use client";

import {
  CaretRightOutlined,
  PauseOutlined,
  UploadOutlined,
  VideoCameraOutlined,
} from "@ant-design/icons";
import { Handle, type NodeProps,Position } from "@xyflow/react";
import { App, Input, Tooltip } from "antd";
import { memo, useCallback, useEffect,useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { VolumeMuteIcon } from "@/components/ui/icons/media/VolumeMuteIcon";
import { VolumeUpIcon } from "@/components/ui/icons/media/VolumeUpIcon";
import { useAssetsStore } from "@/features/assets/store";
import {
  captureFrame as captureFrameApi,
  detachAudio as detachAudioApi,
  type DetachAudioResult,
} from "@/features/canvas/api/file-api";
import { useEditableTitle } from "@/features/canvas/hooks/use-editable-title";
import { createEdge } from "@/features/canvas/node-defaults";
import { markDirtyImmediate, useCanvasStore } from "@/features/canvas/stores/canvas-store";
import type { VideoNode as VideoNodeType, VideoNodeData } from "@/features/canvas/types";
import {
  createAudioNodeFromUrl,
  createNodeFromUrl,
  createVideoNodeFromUrl,
  DERIVED_BASE_GAP_Y,
  useNodeUpload,
} from "@/features/canvas/upload";
import { DEFAULT_NODE_HEIGHT,DEFAULT_NODE_WIDTH,EventNames,isGenerating,NODE_HANDLE_TOP,NODE_TITLE_HEIGHT } from "@/lib/constants";
import { formatTime } from "@/lib/utils/format";
import { AUDIO_DECISION_MIN_TIME, detectAudioTrack, probeAudioTrack } from "@/lib/utils/media-utils";

import GeneratingOverlay from "./GeneratingOverlay";
import UploadFailedOverlay from "./UploadFailedOverlay";

function VideoNode({ id, data, selected }: NodeProps<VideoNodeType>) {
  const { t } = useTranslation();
  const { notification } = App.useApp();
  const [src, setSrc] = useState(data.src || "");
  const [detaching, setDetaching] = useState(false);
  const [capturing, setCapturing] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const seekBarRef = useRef<HTMLDivElement>(null);
  const volumeBarRef = useRef<HTMLDivElement>(null);
  const [playing, setPlaying] = useState(false);
  /**
   * 音量：0~1。= 0 等价于静音；切换静音时用 lastVolume 记住上次非零值。
   * 默认静音自动播放（hover 行为），降低干扰；用户主动拖过滑块后保留偏好。
   */
  const [volume, setVolume] = useState(0);
  const [lastVolume, setLastVolume] = useState(0.5);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  // Sync local src when data.src changes externally (e.g. from undo/clear),
  // adjusted during render to avoid cascading renders.
  const [prevDataSrc, setPrevDataSrc] = useState(data.src || "");
  if (data.src !== prevDataSrc) {
    setPrevDataSrc(data.src);
    setSrc(data.src || "");
  }

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) { v.play(); setPlaying(true); }
    else { v.pause(); setPlaying(false); }
  }, []);

  /** 同步音量到 video 元素，并把最终值绑回 state（拖动结束也会走 setVolume） */
  const applyVolume = useCallback((value: number) => {
    const v = videoRef.current;
    const clamped = Math.max(0, Math.min(1, value));
    if (v) v.volume = clamped;
    setVolume(clamped);
    if (clamped > 0) setLastVolume(clamped);
  }, []);

  /** 静音切换：保留上次非零音量，再次点击恢复 */
  const toggleMute = useCallback(() => {
    applyVolume(volume === 0 ? lastVolume || 0.5 : 0);
  }, [volume, lastVolume, applyVolume]);

  /** 音量滑块点击：转 0~1 比例后写入 */
  const setVolumeFromX = useCallback((clientX: number) => {
    const bar = volumeBarRef.current;
    if (!bar) return;
    const rect = bar.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    applyVolume(pct);
  }, [applyVolume]);

  const handleVolumeDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setVolumeFromX(e.clientX);
    const onMove = (ev: PointerEvent) => { ev.preventDefault(); setVolumeFromX(ev.clientX); };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }, [setVolumeFromX]);

  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleMouseEnter = useCallback(() => {
    if (hoverTimerRef.current) { clearTimeout(hoverTimerRef.current); hoverTimerRef.current = null; }
    const v = videoRef.current;
    if (v && v.paused) {
      v.play().then(() => setPlaying(true)).catch(() => {});
    }
  }, []);
  const handleMouseLeave = useCallback(() => {
    hoverTimerRef.current = setTimeout(() => {
      const v = videoRef.current;
      if (v) { v.pause(); v.currentTime = 0; setPlaying(false); setProgress(0); }
      hoverTimerRef.current = null;
    }, 150);
  }, []);

  /**
   * 回填音轨结论到节点数据。
   * skipHistory：探测属于渲染副产物，不该占用撤销栈。
   */
  const commitHasAudio = useCallback(
    (value: boolean) => {
      if (data.hasAudio === value) return;
      useCanvasStore.getState().updateNodeData(
        id,
        { hasAudio: value } as Partial<VideoNodeData>,
        undefined,
        { skipHistory: true },
      );
    },
    [data.hasAudio, id],
  );

  /** 音轨探测：先读属性，无法确定时静默播放一小段再判定 */
  const resolveAudioTrack = useCallback(async () => {
    const v = videoRef.current;
    if (!v) return;
    if (detectAudioTrack(v, v.currentTime > AUDIO_DECISION_MIN_TIME) === true) {
      commitHasAudio(true);
      return;
    }
    const probed = await probeAudioTrack(v);
    if (probed !== null) commitHasAudio(probed);
  }, [commitHasAudio]);

  const onTimeUpdate = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    setProgress(v.currentTime);

    const detected = detectAudioTrack(v, true);
    if (detected === null) return;
    // 有音轨可立即定论；判定「无音轨」则要求已播够时长，避免解码未就绪时误判
    if (detected || v.currentTime > AUDIO_DECISION_MIN_TIME) {
      commitHasAudio(detected);
    }
  }, [commitHasAudio]);
  const onLoadedMeta = useCallback(() => {
    const v = videoRef.current;
    if (v) setDuration(v.duration || 0);
    void resolveAudioTrack();
  }, [resolveAudioTrack]);

  const seekTo = useCallback((clientX: number) => {
    const v = videoRef.current;
    const bar = seekBarRef.current;
    if (!v || !bar || !duration) return;
    const rect = bar.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    v.currentTime = pct * duration;
    setProgress(pct * duration);
  }, [duration]);

  const handleSeekDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    seekTo(e.clientX);
    const onMove = (ev: PointerEvent) => { ev.preventDefault(); seekTo(ev.clientX); };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }, [seekTo]);

  const captureFrame = useCallback(async (time: number | null) => {
    const v = videoRef.current;
    if (!v || !src || capturing) return;
    setCapturing(true);
    try {
      const seekTime = time !== null ? Math.max(0, Math.min(time, v.duration || time)) : v.currentTime;
      const videoKey = src.replace(/^\/api\/files\//, "").split("?")[0];
      const res = await captureFrameApi(videoKey, seekTime);
      if (!res.ok) {
        // 后端按错误码给出结论（视频缺失 / 组件未就绪 / 抽帧失败），优先用本地化文案
        const errJson = await res.json().catch(() => null);
        const code = errJson?.error as string | undefined;
        notification.error({
          message: code
            ? t(`error.${code}`, { defaultValue: t("error.capture_frame.capture_failed") })
            : t("error.capture_frame.capture_failed"),
          placement: "bottomRight",
        });
        return;
      }
      const json = await res.json();
      const imgUrl = json.data?.url;
      if (!imgUrl) {
        notification.error({ message: t("error.capture_frame.capture_failed"), placement: "bottomRight" });
        return;
      }

      const nw = v.videoWidth, nh = v.videoHeight;
      const label = `${data.alt || t("common.frame")} #${Math.round(seekTime * 10) / 10}s`;
      await createNodeFromUrl(id, imgUrl, nw, nh, label, useCanvasStore.getState(), { source: "derived" }, undefined, label);
    } catch (e) {
      console.error("Frame capture failed:", e);
      notification.error({ message: t("error.capture_frame.capture_failed"), placement: "bottomRight" });
    } finally {
      setCapturing(false);
    }
  }, [src, data.alt, id, t, notification, capturing]);

  /**
   * 分离音频：服务端无损拆出音轨与静音视频。
   *
   * 连线策略：两个产物节点都直接连回原视频（原视频 → 静音视频、原视频 → 音频），
   * 与宫格切分一致，不做链式挂接、也不迁移源节点的旧边。
   *
   * 历史栈：先用 write:false 仅构建两个节点，再一次 addNodes + setEdges 同批
   * 写入——addNodes 压一条「分离前」快照，setEdges 被节流不重复压栈，
   * 撤销一次即整体删除两个派生节点及其连线。
   */
  const handleDetachAudio = useCallback(async () => {
    if (!src || detaching) return;
    const videoKey = src.replace(/^\/api\/files\//, "").split("?")[0];
    setDetaching(true);
    try {
      const res = await detachAudioApi(videoKey);
      const json = await res.json();

      if (!res.ok || !json?.data) {
        // 后端按错误码给出确定结论（无音轨 / 组件缺失等），优先用其本地化文案
        const code = json?.error as string | undefined;
        const fallback = t("detach.failed");
        notification.error({
          message: code ? t(`error.${code}`, { defaultValue: fallback }) : fallback,
          placement: "bottomRight",
        });
        // 确认无音轨后同步禁用入口，避免用户反复点击撞同一个错误
        if (code === "detach_audio.no_audio_track") commitHasAudio(false);
        return;
      }

      const { audio, video } = json.data as DetachAudioResult;
      const v = videoRef.current;
      const nw = v?.videoWidth || data.naturalWidth || 0;
      const nh = v?.videoHeight || data.naturalHeight || 0;
      const store = useCanvasStore.getState();

      // 1. 仅构建两个节点（write:false 不写 store），随后同批写入
      const mutedNode = createVideoNodeFromUrl(
        id,
        video.url,
        nw,
        nh,
        t("detach.mutedSuffix"),
        store,
        { source: "derived" },
        undefined,
        undefined,
        { write: false },
      );
      // 音频节点排在静音视频正下方，避免同批产物重叠
      const audioNode = createAudioNodeFromUrl(
        id,
        audio.url,
        t("detach.audioSuffix"),
        store,
        { source: "derived" },
        {
          x: mutedNode.position.x,
          y:
            mutedNode.position.y +
            ((mutedNode.style?.height as number) || DEFAULT_NODE_HEIGHT) +
            DERIVED_BASE_GAP_Y,
        },
        undefined,
        { write: false },
      );

      // 2. 两个产物节点都直接连回原视频，节点与边同批写入
      //    addNodes 压一条「分离前」快照，setEdges 被节流，撤销一次即整体删除
      store.addNodes([mutedNode, audioNode]);
      store.setEdges([
        ...store.edges,
        createEdge(id, mutedNode.id),
        createEdge(id, audioNode.id),
      ]);

      commitHasAudio(true);
      markDirtyImmediate();
    } catch (e) {
      console.error("Audio detach failed:", e);
      notification.error({ message: t("detach.failed"), placement: "bottomRight" });
    } finally {
      setDetaching(false);
    }
  }, [
    src,
    detaching,
    t,
    commitHasAudio,
    data.naturalWidth,
    data.naturalHeight,
    id,
    notification,
  ]);

  /** 节点内上传 / 替换：走统一上传管道（失败自动回滚并提示） */
  const handleUpload = useNodeUpload(id, { accept: "video/*" });

  const addAsset = useAssetsStore((s) => s.addAsset);

  const handleDownload = useCallback(() => {
    if (!src) return;
    const a = document.createElement("a");
    const sep = src.includes("?") ? "&" : "?";
    const params = new URLSearchParams({ download: "true" });
    if (data.alt) params.set("filename", data.alt);
    a.href = `${src}${sep}${params.toString()}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }, [src, data.alt]);

  const handleSaveToAssets = useCallback(() => {
    if (!src) return;
    const node = useCanvasStore.getState().nodes.find(n => n.id === id);
    const d = node?.data as VideoNodeData | undefined;
    // 缩略图不再在保存时生成：素材库读取时通过 sourceUrl?w= 由后端按需抽帧
    addAsset({
      name: data.alt || data.label || t("node.video"),
      type: "other",
      mediaType: "video",
      width: d?.naturalWidth || 0,
      height: d?.naturalHeight || 0,
      description: "",
      metadata: {
        sourceUrl: src,
        source: d?.source,
      },
    });
  }, [src, data.alt, data.label, id, addAsset, t]);

  const handleClear = useCallback(() => {
    setSrc("");
    useCanvasStore.getState().updateNodeData(id, {
      src: "", label: "", alt: "", naturalWidth: 0, naturalHeight: 0,
      upload: undefined, source: undefined,
    }, { width: DEFAULT_NODE_WIDTH, height: DEFAULT_NODE_HEIGHT });
    markDirtyImmediate();
  }, [id]);

  // Listen for node action events from NodeToolbar
  useEffect(() => {
    function onNodeAction(e: Event) {
      const detail = (e as CustomEvent).detail;
      if (detail.nodeId !== id) return;
      switch (detail.action) {
        case "download": handleDownload(); break;
        case "save-asset": handleSaveToAssets(); break;
        case "clear": handleClear(); break;
        case "capture-frame": {
          const v = videoRef.current;
          if (detail.time === -1) {
            captureFrame(v?.duration ? v.duration - 0.1 : 10);
          } else {
            captureFrame(detail.time);
          }
          break;
        }
        case "detach-audio":
          void handleDetachAudio();
          break;
      }
    }
    window.addEventListener(EventNames.CANVAS_NODE_ACTION, onNodeAction);
    return () => window.removeEventListener(EventNames.CANVAS_NODE_ACTION, onNodeAction);
  }, [id, handleDownload, handleSaveToAssets, handleClear, captureFrame, handleDetachAudio]);

  // 换源后旧探测结论失效，清空以便重新判定
  useEffect(() => {
    const store = useCanvasStore.getState();
    const node = store.nodes.find((n) => n.id === id);
    if (!node) return;
    if ((node.data as VideoNodeData).hasAudio === undefined) return;
    store.updateNodeData(
      id,
      { hasAudio: undefined } as Partial<VideoNodeData>,
      undefined,
      { skipHistory: true },
    );
  }, [id, src]);

  const { editing: editingTitle, draft: titleDraft, setDraft: setTitleDraft, handleDblClick: handleTitleDblClick, handleSave: handleTitleSave } =
    useEditableTitle(id, data.alt || data.label || t("node.video"), { syncAlt: true });

  const hasVideo = src && src.length > 0;

  return (
    <div className="group relative w-full h-full flex flex-col">
      <div className="flex items-center justify-between px-3 py-1 text-[13px] font-medium text-white/80" style={{ height: NODE_TITLE_HEIGHT, flexShrink: 0 }}>
        {editingTitle ? (
          <span className="flex items-center gap-0.5 flex-1 min-w-0">
            <VideoCameraOutlined className="shrink-0" />
            <Input
              size="small"
              variant="borderless"
              className="nodrag text-[13px] font-medium text-white/80"
              value={titleDraft}
              onChange={(e) => setTitleDraft(e.target.value)}
              onBlur={handleTitleSave}
              onPressEnter={handleTitleSave}
              autoFocus
              style={{ padding: "1px 4px", height: 20, background: "var(--canvas-bg)", border: "1px solid #525252", borderRadius: 4, outline: "none", boxShadow: "none", width: "100%" }}
            />
          </span>
        ) : (
          <span className="flex items-center gap-0.5 flex-1 min-w-0" onDoubleClick={handleTitleDblClick}>
            <VideoCameraOutlined className="shrink-0" />
            <span className="truncate">{data.label || data.alt || t("node.video")}</span>
          </span>
        )}
        {hasVideo && data.naturalWidth > 0 && (
          <span className="text-white/30 text-xs whitespace-nowrap ml-2">{data.naturalWidth}×{data.naturalHeight}</span>
        )}
      </div>

      <div
        className={`
          node-body flex-1 flex items-center justify-center overflow-hidden rounded-lg relative group/body
          ${selected ? "node-selected" : ""}
        `}
        style={{ background: hasVideo ? "transparent" : "var(--canvas-bg, #262626)" }}
        onContextMenu={(e) => e.preventDefault()}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
      >
        {data.source === "upload" && hasVideo && !data.upload?.uploading && !isGenerating(data.taskBinding) && (
          <div className="absolute top-2 right-2 z-20 nodrag">
            <Tooltip title={t("common.replace")}>
              <button
                className="flex items-center justify-center w-7 h-7 rounded-md bg-black/60 hover:bg-black/80 text-white/80 hover:text-white transition-colors cursor-pointer"
                onClick={handleUpload}
              >
                <UploadOutlined style={{ fontSize: 12 }} />
              </button>
            </Tooltip>
          </div>
        )}
        {data.upload?.uploading ? (
          <div className="absolute inset-0 rounded-lg overflow-hidden">
            {data.upload?.previewUrl && (
              <video src={data.upload.previewUrl} muted playsInline preload="metadata" className="absolute inset-0 w-full h-full object-cover" style={{ filter: "blur(24px)", animation: "breathe 3s ease-in-out infinite" }} />
            )}
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-8" style={{ background: "rgba(0,0,0,0.35)" }}>
              {data.upload?.progress != null ? (
                <div className="w-3/4 h-1.5 bg-white/10 rounded-full overflow-hidden">
                  <div className="h-full bg-[#1D9E75] rounded-full transition-all duration-300" style={{ width: `${data.upload.progress}%` }} />
                </div>
              ) : (
                <div className="w-3/4 h-1.5 bg-white/10 rounded-full overflow-hidden">
                  <div className="h-full bg-[#1D9E75] rounded-full animate-pulse" style={{ width: "60%" }} />
                </div>
              )}
              <span className="text-sm text-white/70 font-medium tabular-nums">
                {t("common.uploading")}
                {data.upload?.progress != null ? ` ${Math.round(data.upload.progress)}%` : ""}
              </span>
            </div>
          </div>
        ) : data.upload?.error ? (
          <UploadFailedOverlay nodeId={id} error={data.upload.error} previewUrl={data.upload.previewUrl} />
        ) : isGenerating(data.taskBinding) ? (
          <GeneratingOverlay absolute={false} startedAt={data.taskBinding?.startedAt} />
        ) : hasVideo ? (
          <div className="w-full h-full relative">
            <video
              ref={videoRef}
              src={src}
              className="absolute inset-0 w-full h-full rounded-lg"
              loop
              muted={volume === 0}
              playsInline
              preload="metadata"
              onTimeUpdate={onTimeUpdate}
              onLoadedMetadata={onLoadedMeta}
              onEnded={() => setPlaying(false)}
              onContextMenu={(e) => e.preventDefault()}
            />
            {/* 底部渐变遮罩：与控件栏同步显隐，静止时保持画面纯净 */}
            <div className={`pointer-events-none absolute bottom-0 left-0 right-0 h-24 z-[5] video-controls-scrim transition-opacity ${playing ? "opacity-100" : "opacity-0 group-hover/body:opacity-100"}`} />
            {/* Controls bar */}
            <div className={`nodrag absolute bottom-4 left-0 right-0 z-10 flex flex-col gap-2 px-2 video-controls-bar ${playing ? "opacity-100" : "opacity-0 group-hover/body:opacity-100"} transition-opacity`}>
              {/* 第一行：进度条横跨整行（已播放部分用品牌色，与图片一致） */}
              <div
                ref={seekBarRef}
                className="h-[6px] bg-white/20 rounded-full cursor-pointer relative group/progress"
                onPointerDown={handleSeekDown}
              >
                <div
                  className="h-full bg-[#1D9E75] rounded-full relative transition-[width] duration-75"
                  style={{ width: `${duration ? (progress / duration) * 100 : 0}%` }}
                >
                  <div className="absolute -right-[7px] -top-[4px] w-[14px] h-[14px] rounded-full bg-white shadow-md scale-0 group-hover/progress:scale-100 transition-transform" />
                </div>
              </div>

              {/* 第二行：左 play+时间 ｜ 右 volume+slider */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <button
                    className="video-control-btn flex-shrink-0 text-white hover:text-white/80 transition-colors"
                    onClick={(e) => { e.stopPropagation(); togglePlay(); }}
                    style={{ background: "none", border: "none", cursor: "pointer", padding: 0, lineHeight: 1 }}
                  >
                    {playing ? <PauseOutlined style={{ fontSize: 22 }} /> : <CaretRightOutlined style={{ fontSize: 22 }} />}
                  </button>
                  <span className="text-sm text-white flex-shrink-0 tabular-nums">
                    {formatTime(progress)} / {formatTime(duration)}
                  </span>
                </div>
                {/* 确认无音轨时隐藏音量控件（图标+滑块），与浏览器原生行为一致，避免“可拖动但无效果”的误导 */}
                {data.hasAudio !== false && (
                  <div className="flex items-center gap-2">
                    <button
                      className="video-control-btn flex-shrink-0 text-white hover:text-white/80 transition-colors"
                      onClick={(e) => { e.stopPropagation(); toggleMute(); }}
                      style={{ background: "none", border: "none", cursor: "pointer", padding: 0, lineHeight: 1 }}
                      aria-label={volume === 0 ? "unmute" : "mute"}
                    >
                      {volume === 0 ? (
                        <VolumeMuteIcon style={{ color: "#fff", width: 22, height: 22 }} />
                      ) : (
                        <VolumeUpIcon style={{ color: "#fff", width: 22, height: 22 }} />
                      )}
                    </button>
                    {/* 音量滑块：80px，定长避免占据底部控件太多空间 */}
                    <div
                      ref={volumeBarRef}
                      className="w-20 h-[6px] bg-white/20 rounded-full cursor-pointer relative group/volume"
                      onPointerDown={handleVolumeDown}
                    >
                      <div
                        className="h-full bg-[#1D9E75] rounded-full relative transition-[width] duration-75"
                        style={{ width: `${volume * 100}%` }}
                      >
                        <div className="absolute -right-[7px] -top-[4px] w-[14px] h-[14px] rounded-full bg-white shadow-md scale-0 group-hover/volume:scale-100 transition-transform" />
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>

          </div>
        ) : (
          <div className="flex flex-col items-center justify-center gap-2 p-4 text-white/40">
            <VideoCameraOutlined className="text-5xl" />
            <span className="text-base text-center">{t("drop.video")}</span>
            <button className="node-upload-btn nodrag flex items-center gap-2 px-6 py-3 rounded-lg text-base"
              onClick={handleUpload}>
              <UploadOutlined className="text-lg" /> {t("common.upload")}
            </button>
          </div>
        )}

        {/* 分离音频 / 捕获帧处理中：同步请求可能持续数秒，必须给出明确反馈 */}
        {(detaching || capturing) && (
          <div
            className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-2 rounded-lg"
            style={{ background: "rgba(0,0,0,0.45)" }}
          >
            <span className="w-7 h-7 rounded-full border-2 border-white/80 border-t-transparent animate-spin" />
            <span className="text-xs text-white/80">{detaching ? t("detach.processing") : t("capture.processing")}</span>
          </div>
        )}
      </div>

      {data.source !== "upload" && <Handle type="target" position={Position.Left} style={{ top: NODE_HANDLE_TOP }} />}
      <Handle type="source" position={Position.Right} style={{ top: NODE_HANDLE_TOP }} />
    </div>
  );
}

export default memo(VideoNode);
