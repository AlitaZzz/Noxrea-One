/**
 * 视频播放器：与画布视频节点的底部控件同款外观。
 *
 * 复用 .video-controls-scrim / .video-control-btn / .video-controls-bar 三个类，
 * 因此与视频节点的控件栏视觉完全一致（渐变遮罩、进度条、播放/暂停、时间、音量）。
 *
 * 这里是独立实例，不参与视频节点的音轨探测、hover 自动播放与播放注册表，
 * 专供全屏预览这类「用户主动打开」的一次性场景使用。
 *
 * 与节点不同，**默认带声音播放**：节点默认静音是为了 hover 自动播放不扰人，
 * 而预览浮层是用户点按钮主动打开的，有声才是预期。
 * 若被浏览器自动播放策略拦截，自动降级为静音播放并保留「取消静音」入口。
 */
"use client";

import { CaretRightOutlined, PauseOutlined } from "@ant-design/icons";
import { type CSSProperties, useCallback, useEffect, useRef, useState } from "react";

import { VolumeMuteIcon } from "@/components/ui/icons/media/VolumeMuteIcon";
import { VolumeUpIcon } from "@/components/ui/icons/media/VolumeUpIcon";
import { formatTime } from "@/lib/utils/format";

interface Props {
  src: string;
  /** 只用于外层容器的阴影 / 缩放等，尺寸上限由内部 video 自己控制 */
  style?: CSSProperties;
  autoPlay?: boolean;
  loop?: boolean;
  /** 初始音量 0~1，默认 1（有声） */
  defaultVolume?: number;
  /** 填满父容器（父容器需有确定尺寸）；默认按视频自身尺寸并以 88vh/90vw 为上限，用于全屏预览。 */
  fill?: boolean;
}

export default function VideoPlayer({ src, style, autoPlay = true, loop = true, defaultVolume = 1, fill = false }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const seekBarRef = useRef<HTMLDivElement>(null);
  const volumeBarRef = useRef<HTMLDivElement>(null);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(defaultVolume);
  const [lastVolume, setLastVolume] = useState(defaultVolume || 0.5);

  // 音量是唯一真源：state 变化统一回写到元素，静音降级也走这条
  useEffect(() => {
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

  const seekTo = useCallback(
    (clientX: number) => {
      const bar = seekBarRef.current;
      const v = videoRef.current;
      if (!bar || !v || !duration) return;
      const rect = bar.getBoundingClientRect();
      const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      v.currentTime = pct * duration;
      setProgress(v.currentTime);
    },
    [duration],
  );

  const handleSeekDown = useCallback(
    (e: React.PointerEvent) => {
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
    },
    [seekTo],
  );

  const setVolumeFromX = useCallback(
    (clientX: number) => {
      const bar = volumeBarRef.current;
      if (!bar) return;
      const rect = bar.getBoundingClientRect();
      applyVolume((clientX - rect.left) / rect.width);
    },
    [applyVolume],
  );

  const handleVolumeDown = useCallback(
    (e: React.PointerEvent) => {
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
    },
    [setVolumeFromX],
  );

  // 自动播放（默认有声）：被浏览器策略拦截时降级为静音播放，用户点一下即可恢复声音
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !autoPlay) return;
    void v.play().catch(() => {
      setVolume(0);
      setTimeout(() => { void videoRef.current?.play().catch(() => {}); }, 0);
    });
  }, [autoPlay, src]);

  return (
    <div className={`relative${fill ? " w-full h-full" : ""}`} style={style} onClick={(e) => e.stopPropagation()}>
      <video
        ref={videoRef}
        src={src}
        loop={loop}
        muted={volume === 0}
        playsInline
        preload="metadata"
        className={fill ? "block w-full h-full object-contain" : "block max-h-[88vh] max-w-[90vw]"}
        style={{ borderRadius: 8, background: "#000" }}
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
        <div
          ref={seekBarRef}
          className="group/progress relative h-[6px] cursor-pointer rounded-full bg-white/20"
          onPointerDown={handleSeekDown}
        >
          <div
            className="relative h-full rounded-full bg-[var(--canvas-success)] transition-[width] duration-75"
            style={{ width: `${duration ? (progress / duration) * 100 : 0}%` }}
          >
            <div className="absolute -right-[7px] -top-[4px] h-[14px] w-[14px] scale-0 rounded-full bg-white shadow-md transition-transform group-hover/progress:scale-100" />
          </div>
        </div>

        {/* 播放 / 时间 ｜ 音量 + 滑块 */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <button
              className="video-control-btn flex-shrink-0 text-white transition-colors hover:text-white/80"
              onClick={(e) => { e.stopPropagation(); togglePlay(); }}
              style={{ background: "none", border: "none", cursor: "pointer", padding: 0, lineHeight: 1 }}
              aria-label={playing ? "pause" : "play"}
            >
              {playing ? <PauseOutlined style={{ fontSize: 22 }} /> : <CaretRightOutlined style={{ fontSize: 22 }} />}
            </button>
            <span className="flex-shrink-0 text-sm text-white tabular-nums">
              {formatTime(progress)} / {formatTime(duration)}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              className="video-control-btn flex-shrink-0 text-white transition-colors hover:text-white/80"
              onClick={(e) => { e.stopPropagation(); toggleMute(); }}
              style={{ background: "none", border: "none", cursor: "pointer", padding: 0, lineHeight: 1 }}
              aria-label={volume === 0 ? "unmute" : "mute"}
            >
              {volume === 0
                ? <VolumeMuteIcon style={{ color: "#fff", width: 22, height: 22 }} />
                : <VolumeUpIcon style={{ color: "#fff", width: 22, height: 22 }} />}
            </button>
            <div
              ref={volumeBarRef}
              className="group/volume relative h-[6px] w-20 cursor-pointer rounded-full bg-white/20"
              onPointerDown={handleVolumeDown}
            >
              <div
                className="relative h-full rounded-full bg-[var(--canvas-success)] transition-[width] duration-75"
                style={{ width: `${volume * 100}%` }}
              >
                <div className="absolute -right-[7px] -top-[4px] h-[14px] w-[14px] scale-0 rounded-full bg-white shadow-md transition-transform group-hover/volume:scale-100" />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
