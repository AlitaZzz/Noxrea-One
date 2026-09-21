/**
 * 音频波形播放器展示组件（基于 wavesurfer.js）。
 * 负责波形绘制、进度光标与播放按钮：播放完全自治，外部暂停经注册表直连；
 * 就绪时长通过 onReady 向上抛出，供节点标题栏显示。
 */
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import WaveSurfer from "wavesurfer.js";

import { PauseIcon } from "@/components/ui/icons/media/PauseIcon";
import { PlayIcon } from "@/components/ui/icons/media/PlayIcon";
import { clamp01 } from "@/features/canvas/editing/clip-range";
import { registerAudioPlayer } from "@/features/canvas/shared/audio-playback-registry";
import { formatTime } from "@/lib/utils/format";

/** 波形绘制高度（wavesurfer canvas），固定上限，不随容器拉伸 */
const WAVEFORM_HEIGHT = 64;

/** 进度竖线高度：刻意高于波形，上下各冒出一截；容器不够高时由 maxHeight 兜底 */
const CURSOR_HEIGHT = 96;

interface AudioWaveformProps {
  url: string;
  /** 节点 id：传入即把 wavesurfer 实例注册进共享注册表，供音频截取面板读取播放位置 / 直接暂停 */
  nodeId?: string;
  /** 截取面板打开期间锁住本节点的播放按钮与进度拖动，避免与面板循环试听双声叠加 */
  clipActive?: boolean;
  /** 音频总时长（秒），用于底部时间显示 */
  duration?: number;
  /** 波形就绪（音源元数据加载完成）回调，返回时长（秒） */
  onReady?: (duration: number) => void;
}

/**
 * 基于 wavesurfer.js 的音频波形播放器，参考统一设计：
 * 波形区 + 进度光标 + 底部时间栏与圆形播放按钮 + 右上角重新上传。
 *
 * 播放完全自治：按钮直接驱动 wavesurfer（以 isPlaying() 为准），
 * 图标由媒体事件镜像；不接收外部播放态——外部暂停走注册表直连，
 * 避免「事件 → 状态 → effect → 再调 play/pause」双向回环产生播放振荡。
 */
export default function AudioWaveform({
  url,
  nodeId,
  clipActive = false,
  duration = 0,
  onReady,
}: AudioWaveformProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WaveSurfer | null>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [current, setCurrent] = useState(0);
  // wavesurfer 的真实播放态：按钮图标必须镜像实例的真实状态
  const [wsPlaying, setWsPlaying] = useState(false);

  // 用 ref 保存最新回调，避免重建 wavesurfer 实例
  const onReadyRef = useRef(onReady);
  useEffect(() => {
    onReadyRef.current = onReady;
  }, [onReady]);

  // 初始化 / 切换音源
  useEffect(() => {
    if (!containerRef.current) return;
    setReady(false);
    setFailed(false);
    setCurrent(0);
    setWsPlaying(false);

    const ws = WaveSurfer.create({
      container: containerRef.current,
      height: WAVEFORM_HEIGHT,
      // 波形用不透明白色绘制，整体透明度交给 CSS（.canvases 层）控制：
      // 进度层是 source-in 叠加，若 waveColor 自带 alpha 会把进度色一并变淡。
      waveColor: "#ffffff",
      progressColor: "#c7f43d",
      cursorColor: "#c7f43d",
      cursorWidth: 0,
      barWidth: 2,
      barGap: 1,
      barRadius: 2,
      url,
      interact: false,
    });
    wsRef.current = ws;
    // 注册进共享注册表：音频截取面板（画布层）据此直接暂停节点播放、
    // 读取当前播放位置作为选区起点，无需经 React 状态绕行
    const unregister = nodeId ? registerAudioPlayer(nodeId, ws) : undefined;

    ws.on("ready", () => {
      setReady(true);
      onReadyRef.current?.(ws.getDuration());
    });
    ws.on("error", () => setFailed(true));
    ws.on("play", () => setWsPlaying(true));
    ws.on("pause", () => setWsPlaying(false));
    ws.on("finish", () => setWsPlaying(false));
    ws.on("timeupdate", (c: number) => {
      setCurrent(c);
    });

    return () => {
      unregister?.();
      ws.destroy();
      wsRef.current = null;
    };
  }, [url, nodeId]);

  const toggle = useCallback(() => {
    const ws = wsRef.current;
    // 截取面板打开期间节点播放被锁：试听只走面板自己的循环播放
    if (!ws || !ready || failed || clipActive) return;
    // 以实例的真实播放态为准取反，直接驱动实例（不绕外部状态）
    if (ws.isPlaying()) ws.pause();
    else ws.play().catch(() => { /* 真实媒体错误已由 error 事件上报 */ });
  }, [ready, failed, clipActive]);

  // 在波形区按下/拖动即可定位播放进度（进度光标）
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
  const progress = duration > 0 ? clamp01(current / duration) : 0;

  const handleCursorDown = useCallback(
    (e: React.PointerEvent) => {
      if (!ready || failed || clipActive) return;
      e.stopPropagation();
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      draggingRef.current = true;
    },
    [ready, failed, clipActive]
  );

  return (
    <div className="relative h-full w-full">
      {/* 底部留白大于顶部：控制栏（时间 / 播放按钮）不贴节点下沿 */}
      <div className="flex h-full flex-col px-2 pt-2 pb-5">
        {/* 波形区（点击不定位，可拖动节点；仅竖线可拖动定位） */}
        <div
          className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden"
          style={{
            // 背景透明：直接复用节点 body 底色，不再叠一层深灰
            background: "transparent",
            borderRadius: 8,
            padding: "8px 12px",
          }}
        >
          {/* 波形与竖线放在同一个容器里：竖线按百分比定位，
              只有与波形等宽才能和波形时间轴对齐（原先的 px-2 包裹层会让两者错位）。
              容器自身高于波形：波形在其中垂直居中，竖线占满容器高度。 */}
          <div
            ref={seekRef}
            className="relative flex w-full items-center"
            style={{ height: CURSOR_HEIGHT, maxHeight: "100%" }}
          >
            <div
              ref={containerRef}
              className="audio-waveform w-full"
              style={{ opacity: failed ? 0 : 1, minHeight: WAVEFORM_HEIGHT }}
            />
            {/* 自定义进度竖线：仅在该竖线上切换指针样式并支持拖动 */}
            {ready && !failed && (
              <div
                className="absolute top-0 bottom-0 nodrag"
                style={{
                  left: `${progress * 100}%`,
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
                {/* 进度竖线：占满竖线容器，因此高于波形本身 */}
                <div
                  className="absolute left-1/2 top-0 bottom-0 -translate-x-1/2"
                  style={{ width: 2, background: "#c7f43d", borderRadius: 1 }}
                />
              </div>
            )}
          </div>
          {failed && (
            <div className="absolute inset-0 flex items-center justify-center text-xs text-red-400">
              音频加载失败
            </div>
          )}
        </div>

        {/* 底部控制栏：时间 + 播放按钮 */}
        <div className="relative mt-2 flex items-center px-3">
          <div className="whitespace-nowrap text-sm tabular-nums text-white/70">
            {formatTime(current)} / {formatTime(duration)}
          </div>
          <button
              type="button"
              onClick={toggle}
              disabled={!ready || failed || clipActive}
              className="nodrag absolute left-1/2 flex -translate-x-1/2 items-center justify-center gap-0.5 transition-opacity disabled:opacity-50"
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
              {wsPlaying ? (
                <PauseIcon />
              ) : (
                <PlayIcon />
              )}
            </button>
        </div>
      </div>
    </div>
  );
}
