/**
 * 音频波形播放器展示组件（基于 wavesurfer.js）。
 *
 * 波形与播放彻底解耦（specs/canvas-audio-peaks-cache.md 规则 4）：
 * - 波形只由峰值渲染：wavesurfer 以 `{ media, peaks, duration }` 创建，永不传 `url`，
 *   因此绘制波形不产生任何字节请求，签名地址轮换也不重建实例、不重绘；
 * - 播放由 `useAudioElement` 持有的 `<audio>` 元素直连访问地址，波形不可用时仍可播放。
 *
 * 就绪时长通过 onReady 向上抛出，供节点标题栏显示。
 */
"use client";

import { useCallback, useEffect, useRef } from "react";

import { PauseIcon } from "@/components/ui/AppIcon";
import { PlayIcon } from "@/components/ui/AppIcon";
import { Button } from "@/components/ui/button";
import { clamp01 } from "@/features/canvas/editing/clip-range";
import { registerAudioPlayer } from "@/features/canvas/shared/audio-playback-registry";
import { useAudioWaveformInstance } from "@/features/canvas/shared/audio-waveform-instance";
import { IDLE_PROGRESS_PLAYBACK } from "@/features/canvas/shared/media-playback";
import { useAudioPeaks } from "@/lib/audio-peaks/use-audio-peaks";
import { DEFAULT_NODE_COLOR } from "@/lib/constants";
import { useAudioElement } from "@/lib/use-audio-element";
import { useMediaPlaybackMirror } from "@/lib/use-media-playback-mirror";
import { useMediaProgress } from "@/lib/use-media-progress";
import { formatTime } from "@/lib/utils/format";

/** 波形绘制高度（wavesurfer canvas），固定上限，不随容器拉伸 */
const WAVEFORM_HEIGHT = 64;

/** 进度竖线高度：刻意高于波形，上下各冒出一截；容器不够高时由 maxHeight 兜底 */
const CURSOR_HEIGHT = 96;

/** 实例视觉选项：模块常量，身份稳定（实例只随 peaks 身份重建） */
const WAVEFORM_OPTIONS = { height: WAVEFORM_HEIGHT, barWidth: 2, barGap: 1 };

interface AudioWaveformProps {
  /** 逻辑引用值（存储 key / 托管 URL / 外部 URL）：峰值与访问地址都由它派生，不是已解析的地址 */
  audioRef: string;
  /** 节点 id：传入即把播放句柄注册进共享注册表，供音频截取面板读取播放位置 / 直接暂停 */
  nodeId?: string;
  /** 截取面板打开期间锁住本节点的播放按钮与进度拖动，避免与面板循环试听双声叠加 */
  clipActive?: boolean;
  /** 已存音频总时长（秒）：仅在峰值与媒体元数据都不可用时用于底部时间显示 */
  duration?: number;
  /** 每个源时长确定后回调一次（秒），供节点回填 data.duration */
  onReady?: (duration: number) => void;
}

/**
 * 基于 wavesurfer.js 的音频波形播放器，参考统一设计：
 * 波形区 + 进度光标 + 底部时间栏与圆形播放按钮。
 *
 * 播放完全自治：按钮直接驱动媒体元素（以 `paused` 为准），图标由媒体事件镜像；
 * 不接收外部播放态——外部暂停走注册表直连，避免「事件 → 状态 → effect → 再调
 * play/pause」双向回环产生播放振荡。
 */
