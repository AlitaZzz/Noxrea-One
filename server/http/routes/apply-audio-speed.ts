/**
 * 音频变速路由。
 * 对整条音频应用变速（ffmpeg atempo 链式滤镜，保留音调），重编码为 m4a，
 * 落盘去重后返回可访问地址。与片段截取（extract-audio-clip）同构：
 * 产物走流式哈希与文件拷贝落盘；客户端断开经 request.signal 传导到 ffmpeg SIGKILL。
 */
import { Hono } from "hono";
import { z } from "zod";
import { authenticateRequest } from "@server/core/auth/middleware";
import { changeAudioSpeed } from "@server/services/storage/media";
import { localStorage } from "@server/services/storage/backends/local";
import { computeFileHash } from "@server/services/storage/hash";
import { buildFileUrl, buildStorageKey } from "@server/services/storage/service";
import { persistFileObject } from "@server/services/storage/persist";
import { ok, failCode } from "@server/core/response";
import { logger } from "@server/core/logger";
import path from "path";
import fs from "fs/promises";
import { randomUUID } from "crypto";

const applyAudioSpeedSchema = z.object({
  audio_key: z.string().min(1),
  /** 变速倍率（保留音调）：0.1–4，超出部分由服务端拒绝 */
  speed: z.number().finite().min(0.1).max(4),
});

const router = new Hono();

/** 按内容哈希落盘 + 登记文件对象，返回可访问地址与体积 */
async function persistDerived(params: {
  userId: number;
  tmpPath: string;
  ext: string;
  mime: string;
}): Promise<{ key: string; url: string; size: number }> {
  // 流式哈希：变速产物可能几十 MB，不能用 computeBufferHash 整份读入
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

router.post("/api/files/apply-audio-speed", async (c) => {
  const request = c.req.raw;
  const auth = await authenticateRequest(request);
  if ("error" in auth) return auth.error;

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return failCode(400, "common.invalid_json");
  }

  const parsed = applyAudioSpeedSchema.safeParse(body);
  if (!parsed.success) {
    return failCode(422, "common.invalid_request");
  }
  const { audio_key, speed } = parsed.data;

  const audioPath = path.resolve(localStorage.baseDir, audio_key);

  // 路径穿越防护：解析后的绝对路径必须仍位于存储根目录内
  const baseDir = path.resolve(localStorage.baseDir);
  const rel = path.relative(baseDir, audioPath);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    return failCode(403, "files.invalid_path");
  }

  try {
    await fs.access(audioPath);
  } catch {
    return failCode(404, "clip.audio_not_found");
  }

  // 独立临时目录：UUID 避免并发请求互相踩踏临时文件
  const tmpDir = path.resolve(
    localStorage.baseDir,
    "_tmp",
    `audio_speed_${process.pid}_${randomUUID()}`,
  );

  try {
    const result = await changeAudioSpeed(
      audioPath,
      path.join(tmpDir, "speed.m4a"),
      speed,
      request.signal,
    );

    const stored = await persistDerived({
      userId: auth.user.id,
      tmpPath: result.path,
      ext: ".m4a",
      mime: "audio/mp4",
    });

    return c.json(ok({ ...stored, ext: ".m4a", mime: "audio/mp4" }));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Audio speed change failed";
    const code = typeof err === "object" && err !== null && "code" in err
      ? err.code
      : undefined;

    // 客户端断开：不记 error 级别，也无需向已断开的一端回复杂信息
    if ((err as Error).name === "AbortError") {
      logger.debug({ audioKey: audio_key }, "Audio speed change aborted by client");
      return failCode(499, "clip.cancelled");
    }

    logger.error({ err, audioKey: audio_key }, "Audio speed change failed");

    if (code === "ENOENT" || message.includes("ENOENT")) {
      return failCode(500, "clip.ffmpeg_missing");
    }
    if (message.includes("timed out")) {
      return failCode(504, "clip.timeout");
    }
    return failCode(500, "clip.extract_failed");
  } finally {
    // 临时目录整体清理（产物已 copy 进存储后端）
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

export { router as applyAudioSpeedRouter };
