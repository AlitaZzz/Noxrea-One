/**
 * 媒体元数据探测。
 * 图片走 sharp 元数据头（不解码整图像素），视频/音频走 ffmpeg 容器信息（只读
 * 头部或全量解码判定完整性），全部 best-effort：拿不到返回 null，由调用方兜底。
 */

import path from "path";
import { localStorage } from "./backends/local";
import { isPathWithinBase } from "@server/core/paths";
import { probeFfmpeg } from "./ffmpeg";

/**
 * 探测图片文件的真实宽高：sharp 只读元数据头，不解码整图像素，开销极小。
 * 拿不到（文件缺失 / 非图片 / 编码不支持）返回 null，由调用方兜底。
 */
export async function probeImageMeta(filePath: string): Promise<MediaDimensions | null> {
  try {
    const sharp = (await import("sharp")).default;
    const meta = await sharp(filePath).metadata();
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

export async function probePersistedMediaMeta(
  storageKey: string,
  mimeType: string,
): Promise<PersistedMediaMeta> {
  const empty: PersistedMediaMeta = { width: null, height: null, duration: null };
  const isImage = mimeType.startsWith("image/");
  const isVideo = mimeType.startsWith("video/");
  const isAudio = mimeType.startsWith("audio/");
  if (!isImage && !isVideo && !isAudio) return empty;
  const filePath = path.resolve(path.join(localStorage.baseDir, storageKey));
  if (!isPathWithinBase(localStorage.baseDir, filePath)) return empty;
  try {
    if (isImage) {
      const dims = await probeImageMeta(filePath);
      return dims ? { ...empty, width: dims.width, height: dims.height } : empty;
    }
    if (isVideo) {
      const meta = await probeVideoMetaCached(filePath);
      return {
        width: meta?.width ?? null,
        height: meta?.height ?? null,
        duration: meta?.duration ?? null,
      };
    }
    return { ...empty, duration: await probeAudioDuration(filePath) };
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
export async function probeVideoMeta(videoPath: string): Promise<VideoMeta | null> {
  // 只给 -i 不给输出文件：ffmpeg 会带错误码退出，但流信息照常打到 stderr
  const { stderr, spawnFailed } = await probeFfmpeg(
    ["-i", videoPath],
    FFMPEG_PROBE_TIMEOUT_MS,
    { stage: "video_probe" }
  );
  if (spawnFailed) return null;

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
 * ffmpeg 只是白白多 spawn 一个进程。这里按路径缓存，命中直接返回。
 * 存储键由内容哈希派生（同一路径的文件内容不会变），因此不存在陈旧问题；
 * 条目数上限只是防止长跑进程下 Map 无界增长。
 */
const metaCache = new Map<string, VideoMeta | null>();
/** 缓存条目上限：超出后整体清空，宁可重新探测也不让 Map 无限增长 */
const META_CACHE_MAX = 512;

export function probeVideoMetaCached(videoPath: string): Promise<VideoMeta | null> {
  const cached = metaCache.get(videoPath);
  if (cached !== undefined) return Promise.resolve(cached);

  return probeVideoMeta(videoPath).then((meta) => {
    if (metaCache.size >= META_CACHE_MAX) metaCache.clear();
    metaCache.set(videoPath, meta);
    return meta;
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
 * 完整性校验结果缓存。雪碧图与代理两条路由都可能问询，同一次全量解码的结果
 * 按路径共享；条目上限沿用 META_CACHE_MAX 的整体清空策略。
 */
const integrityCache = new Map<string, VideoIntegrity>();

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
  declaredDuration: number
): Promise<VideoIntegrity> {
  const cached = integrityCache.get(videoPath);
  if (cached) return cached;

  // 只要视频流：截断影响的是帧数据，音轨解码对判定没有意义还拖慢速度
  const { stderr, killed, spawnFailed } = await probeFfmpeg(
    ["-i", videoPath, "-an", "-sn", "-dn", "-f", "null", "-"],
    FFMPEG_INTEGRITY_TIMEOUT_MS,
    { stage: "video_integrity" }
  );

  // 超时被杀（progress 停点不代表文件边界）或进程未启动：无法判定
  const result: VideoIntegrity =
    killed || spawnFailed
      ? { decodableDuration: null, truncated: false }
      : (() => {
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

  if (integrityCache.size >= META_CACHE_MAX) integrityCache.clear();
  integrityCache.set(videoPath, result);
  return result;
}
