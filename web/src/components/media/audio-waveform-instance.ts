/**
 * 创建只做渲染的 wavesurfer 实例（specs/canvas-audio-peaks-cache.md 规则 4.1 / 2.4）。
 *
 * 节点内波形与截取面板波形只有尺寸、柱参数和主题来源不同，实例契约必须一致：
 * 只传 `{ media, peaks, duration }`，永不传 `url`——绘制不产生任何字节请求，
 * 签名地址轮换也不会重建或重绘实例；`interact: false` 把指针交互留给组件，
 * `cursorWidth: 0` 让组件画自己的进度光标。
 *
 * 省略 `waveColor` 时从容器计算样式取主题前景色，并观察根元素 class 变化重绘
 * （Canvas 不会随 CSS 主题自动重绘，规则九.2）；传入固定色时不做主题观察。
 *
 * 返回清理函数：断开观察者并销毁实例。调用方在 peaks 变化或卸载时调用它。
 * `useAudioWaveformInstance` 把「peaks 就绪才创建」这条硬约束与实例生命周期
 * 收在一处，两个组件不再各写一份 effect。
 */
import { type RefObject, useEffect } from "react";
import WaveSurfer from "wavesurfer.js";

import type { AudioPeaks } from "@/lib/audio-peaks";
import { DEFAULT_NODE_COLOR } from "@/lib/constants";

interface AudioWaveformOptions {
  container: HTMLElement;
  media: HTMLAudioElement;
  /** 已就绪的峰值；视为不可变，创建时复制一份交给 wavesurfer */
  peaks: AudioPeaks;
  /** 波形 canvas 高度（px） */
  height: number;
  /** 固定波形色；省略时跟随容器主题前景色并随主题切换重绘 */
  waveColor?: string;
  barWidth: number;
  barGap: number;
}

function createAudioWaveform(options: AudioWaveformOptions): () => void {
  const { container, media, peaks, height, waveColor: fixedColor, barWidth, barGap } = options;
  const followTheme = fixedColor === undefined;
  let waveColor = fixedColor ?? getComputedStyle(container).color;

  const waveSurfer = WaveSurfer.create({
    container,
    media,
    // 传副本：wavesurfer 的 createBuffer 会就地 normalize，缓存数组视为不可变（规则 2.4）
    peaks: peaks.channels.map((channel) => channel.slice()),
    duration: peaks.duration,
    height,
    // 波形用不透明主题前景色绘制，整体透明度交给 CSS（.canvases 层）控制：
    // 进度层是 source-in 叠加，若 waveColor 自带 alpha 会把进度色一并变淡
    waveColor,
    progressColor: DEFAULT_NODE_COLOR,
    cursorColor: DEFAULT_NODE_COLOR,
    cursorWidth: 0,
    barWidth,
    barGap,
    barRadius: 2,
    interact: false,
  });

  if (!followTheme) return () => waveSurfer.destroy();

  // 只更新颜色，保留波形与播放位置
  const themeObserver = new MutationObserver(() => {
    const nextColor = getComputedStyle(container).color;
    if (nextColor === waveColor) return;
    waveColor = nextColor;
    waveSurfer.setOptions({ waveColor });
  });
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });

  return () => {
    themeObserver.disconnect();
    waveSurfer.destroy();
  };
}

/** 实例的视觉选项：容器、媒体元素与峰值由 Hook 参数传入（类型只服务本模块，不对外导出） */
type AudioWaveformVisualOptions = Omit<AudioWaveformOptions, "container" | "media" | "peaks">;

/**
 * peaks 就绪后才创建实例——硬约束：peaks 未就绪时创建会走全量下载路径（规则 4.4）。
 * 实例生命周期由峰值身份决定：换源时 peaks 变化 → 销毁重建；地址轮换不触碰它。
 * 视觉选项按值参与依赖：调用方传模块常量，值稳定、不触发重建；将来若按值变化，
 * 实例随之重建，而不是静默沿用旧选项。
 */
export function useAudioWaveformInstance(
  containerRef: RefObject<HTMLElement | null>,
  mediaRef: RefObject<HTMLAudioElement | null>,
  peaks: AudioPeaks | null,
  options: AudioWaveformVisualOptions,
): void {
  const { height, waveColor, barWidth, barGap } = options;
  useEffect(() => {
    const container = containerRef.current;
    const media = mediaRef.current;
    if (!container || !media || !peaks) return;
    return createAudioWaveform({ container, media, peaks, height, waveColor, barWidth, barGap });
  }, [containerRef, mediaRef, peaks, height, waveColor, barWidth, barGap]);
}
