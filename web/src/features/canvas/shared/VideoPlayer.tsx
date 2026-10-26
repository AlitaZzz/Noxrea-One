/**
 * 视频播放器：独立预览场景使用的媒体控件。
 *
 * 复用 .video-controls-scrim / .video-control-btn / .video-controls-bar 三个类，
 * 并使用项目 Button、Slider 组件管理按钮、进度和音量交互。
 *
 * 这里是独立实例，不参与视频节点的音轨探测、hover 自动播放与播放注册表，
 * 专供全屏预览这类「用户主动打开」的一次性场景使用。
 *
 * 与节点不同，**默认带声音播放**：节点默认静音是为了 hover 自动播放不扰人，
 * 而预览浮层是用户点按钮主动打开的，有声才是预期。
 * 若被浏览器自动播放策略拦截，自动降级为静音播放并保留「取消静音」入口。
 */
"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { PauseIcon, PlayIcon } from "@/components/ui/AppIcon";
import { VolumeMuteIcon } from "@/components/ui/AppIcon";
import { VolumeUpIcon } from "@/components/ui/AppIcon";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { useElementMirror } from "@/lib/use-element-mirror";
import { useFileAccessUrl } from "@/lib/use-file-access-url";
import { cn } from "@/lib/utils";
import { formatTime } from "@/lib/utils/format";

import { IDLE_PROGRESS_PLAYBACK } from "./media-playback";

interface Props {
  src: string;
  /** 只用于外层容器的阴影 / 缩放等，尺寸上限由内部 video 自己控制 */
  className?: string;
  autoPlay?: boolean;
  loop?: boolean;
  /** 初始音量 0~1，默认 1（有声） */
  defaultVolume?: number;
  /** 填满父容器（父容器需有确定尺寸）；默认按视频自身尺寸并以 88vh/90vw 为上限，用于全屏预览。 */
  fill?: boolean;
}

