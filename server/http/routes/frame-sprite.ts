/**
 * 帧序列雪碧图路由。
 *
 * 为帧序列面板提供整条轨道的缩略图：一次 ffmpeg 解码后按等间隔采样，把结果拼成
 * 一张雪碧图（storyboard），前端用背景偏移逐格取图。
 *
 * 这是剪辑软件与视频站点的通行做法（Premiere 的 .pek、DaVinci 的 .TMB、YouTube
 * 的 storyboard）：缩略图本质就是「几十张小图」，用位图承载只需几十 KB；若改用
 * 视频代理再逐时间点 seek，产物是 MB 级且抽帧更慢。因此雪碧图与
 * /api/files/video-proxy 的 scrub 代理是两套独立产物，各司其职。
 *
 * 雪碧图按「源键 + 格宽 + 帧数」派生文件名，生成一次后长期复用。
 */
import { Hono } from "hono";
import { z } from "zod";
import { authenticateRequest } from "@server/core/auth/middleware";
import { createFrameSprite, probeVideoMetaCached } from "@server/services/storage/media";
import { localStorage } from "@server/services/storage/backends/local";
import { ok, failCode } from "@server/core/response";
import { logger } from "@server/core/logger";
import path from "path";
import fs from "fs/promises";
import { createHash, randomUUID } from "crypto";

const frameSpriteSchema = z.object({
  video_key: z.string().min(1),
});

/** 单格宽度（px）：与轨道上单格的显示宽度同量级，再大只是白白增加体积 */
const CELL_WIDTH = 160;
/** 目标粒度：每格约 0.5 秒，让不同时长视频的选帧手感一致 */
const TARGET_SEC_PER_FRAME = 0.5;
/**
 * 帧数上下限。上限 20 同时兜住两件事：单格显示宽度不低于 50px（再窄认不出画面），
 * 雪碧图体积可控；下限 8 避免短视频只剩稀疏几格。
 */
const MIN_FRAMES = 8;
const MAX_FRAMES = 20;
/** 雪碧图参数版本：采样或编码参数变化后自动生成新图，不命中旧缓存 */
const SPRITE_VERSION = 1;
/** 正在生成的图：同一视频的并发请求共用一次转码 */
const inflight = new Map<string, Promise<void>>();
/** 清理扫描的最小间隔：避免每次请求都遍历目录 */
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000;
/** 雪碧图存活时间：单张只有几十 KB，与代理同周期清理即可 */
const SPRITE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
let lastCleanupAt = 0;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** 清掉过期雪碧图：按最后生成时间判定，纯维护动作，任何失败都不影响主流程 */
async function cleanupStaleSprites(baseDir: string): Promise<void> {
  const now = Date.now();
  if (now - lastCleanupAt < CLEANUP_INTERVAL_MS) return;
  lastCleanupAt = now;
  try {
    const dir = path.resolve(baseDir, "_sprite");
    const names = await fs.readdir(dir);
    for (const name of names) {
      const target = path.join(dir, name);
      const stat = await fs.stat(target).catch(() => null);
      if (!stat || !stat.isFile()) continue;
      if (now - stat.mtimeMs > SPRITE_TTL_MS) {
        await fs.rm(target, { force: true }).catch(() => {});
      }
    }
  } catch {
    // 目录不存在或读取失败：清理只是顺带做的维护，静默跳过
  }
}

/** 生成到临时文件后原子改名；失败时清掉临时文件 */
async function generateSprite(
  videoPath: string,
  tmpPath: string,
  spritePath: string,
  count: number,
  duration: number,
): Promise<void> {
  let renamed = false;
  try {
    await createFrameSprite(videoPath, tmpPath, { count, cellWidth: CELL_WIDTH, duration });
    await fs.mkdir(path.dirname(spritePath), { recursive: true });
    await fs.rename(tmpPath, spritePath);
    renamed = true;
  } finally {
    // 改名成功后临时文件已随之消失，只有失败路径才需要清理；
    // force 兜住「根本没生成出来」的情况，避免又刷一条 ENOENT 警告
    if (!renamed) {
      await fs.rm(tmpPath, { force: true }).catch((err: unknown) => {
        logger.warn({ err, tmpPath }, "Failed to remove temp sprite file");
      });
    }
  }
}

