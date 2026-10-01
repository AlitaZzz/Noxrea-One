/**
 * 秒数格式化：59s 内 "12s"，超过 "1m05s"。
 *
 * 生成中浮层与本地处理浮层共用同一套耗时文案样式，故收敛在此，避免各浮层各写一份。
 */
export function formatElapsed(totalSeconds: number): string {
  if (totalSeconds < 60) return `${totalSeconds}s`;
  return `${Math.floor(totalSeconds / 60)}m${String(totalSeconds % 60).padStart(2, "0")}s`;
}
