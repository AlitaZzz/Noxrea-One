/**
 * 视频节点（video-node）渲染组件。
 * 内置轻量播放器（播放/暂停、静音、进度条拖拽），支持视频上传与拖入、
 * 生成中状态展示，以及「截取当前帧生成图片节点」操作。
 */
"use client";

import {
  CaretRightOutlined,
  CloseOutlined,
  DownloadOutlined,
  PauseCircleOutlined,
  UploadOutlined,
  VideoCameraOutlined,
} from "@ant-design/icons";
import { Handle, type NodeProps,Position } from "@xyflow/react";
import { Input, Tooltip } from "antd";
import { memo, useCallback, useEffect,useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import { VolumeMuteIcon } from "@/components/ui/icons/media/VolumeMuteIcon";
import { VolumeUpIcon } from "@/components/ui/icons/media/VolumeUpIcon";
import { useAssetsStore } from "@/features/assets/store";
import { captureFrame as captureFrameApi } from "@/features/canvas/api/file-api";
import { useEditableTitle } from "@/features/canvas/hooks/use-editable-title";
import { markDirtyImmediate, useCanvasStore } from "@/features/canvas/stores/canvas-store";
import type { VideoNode as VideoNodeType } from "@/features/canvas/types";
import { createNodeFromUrl, useNodeUpload } from "@/features/canvas/upload";
import { DEFAULT_NODE_HEIGHT,DEFAULT_NODE_WIDTH,EventNames,isGenerating,NODE_HANDLE_TOP,NODE_TITLE_HEIGHT } from "@/lib/constants";
import { formatTime } from "@/lib/utils/format";

import GeneratingOverlay from "./GeneratingOverlay";
import UploadFailedOverlay from "./UploadFailedOverlay";

function VideoNode({ id, data, selected }: NodeProps<VideoNodeType>) {
  const { t } = useTranslation();
  const [src, setSrc] = useState(data.src || "");

  const videoRef = useRef<HTMLVideoElement>(null);
  const seekBarRef = useRef<HTMLDivElement>(null);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(true);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  // Sync local src when data.src changes externally (e.g. from undo/clear),
  // adjusted during render to avoid cascading renders.
  const [prevDataSrc, setPrevDataSrc] = useState(data.src || "");
  const [previewOpen, setPreviewOpen] = useState(false);
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

  const onTimeUpdate = useCallback(() => {
    const v = videoRef.current;
    if (v) setProgress(v.currentTime);
  }, []);
  const onLoadedMeta = useCallback(() => {
    const v = videoRef.current;
    if (v) setDuration(v.duration || 0);
  }, []);

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
    if (!v || !src) return;
    try {
      const seekTime = time !== null ? Math.max(0, Math.min(time, v.duration || time)) : v.currentTime;
      const videoKey = src.replace(/^\/api\/files\//, "").split("?")[0];
      const res = await captureFrameApi(videoKey, seekTime);
      if (!res.ok) return;
      const json = await res.json();
      const imgUrl = json.data?.url;
      if (!imgUrl) return;

      const nw = v.videoWidth, nh = v.videoHeight;
      const label = `${data.alt || t("common.frame")} #${Math.round(seekTime * 10) / 10}s`;
      await createNodeFromUrl(id, imgUrl, nw, nh, label, useCanvasStore.getState(), { source: "derived" }, undefined, label);
    } catch (e) { console.error("Frame capture failed:", e); }
  }, [src, data.alt, id]);

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
    const d = node?.data as VideoNodeType | undefined;
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
        case "preview-fullscreen": if (src) setPreviewOpen(true); break;
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
      }
    }
    window.addEventListener(EventNames.CANVAS_NODE_ACTION, onNodeAction);
    return () => window.removeEventListener(EventNames.CANVAS_NODE_ACTION, onNodeAction);
  }, [id, handleDownload, handleSaveToAssets, handleClear, captureFrame]);

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
              className="text-[13px] font-medium text-white/80"
              value={titleDraft}
              onChange={(e) => setTitleDraft(e.target.value)}
              onBlur={handleTitleSave}
              onPressEnter={handleTitleSave}
              autoFocus
              style={{ padding: "1px 4px", height: 20, background: "var(--canvas-bg)", border: "1px solid #525252", borderRadius: 4, outline: "none", boxShadow: "none", width: "100%" }}
            />
          </span>
        ) : (
          <span className="truncate cursor-default" onDoubleClick={handleTitleDblClick}>
            <VideoCameraOutlined className="mr-1" />
            {data.label || data.alt || t("node.video")}
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
              muted={muted}
              playsInline
              preload="metadata"
              onTimeUpdate={onTimeUpdate}
              onLoadedMetadata={onLoadedMeta}
              onEnded={() => setPlaying(false)}
              onContextMenu={(e) => e.preventDefault()}
            />
            {/* 底部渐变遮罩：保证纯白/浅色视频下控件可见 */}
            <div className="pointer-events-none absolute bottom-0 left-0 right-0 h-20 z-[5] video-controls-scrim" />
            {/* Controls bar */}
            <div className={`nodrag absolute bottom-4 left-0 right-0 z-10 flex items-center gap-2 px-2 video-controls-bar ${playing ? "opacity-100" : "opacity-0 group-hover/body:opacity-100"} transition-opacity`}>
              <button
                className="video-control-btn flex-shrink-0 text-white hover:text-white/80 transition-colors"
                onClick={(e) => { e.stopPropagation(); togglePlay(); }}
                style={{ background: "none", border: "none", cursor: "pointer", padding: 0, lineHeight: 1 }}
              >
                {playing ? <PauseCircleOutlined style={{ fontSize: 22 }} /> : <CaretRightOutlined style={{ fontSize: 22 }} />}
              </button>
              <span className="text-sm text-white flex-shrink-0 tabular-nums min-w-[40px]">
                {formatTime(progress)}
              </span>
              <div
                ref={seekBarRef}
                className="flex-1 h-[6px] bg-white/20 rounded-full cursor-pointer relative group/progress"
                onPointerDown={handleSeekDown}
              >
                <div
                  className="h-full bg-white rounded-full relative transition-[width] duration-75"
                  style={{ width: `${duration ? (progress / duration) * 100 : 0}%` }}
                >
                  <div className="absolute -right-[7px] -top-[4px] w-[14px] h-[14px] rounded-full bg-white shadow-md scale-0 group-hover/progress:scale-100 transition-transform" />
                </div>
              </div>
              <span className="text-sm text-white flex-shrink-0 tabular-nums min-w-[40px] text-right">
                {formatTime(duration)}
              </span>
              <button
                className="video-control-btn flex-shrink-0 text-white hover:text-white/80 transition-colors"
                onClick={(e) => { e.stopPropagation(); setMuted(!muted); }}
                style={{ background: "none", border: "none", cursor: "pointer", padding: 0, lineHeight: 1 }}
              >
                {muted ? (
                  <VolumeMuteIcon style={{ color: "#fff", width: 24, height: 24 }} />
                ) : (
                  <VolumeUpIcon style={{ color: "#fff", width: 24, height: 24 }} />
                )}
              </button>
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
      </div>

      {data.source !== "upload" && <Handle type="target" position={Position.Left} style={{ top: NODE_HANDLE_TOP }} />}
      <Handle type="source" position={Position.Right} style={{ top: NODE_HANDLE_TOP }} />

      {previewOpen && src && createPortal(
        <VideoPreviewOverlay src={src} onClose={() => setPreviewOpen(false)} />,
        document.body
      )}
    </div>
  );
}

