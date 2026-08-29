/**
 * 视频抽帧路由。
 * 提供从视频文件中抽取指定帧并返回图片的接口。
 */
import { Hono } from "hono";
import { z } from "zod";
import { authenticateRequest } from "@server/core/auth/middleware";
import { captureVideoFrame } from "@server/services/storage/media";
import { localStorage } from "@server/services/storage/backends/local";
import { computeBufferHash, sniffMime, normalizeExt } from "@server/services/storage/hash";
import { buildStorageKey } from "@server/services/storage/service";
import { persistFileObject } from "@server/services/storage/persist";
import { ok, failCode } from "@server/core/response";
import { logger } from "@server/core/logger";
import path from "path";
import fs from "fs/promises";

const captureFrameSchema = z.object({
  video_key: z.string().min(1),
  time: z.number().min(0).optional(),
});

const router = new Hono();

router.post("/api/files/capture-frame", async (c) => {
  const request = c.req.raw;
  const auth = await authenticateRequest(request);
  if ("error" in auth) return auth.error;

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return failCode(400, "common.invalid_json");
  }

  const parsed = captureFrameSchema.safeParse(body);
  if (!parsed.success) {
    return failCode(422, "common.invalid_request");
  }
  const { video_key, time } = parsed.data;

  const videoPath = path.resolve(localStorage.baseDir, video_key);

  // 路径穿越防护：解析后的绝对路径必须仍位于存储根目录内
  const baseDir = path.resolve(localStorage.baseDir);
  const rel = path.relative(baseDir, videoPath);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    return failCode(403, "files.invalid_path");
  }

  try {
    await fs.access(videoPath);
  } catch {
    return failCode(404, "capture_frame.video_not_found");
  }

  const tmpFramePath = path.resolve(localStorage.baseDir, `_tmp_frame_${Date.now()}.jpg`);

  try {
    await captureVideoFrame(videoPath, tmpFramePath, time ?? 1);

    // 读取截取的帧，按标准流程落盘 + 落库
    const buffer = await fs.readFile(tmpFramePath);
    const hash = await computeBufferHash(buffer);
    const sniffed = sniffMime(buffer.subarray(0, 16));
    const finalExt = normalizeExt(sniffed.ext);
    const storageKey = buildStorageKey(auth.user.id, hash, finalExt);

    await localStorage.save(storageKey, buffer);
    await persistFileObject({
      userId: auth.user.id,
      hash,
      size: buffer.length,
      mimeType: sniffed.mime,
      ext: finalExt,
      source: "derived",
    });

    return c.json(
      ok({
        frame_key: storageKey,
        url: `/api/files/${storageKey}`,
      })
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Frame capture failed";
    const code = typeof err === "object" && err !== null && "code" in err
      ? err.code
      : undefined;
    // ffmpeg 缺失或抽帧失败的底层信息只进日志，运维细节不下发给客户端
    logger.error({ err, videoKey: video_key }, "Frame capture failed");
    if (code === "ENOENT" || message.includes("ENOENT")) {
      return failCode(500, "capture_frame.ffmpeg_missing");
    }
    return failCode(500, "capture_frame.capture_failed");
  } finally {
    // 清理临时文件
    await fs.unlink(tmpFramePath).catch(() => undefined);
  }
});

export { router };
