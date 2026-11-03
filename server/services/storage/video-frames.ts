/**
 * 视频帧产物：截帧、帧序列雪碧图与 scrub 预览代理。
 * 三者都是 ffmpeg 直接产出文件的独立产物，互不依赖；超时与中止由 ffmpeg
 * 统一执行器（ffmpeg.ts）兜底。
 */

import path from "path";
import fs from "fs/promises";
import { z } from "zod";
import type { FrameSelection } from "@noxrea/shared";
import { isAbortError, throwIfAborted, TimeoutError } from "@server/core/abort";
import { setBounded } from "@server/core/bounded-cache";
import { logEvent } from "@server/core/logger/utils";
import { runFfmpegHeavy, runFfmpegLight, runFfprobe, scanFfprobe, type FfprobeScanResult } from "./ffmpeg";

/** ffmpeg 抽帧超时：子进程若挂起会持续持有视频文件句柄，必须兜底杀掉 */
const FFMPEG_TIMEOUT_MS = 30_000;
/** Timeline, packet indexing, corrupt-tail traversal and image output share one deadline. */
const FRAME_CAPTURE_BUDGET_MS = 90_000;

/**
 * 截帧预算耗尽。与单次 ffprobe / ffmpeg 调用的自身超时区分：预算耗尽时已没有
 * 余量做任何降级，必须上抛给路由映射为 504；单次调用超时只是末帧探测失败，
 * 余量尚在，普通时间选择仍可退回普通 seek。
 */
class FrameCaptureBudgetError extends TimeoutError {
  constructor() {
    super("Video frame capture timed out");
  }
}

/** 代理转码超时：整段重编码比抽一帧慢得多，给足时间但仍要兜底 */
const FFMPEG_PROXY_TIMEOUT_MS = 60_000;

/** 雪碧图生成超时：一次解码 + 拼图，比整段转码轻，但长视频仍需兜底 */
const FFMPEG_SPRITE_TIMEOUT_MS = 60_000;

/** 探测不到帧率时的 GOP 回退值（帧）：按 25fps 估算，约合 1 秒 */
const FALLBACK_FPS = 25;

/**
 * 视频流声明时长可用时，只读取末尾这一窗口来定位末帧。
 * 窗口须明显大于常见的帧间隔；极低帧率 / 末帧展示区间更长的 VFR 由全量索引兜底。
 */
const TAIL_READ_WINDOW_S = 2;

/** ffprobe 用 "N/A" 表示容器未声明该字段（Matroska 的视频流时长即是如此） */
const optionalSeconds = z.preprocess(
  (value) => (value === "N/A" ? null : value),
  z.coerce.number().finite().nullish(),
);
const videoTimelineSchema = z.object({
  streams: z.array(z.object({
    time_base: z.string().regex(/^\d+\/[1-9]\d*$/),
    start_time: optionalSeconds,
    duration: optionalSeconds,
  })),
  format: z.object({
    start_time: z.coerce.number().finite().default(0),
    /** 容器总时长；语义随封装格式不同（MP4 为长度，Matroska 为绝对结束时间） */
    duration: optionalSeconds,
  }),
});
const frameProbeSchema = z.object({ best_effort_timestamp: z.number().int().nullish() });
const packetProbeSchema = z.object({ pts: z.number().int().optional(), flags: z.string() });

interface FrameEnd {
  /** 绝对 PTS（time_base 单位） */
  pts: number;
  /** 相对媒体起点（format.start_time）的播放时间（s） */
  time: number;
}

interface TailScan {
  lastTimestamp: number | undefined;
  entryCount: number;
  stderr: string;
  /** ffprobe 退出码；损坏尾巴可能非 0，但已解码出的帧仍然有效 */
  code: number;
}

/**
 * 从指定绝对时间戳（秒）读视频帧到 EOF，返回最后一帧的 PTS。单次扫描，不重试。
 */