/** 视频全屏预览浮层：带播放控件、下载、Esc/点击背景关闭，淡入动画 */
function VideoPreviewOverlay({ src, onClose }: { src: string; onClose: () => void }) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const r = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(r);
  }, []);

  const handleDownload = () => {
    if (!src) return;
    const a = document.createElement("a");
    const sep = src.includes("?") ? "&" : "?";
    a.href = `${src}${sep}${new URLSearchParams({ download: "true" }).toString()}`;
    a.download = "";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const btnBase =
    "flex cursor-pointer items-center justify-center rounded-full text-white/90 transition hover:text-white hover:bg-white/15";

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center nodrag"
      style={{
        background: "rgba(0,0,0,0.92)",
        opacity: shown ? 1 : 0,
        transition: "opacity 0.2s ease",
      }}
      onClick={onClose}
    >
      {/* 关闭 */}
      <button
        className={`${btnBase} absolute right-5 top-5 h-10 w-10 text-xl`}
        onClick={onClose}
      >
        <CloseOutlined />
      </button>

      {/* 下载 */}
      <button
        className={`${btnBase} absolute right-5 top-[68px] h-10 w-10 text-lg`}
        onClick={(e) => { e.stopPropagation(); handleDownload(); }}
      >
        <DownloadOutlined />
      </button>

      {/* 当前视频 */}
      <video
        src={src}
        controls
        autoPlay
        loop
        playsInline
        onClick={(e) => e.stopPropagation()}
        style={{
          maxWidth: "90vw",
          maxHeight: "88vh",
          borderRadius: 8,
          boxShadow: "0 8px 40px rgba(0,0,0,0.5)",
          transform: shown ? "scale(1)" : "scale(0.96)",
          transition: "transform 0.2s ease",
          background: "#000",
        }}
      />
    </div>
  );
}

export default memo(VideoNode);
