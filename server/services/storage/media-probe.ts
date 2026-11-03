/**
 * 媒体元数据探测。
 * 图片走 sharp 元数据头（不解码整图像素），视频/音频走 ffmpeg 容器信息（只读
 * 头部或全量解码判定完整性），全部 best-effort：拿不到返回 null，由调用方兜底。
 */

import { mediaSourceInput, resolveMediaSource, type MediaSource } from "./media-source";
import { isVideoExt } from "./formats";
import { extOfName } from "./mime";
import { probeFfmpeg, probeFfmpegDecode } from "./ffmpeg";
import { setBounded } from "@server/core/bounded-cache";
import { runSingleFlight } from "@server/core/single-flight";
import { MediaPoolBusyError } from "./media-pool";
import { logEvent } from "@server/core/logger/utils";
import { logger } from "@server/core/logger";

/**
 * 探测图片的真实宽高：sharp 只读元数据头，不解码整图像素，开销极小。
 * input 为本地路径或 Buffer（S3 探测经 probeSharpInput 拉取）。
 * 拿不到（文件缺失 / 非图片 / 编码不支持）返回 null，由调用方兜底。
 */
export async function probeImageMeta(input: string | Buffer): Promise<MediaDimensions | null> {
  try {
    const sharp = (await import("sharp")).default;
    const meta = await sharp(input).metadata();
    if (meta.width && meta.height) {
      // EXIF orientation 5-8 = 旋转 90° 存储：浏览器按方向显示（宽高互换），
      // 而 metadata 返回未旋转的存储宽高，这里对齐显示语义，否则旋转照片
      // 落库的宽高是横竖颠倒的
      const rotated = meta.orientation !== undefined && meta.orientation >= 5 && meta.orientation <= 8;
      return {
        width: rotated ? meta.height : meta.width,
        height: rotated ? meta.width : meta.height,
      };
    }
    return null;
  } catch {
    return null;
  }
}

/** 真实像素尺寸（媒体探测共用形状） */
export interface MediaDimensions {
  width: number;
  height: number;
}

/**
 * 文件落盘时的媒体元数据探测：按 MIME 分派探测器，一次拿齐宽高与时长。
 * 图片走 sharp 元数据头，视频走 ffmpeg 流信息（带缓存），音频走容器时长。
 * 任何失败都返回全 null——探测是 best-effort，不阻塞落盘主流程。
 */
export interface PersistedMediaMeta {
  width: number | null;
  height: number | null;
  /** 时长（秒），仅视频 / 音频有值 */
  duration: number | null;
}

/**
 * sharp 输入取用：sharp 只接受路径 / Buffer，不接受 URL 字符串。
 * S3 短操作探测把预签名 GET URL 拉成 Buffer（图片体积受上传上限约束，内存可控）。
 */
