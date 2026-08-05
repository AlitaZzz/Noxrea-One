/**
 * 视频节点（video-node）渲染组件。
 * 内置轻量播放器（播放/暂停、静音、进度条拖拽），支持视频上传与拖入、
 * 生成中状态展示，以及「截取当前帧生成图片节点」操作。
 */
"use client";

import {
  CameraOutlined,
  CaretRightOutlined,
  DeleteOutlined,
  DownloadOutlined,
  PauseCircleOutlined,
  UploadOutlined,
  VideoCameraOutlined,
} from "@ant-design/icons";
import { Handle, type NodeProps,Position } from "@xyflow/react";
import { Input, Popover,Tooltip } from "antd";
import { memo, useCallback, useEffect,useRef, useState } from "react";
import { useEditableTitle } from "@/hooks/use-editable-title";
import { apiUploadWithProgress, BASE } from "@/lib/api";
import { DEFAULT_NODE_HEIGHT,DEFAULT_NODE_WIDTH,EventNames,NODE_HANDLE_TOP,NODE_TITLE_HEIGHT,NODE_TYPE_COLOR, NODE_TYPE, isGenerating } from "@/lib/constants";
import { applyThumbnailSettings, computeNodeSize } from "@/lib/image-utils";
import { createImageNode } from "@/lib/node-defaults";
import { type VideoNode as VideoNodeType,type VideoNodeData } from "@/lib/types/nodes";
import { findFreePosition, markDirtyImmediate, useCanvasStore } from "@/stores/canvas-store";
import { VolumeMuteIcon } from "@/components/common/icons/media/VolumeMuteIcon";
import { VolumeUpIcon } from "@/components/common/icons/media/VolumeUpIcon";
import { useI18nStore } from "@/stores/i18n-store";

