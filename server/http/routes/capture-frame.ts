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
import { ok, fail } from "@server/core/response";
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
    return fail(400, "Invalid JSON body");
  }

  const parsed = captureFrameSchema.safeParse(body);
  if (!parsed.success) {
    return fail(422, parsed.error.issues.map((i) => i.message).join("; "));
  }
  const { video_key, time } = parsed.data;

  const videoPath = path.resolve(localStorage.baseDir, video_key);

  try {
    await fs.access(videoPath);
  } catch {
    return fail(404, "Video file not found");
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
    if (code === "ENOENT" || message.includes("ENOENT")) {
      return fail(500, "ffmpeg not found - please install ffmpeg and set FFMPEG_PATH in .env");
    }
    return fail(500, message);
  } finally {
    // 清理临时文件
    await fs.unlink(tmpFramePath).catch(() => undefined);
  }
});

export { router };
