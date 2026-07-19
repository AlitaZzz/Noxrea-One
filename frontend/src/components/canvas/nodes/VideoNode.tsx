"use client";

import { memo, useState, useCallback, useRef, useEffect } from "react";
import { Handle, Position } from "@xyflow/react";
import { Tooltip, Input, Popover } from "antd";
import {
  UploadOutlined,
  VideoCameraOutlined,
  CameraOutlined,
  DeleteOutlined,
  DownloadOutlined,
  PauseCircleOutlined,
  CaretRightOutlined,
} from "@ant-design/icons";
import { useCanvasStore } from "@/stores/canvas-store";
import { createImageNode } from "@/lib/node-defaults";
import { applyThumbnailSettings, computeNodeSize } from "@/lib/image-utils";
import { useI18nStore } from "@/stores/i18n-store";
import { useEditableTitle } from "@/hooks/use-editable-title";
import { apiUpload, BASE } from "@/lib/api";
import { DEFAULT_NODE_WIDTH, DEFAULT_NODE_HEIGHT } from "@/lib/constants";
import { EventNames } from "@/lib/eventNames";

interface VideoNodeData {
  label: string;
  src: string;
  naturalWidth: number;
  naturalHeight: number;
  alt: string;
}

interface VideoNodeProps {
  id: string;
  data: VideoNodeData & { lockAspectRatio?: boolean };
  selected?: boolean;
}