async function probeSharpInput(source: MediaSource): Promise<string | Buffer> {
  if (source.kind === "path") return source.path;
  const res = await fetch(source.url);
  if (!res.ok) throw new Error(`Probe fetch failed with ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

export async function probePersistedMediaMeta(
  storageKey: string,
  mimeType: string,
): Promise<PersistedMediaMeta> {
  const empty: PersistedMediaMeta = { width: null, height: null, duration: null };
  const isImage = mimeType.startsWith("image/");
  const isVideo = mimeType.startsWith("video/");
  const isAudio = mimeType.startsWith("audio/");
  if (!isImage && !isVideo && !isAudio) return empty;
  try {
    // 探测只读元数据 / 容器头，不值得把远程文件整体下载到工作区：
    // ffmpeg 原生支持 URL 输入（S3 后端经 resolveMediaSource 给预签名 GET）；
    // sharp 不接受 URL，S3 下经 probeSharpInput 拉成 Buffer；本地后端给绝对路径。
    // 探测失败一律静默 empty
    const source = await resolveMediaSource(storageKey);
    const input = mediaSourceInput(source);
    if (isImage) {
      const dims = await probeImageMeta(await probeSharpInput(source));
      return dims ? { ...empty, width: dims.width, height: dims.height } : empty;
    }
    if (isVideo) {
      // 以存储键缓存：S3 预签名 URL 随签名窗口变化，不能作为稳定身份
      const meta = await probeVideoMetaCached(input, storageKey);
      return {
        width: meta?.width ?? null,
        height: meta?.height ?? null,
        duration: meta?.duration ?? null,
      };
    }
    return { ...empty, duration: await probeAudioDuration(input) };
  } catch {
    return empty;
  }
}

/** 探测帧率的超时（ms）：只读取容器信息，正常应在百毫秒内返回 */
const FFMPEG_PROBE_TIMEOUT_MS = 10_000;

/**
 * 探测音频文件时长（spawn ffmpeg 解析容器信息，只读头部）。
 * 拿不到（文件缺失 / 非音频 / 解析失败）返回 null，由调用方兜底。
 */
export async function probeAudioDuration(audioPath: string): Promise<number | null> {
  // 只给 -i 不给输出文件：ffmpeg 会带错误码退出，但容器信息照常打到 stderr
  const { stderr, killed, spawnFailed } = await probeFfmpeg(
    ["-i", audioPath],
    FFMPEG_PROBE_TIMEOUT_MS,
    { stage: "audio_probe" }
  );
  if (killed || spawnFailed) return null;
  const dur = stderr.match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
  const seconds = dur
    ? Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3])
    : NaN;
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

export interface VideoMeta {
  /** 帧率，用于面板的一帧步进 */
  fps: number | null;
  width: number | null;
  height: number | null;
  /** 时长（s），用于雪碧图的等间隔采样；拿不到时调用方需放弃缩略图 */
  duration: number | null;
}

/**
 * 探测视频帧率、分辨率与时长（spawn ffmpeg 解析流信息）。
 *
 * 帧率供帧序列面板「一帧步进」使用——知道真实帧率才能按 1/fps 精确前后移动；
 * 分辨率用于决定代理尺寸：源视频比代理目标小的时候不该被放大；
 * 时长用于雪碧图推算采样间隔，拿不到就无法把格子映射到时间轴。
 * 拿不到就返回 null，由调用方兜底。
 */
export async function probeVideoMeta(videoPath: string, signal?: AbortSignal): Promise<VideoMeta | null> {
  // 只给 -i 不给输出文件：ffmpeg 会带错误码退出，但流信息照常打到 stderr
  const { stderr, killed, spawnFailed } = await probeFfmpeg(
    ["-i", videoPath],
    FFMPEG_PROBE_TIMEOUT_MS,
    { stage: "video_probe", signal }
  );
  // 超时被杀时 stderr 只覆盖到进程被杀前：可能已有视频行却缺 Duration，
  // 按完整结果缓存会把一次瞬时超时固化成永久的半份元数据
  if (killed || spawnFailed) return null;

  const line = stderr
    .split("\n")
    .find((l) => /Stream #\d+:\d+/.test(l) && /Video:/.test(l));
  if (!line) return null;
  const size = line.match(/(\d{2,5})x(\d{2,5})/);
  const fps = line.match(/,\s*([\d.]+)\s+fps,/);
  const parsedFps = fps ? Number(fps[1]) : NaN;
  // 容器时长形如「Duration: 00:00:10.05, start: ...」，音轨行不带该字段，
  // 因此直接在整段 stderr 里找，而不是限定在视频流行内
  const dur = stderr.match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
  const parsedDuration = dur
    ? Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3])
    : NaN;
  return {
    fps: Number.isFinite(parsedFps) && parsedFps > 0 ? parsedFps : null,
    width: size ? Number(size[1]) : null,
    height: size ? Number(size[2]) : null,
    duration: Number.isFinite(parsedDuration) && parsedDuration > 0 ? parsedDuration : null,
  };
}

/**
 * 探测结果缓存。
 *
 * 帧序列面板会同时请求雪碧图与预览代理，两者都要同一次探测结果；各跑一次
 * ffmpeg 只是白白多 spawn 一个进程。缓存键由调用方给出：local 为稳定存储路径；
 * S3 租约的临时下载路径每次请求都不同，必须传稳定的源存储键，否则同一视频在
 * 每次请求都会重新探测（内容键内容不变，不存在陈旧问题）。
 * 负结果只保留短 TTL：内容键下的瞬时探测失败不应在整个进程生命周期内一直命中。
 * 条目数上限只是防止长跑进程下 Map 无界增长。
 */
const META_NEGATIVE_TTL_MS = 60_000;
interface MetaCacheEntry {
  meta: VideoMeta | null;
  at: number;
}
const metaCache = new Map<string, MetaCacheEntry>();
/** 缓存条目上限：超出后整体清空，宁可重新探测也不让 Map 无限增长 */
const META_CACHE_MAX = 512;

/** 条目是否仍可用：正结果永久有效，负结果只在短 TTL 内有效 */
function isUsable(entry: MetaCacheEntry): boolean {
  return entry.meta !== null || Date.now() - entry.at < META_NEGATIVE_TTL_MS;
}

/** 读取已缓存元数据（不触发探测）；未缓存或负缓存已过期返回 null */
export function peekVideoMetaCached(cacheKey: string): VideoMeta | null {
  const cached = metaCache.get(cacheKey);
  if (!cached) return null;
  if (isUsable(cached)) return cached.meta;
  metaCache.delete(cacheKey);
  return null;
}

/**
 * 按稳定内容键缓存视频元数据。videoPath 是本次请求可用的输入（本地路径 /
 * S3 租约临时路径 / 预签名 URL），cacheKey 是内容身份（源存储键）。两者必须
 * 分开传入：S3 输入每次请求都不同，用输入串当缓存键等于永不命中。
 * signal 为本次等待的取消信号：只退出等待，全部等待者都取消才中止探测。
 */
export function probeVideoMetaCached(
  videoPath: string,
  cacheKey: string,
  signal?: AbortSignal,
): Promise<VideoMeta | null> {
  const cached = metaCache.get(cacheKey);
  if (cached && isUsable(cached)) return Promise.resolve(cached.meta);
  if (cached) metaCache.delete(cacheKey);

  // 与完整性探测同口径：同一内容键的并发首次问询共用一次 ffprobe。否则雪碧图与
  // 代理同时首开各起一次探测，晚到的负结果还会把已缓存的正结果盖回 60s。
  return runSingleFlight({
    key: `meta|${cacheKey}`,
    signal,
    generate: async (genSignal) => {
      const meta = await probeVideoMeta(videoPath, genSignal);
      setBounded(metaCache, cacheKey, { meta, at: Date.now() }, META_CACHE_MAX);
      return meta;
    },
  });
}

/** 完整解码校验的超时：与代理转码同量级；超长的视频宁可放弃判定也不无限等 */
const FFMPEG_INTEGRITY_TIMEOUT_MS = 60_000;

export interface VideoIntegrity {
  /** 实际可解码时长（s）；无法判定时为 null */
  decodableDuration: number | null;
  /** 可解码时长明显短于容器声明时长：文件被截断，超出部分是坏数据 */
  truncated: boolean;
}

/**
 * 完整性校验结果缓存。雪碧图与代理两条路由都可能问询；键由稳定内容键与容器
 * 声明时长共同组成——S3 租约的临时路径每次请求不同，不能作为身份；声明时长
 * 改变会改变截断判定，也必须参与键。条目上限沿用 META_CACHE_MAX 的整体清空策略。
 */
const integrityCache = new Map<string, VideoIntegrity>();

function integrityCacheKey(cacheKey: string, declaredDuration: number): string {
  return `${cacheKey}|${declaredDuration}`;
}

/** 读取已缓存的完整性结论（不触发解码）；未缓存返回 null */
export function peekVideoIntegrityCached(cacheKey: string, declaredDuration: number): VideoIntegrity | null {
  return integrityCache.get(integrityCacheKey(cacheKey, declaredDuration)) ?? null;
}

/**
 * 校验视频实际可解码时长（spawn ffmpeg 全量解码到 null）。
 *
 * MP4 的 moov 声明时长与 mdat 实际数据量可以不一致——典型是下载中断的
 * faststart 文件：头部完整声明 8 分钟，媒体数据只落盘了前 20 秒。这类文件
 * 探测（只读 -i）与浏览器都按声明时长显示，但解码到断点即止，雪碧图按声明
 * 时长采样会把超出部分铺满坏帧，代理与播放器的时长也对不上。这里真解码一遍，
 * 取最后的 progress time 作为实际可解码时长，供调用方把时间轴收敛到真实数据
 * 范围（截断只发生在尾部，可解码部分一定是 0 起点的前缀，时间轴无需平移）。
 *
 * 判定容差取 max(1s, 1%)：正常文件解码末点与声明时长相差不到一秒；ffmpeg 对
 * 中途个别损坏包只跳帧不解码（可恢复），不会把这种文件误判成截断。
 * 超时被杀时 progress 停在中途，与截断无法区分，因此超时一律返回「无法判定」。
 */
export async function probeVideoIntegrity(
  videoPath: string,
  declaredDuration: number,
  { owner, timeoutMs = FFMPEG_INTEGRITY_TIMEOUT_MS, signal, cacheKey }: {
    owner: number;
    timeoutMs?: number;
    signal?: AbortSignal;
    /** 稳定内容键；S3 租约临时路径每次请求不同，不能沿用 videoPath */
    cacheKey: string;
  },
): Promise<VideoIntegrity> {
  const cacheId = integrityCacheKey(cacheKey, declaredDuration);
  const cached = integrityCache.get(cacheId);
  if (cached) return cached;

  // 同一视频的并发首次问询（雪碧图 / 上传体检）共用一次全量解码；
  // 超时预算并入键：短预算被杀不写缓存，不能与全预算的结果互相复用
  return runSingleFlight({
    key: `integrity|${cacheId}|${timeoutMs}`,
    signal,
    generate: (genSignal) => decodeIntegrity(videoPath, declaredDuration, timeoutMs, owner, genSignal, cacheId),
  });
}

async function decodeIntegrity(
  videoPath: string,
  declaredDuration: number,
  timeoutMs: number,
  owner: number,
  signal: AbortSignal,
  cacheId: string,
): Promise<VideoIntegrity> {
  // 只要视频流：截断影响的是帧数据，音轨解码对判定没有意义还拖慢速度
  const { stderr, killed, spawnFailed } = await probeFfmpegDecode(
    ["-i", videoPath, "-an", "-sn", "-dn", "-f", "null", "-"],
    timeoutMs,
    { stage: "video_integrity", signal, owner }
  );

  // 超时被杀（progress 停点不代表文件边界）或进程未启动：无法判定。
  // 短预算（上传体检）被杀不写缓存：同文件后续媒体处理仍可用完整预算重试；
  // 全预算超时说明文件本身解码不动，按原有语义缓存，避免反复整段解码。
  if (killed || spawnFailed) {
    const undecidable: VideoIntegrity = { decodableDuration: null, truncated: false };
    if (!killed || timeoutMs >= FFMPEG_INTEGRITY_TIMEOUT_MS) {
      setBounded(integrityCache, cacheId, undecidable, META_CACHE_MAX);
    }
    return undecidable;
  }

  const result: VideoIntegrity = (() => {
    // progress 行的 time= 是最后一个可信的解码位置；解码到断点即止的文件，
    // 它就是实际可解码时长
    const matches = [...stderr.matchAll(/time=(\d+):(\d+):([\d.]+)/g)];
    const last = matches[matches.length - 1];
    const decodable = last
      ? Number(last[1]) * 3600 + Number(last[2]) * 60 + Number(last[3])
      : null;
    const truncated =
      decodable !== null &&
      Number.isFinite(declaredDuration) &&
      declaredDuration - decodable > Math.max(1, declaredDuration * 0.01);
    return { decodableDuration: decodable, truncated };
  })();

  setBounded(integrityCache, cacheId, result, META_CACHE_MAX);
  return result;
}

/** 视频上传体检结论：标称时长 vs 实际可解码时长（截断/损坏时非空） */
export interface VideoUploadWarning {
  declared: number;
  decodable: number;
}

const UPLOAD_VIDEO_PROBE_TIMEOUT_MS = 1_500;

/**
 * 视频上传体检：标称时长 vs 实际可解码时长。
 * 门槛内聚于探测入口：仅视频扩展名的 key 参与体检（key 以内容寻址扩展名结尾），
 * 调用方无需各自预判 isVideoExt。完整探测必须在当前批次返回前结束，
 * 确保并发租约覆盖整个媒体处理成本。
 */
export async function probeUploadVideo(storageKey: string, owner: number): Promise<VideoUploadWarning | undefined> {
  if (!isVideoExt(extOfName(storageKey))) return undefined;
  try {
    // 探测只读容器头 / 解码判定，不值得把远程文件整体下载到工作区：
    // ffmpeg 直接以源为输入（local 后端给存储路径，S3 后端给预签名 GET URL）
    const source = await resolveMediaSource(storageKey);
    const input = mediaSourceInput(source);
    const meta = await probeVideoMetaCached(input, storageKey);
    if (!meta?.duration) return undefined;
    const integrity = await probeVideoIntegrity(input, meta.duration, {
      timeoutMs: UPLOAD_VIDEO_PROBE_TIMEOUT_MS,
      owner,
      cacheKey: storageKey,
    });
    if (!integrity.truncated || !integrity.decodableDuration) return undefined;
    const warning = { declared: meta.duration, decodable: integrity.decodableDuration };
    logEvent("media", { stage: "upload_truncated", video: storageKey, ...warning });
    return warning;
  } catch (err: unknown) {
    // 体检是 best-effort：媒体池过载（池已记录拒绝）按「无法体检」跳过，不使上传失败
    if (!(err instanceof MediaPoolBusyError)) logger.debug({ err, video: storageKey }, "upload probe failed");
    return undefined;
  }
}
