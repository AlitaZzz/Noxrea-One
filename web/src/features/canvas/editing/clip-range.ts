/**
 * 片段截取面板（视频 / 音频）共享的区间常量与纯函数。
 * 以无副作用的时间轴数学为主，另含唯一的 DOM 测量助手（指针横坐标 → 轨道比例）；
 * 交互逻辑分属各面板（视频走雪碧图+代理，音频走 wavesurfer）。
 */

import { SEEK_MARGIN_S } from "@/lib/constants";

/** 最小区间（s）：拖动与键盘步进都被钳住，防止截出过短片段 */
export const MIN_RANGE_S = 0.5;
/** 初始区间时长：片长的 20%，钳在 [1s, 30s]——短视频不至于一选选走大半部，
    长视频的默认选区也不至于窄到看不清（8 分钟片 5s 只占 1%） */
const INITIAL_RANGE_RATIO = 0.2;
const INITIAL_RANGE_MIN_S = 1;
const INITIAL_RANGE_MAX_S = 30;

/** 选区长度（秒）是否达到最小区间：循环回跳/续播的门槛与确认按钮共用，
    集中在此防止各处容差写法漂移 */
export function isRangeLongEnough(inTime: number, outTime: number): boolean {
  return outTime - inTime >= MIN_RANGE_S - 1e-6;
}

/** 播放位置（秒）是否越出循环区间：越过出点，或入点被拖到播放位置之前
    （SEEK_MARGIN_S 容差吸收 seek 精度，避免贴着入点时来回折跳） */
export function isOutsideLoopRange(currentTime: number, inTime: number, outTime: number): boolean {
  return currentTime >= outTime || currentTime < inTime - SEEK_MARGIN_S;
}

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** band 整段平移的入点钳制：时长不变的平移整体落在 [0,1] 内。
    视频/音频两面板共用同一公式（从各面板的轨道事件换算而来） */
export function clampBandPan(startIn: number, delta: number, bandWidth: number): number {
  return Math.min(Math.max(0, startIn + delta), 1 - bandWidth);
}

/** 指针横坐标 → 轨道内比例 [0,1]；轨道不可测（宽度 0 / 元素缺失）时返回 null */
export function ratioFromClientX(el: HTMLElement | null, clientX: number): number | null {
  if (!el) return null;
  const rect = el.getBoundingClientRect();
  if (rect.width <= 0) return null;
  return clamp01((clientX - rect.left) / rect.width);
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
