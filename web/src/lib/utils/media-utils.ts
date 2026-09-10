/**
 * 媒体能力探测（纯工具，无框架依赖）。
 */

/** 浏览器私有的音轨探测字段。各引擎实现不一，按能力逐个降级，故统一走宽松类型 */
interface AudioProbeElement {
  mozHasAudio?: boolean;
  webkitAudioDecodedByteCount?: number;
  audioTracks?: { length: number };
}

/**
 * 探测视频是否包含音轨。
 *
 * 浏览器没有统一 API，按可靠性依次降级：
 * - Firefox：`mozHasAudio`，加载元数据后立即可用
 * - Safari / 开启实验特性的 Chrome：标准 `audioTracks`
 * - Chrome：`webkitAudioDecodedByteCount`（已废弃但仍可用），**必须先解码若干帧才有值**
 *
 * @param video  视频元素
 * @param played 是否已播放过。Chrome 未播放时计数恒为 0，
 *               此时不能判定为「无音轨」，故仅在确认播放过才把 0 当作无音轨。
 * @returns true = 有音轨；false = 无音轨；null = 当前无法确定
 */
export function detectAudioTrack(
  video: HTMLVideoElement | null,
  played = false,
): boolean | null {
  if (!video) return null;

  const probe = video as unknown as AudioProbeElement;

  if (typeof probe.mozHasAudio === "boolean") return probe.mozHasAudio;
  if (probe.audioTracks) return probe.audioTracks.length > 0;

  if (typeof probe.webkitAudioDecodedByteCount === "number") {
    if (probe.webkitAudioDecodedByteCount > 0) return true;
    if (played) return false;
  }

  return null;
}

/**
 * 判定「无音轨」所需的最短已播放时长（秒）。
 * 解码计数为 0 可能是「还没解出音频」而非「没有音轨」，
 * 未播够时长就下结论会误禁用功能入口。
 */
export const AUDIO_DECISION_MIN_TIME = 0.2;

/**
 * 音轨判定只发生在用户交互之后：浏览器属性直读（Firefox / Safari）、播放时补判
 * （Chrome 的解码计数要播放后才可靠），或点「分离音频」时由后端给出确定结论。
 *
 * 刻意不在加载时判定——为拿到 Chrome 的解码计数而播放一小段，会让刷新页面时
 * 每个视频节点都先动一下再停回去。
 */