export default function VideoPlayer({ src, className, autoPlay = true, loop = true, defaultVolume = 1, fill = false }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [volume, setVolume] = useState(defaultVolume);
  const [lastVolume, setLastVolume] = useState(defaultVolume || 0.5);
  const { url: accessUrl, retrySigned, reloadToken } = useFileAccessUrl(src);
  // 重挂即换元素（key=reloadToken）：新元素暂停在 0，播放态 / 进度 / 时长是旧元素
  // 的镜像，不会收到新元素的事件。不复位就会出现「图标显示暂停、实际在播」或
  // 「进度条停在旧位置」。音量偏好由 ref 回调在元素附着时回写（见 setVideoRef）。
  const [mirror, patchMirror] = useElementMirror(`${reloadToken}:${accessUrl ?? ""}`, IDLE_PROGRESS_PLAYBACK);
  const { playing, progress, duration } = mirror;
  const setPlaying = useCallback((next: boolean) => patchMirror({ playing: next }), [patchMirror]);
  const setProgress = useCallback((next: number) => patchMirror({ progress: next }), [patchMirror]);
  const setDuration = useCallback((next: number) => patchMirror({ duration: next }), [patchMirror]);

  // signed URL 错误先重新描述一次（过期 / 跨窗口），仍失败保持原有静默失败语义；
  // stream / 外部地址重试同一地址不会改变结果。闩锁与重挂令牌由 Hook 统一提供。
  const handleError = useCallback(() => {
    void retrySigned();
  }, [retrySigned]);

  // 音量偏好必须随元素一起落地：reloadToken 重挂会换掉元素，新元素音量回到浏览器
  // 默认 1.0，而 state 里的偏好仍然有效。挂在 ref 回调上而不是依赖列表里——元素
  // 每次附着都回写一次，不依赖 effect 去追元素身份（与 VideoNode 的 setVideoRef 同一做法）
  const volumeRef = useRef(volume);
  const setVideoRef = useCallback((el: HTMLVideoElement | null) => {
    videoRef.current = el;
    if (el) el.volume = volumeRef.current;
  }, []);

  // 音量是唯一真源：state 变化统一回写到元素，静音降级也走这条
  useEffect(() => {
    volumeRef.current = volume;
    const v = videoRef.current;
    if (v) v.volume = volume;
  }, [volume]);

  const applyVolume = useCallback((value: number) => {
    const v = videoRef.current;
    const clamped = Math.max(0, Math.min(1, value));
    if (v) v.volume = clamped;
    setVolume(clamped);
    if (clamped > 0) setLastVolume(clamped);
  }, []);

  /** 静音切换：记住上次非零音量，再次点击恢复 */
  const toggleMute = useCallback(() => {
    applyVolume(volume === 0 ? lastVolume || 0.5 : 0);
  }, [volume, lastVolume, applyVolume]);

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) void v.play().catch(() => {});
    else v.pause();
  }, []);

  const seekTo = useCallback((value: number) => {
    const v = videoRef.current;
    if (!v || !duration) return;
    const time = Math.max(0, Math.min(duration, value));
    v.currentTime = time;
    setProgress(time);
  }, [duration, setProgress]);

  // 自动播放（默认有声）：被浏览器策略拦截时降级为静音播放，用户点一下即可恢复声音。
  // 地址未就绪时元素没有源，play() 会以 NotSupportedError 拒绝——那不是策略拦截，
  // 不能当作拦截去静音（否则地址到达后永远无声）；只有 NotAllowedError 才降级。
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !autoPlay || !accessUrl) return;
    void v.play().catch((error: unknown) => {
      if (!(error instanceof DOMException) || error.name !== "NotAllowedError") return;
      // 直接同步置 DOM muted 再重试：走 setState 等 React 提交会晚一拍，不可靠
      v.muted = true;
      setVolume(0);
      void v.play().catch(() => {});
    });
  }, [autoPlay, accessUrl, reloadToken]);

  return (
    <div className={cn("relative", fill && "h-full w-full", className)} onClick={(e) => e.stopPropagation()}>
      <video
        key={reloadToken}
        ref={setVideoRef}
        src={accessUrl}
        onError={handleError}
        crossOrigin="anonymous"
        loop={loop}
        muted={volume === 0}
        playsInline
        preload="metadata"
        className={cn(
          "rounded-lg bg-black",
          fill ? "block h-full w-full object-contain" : "block max-h-[88vh] max-w-[90vw]",
        )}
        onTimeUpdate={() => { const v = videoRef.current; if (v) setProgress(v.currentTime); }}
        onLoadedMetadata={() => { const v = videoRef.current; if (v) setDuration(v.duration || 0); }}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onContextMenu={(e) => e.preventDefault()}
      />

      {/* 底部渐变遮罩：保证纯白 / 浅色视频下控件可见 */}
      <div className="video-controls-scrim pointer-events-none absolute bottom-0 left-0 right-0 h-24 rounded-b-lg" />

      <div className={`video-controls-bar absolute ${fill ? "bottom-2" : "bottom-4"} left-0 right-0 z-10 flex flex-col gap-2 px-3`}>
        {/* 进度条：已播放部分用品牌色，与视频节点一致 */}
        <Slider
          min={0}
          max={duration || 1}
          step={0.01}
          value={[Math.min(progress, duration || 1)]}
          disabled={!duration}
          aria-label="Video progress"
          className="h-3 w-full"
          onPointerDown={(e) => e.stopPropagation()}
          onValueChange={([value]) => seekTo(value)}
        />

        {/* 播放 / 时间 ｜ 音量 + 滑块 */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="video-control-btn shrink-0 text-white hover:text-white/80"
              onClick={(e) => { e.stopPropagation(); togglePlay(); }}
              aria-label={playing ? "pause" : "play"}
            >
              {playing ? <PauseIcon className="size-5" /> : <PlayIcon className="size-5" />}
            </Button>
            <span className="flex-shrink-0 text-sm text-white tabular-nums">
              {formatTime(progress)} / {formatTime(duration)}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="video-control-btn shrink-0 text-white hover:text-white/80"
              onClick={(e) => { e.stopPropagation(); toggleMute(); }}
              aria-label={volume === 0 ? "unmute" : "mute"}
            >
              {volume === 0
                ? <VolumeMuteIcon className="text-xl" />
                : <VolumeUpIcon className="text-xl" />}
            </Button>
            <Slider
              min={0}
              max={1}
              step={0.01}
              value={[volume]}
              aria-label="Volume"
              className="h-3 w-20"
              onPointerDown={(e) => e.stopPropagation()}
              onValueChange={([value]) => applyVolume(value)}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
