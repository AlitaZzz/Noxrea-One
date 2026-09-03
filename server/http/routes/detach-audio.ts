/**
 * 音视频分离路由。
 * 从视频中无损拆出「独立音轨」与「静音视频」两个产物，落盘去重后返回可访问地址。
 *
 * 与抽帧路由的关键差异：产物可能是几十 MB 的音频，全程走流式哈希与
 * 文件拷贝，不把产物整份读进内存。
 */
import { Hono } from "hono";
import { z } from "zod";
import { authenticateRequest } from "@server/core/auth/middleware";
import {
  extractAudioTrack,
  extractMutedVideo,
  NoAudioTrackError,
} from "@server/services/storage/media";
import { localStorage } from "@server/services/storage/backends/local";
import { computeFileHash } from "@server/services/storage/hash";
import { buildFileUrl, buildStorageKey } from "@server/services/storage/service";
import { persistFileObject } from "@server/services/storage/persist";
import { ok, failCode } from "@server/core/response";
import { logger } from "@server/core/logger";
import path from "path";
import fs from "fs/promises";
import { randomUUID } from "crypto";

const detachAudioSchema = z.object({
  video_key: z.string().min(1),
});

/** 静音视频的容器沿用源扩展名，仅做 MIME 映射（格式由源容器决定，无需嗅探） */
const VIDEO_MIME_BY_EXT: Record<string, string> = {
  ".mp4": "video/mp4",
  ".m4v": "video/x-m4v",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
};

const router = new Hono();

/** 按内容哈希落盘 + 登记文件对象，返回可访问地址与体积 */
async function persistDerived(params: {
  userId: number;
  tmpPath: string;
  ext: string;
  mime: string;
}): Promise<{ key: string; url: string; size: number }> {
  // 流式哈希：音频产物动辄几十 MB，不能用 computeBufferHash 整份读入
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

router.post("/api/files/detach-audio", async (c) => {
  const request = c.req.raw;
  const auth = await authenticateRequest(request);
  if ("error" in auth) return auth.error;

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return failCode(400, "common.invalid_json");
  }

  const parsed = detachAudioSchema.safeParse(body);
  if (!parsed.success) {
    return failCode(422, "common.invalid_request");
  }
  const { video_key } = parsed.data;

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
    return failCode(404, "detach_audio.video_not_found");
  }

  // 独立临时目录：UUID 避免并发请求互相踩踏临时文件
  const tmpDir = path.resolve(
    localStorage.baseDir,
    "_tmp",
    `detach_${process.pid}_${randomUUID()}`,
  );
  const sourceExt = path.extname(video_key).toLowerCase() || ".mp4";

  try {
    const audio = await extractAudioTrack(videoPath, tmpDir, "audio", request.signal);
    const mutedPath = path.join(tmpDir, `muted${sourceExt}`);
    await extractMutedVideo(videoPath, mutedPath, request.signal);

    const audioStored = await persistDerived({
      userId: auth.user.id,
      tmpPath: audio.path,
      ext: audio.ext,
      mime: audio.mime,
    });
    const videoStored = await persistDerived({
      userId: auth.user.id,
      tmpPath: mutedPath,
      ext: sourceExt,
      mime: VIDEO_MIME_BY_EXT[sourceExt] ?? "video/mp4",
    });

    return c.json(
      ok({
        audio: { ...audioStored, mime: audio.mime, ext: audio.ext, format: audio.format },
        video: { ...videoStored, mime: VIDEO_MIME_BY_EXT[sourceExt] ?? "video/mp4", ext: sourceExt },
      })
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Audio detach failed";
    const code = typeof err === "object" && err !== null && "code" in err
      ? err.code
      : undefined;

    // 客户端断开：不记 error 级别，也无需向已断开的一端回复杂信息
    if ((err as Error).name === "AbortError") {
      logger.debug({ videoKey: video_key }, "Audio detach aborted by client");
      return failCode(499, "detach_audio.cancelled");
    }

    // ffmpeg 缺失或分离失败的底层信息只进日志，运维细节不下发给客户端
    logger.error({ err, videoKey: video_key }, "Audio detach failed");

    if (err instanceof NoAudioTrackError) {
      return failCode(422, "detach_audio.no_audio_track");
    }
    if (code === "ENOENT" || message.includes("ENOENT")) {
      return failCode(500, "detach_audio.ffmpeg_missing");
    }
    return failCode(500, "detach_audio.extract_failed");
  } finally {
    // 清理临时目录；失败通常意味着 ffmpeg 仍持有句柄，必须留痕以便排查
    await fs.rm(tmpDir, { recursive: true, force: true }).catch((err: unknown) => {
      logger.warn({ err, tmpDir }, "Failed to remove temp detach dir");
    });
  }
});

export { router };