async function scanTailFrames(
  videoPath: string,
  cacheKey: string,
  probeArgs: string[],
  startSeconds: number,
  remaining: () => number,
  signal?: AbortSignal,
): Promise<TailScan> {
  let lastTimestamp: number | undefined;
  const outcome = await scanFfprobe([
    ...probeArgs, "-show_frames", "-read_intervals", `${Math.floor(startSeconds * 1e6) / 1e6}%`,
    "-show_entries", "frame=best_effort_timestamp", videoPath,
  ], Math.min(FFMPEG_TIMEOUT_MS, remaining()), {
    signal, stage: "capture_tail", section: "frames", tolerateExitErrors: true,
    onEntry: (entry) => {
      const frame = frameProbeSchema.parse(entry);
      if (typeof frame.best_effort_timestamp === "number") lastTimestamp = frame.best_effort_timestamp;
    },
  });
  return { lastTimestamp, ...outcome };
}

/**
 * GOP 回退路径专用：ffprobe 对「seek 后读至 EOF」的调用存在瞬时空结果缺陷
 * （exit 0、目标 section 为空、无任何 stderr，紧接重试即恢复；实测 ~0.3%/次，
 * 与父进程、卷无关），干净空结果重试一次。
 *
 * 只用于包索引已证实该关键帧存在的路径——那里的干净空结果只能是探测缺陷，
 * 不可能是合法内容。时长锚点快路径不走这里：容器时长可能落在视频末帧之后，
 * 锚点窗口读到 EOF 为空是合法结果，重试只会白跑一次解码；直接退回包索引即可。
 * 损坏尾巴的扫描带解码错误 stderr 且可能非 0 退出，不重试。
 */
async function scanTailFramesWithRetry(
  videoPath: string,
  cacheKey: string,
  probeArgs: string[],
  startSeconds: number,
  remaining: () => number,
  signal?: AbortSignal,
): Promise<TailScan> {
  const first = await scanTailFrames(videoPath, cacheKey, probeArgs, startSeconds, remaining, signal);
  if (first.entryCount !== 0 || first.stderr !== "") return first;
  // 日志只记稳定内容键：S3 direct 下 videoPath 是预签名 URL，basename 带查询串
  logEvent("media", { stage: "capture_tail_empty_retry", video: cacheKey });
  return scanTailFrames(videoPath, cacheKey, probeArgs, startSeconds, remaining, signal);
}

/**
 * 定位并解码视频末尾的最后一帧。
 *
 * 有可用时长锚点时，直接从锚点前的窗口读到 EOF：ffprobe 会从锚点之前的关键帧
 * 解码到末尾，成本与视频总长无关。视频流时长优先（最准确），流时长缺失时退回
 * 容器时长（Matroska 常见）。锚点缺失或读不到帧（截断 / 元数据不一致）时，
 * 退回全量包索引，从最后一个关键帧开始向前逐个 GOP 尝试——这条路径不依赖时长
 * 元数据，是截断文件也能取到最后一个可解码帧的原因。
 */
