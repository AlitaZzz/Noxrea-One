/**
 * 音频波形播放器展示组件（基于 wavesurfer.js）。
 * 纯受控 UI：负责波形绘制、进度光标与播放按钮，播放态由父组件传入，
 * 通过回调向上抛出进度与就绪时长；另导出通用的时间格式化函数。
 */
"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import WaveSurfer from "wavesurfer.js";
import { PlayIcon } from "@/components/common/icons/media/PlayIcon";
import { PauseIcon } from "@/components/common/icons/media/PauseIcon";

export function formatTime(sec?: number): string {
  const s = Math.max(0, Math.floor(sec || 0));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
}

interface AudioWaveformProps {
  url: string;
  /** 音频总时长（秒），用于底部时间显示 */
  duration?: number;
  /** 外部控制播放/暂停（true = 播放） */
  playing?: boolean;
  onToggle?: (next: boolean) => void;
  /** 进度变化回调（0~1） */
  onProgress?: (progress: number) => void;
  /** 波形就绪（音源元数据加载完成）回调，返回时长（秒） */
  onReady?: (duration: number) => void;
}

/**
 * 基于 wavesurfer.js 的音频波形播放器，参考统一设计：
 * 波形区 + 红色进度光标 + 底部时间栏与圆形播放按钮 + 右上角重新上传。
 */
export default function AudioWaveform({
  url,
  duration = 0,
  playing = false,
  onToggle,
  onProgress,
  onReady,
}: AudioWaveformProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WaveSurfer | null>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [current, setCurrent] = useState(0);

  // 用 ref 保存最新回调，避免重建 wavesurfer 实例
  const onProgressRef = useRef(onProgress);
  onProgressRef.current = onProgress;
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;

  // 初始化 / 切换音源
  useEffect(() => {
    if (!containerRef.current) return;
    setReady(false);
    setFailed(false);
    setCurrent(0);

    const ws = WaveSurfer.create({
      container: containerRef.current,
      height: 64,
      waveColor: "rgba(255,255,255,0.35)",
      progressColor: "rgb(29, 158, 117)",
      cursorColor: "rgb(29, 158, 117)",
      cursorWidth: 0,
      barWidth: 2,
      barGap: 1,
      barRadius: 2,
      url,
      interact: false,
    });
    wsRef.current = ws;

    ws.on("ready", () => {
      setReady(true);
      onReadyRef.current?.(ws.getDuration());
    });
    ws.on("error", () => setFailed(true));
    ws.on("timeupdate", (c: number) => {
      setCurrent(c);
      const d = ws.getDuration();
      if (d > 0) onProgressRef.current?.(c / d);
    });

    return () => {
      ws.destroy();
      wsRef.current = null;
    };
  }, [url]);

  // 同步外部播放状态
  useEffect(() => {
    const ws = wsRef.current;
    if (!ws || !ready) return;
    if (playing) ws.play();
    else ws.pause();
  }, [playing, ready]);

  const toggle = useCallback(() => {
    if (!ready || failed) return;
    onToggle?.(!playing);
  }, [ready, failed, playing, onToggle]);

  // 在波形区按下/拖动即可定位播放进度（红色光标）
  const seekRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);

  const seekFromEvent = useCallback(
    (e: React.PointerEvent) => {
      const ws = wsRef.current;
      const el = seekRef.current;
      if (!ws || !el) return;
      const rect = el.getBoundingClientRect();
      const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
      ws.seekTo(ratio);
    },
    []
  );

  const handleSeekMove = useCallback(
    (e: React.PointerEvent) => {
      if (!draggingRef.current) return;
      e.stopPropagation();
      seekFromEvent(e);
    },
    [seekFromEvent]
  );

  const handleSeekUp = useCallback((e: React.PointerEvent) => {
    draggingRef.current = false;
    (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
  }, []);

  // 竖线（进度光标）位置：仅在竖线上切换指针样式
  const progress = duration > 0 ? Math.min(1, Math.max(0, current / duration)) : 0;

  const handleCursorDown = useCallback(
    (e: React.PointerEvent) => {
      if (!ready || failed) return;
      e.stopPropagation();
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      draggingRef.current = true;
    },
    [ready, failed]
  );

  return (
    <div className="relative h-full w-full">
      <div className="flex h-full flex-col p-2">
        {/* 波形区（点击不定位，可拖动节点；仅竖线可拖动定位） */}
        <div
          ref={seekRef}
          className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden"
          style={{
            background: "rgb(54, 54, 54)",
            borderRadius: 8,
            padding: "8px 0",
          }}
        >
          <div className="w-full px-2">
            <div
              ref={containerRef}
              className="w-full"
              style={{ opacity: failed ? 0 : 1, minHeight: 64 }}
            />
          </div>
          {/* 自定义进度竖线：仅在该竖线上切换指针样式并支持拖动 */}
          {ready && !failed && (
            <div
              className="absolute top-0 bottom-0 nodrag"
              style={{
                left: `calc(${progress * 100}% )`,
                width: 12,
                transform: "translateX(-50%)",
                cursor: "col-resize",
                touchAction: "none",
                zIndex: 5,
              }}
              onPointerDown={handleCursorDown}
              onPointerMove={handleSeekMove}
              onPointerUp={handleSeekUp}
              onPointerCancel={handleSeekUp}
            >
              <div
                className="absolute left-1/2 top-1 bottom-1 -translate-x-1/2"
                style={{ width: 2, background: "rgb(29, 158, 117)", borderRadius: 1 }}
              />
            </div>
          )}
          {failed && (
            <div className="absolute inset-0 flex items-center justify-center text-xs text-red-400">
              音频加载失败
            </div>
          )}
        </div>

        {/* 底部控制栏 */}
        <div className="mt-2 grid grid-cols-3 items-center">
          <div className="justify-self-start text-sm tabular-nums text-white/70">
            {formatTime(current)} / {formatTime(duration)}
          </div>
          <button
            type="button"
            onClick={toggle}
            disabled={!ready || failed}
            className="nodrag flex items-center justify-center gap-0.5 justify-self-center transition-opacity disabled:opacity-50"
            style={{
              width: 24,
              height: 24,
              padding: 0,
              borderRadius: "100%",
              border: "0.5px solid rgb(82, 82, 82)",
              background: "rgba(31, 31, 31, 0.9)",
              boxShadow: "rgba(0,0,0,0.12) 0px 4px 10px 0px, rgba(0,0,0,0.2) 0px 2px 4px 0px",
              backdropFilter: "blur(16px)",
              color: "rgba(255,255,255,0.9)",
              cursor: "pointer",
            }}
          >
            {playing ? (
              <PauseIcon />
            ) : (
              <PlayIcon />
            )}
          </button>
          <div className="justify-self-end text-sm tabular-nums opacity-0" aria-hidden="true">
            {formatTime(current)} / {formatTime(duration)}
          </div>
        </div>
      </div>
    </div>
  );
}
