/**
 * 片段截取面板（视频 / 音频）共享的区间常量与纯函数。
 * 只含无副作用的时间轴数学，交互逻辑分属各面板（视频走雪碧图+代理，
 * 音频走 wavesurfer）。
 */

/** 最小区间（s）：拖动与键盘步进都被钳住，防止截出过短片段 */
export const MIN_RANGE_S = 0.5;
/** 初始区间时长：片长的 20%，钳在 [1s, 30s]——短视频不至于一选选走大半部，
    长视频的默认选区也不至于窄到看不清（8 分钟片 5s 只占 1%） */
const INITIAL_RANGE_RATIO = 0.2;
const INITIAL_RANGE_MIN_S = 1;
const INITIAL_RANGE_MAX_S = 30;

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * 计算初始选区：起点在打开时的播放位置，时长为片长 20%（钳 [1s, 30s]）；
 * 贴尾部放不下时整段左滑贴齐片尾。初始化 effect 与「资源就绪前的预览渲染」
 * 共用同一公式，保证预览画出的选区和初始化落下的选区完全一致、无缝接管。
 */
export function computeInitialRange(duration: number, startPos: number): { inR: number; outR: number } {
  const minRangeRatio = MIN_RANGE_S / duration;
  const start = clamp01(startPos / duration);
  const rangeRatio =
    Math.min(INITIAL_RANGE_MAX_S, Math.max(INITIAL_RANGE_MIN_S, duration * INITIAL_RANGE_RATIO)) /
    duration;
  const outR = Math.min(1, start + rangeRatio);
  const inR = Math.max(0, outR - rangeRatio);
  // 极短音视频（时长不足最小区间）：钳到末尾，rangeValid 自然为 false、确认禁用
  if (outR - inR < minRangeRatio) {
    return { inR: Math.max(0, 1 - minRangeRatio), outR: 1 };
  }
  return { inR, outR };
}