function formatTime(s: number): string {
  if (!s || !isFinite(s)) return "0:00";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

function VideoNode({ id, data, selected }: NodeProps<VideoNodeType>) {
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
      const token = localStorage.getItem("noxrea-auth-token") || "";
      const res = await fetch(`${BASE}/api/files/capture-frame`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ video_key: videoKey, time: seekTime }),
      });
      if (!res.ok) return;
      const json = await res.json();
      const imgUrl = json.data?.url;
      if (!imgUrl) return;

      const nw = v.videoWidth, nh = v.videoHeight;
      const node = createImageNode({ x: 0, y: 0 }, imgUrl);
      const label = `${data.alt || t("frame")} #${Math.round(seekTime * 10) / 10}s`;
      applyThumbnailSettings(node, nw, nh, label);
      const w = (node.style?.width as number) ?? 0;
      const h = (node.style?.height as number) ?? 0;
      node.position = findFreePosition({ width: w, height: h });
      addNodes([node]);
    } catch (e) { console.error("Frame capture failed:", e); }
  }, [src, data.alt, addNodes]);

  const handleFile = useCallback(
    async (file: File) => {
      if (!file.type.startsWith("video/")) return;

      // 生成本次上传的版本标记。版本号存储在 node.data.upload.version 中，
      // 撤销/清除时整个 node.data 被替换，版本号自动失效，从而丢弃过期回调。
      const uploadVersion = Date.now();
      const store = useCanvasStore.getState();
      const nodeBefore = store.nodes.find((n) => n.id === id);
      if (nodeBefore) {
        // 立即进入 uploading 状态，让节点进度条出现（与拖到画布路径一致）
        store.updateNodeData(
          id,
          { upload: { uploading: true, progress: 0, version: uploadVersion } },
          undefined,
          { skipHistory: true }
        );
      }

      try {
        const formData = new FormData();
        formData.append("file", file);
        const json = await apiUploadWithProgress<{ url: string }>(
          "/api/files/upload?category=videos",
          formData,
          (pct) => {
            // 上传进度回传，更新进度条
            useCanvasStore.getState().updateNodeData(
              id,
              { upload: { uploading: true, progress: pct, version: uploadVersion } },
              undefined,
              { skipHistory: true }
            );
          }
        );
        if (json.code === 200 && json.data?.url) {
          const url = json.data.url;
          const s = useCanvasStore.getState();
          const currentNode = s.nodes.find((n) => n.id === id);
          if (!currentNode) return;
          // 异步回调时校验：节点存在且版本号匹配（未被撤销/重置）
          if ((currentNode.data as VideoNodeData).upload?.version !== uploadVersion) return;

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
          const latestData = currentNode.data as VideoNodeData;
          // 上传完成：清空 upload（进度条消失），写回视频主信息
          window.dispatchEvent(
            new CustomEvent(EventNames.NODE_UPDATE_DATA, {
              detail: {
                nodeId: id,
                data: { ...latestData, src: url, label: file.name, alt: file.name, naturalWidth: nw, naturalHeight: nh, upload: undefined },
                style: { width, height },
                immediate: true,
              },
            })
          );
        } else {
          // 后端返回非 200：清除 uploading 状态，避免卡在"上传中"
          const s = useCanvasStore.getState();
          const currentNode = s.nodes.find((n) => n.id === id);
          if (currentNode && (currentNode.data as VideoNodeData).upload?.version === uploadVersion) {
            s.updateNodeData(id, { upload: undefined }, undefined, { skipHistory: true });
          }
        }
      } catch (e) {
        console.error("Video upload failed:", e);
        // 失败时清除 uploading 状态（进度条消失），避免卡在"上传中"
        const s = useCanvasStore.getState();
        const currentNode = s.nodes.find((n) => n.id === id);
        if (currentNode && (currentNode.data as VideoNodeData).upload?.version === uploadVersion) {
          s.updateNodeData(id, { upload: undefined }, undefined, { skipHistory: true });
        }
      }
    },
    [id]
  );

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

  const handleClear = useCallback(() => {
    setSrc("");
    useCanvasStore.getState().updateNodeData(id, {
      src: "", label: "", alt: "", naturalWidth: 0, naturalHeight: 0,
      upload: undefined,
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
  }, [id, handleDownload, handleClear, captureFrame]);

  const { editing: editingTitle, draft: titleDraft, setDraft: setTitleDraft, handleDblClick: handleTitleDblClick, handleSave: handleTitleSave } =
    useEditableTitle(id, data.alt || data.label || t("video.node"), { syncAlt: true });

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
            {data.label || data.alt || t("video.node")}
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
          ${isDragOver ? "node-drag-over" : ""}
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
        {data.upload?.uploading ? (
          <div className="w-full h-full relative flex flex-col items-center justify-center gap-2 px-8" style={{ background: "var(--canvas-bg)", borderRadius: 8 }}>
            {data.upload?.progress != null ? (
              <div className="w-3/4 h-1.5 bg-white/10 rounded-full overflow-hidden">
                <div className="h-full bg-blue-500 rounded-full transition-all duration-300" style={{ width: `${data.upload.progress}%` }} />
              </div>
            ) : (
              <div className="w-3/4 h-1.5 bg-white/10 rounded-full overflow-hidden">
                <div className="h-full bg-blue-500 rounded-full animate-pulse" style={{ width: "60%" }} />
              </div>
            )}
            <span className="text-sm text-white/70 font-medium">{t("uploading")}</span>
          </div>
        ) : isGenerating(data.taskBinding) ? (
          <div className="w-full h-full relative flex flex-col items-center justify-center gap-2" style={{ background: "var(--canvas-bg)", borderRadius: 8 }}>
            <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
            <span className="text-sm text-white/70 font-medium">{t("generating")}</span>
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
                  <VolumeMuteIcon style={{ color: "#fff", width: 24, height: 24 }} />
                ) : (
                  <VolumeUpIcon style={{ color: "#fff", width: 24, height: 24 }} />
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
            <button className="node-upload-btn nodrag flex items-center gap-2 px-6 py-3 rounded-lg text-base"
              onClick={() => {
                const input = document.createElement("input");
                input.type = "file";
                input.accept = "video/*";
                input.onchange = (e) => {
                  const file = (e.target as HTMLInputElement).files?.[0];
                  if (file) handleFile(file);
                };
                input.click();
              }}>
              <UploadOutlined className="text-lg" /> {t("upload")}
            </button>
          </div>
        )}
      </div>

      <Handle type="target" position={Position.Left} style={{ width: 10, height: 10, background: NODE_TYPE_COLOR[NODE_TYPE.VIDEO], top: NODE_HANDLE_TOP }} />
      <Handle type="source" position={Position.Right} style={{ width: 10, height: 10, background: NODE_TYPE_COLOR[NODE_TYPE.VIDEO], top: NODE_HANDLE_TOP }} />
    </div>
  );
}

export default memo(VideoNode);
