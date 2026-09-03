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

/** 静默探测时长：需超过 AUDIO_DECISION_MIN_TIME，保证结论有效 */
const AUDIO_PROBE_DURATION_MS = 300;

/**
 * 静默探测音轨：播放极短一段驱动计数，随后立即复位。
 *
 * 仅在属性无法直接判定（Chrome 系、且尚未播放）时调用。
 * 全过程 mute，不会出声；若自动播放被浏览器策略拒绝，返回 null 交由后端兜底。
 */
export async function probeAudioTrack(
  video: HTMLVideoElement | null,
): Promise<boolean | null> {
  if (!video) return null;
  // 正在播放：无需探测，timeupdate 会自然得出计数
  if (!video.paused) return null;
  // 尚未加载到可播放状态
  if (video.readyState < 2) return null;

  const prevTime = video.currentTime;
  const wasMuted = video.muted;
  video.muted = true;

  try {
    await video.play();
    await new Promise((resolve) => setTimeout(resolve, AUDIO_PROBE_DURATION_MS));
    return detectAudioTrack(video, true);
  } catch {
    // 自动播放被拒：保持未知，由后端在无音轨时给出确定结论
    return null;
  } finally {
    video.pause();
    video.currentTime = prevTime;
    video.muted = wasMuted;
  }
}