async function lastVideoFrame(
  videoPath: string,
  cacheKey: string,
  remaining: () => number,
  signal?: AbortSignal,
): Promise<FrameEnd> {
  const probeArgs = ["-v", "error", "-select_streams", "v:0", "-of", "json"];
  const index = videoTimelineSchema.parse(await runFfprobe([
    ...probeArgs, "-show_entries", "stream=time_base,start_time,duration:format=start_time,duration", videoPath,
  ], Math.min(FFMPEG_TIMEOUT_MS, remaining()), { signal, stage: "capture_timeline" }));
  const stream = index.streams[0];
  if (!stream) throw new Error("No decoded video frame available");
  const [numerator, denominator] = stream.time_base.split("/").map(Number);
  const timeBase = numerator / denominator;
  const frameEnd = (lastTimestamp: number): FrameEnd => ({
    pts: lastTimestamp,
    time: lastTimestamp * timeBase - index.format.start_time,
  });

  // 锚点只需落在末帧附近：-read_intervals 会从锚点之前的关键帧解码到 EOF，
  // 锚点略早不影响取到真正的末帧，只影响解码量。优先用视频流时长（最准确）；
  // Matroska 的流时长常为 N/A，退回容器时长——它可能把更长的音轨算进来，锚点
  // 落在视频末帧之后超过 TAIL_READ_WINDOW_S 时尾段读不到帧，退回全量包索引；
  // 结果仍正确，代价是一次不依赖解码的包扫描。
  const streamEnd = stream.duration !== null && stream.duration !== undefined && stream.duration > 0
    ? (stream.start_time ?? index.format.start_time) + stream.duration
    : null;
  const anchor = streamEnd
    ?? (index.format.duration !== null && index.format.duration !== undefined && index.format.duration > 0
      ? index.format.duration
      : null);
  if (anchor !== null) {
    // 锚点窗口的干净空结果可能是合法内容（锚点落在视频末帧之后），不重试；
    // 读不到帧就直接进入下面的包索引路径
    const tail = await scanTailFrames(
      videoPath, cacheKey, probeArgs, Math.max(0, anchor - TAIL_READ_WINDOW_S), remaining, signal,
    );
    if (tail.lastTimestamp !== undefined) return frameEnd(tail.lastTimestamp);
  }

  // Demux packet headers without decoding the video, then decode only the final GOP.
  const keyframes: number[] = [];
  const indexScan = await scanFfprobe([
    ...probeArgs, "-show_packets", "-show_entries", "packet=pts,flags", videoPath,
  ], Math.min(FFMPEG_SPRITE_TIMEOUT_MS, remaining()), {
    signal, stage: "capture_keyframes", section: "packets", tolerateExitErrors: true,
    onEntry: (entry) => {
      const packet = packetProbeSchema.parse(entry);
      if (packet.pts !== undefined && packet.flags.includes("K")) keyframes.push(packet.pts);
    },
  });
  if (!keyframes.length) throw noFrameError(indexScan);
  let lastTail: TailScan | undefined;
  for (let i = keyframes.length - 1; i >= 0; i--) {
    // An indexed key packet may be truncated. Search the preceding GOP only if no frame decoded.
    lastTail = await scanTailFramesWithRetry(
      videoPath, cacheKey, probeArgs, keyframes[i] * timeBase, remaining, signal,
    );
    if (lastTail.lastTimestamp !== undefined) return frameEnd(lastTail.lastTimestamp);
  }
  throw noFrameError(lastTail ?? indexScan);
}

/** 没有可解码帧时保留 ffprobe 的退出码与诊断；正常退出则给出内容侧结论 */
function noFrameError(scan: Pick<FfprobeScanResult, "code" | "stderr">): Error {
  return scan.code !== 0
    ? new Error(`ffprobe exited with code ${scan.code}: ${scan.stderr.slice(-200)}`)
    : new Error("No decoded video frame available");
}

/**
 * 末帧结果缓存。
 *
 * 同一源的内容身份不变，末帧无需每次截取都重新解析。键必须是稳定内容键：
 * S3 直接交付下 videoPath 是每次请求都不同的预签名 URL，不能作为身份。
 * 条目上限沿用 media-probe 的整体清空策略，防止长跑进程下 Map 无界增长。
 */
const FRAME_END_CACHE_MAX = 512;
const frameEndCache = new Map<string, FrameEnd>();

async function lastVideoFrameCached(
  videoPath: string,
  cacheKey: string,
  remaining: () => number,
  signal?: AbortSignal,
): Promise<FrameEnd> {
  const cached = frameEndCache.get(cacheKey);
  if (cached) return cached;
  const end = await lastVideoFrame(videoPath, cacheKey, remaining, signal);
  setBounded(frameEndCache, cacheKey, end, FRAME_END_CACHE_MAX);
  return end;
}