const router = new Hono();

router.post("/api/files/frame-sprite", async (c) => {
  const request = c.req.raw;
  const auth = await authenticateRequest(request);
  if ("error" in auth) return auth.error;

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return failCode(400, "common.invalid_json");
  }

  const parsed = frameSpriteSchema.safeParse(body);
  if (!parsed.success) {
    return failCode(422, "common.invalid_request");
  }
  const { video_key } = parsed.data;

  const baseDir = path.resolve(localStorage.baseDir);
  const videoPath = path.resolve(baseDir, video_key);

  // 路径穿越防护：解析后的绝对路径必须仍位于存储根目录内
  const rel = path.relative(baseDir, videoPath);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    return failCode(403, "files.invalid_path");
  }

  try {
    await fs.access(videoPath);
  } catch {
    return failCode(404, "capture_frame.video_not_found");
  }

  const meta = await probeVideoMetaCached(videoPath);
  const duration = meta?.duration ?? null;
  // 拿不到时长就无法把格子映射到时间轴，采样间隔无从计算——此时只能放弃缩略图。
  // 面板退化为「只有播放头」仍可定位与截取：成片抽帧走后端精确 seek
  if (!duration) {
    return failCode(422, "frame_sprite.duration_unavailable");
  }

  // 密度由时长决定（每格约 TARGET_SEC_PER_FRAME 秒）后钳到上下限：
  // 10 秒内的视频能拿到 0.5 秒粒度，更长的视频固定 20 格、粒度随之变粗
  const count = clamp(Math.ceil(duration / TARGET_SEC_PER_FRAME), MIN_FRAMES, MAX_FRAMES);
  const fps = meta?.fps ?? null;

  // 图名由源键、格宽与帧数共同派生：格宽与帧数并入哈希后，调整参数会自动生成
  // 新图，不会命中旧规格的缓存
  const spriteKey = `_sprite/${createHash("sha1")
    .update(`${video_key}|${CELL_WIDTH}|${count}|v${SPRITE_VERSION}`)
    .digest("hex")
    .slice(0, 32)}.webp`;
  const spritePath = path.resolve(baseDir, spriteKey);

  // 顺带做一次低频清理，不阻塞本次请求
  void cleanupStaleSprites(baseDir);

  const payload = {
    url: `/api/files/${spriteKey}`,
    count,
    cell_width: CELL_WIDTH,
    duration,
    fps,
  };

  try {
    await fs.access(spritePath);
    return c.json(ok({ ...payload, cached: true }));
  } catch {
    // 未生成，继续往下走
  }

  // 同一张图正在生成：复用那次转码，避免并发各跑一个 ffmpeg
  const pending = inflight.get(spriteKey);
  if (pending) {
    await pending.catch(() => {});
    try {
      await fs.access(spritePath);
      return c.json(ok({ ...payload, cached: true }));
    } catch {
      return failCode(500, "frame_sprite.generation_failed");
    }
  }

  const tmpPath = path.resolve(baseDir, `_tmp/sprite_${process.pid}_${randomUUID()}.webp`);
  const task = generateSprite(videoPath, tmpPath, spritePath, count, duration);
  inflight.set(spriteKey, task);

  try {
    await task;
    return c.json(ok({ ...payload, cached: false }));
  } catch (err: unknown) {
    // ffmpeg 缺失或转码失败的底层信息只进日志，运维细节不下发给客户端
    logger.error({ err, videoKey: video_key }, "Frame sprite generation failed");
    return failCode(500, "frame_sprite.generation_failed");
  } finally {
    inflight.delete(spriteKey);
  }
});

export { router };
