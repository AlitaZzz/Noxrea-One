/**
 * 截取面板轨道时长的统一口径。
 *
 * 雪碧图时长由服务端按可解码内容计算，优先使用；雪碧图失败时浏览器读到的
 * 原视频标称值不可信（截断文件会虚报），改用代理的真实时长——代理只含可解码
 * 内容，且正是正在播放的实体。代理时长未知（转码中 / 失败 / 非 key 源）时按 0
 * 处理，面板保持禁用。
 */
export function resolveTrackDuration(
  durationSource: "sprite" | "fallback" | null,
  spriteDuration: number,
  proxyDuration: number | null,
): number {
  return durationSource === "fallback" ? proxyDuration ?? 0 : spriteDuration;
}