/**
 * 截取并解码指定帧。
 *
 * frameEnd 非空表示要的是精确末帧：-copyts 保留原始时间戳，select 按绝对 PTS
 * 命中该帧；为空时按 time 普通 seek，取目标位置后的第一帧。
 */
async function runCaptureFrame(
  videoPath: string,
  outputPath: string,
  time: number,
  frameEnd: FrameEnd | null,
  logFields: Record<string, unknown>,
  signal: AbortSignal | undefined,
  remaining: () => number,
): Promise<void> {
  // FFmpeg seeks in microseconds. Round down to keep the selected frame within the seek range.
  const seekTime = Math.max(0, Math.floor(time * 1e6) / 1e6);
  const { code, stderr } = await runFfmpegLight(
    [
      "-nostdin", "-nostats",
      ...frameEnd ? ["-copyts"] : [],
      "-ss", String(seekTime),
      "-i", videoPath,
      "-map", "0:v:0", "-an",
      ...frameEnd ? ["-vf", `select=eq(pts\\,${frameEnd.pts})`] : [],
      "-frames:v", "1", "-fps_mode", "passthrough",
      "-q:v", "2",
      "-y",
      outputPath,
    ],
    Math.min(FFMPEG_TIMEOUT_MS, remaining()),
    { signal, stage: "capture_frame", logFields }
  );
  if (code !== 0) {
    logEvent("media", {
      stage: "capture_frame_failed",
      exitCode: code,
      stderr: stderr.slice(-200),
      ...logFields,
    });
    throw new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-200)}`);
  }
}

/**
 * 视频截帧（spawn ffmpeg）
 * 基于 subprocess 调用 ffmpeg
 */
export async function captureVideoFrame(
  videoPath: string,
  outputPath: string,
  selection: FrameSelection = { kind: "time", seconds: 1 },
  /**
   * 稳定内容键（源存储键）：S3 直接交付下 videoPath 是每次请求都不同的预签名
   * URL，不能作为末帧缓存的身份。
   */
  cacheKey: string,
  signal?: AbortSignal,
): Promise<number> {
  const deadline = performance.now() + FRAME_CAPTURE_BUDGET_MS;
  const remaining = () => {
    throwIfAborted(signal);
    const timeLeft = deadline - performance.now();
    if (timeLeft <= 0) throw new FrameCaptureBudgetError();
    return timeLeft;
  };
  await fs.mkdir(path.dirname(outputPath), { recursive: true });

  // 日志只记稳定内容键：S3 direct 下 videoPath 是预签名 URL，basename 带查询串
  const logFields = { video: cacheKey };

  // 显式末帧：定位失败没有可降级的语义，原样上抛
  if (selection.kind === "last") {
    const end = await lastVideoFrameCached(videoPath, cacheKey, remaining, signal);
    await runCaptureFrame(videoPath, outputPath, end.time, end, logFields, signal, remaining);
    logEvent("media", { stage: "capture_frame", ...logFields });
    return end.time;
  }

  // 时间轴末端可能落在音轨尾部（容器时长 > 视频流末帧）：请求越过末帧时收敛到
  // 末帧本身，而不是让 ffmpeg 在视频流结束后找不到任何包而失败。
  // 末帧定位只用于这次收敛：定位失败不能让原本可用的普通时间点一起变成 500，
  // 此时按请求时间直接 seek（即末帧收敛引入之前的语义）。
  const frameEnd = await lastVideoFrameCached(videoPath, cacheKey, remaining, signal).catch((err: unknown) => {
    // 取消与截帧预算耗尽不是末帧探测故障，必须照常上抛给路由映射为 499 / 504；
    // 单次探测调用自身的超时（余量仍在）按探测失败降级，不把普通时间点变成 500
    if (isAbortError(err) || err instanceof FrameCaptureBudgetError) throw err;
    // 探测失败可能恰好耗尽预算：此时没有降级余量，不能记成「已降级」
    remaining();
    logEvent("media", {
      stage: "capture_end_probe_failed",
      reason: err instanceof Error ? err.message : String(err),
      ...logFields,
    });
    return null;
  });
  const atFrameEnd = frameEnd !== null && selection.seconds >= frameEnd.time;
  const time = atFrameEnd ? frameEnd.time : selection.seconds;
  if (frameEnd !== null && selection.seconds > frameEnd.time) {
    logEvent("media", {
      stage: "capture_frame_clamped",
      requested: selection.seconds,
      last: frameEnd.time,
      ...logFields,
    });
  }
  await runCaptureFrame(videoPath, outputPath, time, atFrameEnd ? frameEnd : null, logFields, signal, remaining);
  logEvent("media", { stage: "capture_frame", ...logFields });
  return time;
}

export interface FrameSpriteOptions {
  /** 采样帧数，即雪碧图的格子数 */
  count: number;
  /** 单格宽度（px）；高度按源宽高比推算 */
  cellWidth: number;
  /** 源视频时长（s），用于推算等间隔采样的时间点 */
  duration: number;
}

/**
 * 生成帧序列雪碧图（spawn ffmpeg）。
 *
 * 剪辑软件与视频站点都不用视频代理来画时间线缩略图——Premiere 的 .pek、DaVinci
 * 的 .TMB、YouTube 的 storyboard 全都是一张拼好的静态雪碧图。原因很直接：铺满
 * 一整条轨道只需要几十 KB 的位图，而为此转一份视频代理是 MB 级开销，抽帧时还要
 * 逐个时间点 seek 解码。缩略图与 scrub 代理因此是两套独立产物，各司其职。
 *
 * 采样点取每格中点附近：setpts 把全部帧时间戳后移半格，fps filter 按输出时刻
 * 从这些帧里选最近者。输出时刻 (i+0.5)*duration/count 对应原始时间的中点附近，
 * 量化误差不超过源帧率的一半（30fps 时 ±0.017s），远小于格宽。末帧时间
 * < duration + half 必有输入帧可选，数学上保证「末格黑」不出现；短视频也不再
 * 因 select 累积漂移丢失采样（5s/10 格旧方案漂移可达 0.36s，末帧推出视频时长）。
 *
 * scale 用 -8 而不是 -2：格高对齐到 8 的倍数，避免编码块跨越格边界造成相邻格
 * 渗色。WebP 宏块为 16×16，但自带环路去块滤波，8 对齐已足够。
 */
export async function createFrameSprite(
  videoPath: string,
  outputPath: string,
  { count, cellWidth, duration }: FrameSpriteOptions,
  owner: number,
  signal?: AbortSignal,
): Promise<void> {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });

  const interval = duration / count;
  const half = interval / 2;
  const fps = count / duration;

  const logFields = { video: path.basename(videoPath) };
  const { code, stderr } = await runFfmpegHeavy(
    [
      "-i", videoPath,
      // 只要画面：音轨对拼图没有意义，跳过能省掉一路解码
      "-an",
      "-vf",
      // setpts 把全部帧时间戳后移半格，fps filter 再按输出时刻从这些帧里选最近
      // 的那一帧。末帧输出时刻 (count-1)/fps 对应原始时间 half + (count-1)*duration/count
      // < duration + half，输入帧必覆盖到，末格不会再黑。
      // 不再用「select 相对间隔」方案——它有累积漂移：短视频漂移占比大，会把末帧
      // 推出视频时长（实测 5s/10 格末格 YAVG=0）
      `setpts=PTS+${half.toFixed(6)},fps=${fps.toFixed(6)},` +
        `scale=${cellWidth}:-8,tile=${count}x1`,
      // tile 按 count 铺满一页；时长探测偏小时会多出一帧并溢出到第二页，只取第一页
      "-frames:v", "1",
      // WebP 而不是 JPEG：同等观感下体积只有六成（实测 20 格雪碧图 72KB → 29KB），
      // 且自带环路去块滤波，跨格边界的块效应比 JPEG 轻
      "-c:v", "libwebp",
      "-quality", "78",
      "-y",
      outputPath,
    ],
    FFMPEG_SPRITE_TIMEOUT_MS,
    { signal, stage: "frame_sprite", logFields, owner }
  );

  if (code !== 0) {
    logEvent("media", {
      stage: "frame_sprite_failed",
      exitCode: code,
      stderr: stderr.slice(-200),
      ...logFields,
    });
    throw new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-200)}`);
  }

  logEvent("media", { stage: "frame_sprite", ...logFields });
}

