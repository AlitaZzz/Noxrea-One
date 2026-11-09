/**
 * 视频节点底部播放控件条：进度、播放 / 暂停、音量。
 * 进度与时长从当前会话视频元素的事件读取，命令式 seek 走 videoRef。
 */
"use client";

import { memo, useCallback, useEffect, useState } from "react";

import {
  PauseIcon,
  PlayIcon,
  VolumeMuteIcon,
  VolumeUpIcon,
} from "@/components/ui/AppIcon";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { formatTime } from "@/lib/utils/format";

export interface VideoControlsProps {
  /** 当前会话视频元素（元素身份变化时监听器随之重挂，重试重挂后控件照常工作） */
  video: HTMLVideoElement | null;
  /** 命令式写入通道（seekTo 改 currentTime）；与 video 指向同一元素 */
  videoRef: { current: HTMLVideoElement | null };
  visible: boolean;
  panelOpen: boolean;
  playing: boolean;
  volume: number;
  hasAudio: boolean;
  togglePlay: () => void;
  toggleMute: () => void;
  applyVolume: (value: number) => void;
}

const VideoControls = memo(function VideoControls({
  video,
  videoRef,
  visible,
  panelOpen,
  playing,
  volume,
  hasAudio,
  togglePlay,
  toggleMute,
  applyVolume,
}: VideoControlsProps) {
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);

  useEffect(() => {
    if (!video) return;
    const sync = () => setProgress(video.currentTime || 0);
    const syncDuration = () => {
      setDuration(Number.isFinite(video.duration) ? video.duration : 0);
      sync();
    };
    syncDuration();
    video.addEventListener("timeupdate", sync);
    video.addEventListener("seeked", sync);
    video.addEventListener("loadedmetadata", syncDuration);
    return () => {
      video.removeEventListener("timeupdate", sync);
      video.removeEventListener("seeked", sync);
      video.removeEventListener("loadedmetadata", syncDuration);
    };
  }, [video]);

  const seekTo = useCallback((value: number) => {
    const video = videoRef.current;
    if (!video || !duration) return;
    const time = Math.max(0, Math.min(duration, value));
    video.currentTime = time;
    setProgress(time);
  }, [duration, videoRef]);

  return (
    <div className={`nodrag absolute bottom-4 left-0 right-0 z-10 flex flex-col gap-2 px-2 video-controls-bar ${visible || panelOpen ? "opacity-100" : "opacity-0 group-hover/body:opacity-100"} transition-opacity`}>
      <Slider
        min={0}
        max={duration || 1}
        step={0.01}
        value={[Math.min(progress, duration || 1)]}
        disabled={!duration}
        aria-label="Video progress"
        className="h-3 w-full"
        onPointerDown={(event) => event.stopPropagation()}
        onValueChange={([value]) => seekTo(value)}
      />
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="video-control-btn shrink-0 text-white hover:text-white/80"
            onClick={(event) => { event.stopPropagation(); togglePlay(); }}
            aria-label={playing ? "pause" : "play"}
          >
            {playing ? <PauseIcon className="size-5" /> : <PlayIcon className="size-5" />}
          </Button>
          <span className="text-sm text-white flex-shrink-0 tabular-nums">
            {formatTime(progress)} / {formatTime(duration)}
          </span>
        </div>
        {hasAudio && <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="video-control-btn shrink-0 text-white hover:text-white/80"
            onClick={(event) => { event.stopPropagation(); toggleMute(); }}
            aria-label={volume === 0 ? "unmute" : "mute"}
          >
            {volume === 0 ? <VolumeMuteIcon className="text-xl" /> : <VolumeUpIcon className="text-xl" />}
          </Button>
          <Slider
            min={0}
            max={1}
            step={0.01}
            value={[volume]}
            aria-label="Volume"
            className="h-3 w-20"
            onPointerDown={(event) => event.stopPropagation()}
            onValueChange={([value]) => applyVolume(value)}
          />
        </div>}
      </div>
    </div>
  );
});

export default VideoControls;
