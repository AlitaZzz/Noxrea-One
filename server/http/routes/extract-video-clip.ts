/**
 * 视频片段截取路由。
 * 从视频里按 [start, end] 区间截出一段，落盘去重后返回可访问地址。
 *
 * 与分离音频同构：产物可能是几十 MB 的视频，全程走流式哈希与文件拷贝；
 * 同步长请求（前端用节点忙浮层反馈），客户端断开经 request.signal 传导到
 * ffmpeg SIGKILL。路由只做校验、派发与落盘。
 */
import { Hono } from "hono";
import { z } from "zod";
import { authenticateRequest } from "@server/http/middleware/auth";
import { extractVideoClip } from "@server/services/storage/media";
import { localStorage } from "@server/services/storage/backends/local";
import { isPathWithinBase } from "@server/core/paths";
import { computeFileHash } from "@server/services/storage/hash";
import { buildFileUrl, buildStorageKey } from "@server/services/storage/service";
import { persistFileObject } from "@server/services/storage/persist";
import { ok, failCode } from "@server/core/response";
import { logger } from "@server/core/logger";
import path from "path";
import fs from "fs/promises";
import { randomUUID } from "crypto";

const extractClipSchema = z
  .object({
    video_key: z.string().min(1),
    start: z.number().finite().min(0),
    end: z.number().finite(),
  })
  .refine((d) => d.end > d.start, { message: "invalid range" });

/** 区间下限（s）：短于此视为误操作；上限为同步请求封顶（前端轨道可选拖满全片） */
const MIN_CLIP_DURATION_S = 0.5;
const MAX_CLIP_DURATION_S = 600;

const router = new Hono();

/** 按内容哈希落盘 + 登记文件对象，返回可访问地址与体积 */
async function persistDerived(params: {
  userId: number;
  tmpPath: string;
  ext: string;
  mime: string;
}): Promise<{ key: string; url: string; size: number }> {
  // 流式哈希：片段产物可能几十 MB，不能用 computeBufferHash 整份读入
  const hash = await computeFileHash(params.tmpPath);
  const { size } = await fs.stat(params.tmpPath);
  const storageKey = buildStorageKey(params.userId, hash, params.ext);

  // 传路径而非 Buffer：内部走 copyFile，全程不进内存
  await localStorage.save(storageKey, params.tmpPath);
  await persistFileObject({
    userId: params.userId,
    hash,
    size,
    mimeType: params.mime,
    ext: params.ext,
    source: "derived",
  });

  return { key: storageKey, url: buildFileUrl(storageKey), size };
}

router.post("/api/files/extract-clip", async (c) => {
  const request = c.req.raw;
  const auth = await authenticateRequest(request);
  if ("error" in auth) return auth.error;

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return failCode(400, "common.invalid_json");
  }

  const parsed = extractClipSchema.safeParse(body);
  if (!parsed.success) {
    return failCode(422, "common.invalid_request");
  }
  const { video_key } = parsed.data;
  const start = parsed.data.start;
  const end = parsed.data.end;

  // zod refine 已保证 end > start，这里再按业务语义限宽（1e-6 容差吃掉浮点误差：
  // 前端钳位极限处 end-start 可能是 0.49999999999999994 这类值）
  if (end - start < MIN_CLIP_DURATION_S - 1e-6) {
    return failCode(422, "clip.invalid_range");
  }
  if (end - start > MAX_CLIP_DURATION_S) {
    return failCode(422, "clip.range_too_long");
  }

  const videoPath = path.resolve(localStorage.baseDir, video_key);

  // 路径穿越防护：解析后的绝对路径必须仍位于存储根目录内
  if (!isPathWithinBase(localStorage.baseDir, videoPath)) {
    return failCode(403, "files.invalid_path");
  }

  try {
    await fs.access(videoPath);
  } catch {
    return failCode(404, "clip.video_not_found");
  }

  // 独立临时目录：UUID 避免并发请求互相踩踏临时文件
  const tmpDir = path.resolve(
    localStorage.baseDir,
    "_tmp",
    `clip_${process.pid}_${randomUUID()}`,
  );

  try {
    const clip = await extractVideoClip(
      videoPath,
      path.join(tmpDir, "clip.mp4"),
      { start, end },
      request.signal,
    );

    const stored = await persistDerived({
      userId: auth.user.id,
      tmpPath: clip.path,
      ext: clip.ext,
      mime: clip.mime,
    });

    return c.json(ok({ ...stored, ext: clip.ext, mime: clip.mime }));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Clip extraction failed";
    const code = typeof err === "object" && err !== null && "code" in err
      ? err.code
      : undefined;

    // 客户端断开：不记 error 级别，也无需向已断开的一端回复杂信息
    if ((err as Error).name === "AbortError") {
      logger.debug({ videoKey: video_key }, "Clip extraction aborted by client");
      return failCode(499, "clip.cancelled");
    }

    // ffmpeg 缺失或截取失败的底层信息只进日志，运维细节不下发给客户端
    logger.error({ err, videoKey: video_key }, "Clip extraction failed");

    if (code === "ENOENT" || message.includes("ENOENT")) {
      return failCode(500, "clip.ffmpeg_missing");
    }
    if (message.includes("timed out")) {
      return failCode(504, "clip.timeout");
    }
    return failCode(500, "clip.extract_failed");
  } finally {
    // 清理临时目录；失败通常意味着 ffmpeg 仍持有句柄，必须留痕以便排查
    await fs.rm(tmpDir, { recursive: true, force: true }).catch((err: unknown) => {
      logger.warn({ err, tmpDir }, "Failed to remove temp clip dir");
    });
  }
});

export { router };
