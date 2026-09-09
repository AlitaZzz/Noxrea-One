/**
 * 预览代理视频路由。
 *
 * 为帧序列面板的拖动预览提供低分辨率副本：原视频多为长 GOP（x264 默认 250 帧
 * 一个关键帧），直接拖动要从 GOP 起点一路解码过来，明显发涩。副本取 1 秒 GOP——
 * 刻意不用全 I 帧：全 I 帧 seek 最快，但放弃帧间预测后同画质码率是长 GOP 的
 * 3～5 倍，代理文件反而比原视频还大；1 秒 GOP 下 seek 最多解码 1 秒画面（几十
 * 毫秒），拖动已经无感，体积则降到全 I 帧的三分之一左右。
 *
 * 轨道缩略图不走这里，改由 /api/files/frame-sprite 出雪碧图（几十 KB）：
 * 缩略图与 scrub 代理是两套独立产物，这也是剪辑软件的通行做法。
 *
 * 代理按「源键 + 宽度」派生文件名，生成一次后长期复用；成片抽帧仍走原视频。
 */
import { Hono } from "hono";
import { z } from "zod";
import { authenticateRequest } from "@server/core/auth/middleware";
import { createScrubProxy, probeVideoMetaCached } from "@server/services/storage/media";
import { localStorage } from "@server/services/storage/backends/local";
import { ok, failCode } from "@server/core/response";
import { logger } from "@server/core/logger";
import path from "path";
import fs from "fs/promises";
import { createHash, randomUUID } from "crypto";

const videoProxySchema = z.object({
  video_key: z.string().min(1),
});

/** 代理宽度上限：跟随节点默认宽度 600px 取值，低于它会明显发虚 */
const PROXY_WIDTH = 720;
/** 代理参数版本：编码参数变化后自动生成新代理，不命中旧缓存 */
const PROXY_VERSION = 2;
/** 正在生成的代理：同一视频的并发请求共用一次转码 */
const inflight = new Map<string, Promise<void>>();
/** 清理扫描的最小间隔：避免每次请求都遍历目录 */
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000;
/** 代理存活时间：过期后删除，下次打开面板会自动重建 */
const PROXY_TTL_MS = 30 * 24 * 60 * 60 * 1000;
let lastCleanupAt = 0;

/** 清掉过期代理：按最后生成时间判定，纯维护动作，任何失败都不影响主流程 */
async function cleanupStaleProxies(baseDir: string): Promise<void> {
  const now = Date.now();
  if (now - lastCleanupAt < CLEANUP_INTERVAL_MS) return;
  lastCleanupAt = now;
  try {
    const dir = path.resolve(baseDir, "_proxy");
    const names = await fs.readdir(dir);
    for (const name of names) {
      const target = path.join(dir, name);
      const stat = await fs.stat(target).catch(() => null);
      if (!stat || !stat.isFile()) continue;
      if (now - stat.mtimeMs > PROXY_TTL_MS) {
        await fs.rm(target, { force: true }).catch(() => {});
      }
    }
  } catch {
    // 目录不存在或读取失败：清理只是顺带做的维护，静默跳过
  }
}

/** 转码到临时文件后原子改名；失败时清掉临时文件 */
async function generateProxy(
  videoPath: string,
  tmpPath: string,
  proxyPath: string,
  width: number,
  fps: number | null,
): Promise<void> {
  let renamed = false;
  try {
    await createScrubProxy(videoPath, tmpPath, width, fps);
    await fs.mkdir(path.dirname(proxyPath), { recursive: true });
    await fs.rename(tmpPath, proxyPath);
    renamed = true;
  } finally {
    // 改名成功后临时文件已随之消失，只有失败路径才需要清理；
    // force 兜住「根本没生成出来」的情况，避免又刷一条 ENOENT 警告
    if (!renamed) {
      await fs.rm(tmpPath, { force: true }).catch((err: unknown) => {
        logger.warn({ err, tmpPath }, "Failed to remove temp proxy file");
      });
    }
  }
}

const router = new Hono();

router.post("/api/files/video-proxy", async (c) => {
  const request = c.req.raw;
  const auth = await authenticateRequest(request);
  if ("error" in auth) return auth.error;

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return failCode(400, "common.invalid_json");
  }

  const parsed = videoProxySchema.safeParse(body);
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

  // 帧率与分辨率：读取容器信息，开销可忽略。
  // 分辨率用来避免把小视频放大——源本身不足 PROXY_WIDTH 时按原尺寸生成；
  // 帧率用来把关键帧间隔定成 1 秒——探测结果在雪碧图路由间共用，只跑一次
  const meta = await probeVideoMetaCached(videoPath);
  const width = meta?.width && meta.width > 0
    ? Math.min(PROXY_WIDTH, meta.width)
    : PROXY_WIDTH;

  // 代理名由源键与宽度共同派生：同一视频反复打开面板直接命中缓存；
  // 宽度并入哈希后，调整参数会自动生成新代理，不会命中旧尺寸的缓存
  const proxyKey = `_proxy/${createHash("sha1").update(`${video_key}|${width}|v${PROXY_VERSION}`).digest("hex").slice(0, 32)}.mp4`;
  const proxyPath = path.resolve(baseDir, proxyKey);
  const fps = meta?.fps ?? null;

  // 顺带做一次低频清理，不阻塞本次请求
  void cleanupStaleProxies(baseDir);

  try {
    await fs.access(proxyPath);
    return c.json(ok({ url: `/api/files/${proxyKey}`, fps, cached: true }));
  } catch {
    // 未生成，继续往下走
  }

  // 同一代理正在生成：复用那次转码，避免并发各跑一个 ffmpeg
  const pending = inflight.get(proxyKey);
  if (pending) {
    await pending.catch(() => {});
    try {
      await fs.access(proxyPath);
      return c.json(ok({ url: `/api/files/${proxyKey}`, fps, cached: true }));
    } catch {
      return failCode(500, "video_proxy.generation_failed");
    }
  }

  const tmpPath = path.resolve(baseDir, `_tmp/proxy_${process.pid}_${randomUUID()}.mp4`);
  const task = generateProxy(videoPath, tmpPath, proxyPath, width, fps);
  inflight.set(proxyKey, task);

  try {
    await task;
    return c.json(ok({ url: `/api/files/${proxyKey}`, fps, cached: false }));
  } catch (err: unknown) {
    // ffmpeg 缺失或转码失败的底层信息只进日志，运维细节不下发给客户端
    logger.error({ err, videoKey: video_key }, "Video proxy generation failed");
    return failCode(500, "video_proxy.generation_failed");
  } finally {
    inflight.delete(proxyKey);
  }
});

export { router };
