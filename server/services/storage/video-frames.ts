/**
 * 视频帧产物：截帧、帧序列雪碧图与 scrub 预览代理。
 * 三者都是 ffmpeg 直接产出文件的独立产物，互不依赖；超时与中止由 ffmpeg
 * 统一执行器（ffmpeg.ts）兜底。
 */

import path from "path";
import fs from "fs/promises";
import { logEvent } from "@server/core/logger/utils";
import { runFfmpeg } from "./ffmpeg";

/** ffmpeg 抽帧超时：子进程若挂起会持续持有视频文件句柄，必须兜底杀掉 */
const FFMPEG_TIMEOUT_MS = 30_000;

/** 代理转码超时：整段重编码比抽一帧慢得多，给足时间但仍要兜底 */
const FFMPEG_PROXY_TIMEOUT_MS = 60_000;

/** 雪碧图生成超时：一次解码 + 拼图，比整段转码轻，但长视频仍需兜底 */
const FFMPEG_SPRITE_TIMEOUT_MS = 60_000;

/** 探测不到帧率时的 GOP 回退值（帧）：按 25fps 估算，约合 1 秒 */
const FALLBACK_FPS = 25;

/**
 * 视频截帧（spawn ffmpeg）
 * 基于 subprocess 调用 ffmpeg
 */
export async function captureVideoFrame(
  videoPath: string,
  outputPath: string,
  timeSeconds = 1,
  signal?: AbortSignal,
): Promise<void> {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });

  const logFields = { video: path.basename(videoPath) };
  const { code, stderr } = await runFfmpeg(
    [
      "-ss", String(timeSeconds),
      "-i", videoPath,
      "-vframes", "1",
      "-q:v", "2",
      "-y",
      outputPath,
    ],
    FFMPEG_TIMEOUT_MS,
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

  logEvent("media", { stage: "capture_frame", ...logFields });
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
  signal?: AbortSignal,
): Promise<void> {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });

  const interval = duration / count;
  const half = interval / 2;
  const fps = count / duration;

  const logFields = { video: path.basename(videoPath) };
  const { code, stderr } = await runFfmpeg(
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
    { signal, stage: "frame_sprite", logFields }
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
  width = 480,
  fps: number | null = null,
  signal?: AbortSignal,
): Promise<void> {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });

  // 关键帧间隔取 1 秒：拖动 seek 最坏解码 1 秒画面，压缩率又已接近正常 GOP。
  // keyint_min 取一半，允许场景切换时提前插入关键帧，避免转场处被固定间隔卡住
  const gop = Math.max(1, Math.round(fps && fps > 0 ? fps : FALLBACK_FPS));

  const logFields = { video: path.basename(videoPath) };
  const { code, stderr } = await runFfmpeg(
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
    { signal, stage: "video_proxy", logFields }
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
