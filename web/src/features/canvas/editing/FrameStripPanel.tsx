/**
 * 视频帧序列面板。
 *
 * 打开时抽取整条轨道的缩略图，用户拖动播放头（或点击某一格）定位到目标帧，
 * 点「截取」才真正抽帧——时间通过 canvas:node-action 事件交给 VideoNode，
 * 复用既有的后端抽帧与派生节点创建链路。
 *
 * 挂载位置由 InfiniteCanvas 用 RfNodeToolbar(Position.Bottom) 决定：
 * 浮在节点下方居中，且不随画布缩放，轨道尺寸始终稳定。
 */
"use client";

import { X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { useFrameThumbnails } from "@/features/canvas/hooks/use-frame-thumbnails";
import { getVideoPlaybackTime, pauseVideo } from "@/features/canvas/shared/video-playback-registry";
import { EventNames } from "@/lib/constants";
import { formatTime } from "@/lib/utils/format";

interface FrameStripPanelProps {
  nodeId: string;
  videoSrc: string;
  onClose: () => void;
}

function FrameStripPanel({ nodeId, videoSrc, onClose }: FrameStripPanelProps) {
  const { t } = useTranslation();
  const { frames, frameWidth, duration, extracted, status } = useFrameThumbnails(videoSrc);
  const trackRef = useRef<HTMLDivElement>(null);
  // 打开瞬间的播放位置作为播放头初始位置，之后不再随节点播放变化
  const initialTimeRef = useRef<number | null>(null);
  if (initialTimeRef.current === null) initialTimeRef.current = getVideoPlaybackTime(nodeId);
  const [ratio, setRatio] = useState(0);
  const initializedRef = useRef(false);

  // 选帧期间暂停节点播放，避免 hover 播放干扰视觉判断
  useEffect(() => {
    pauseVideo(nodeId);
  }, [nodeId]);

  // 时长就绪后把播放头放到打开时的播放位置（首帧渲染时 duration 仍为 0）
  useEffect(() => {
    if (initializedRef.current || duration <= 0) return;
    initializedRef.current = true;
    setRatio(clamp01((initialTimeRef.current ?? 0) / duration));
  }, [duration]);

  // Esc 关闭：与点击画布空白（取消选中后面板自动卸载）形成一致的退出路径
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const ratioFromClientX = useCallback((clientX: number) => {
    const el = trackRef.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0) return null;
    return clamp01((clientX - rect.left) / rect.width);
  }, []);

  const handleTrackDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const next = ratioFromClientX(e.clientX);
      if (next !== null) setRatio(next);
      const onMove = (ev: PointerEvent) => {
        ev.preventDefault();
        const r = ratioFromClientX(ev.clientX);
        if (r !== null) setRatio(r);
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [ratioFromClientX],
  );

  const frameCount = frames.length;
  const ready = frameCount > 0 && duration > 0;
  const currentTime = ready ? ratio * duration : 0;

  const handleCapture = useCallback(() => {
    if (!ready) return;
    // 末帧留 0.05s 余量：贴着 duration 抽帧可能落到视频结尾之外
    const time = Math.max(0, Math.min(currentTime, duration - 0.05));
    window.dispatchEvent(
      new CustomEvent(EventNames.CANVAS_NODE_ACTION, {
        detail: { nodeId, action: "capture-frame", time },
      }),
    );
    onClose();
  }, [ready, currentTime, duration, nodeId, onClose]);

  return (
    <div className="nodrag nopan nowheel pointer-events-auto flex items-center gap-3">
      <div
        ref={trackRef}
        className="relative h-14 w-250 cursor-ew-resize overflow-visible"
        onPointerDown={handleTrackDown}
      >
        <div className="flex size-full overflow-hidden rounded-xl bg-black/80">
          {ready ? (
            frames.map((src, i) => (
              <button
                key={i}
                type="button"
                className="relative h-full shrink-0 overflow-hidden"
                style={{ width: frameWidth, marginLeft: i === 0 ? 0 : -1 }}
                onClick={() => setRatio((i + 0.5) / frameCount)}
              >
                {src ? (
                  <img
                    alt=""
                    draggable={false}
                    src={src}
                    className="size-full select-none bg-black/80 object-contain object-center"
                  />
                ) : (
                  <span className="block size-full bg-white/5" />
                )}
              </button>
            ))
          ) : (
            <div className="flex size-full items-center justify-center px-4 text-xs text-white/60">
              {status === "error" ? t("capture.unavailable") : t("capture.loading")}
            </div>
          )}
        </div>

        {/* 抽帧进度：贴轨道上方，避免遮挡缩略图 */}
        {status === "extracting" && frameCount > 0 && (
          <div className="pointer-events-none absolute -top-5 right-0 z-20 text-xs tabular-nums text-white/60">
            {t("capture.extracting", { done: extracted, total: frameCount })}
          </div>
        )}

        {/* 播放头：白色圆点 + 竖线，与轨道内侧留 12px 边距 */}
        {ready && (
          <div className="pointer-events-none absolute inset-0 z-20 overflow-visible">
            <div className="absolute inset-x-3 inset-y-0 overflow-visible">
              <div
                className="absolute top-0 h-full -translate-x-1/2"
                style={{ left: `${ratio * 100}%` }}
              >
                <div className="relative h-14 w-4 touch-none">
                  <div className="absolute -top-1 left-1/2 size-4 -translate-x-1/2 rounded-full bg-white shadow-[0_4px_12px_rgba(0,0,0,0.45)]" />
                  <div className="absolute bottom-px left-1/2 top-0.5 w-0.5 -translate-x-1/2 bg-white/95" />
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      <span className="text-sm tabular-nums text-white/70">{formatTime(currentTime)}</span>

      <button
        type="button"
        className="h-9 w-15 rounded-full bg-white text-sm font-medium text-black transition-opacity hover:opacity-90 disabled:opacity-60"
        disabled={!ready}
        onClick={handleCapture}
      >
        {t("capture.confirm")}
      </button>
      <button
        type="button"
        className="flex size-9 items-center justify-center rounded-full border border-white/10 bg-black/60 text-white/60 transition-colors hover:text-white"
        aria-label={t("capture.close")}
        onClick={onClose}
      >
        <X className="size-4" />
      </button>
    </div>
  );
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

export default FrameStripPanel;