function formatTime(s: number): string {
  if (!s || !isFinite(s)) return "0:00";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

function VideoNode({ id, data, selected }: VideoNodeProps) {
  useI18nStore((s) => s.lang);
  const t = useI18nStore((s) => s.t);
  const [src, setSrc] = useState(data.src || "");
  const [isDragOver, setIsDragOver] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const seekBarRef = useRef<HTMLDivElement>(null);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(true);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  const addNodes = useCanvasStore((s) => s.addNodes);

  // Sync local src when data.src changes externally (e.g. from undo/clear)
  useEffect(() => {
    if (data.src !== src) setSrc(data.src || "");
  }, [data.src]);

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
    if (seekingRef.current) return;
    const v = videoRef.current;
    if (v) setProgress(v.currentTime);
  }, []);
  const onLoadedMeta = useCallback(() => {
    const v = videoRef.current;
    if (v) setDuration(v.duration || 0);
  }, []);

  const seekingRef = useRef(false);

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
    seekingRef.current = true;
    seekTo(e.clientX);
    const onMove = (ev: PointerEvent) => { ev.preventDefault(); seekTo(ev.clientX); };
    const onUp = () => {
      seekingRef.current = false;
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
      const token = localStorage.getItem("noxrea-auth-token") || "";
      const res = await fetch(`${BASE}/api/files/capture-frame`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ url: src, time: seekTime }),
      });
      if (!res.ok) return;
      const json = await res.json();
      const imgUrl = json.data?.url;
      if (!imgUrl) return;

      const st = useCanvasStore.getState();
      const cx = -st.viewport.x / st.viewport.zoom + (window.innerWidth / 2) / st.viewport.zoom;
      const cy = -st.viewport.y / st.viewport.zoom + (window.innerHeight / 2) / st.viewport.zoom;
      const nw = v.videoWidth, nh = v.videoHeight;
      const node = createImageNode({ x: cx, y: cy }, imgUrl);
      const label = `${data.alt || t("frame")} #${Math.round(seekTime * 10) / 10}s`;
      applyThumbnailSettings(node, nw, nh, label);
      // Center the node relative to viewport center
      node.position.x = cx - (node.style.width as number) / 2;
      node.position.y = cy - (node.style.height as number) / 2;
      addNodes([node]);
    } catch (e) { console.error("Frame capture failed:", e); }
  }, [src, data.alt, addNodes]);

  const handleFile = useCallback(
    async (file: File) => {
      if (!file.type.startsWith("video/")) return;
      try {
        const formData = new FormData();
        formData.append("file", file);
        const json = await apiUpload("/api/files/upload?category=videos", formData);
        if (json.code === 200 && json.data?.url) {
          const url = json.data.url;
          setSrc(url);
          const dims = await new Promise<{ w: number; h: number }>((resolve) => {
            const v = document.createElement("video");
            v.preload = "metadata";
            v.onloadedmetadata = () => resolve({ w: v.videoWidth, h: v.videoHeight });
            v.onerror = () => resolve({ w: 0, h: 0 });
            v.src = url;
          });
          const nw = dims.w || 1280;
          const nh = dims.h || 720;
          const { width, height } = computeNodeSize(nw, nh);
          const store = useCanvasStore.getState();
          const currentNode = store.nodes.find((n) => n.id === id);
          const latestData = (currentNode?.data || data) as any;
          window.dispatchEvent(
            new CustomEvent(EventNames.NODE_UPDATE_DATA, {
              detail: {
                nodeId: id,
                data: { ...latestData, src: url, label: file.name, alt: file.name, naturalWidth: nw, naturalHeight: nh },
                style: { width, height },
                immediate: true,
              },
            })
          );
        }
      } catch (e) { console.error("Video upload failed:", e); }
    },
    [id, data]
  );

  const handleReplace = useCallback(() => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "video/*";
    input.onchange = (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (file) handleFile(file);
    };
    input.click();
  }, [handleFile]);

  const handleDownload = useCallback(async () => {
    if (!src) return;
    try {
      const res = await fetch(src);
      if (res.ok) {
        const blob = await res.blob();
        const blobUrl = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = blobUrl;
        a.download = data.alt || "video.mp4";
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(blobUrl);
      }
    } catch {}
  }, [src, data.alt]);

  const handleClear = useCallback(() => {
    setSrc("");
    window.dispatchEvent(
      new CustomEvent(EventNames.NODE_UPDATE_DATA, {
        detail: { nodeId: id, data: { ...data, src: "", label: t("video.node"), alt: "", naturalWidth: 0, naturalHeight: 0 }, style: { width: DEFAULT_NODE_WIDTH, height: DEFAULT_NODE_HEIGHT }, immediate: true },
      })
    );
  }, [id, data]);

  // Listen for node action events from NodeToolbar
  useEffect(() => {
    function onNodeAction(e: Event) {
      const detail = (e as CustomEvent).detail;
      if (detail.nodeId !== id) return;
      switch (detail.action) {
        case "download": handleDownload(); break;
        case "replace": handleReplace(); break;
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
  }, [id, handleDownload, handleReplace, handleClear, captureFrame]);

  const { editing: editingTitle, draft: titleDraft, setDraft: setTitleDraft, handleDblClick: handleTitleDblClick, handleSave: handleTitleSave } =
    useEditableTitle(id, data.alt || data.label || "", { syncAlt: true });

  const hasVideo = src && src.length > 0;

  return (
    <div className="group relative w-full h-full flex flex-col">
      <div className="flex items-center justify-between px-3 py-1 text-[13px] font-medium text-white/80">
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
            {data.label || data.alt || t("video.node")}
          </span>
        )}
        {hasVideo && data.naturalWidth > 0 && (
          <span className="text-white/30 text-xs whitespace-nowrap ml-2">{data.naturalWidth}×{data.naturalHeight}</span>
        )}
      </div>

      <div
        className={`
          flex-1 flex items-center justify-center overflow-hidden rounded-lg relative group/body
          ${selected ? "outline outline-1 outline-white/30 shadow-lg" : "outline outline-1 outline-white/10"}
          ${isDragOver ? "outline-2 outline-white/50" : ""}
        `}
        style={{ background: hasVideo ? "transparent" : "var(--canvas-bg, #262626)" }}
        onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setIsDragOver(true); }}
        onDragLeave={(e) => { e.preventDefault(); e.stopPropagation(); setIsDragOver(false); }}
        onDrop={(e) => {
          e.preventDefault(); e.stopPropagation(); setIsDragOver(false);
          const file = e.dataTransfer.files?.[0];
          if (file) handleFile(file);
        }}
        onContextMenu={(e) => e.preventDefault()}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
      >
        {(data as any)._uploading ? (
          <div className="w-full h-full relative flex flex-col items-center justify-center gap-2 px-8" style={{ background: "var(--canvas-bg)", borderRadius: 8 }}>
            {(data as any)._uploadProgress != null ? (
              <div className="w-3/4 h-1.5 bg-white/10 rounded-full overflow-hidden">
                <div className="h-full bg-blue-500 rounded-full transition-all duration-300" style={{ width: `${(data as any)._uploadProgress}%` }} />
              </div>
            ) : (
              <div className="w-3/4 h-1.5 bg-white/10 rounded-full overflow-hidden">
                <div className="h-full bg-blue-500 rounded-full animate-pulse" style={{ width: "60%" }} />
              </div>
            )}
            <span className="text-sm text-white/70 font-medium">{t("uploading")}</span>
          </div>
        ) : (data as any)._generating ? (
          <div className="w-full h-full relative flex flex-col items-center justify-center gap-2" style={{ background: "var(--canvas-bg)", borderRadius: 8 }}>
            <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
            <span className="text-sm text-white/70 font-medium">{(data as any)._genStatus || t("generating")}</span>
            {(data as any)._genProgress != null && (
              <div className="w-3/4 h-1 bg-white/10 rounded-full overflow-hidden">
                <div className="h-full bg-blue-500 rounded-full transition-all duration-500" style={{ width: `${(data as any)._genProgress}%` }} />
              </div>
            )}
          </div>
        ) : hasVideo ? (
          <div className="w-full h-full relative">
            <video
              ref={videoRef}
              src={src}
              className="absolute inset-0 w-full h-full rounded-lg"
              loop
              muted={muted}
              playsInline
              onTimeUpdate={onTimeUpdate}
              onLoadedMetadata={onLoadedMeta}
              onEnded={() => setPlaying(false)}
              onContextMenu={(e) => e.preventDefault()}
            />
            {/* 替换按钮 — hover 时显示在内容右上角 */}
            <div className="absolute top-2 right-2 opacity-0 group-hover/body:opacity-100 transition-opacity z-10 nodrag">
              <Tooltip title={t("replace")}>
                <button
                  className="flex items-center justify-center w-7 h-7 rounded-md bg-black/60 hover:bg-black/80 text-white/80 hover:text-white transition-colors"
                  onClick={handleReplace}
                >
                  <UploadOutlined style={{ fontSize: 13 }} />
                </button>
              </Tooltip>
            </div>
            {/* Controls bar */}
            <div className={`nodrag absolute bottom-4 left-0 right-0 z-10 flex items-center gap-2 px-2 ${playing ? "opacity-100" : "opacity-0 group-hover/body:opacity-100"} transition-opacity`}>
              <button
                className="flex-shrink-0 text-white hover:text-white/80 transition-colors"
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
                className="flex-shrink-0 text-white hover:text-white/80 transition-colors"
                onClick={(e) => { e.stopPropagation(); setMuted(!muted); }}
                style={{ background: "none", border: "none", cursor: "pointer", padding: 0, lineHeight: 1 }}
              >
                {muted ? (
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                    <line x1="23" y1="9" x2="17" y2="15" />
                    <line x1="17" y1="9" x2="23" y2="15" />
                  </svg>
                ) : (
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                    <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
                    <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                  </svg>
                )}
              </button>
              <Popover trigger="hover" placement="top"
                content={
                  <div className="flex flex-col p-2 gap-0.5" style={{ margin: -12, background: "var(--canvas-bg)", borderRadius: 8, minWidth: 170 }}>
                    <style>{`.menu-popover-item:hover { background: var(--canvas-bg-hover) !important; }`}</style>
                    <div className="menu-popover-item flex items-center gap-1.5 px-3 py-1.5 rounded cursor-pointer text-sm whitespace-nowrap"
                      style={{ color: "var(--canvas-text)" }}
                      onClick={() => captureFrame(videoRef.current?.currentTime ?? null)}>
                      <CameraOutlined style={{ fontSize: 14 }} />{t("capture.currentFrame")}
                    </div>
                    <div className="menu-popover-item flex items-center gap-1.5 px-3 py-1.5 rounded cursor-pointer text-sm whitespace-nowrap"
                      style={{ color: "var(--canvas-text)" }}
                      onClick={() => captureFrame(0)}>
                      <CameraOutlined style={{ fontSize: 14 }} />{t("capture.firstFrame")}
                    </div>
                    <div className="menu-popover-item flex items-center gap-1.5 px-3 py-1.5 rounded cursor-pointer text-sm whitespace-nowrap"
                      style={{ color: "var(--canvas-text)" }}
                      onClick={() => captureFrame(videoRef.current?.duration ? videoRef.current.duration - 0.1 : 10)}>
                      <CameraOutlined style={{ fontSize: 14 }} />{t("capture.lastFrame")}
                    </div>
                  </div>
                }
              >
                <button
                  className="flex-shrink-0 text-white hover:text-white/80 transition-colors"
                  onClick={(e) => { e.stopPropagation(); captureFrame(videoRef.current?.currentTime ?? null); }}
                  style={{ background: "none", border: "none", cursor: "pointer", padding: 0, lineHeight: 1 }}
                >
                  <CameraOutlined style={{ fontSize: 22 }} />
                </button>
              </Popover>
            </div>

          </div>
        ) : (
          <div className="flex flex-col items-center justify-center gap-2 p-4 text-white/40">
            <VideoCameraOutlined className="text-5xl" />
            <span className="text-base text-center">{t("drop.video")}</span>
            <button className="nodrag flex items-center gap-2 px-6 py-3 rounded-lg text-base text-white/70 hover:text-white hover:bg-white/10 transition-colors" onClick={handleReplace}>
              <UploadOutlined className="text-lg" /> {t("upload")}
            </button>
          </div>
        )}
      </div>

      <Handle type="target" position={Position.Left} style={{ width: 10, height: 10, background: "#13c2c2" }} />
      <Handle type="source" position={Position.Right} style={{ width: 10, height: 10, background: "#13c2c2" }} />
    </div>
  );
}

export default memo(VideoNode);
