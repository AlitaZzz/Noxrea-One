/**
 * 视频画面裁剪路由。
 * 按源像素矩形 crop 并重编码整段视频，落盘去重后返回可访问地址。
 * 与片段截取同构（同步长请求 + 流式落盘 + 客户端断开中断），
 * 矩形由服务端做偶数钳位与边界校验（yuv420p 色度采样要求）。
 */
import { Hono } from "hono";
import { z } from "zod";
import { authenticateRequest } from "@server/http/middleware/auth";
import { cropVideoRegion, probeVideoMetaCached } from "@server/services/storage/media";
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

const cropVideoSchema = z.object({
  video_key: z.string().min(1),
  x: z.number().int().min(0),
  y: z.number().int().min(0),
  width: z.number().int().min(2),
  height: z.number().int().min(2),
});

const router = new Hono();

/** 按内容哈希落盘 + 登记文件对象，返回可访问地址与体积 */
async function persistDerived(params: {
  userId: number;
  tmpPath: string;
  ext: string;
  mime: string;
}): Promise<{ key: string; url: string; size: number }> {
  // 流式哈希：裁剪产物可能几十 MB，不能用 computeBufferHash 整份读入
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

/** 把矩形钳进源画面，且偏移/宽高取偶（yuv420p 色度采样要求） */
function clampRect(
  rect: { x: number; y: number; width: number; height: number },
  srcW: number,
  srcH: number,
): { x: number; y: number; width: number; height: number } {
  const even = (v: number) => v - (v % 2);
  let width = Math.min(even(rect.width), even(srcW));
  let height = Math.min(even(rect.height), even(srcH));
  let x = Math.min(even(rect.x), srcW - width);
  let y = Math.min(even(rect.y), srcH - height);
  width = Math.max(2, width);
  height = Math.max(2, height);
  x = Math.max(0, x);
  y = Math.max(0, y);
  return { x, y, width, height };
}

router.post("/api/files/crop-video", async (c) => {
  const request = c.req.raw;
  const auth = await authenticateRequest(request);
  if ("error" in auth) return auth.error;

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return failCode(400, "common.invalid_json");
  }

  const parsed = cropVideoSchema.safeParse(body);
  if (!parsed.success) {
    return failCode(422, "common.invalid_request");
  }

  const videoPath = path.resolve(localStorage.baseDir, parsed.data.video_key);

  // 路径穿越防护：解析后的绝对路径必须仍位于存储根目录内
  if (!isPathWithinBase(localStorage.baseDir, videoPath)) {
    return failCode(403, "files.invalid_path");
  }

  try {
    await fs.access(videoPath);
  } catch {
    return failCode(404, "clip.video_not_found");
  }

  // 源分辨率用于钳位；探测失败按无法裁剪处理（源画面尺寸都拿不到时裁剪无从谈起）
  const meta = await probeVideoMetaCached(videoPath);
  if (!meta?.width || !meta?.height) {
    return failCode(422, "crop.invalid_rect");
  }
  const rect = clampRect(parsed.data, meta.width, meta.height);
  if (rect.width < 2 || rect.height < 2) {
    return failCode(422, "crop.invalid_rect");
  }

  // 独立临时目录：UUID 避免并发请求互相踩踏临时文件
  const tmpDir = path.resolve(
    localStorage.baseDir,
    "_tmp",
    `crop_${process.pid}_${randomUUID()}`,
  );

  try {
    const crop = await cropVideoRegion(videoPath, path.join(tmpDir, "crop.mp4"), rect, request.signal);

    const stored = await persistDerived({
      userId: auth.user.id,
      tmpPath: crop.path,
      ext: crop.ext,
      mime: crop.mime,
    });

    return c.json(
      ok({ ...stored, ext: crop.ext, mime: crop.mime, width: rect.width, height: rect.height })
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Video crop failed";
    const code = typeof err === "object" && err !== null && "code" in err
      ? err.code
      : undefined;

    // 客户端断开：不记 error 级别，也无需向已断开的一端回复杂信息
    if ((err as Error).name === "AbortError") {
      logger.debug({ videoKey: parsed.data.video_key }, "Video crop aborted by client");
      return failCode(499, "clip.cancelled");
    }

    logger.error({ err, videoKey: parsed.data.video_key }, "Video crop failed");

    if (code === "ENOENT" || message.includes("ENOENT")) {
      return failCode(500, "clip.ffmpeg_missing");
    }
    if (message.includes("timed out")) {
      return failCode(504, "crop.timeout");
    }
    return failCode(500, "crop.failed");
  } finally {
    // 清理临时目录；失败通常意味着 ffmpeg 仍持有句柄，必须留痕以便排查
    await fs.rm(tmpDir, { recursive: true, force: true }).catch((err: unknown) => {
      logger.warn({ err, tmpDir }, "Failed to remove temp crop dir");
    });
  }
});

export { router };
