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

/**
 * 字节数格式化为人类可读（B/KB/MB/GB），如 `134 KB`、`1.8 MB`。
 * 非法或非正输入返回空串，便于调用方直接省略该段。
 */
export function formatBytes(bytes?: number | null): string {
  if (!bytes || bytes <= 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  const text = i === 0 || v >= 100 ? String(Math.round(v)) : v.toFixed(1);
  return `${text} ${units[i]}`;
}

/** 将毫秒时间戳格式化为 `MM/DD HH:mm`（本地时区），非法输入返回空串 */
export function formatDateTime(ts?: number | null): string {
  if (!ts || ts <= 0) return "";
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