/**
 * 生成预览代理视频（spawn ffmpeg）。
 *
 * 原视频多为长 GOP（x264 默认 250 帧一个关键帧），seek 到任意时间点都要从
 * GOP 起点解码过来，拖动时明显发涩；这里转出一份低分辨率副本用于 scrub 与预览。
 * 这是剪辑软件 proxy 工作流的轻量版——只用于预览，成片仍走原视频。
 *
 * 关键取舍：代理用「短 GOP」而不是「全 I 帧」。全 I 帧每帧独立可解、seek 最快，
 * 但彻底放弃了帧间预测，同画质下码率是长 GOP 的 3～5 倍，代理反而比原视频还大。
 * 改成 1 秒一个关键帧后，seek 最多解码 1 秒的帧（720p 约 30 帧，几十毫秒），
 * 拖动已经无感，体积则降到全 I 帧的三分之一左右。
 *
 * crf 保持 30 不往上调：引入帧间预测后同样的 crf 画质本就高于全 I 帧，
 * 体积的下降来自 GOP 而非画质让步，因此这里不做「降画质换体积」的交换。
 *
 * 缩放只给宽度、高度用 -2 保持比例并取整到偶数。这里刻意不写 min(width,iw)：
 * filtergraph 里逗号是 filter 之间的分隔符，写成 min(720,iw) 会被拆成两个
 * filter 而报错，转义写法又存在跨平台解析差异；分辨率低于 720 的源视频会被
 * 轻微放大，对预览没有影响。
 *
 * 默认 480 宽刻意低于节点显示宽度：代理画质发虚是特性，肉眼可分辨当前
 * 播放的是代理还是原视频。路由始终显式传宽度，此默认值仅兜底。
 */
