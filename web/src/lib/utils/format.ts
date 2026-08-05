/**
 * 通用格式化工具。
 * 集中放置与展示相关的纯函数，避免各组件内重复实现（如 formatTime 曾在
 * VideoNode / AudioNode / AudioWaveform 三处各自定义）。
 */

/**
 * 将秒数格式化为 `mm:ss`（分钟与秒均两位补零）。
 * 非法或缺失输入兜底为 `00:00`。
 */
export function formatTime(seconds?: number): string {
  const s = Math.max(0, Math.floor(seconds || 0));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
}