export default function AudioWaveform({
  audioRef,
  nodeId,
  clipActive = false,
  duration = 0,
  onReady,
}: AudioWaveformProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  // 播放元素由 Hook 命令式创建并持有：不进入 React 渲染树、不挂进 DOM（脱离文档仍可播放）
  const { mediaRef, src, mediaFailed, accessFailed, refresh, readTime } = useAudioElement(audioRef);
  const { peaks, duration: peaksDuration, status: peaksStatus } = useAudioPeaks(audioRef);
  const failed = accessFailed || mediaFailed;

  // 播放态按源记账：换源后旧源的进度与元数据在渲染期作废（规则 4.6）；
  // 事件 → 镜像的映射与截取面板共用 `useMediaPlaybackMirror`
  const { mirror: playback, patch: updatePlayback, reportProgress } = useMediaPlaybackMirror(
    mediaRef,
    audioRef,
    IDLE_PROGRESS_PLAYBACK,
  );
  const { playing, progress: current, duration: mediaDuration } = playback;

  // 进度线逐帧跟随播放：timeupdate 只有约 4Hz，播放中改由共享 Hook 读媒体时间；
  // 静止时不产生任何渲染（规则 4.5）。时间源由 useAudioElement 提供（身份稳定），
  // 循环只在播放态切换时重启
  useMediaProgress(readTime, playing, reportProgress);

  // 实例只在 peaks 就绪后创建；生命周期由 peaks 身份决定（换源重建、地址轮换不触碰）
  useAudioWaveformInstance(containerRef, mediaRef, peaks, WAVEFORM_OPTIONS);

  // 注册进共享注册表：截取面板据此暂停节点播放、读取当前播放位置作为选区起点。
  // 句柄由播放元素支撑，波形不可用时同样有效（规则 5.2）
  useEffect(() => {
    const media = mediaRef.current;
    if (!media || !nodeId) return;
    return registerAudioPlayer(nodeId, {
      getCurrentTime: () => media.currentTime,
      pause: () => media.pause(),
    });
  }, [mediaRef, nodeId]);

  // 可播时长只认峰值与媒体元数据（规则 5.3）：节点已存时长不参与可播判断，
  // 否则时长未知时会错误地点亮播放按钮、定位到错误位置
  const knownDuration = peaksDuration ?? (mediaDuration > 0 ? mediaDuration : 0);
  // 上报只在 peaks 落定后：loading 期间媒体元数据只是可播依据，优先级低于 peaks；
  // 提前上报会先用媒体时长写一次、peaks 到达后再写一次（规则 4.6 / 5.3「回调一次」）。
  // null 表示「还不该上报」——0 是合法的时长值，不能兼作哨兵
  const reportableDuration =
    peaksStatus === "loading" ? null : knownDuration > 0 ? knownDuration : null;
  // 底部时间栏的显示时长：两者都不可用时才退回节点已存时长（prop 注释的约定）
  const displayDuration = knownDuration > 0 ? knownDuration : duration;
  // 地址未就绪时元素没有 src，`play()` 只会以 NotSupportedError 拒绝——
  // 播放按钮必须等到真正有地址才可点
  const playable = knownDuration > 0 && !failed && src !== null;

  // 用 ref 保存最新回调，避免把实例生命周期绑到回调身份上
  const onReadyRef = useRef(onReady);
  useEffect(() => {
    onReadyRef.current = onReady;
  }, [onReady]);
  // 上报按源去重：同一组件实例换源后必须重新上报；同一源只上报一次，
  // 避免 peaks 到达后再次回填（规则 4.6 / 5.3）。等值写入由消费方决定，
  // 组件不因 duration prop 已相同而吞掉回调。
  const reportedSourceRef = useRef<string | null>(null);
  useEffect(() => {
    if (reportableDuration === null) return;
    if (reportedSourceRef.current === audioRef) return;
    reportedSourceRef.current = audioRef;
    onReadyRef.current?.(reportableDuration);
  }, [audioRef, reportableDuration]);

  const toggle = useCallback(() => {
    const media = mediaRef.current;
    // 截取面板打开期间节点播放被锁：试听只走面板自己的循环播放
    if (!media || !playable || clipActive) return;
    // 以媒体元素的真实播放态为准取反，直接驱动元素（不绕外部状态）
    if (!media.paused && !media.ended) media.pause();
    else void media.play().catch(() => { /* 真实媒体错误已由 error 事件上报 */ });
  }, [mediaRef, playable, clipActive]);

  // 在波形区按下/拖动即可定位播放进度（进度光标）
  const seekRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);

  const seekFromEvent = useCallback(
    (e: React.PointerEvent) => {
      const media = mediaRef.current;
      const el = seekRef.current;
      if (!media || !el || knownDuration <= 0) return;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0) return;
      const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
      // 定位直接写媒体元素（规则 4.6）；光标立即同步，不等 timeupdate
      media.currentTime = ratio * knownDuration;
      updatePlayback({ progress: ratio * knownDuration });
    },
    [mediaRef, knownDuration, updatePlayback]
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
  const progress = knownDuration > 0 ? clamp01(current / knownDuration) : 0;

  const handleCursorDown = useCallback(
    (e: React.PointerEvent) => {
      if (!playable || clipActive) return;
      e.stopPropagation();
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      draggingRef.current = true;
    },
    [playable, clipActive]
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
            {/* 波形不可用时保持空白（不加静态占位条），播放不受影响 */}
            <div
              ref={containerRef}
              className="audio-waveform w-full"
              style={{ opacity: failed ? 0 : 1, minHeight: WAVEFORM_HEIGHT }}
            />
            {/* 自定义进度竖线：仅在该竖线上切换指针样式并支持拖动 */}
            {playable && (
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
                  style={{ width: 2, background: DEFAULT_NODE_COLOR, borderRadius: 1 }}
                />
              </div>
            )}
          </div>
          {failed && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-xs text-red-400">
              <span>音频加载失败</span>
              {accessFailed && (
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  onClick={() => { void refresh(); }}
                >
                  重试
                </Button>
              )}
            </div>
          )}
        </div>

        {/* 底部控制栏：时间 + 播放按钮 */}
        <div className="relative mt-2 flex items-center px-3">
          <div className="whitespace-nowrap text-sm tabular-nums opacity-70">
            {formatTime(current)} / {formatTime(displayDuration)}
          </div>
          <Button
            type="button"
            variant="secondary"
            size="icon-sm"
            onClick={toggle}
            disabled={!playable || clipActive}
            className="nodrag absolute left-1/2 -translate-x-1/2 rounded-full"
            aria-label={playing ? "Pause" : "Play"}
          >
            {playing ? <PauseIcon /> : <PlayIcon />}
          </Button>
        </div>
      </div>
    </div>
  );
}