export async function createScrubProxy(
  videoPath: string,
  outputPath: string,
  width: number,
  fps: number | null,
  owner: number,
  signal?: AbortSignal,
): Promise<void> {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });

  // 关键帧间隔取 1 秒：拖动 seek 最坏解码 1 秒画面，压缩率又已接近正常 GOP。
  // keyint_min 取一半，允许场景切换时提前插入关键帧，避免转场处被固定间隔卡住
  const gop = Math.max(1, Math.round(fps && fps > 0 ? fps : FALLBACK_FPS));

  const logFields = { video: path.basename(videoPath) };
  const { code, stderr } = await runFfmpegHeavy(
    [
      "-i", videoPath,
      // 保留音轨：选帧时常要点开播放「边听边找」（口型、台词、卡点）。
      // 统一重编码为 aac——源编码未必能直接装进 mp4 容器，copy 有失败风险
      "-c:a", "aac",
      "-b:a", "96k",
      "-vf", `scale=${width}:-2`,
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-crf", "30",
      "-g", String(gop),
      "-keyint_min", String(Math.max(1, Math.round(gop / 2))),
      "-movflags", "+faststart",
      "-y",
      outputPath,
    ],
    FFMPEG_PROXY_TIMEOUT_MS,
    { signal, stage: "video_proxy", logFields, owner }
  );

  if (code !== 0) {
    logEvent("media", {
      stage: "video_proxy_failed",
      exitCode: code,
      stderr: stderr.slice(-200),
      ...logFields,
    });
    throw new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-200)}`);
  }

  logEvent("media", { stage: "video_proxy", ...logFields });
}
