/**
 * 音频片段截取路由。
 * 从音频里按 [start, end] 区间截出一段，落盘去重后返回可访问地址。
 *
 * 与视频片段截取（extract-clip）同构：产物走流式哈希与文件拷贝落盘；
 * 同步长请求（前端用节点忙浮层反馈），客户端断开经 request.signal 传导到
 * ffmpeg SIGKILL。路由只做校验、派发与落盘。
 * 音频流直接 copy 不重编码（切点误差 ~20ms 远低于体感阈值），产物容器与源一致。
 */
import { Hono } from "hono";
import { z } from "zod";
import { authenticateRequest } from "@server/core/auth/middleware";
import { extractAudioClip } from "@server/services/storage/media";
import { localStorage } from "@server/services/storage/backends/local";
import { computeFileHash } from "@server/services/storage/hash";
import { buildFileUrl, buildStorageKey } from "@server/services/storage/service";
import { persistFileObject } from "@server/services/storage/persist";
import { ok, failCode } from "@server/core/response";
import { logger } from "@server/core/logger";
import path from "path";
import fs from "fs/promises";
import { randomUUID } from "crypto";

const extractAudioClipSchema = z
  .object({
    audio_key: z.string().min(1),
    start: z.number().finite().min(0),
    end: z.number().finite(),
  })
  .refine((d) => d.end > d.start, { message: "invalid range" });

/** 区间下限（s）：短于此视为误操作；上限为同步请求封顶（前端轨道可选拖满全片） */
const MIN_CLIP_DURATION_S = 0.5;
const MAX_CLIP_DURATION_S = 600;

/** 常见音频容器扩展名 → MIME；未识别的扩展名回退 mpeg（播放器按内容嗅探兜底） */
const AUDIO_MIME_BY_EXT: Record<string, string> = {
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".opus": "audio/ogg",
  ".flac": "audio/flac",
  ".webm": "audio/webm",
};

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

router.post("/api/files/extract-audio-clip", async (c) => {
  const request = c.req.raw;
  const auth = await authenticateRequest(request);
  if ("error" in auth) return auth.error;

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return failCode(400, "common.invalid_json");
  }

  const parsed = extractAudioClipSchema.safeParse(body);
  if (!parsed.success) {
    return failCode(422, "common.invalid_request");
  }
  const { audio_key } = parsed.data;
  const start = parsed.data.start;
  const end = parsed.data.end;

  // zod refine 已保证 end > start，这里再按业务语义限宽（1e-6 容差吃掉浮点误差）
  if (end - start < MIN_CLIP_DURATION_S - 1e-6) {
    return failCode(422, "clip.invalid_range");
  }
  if (end - start > MAX_CLIP_DURATION_S) {
    return failCode(422, "clip.range_too_long");
  }

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

  // 产物容器与源一致：扩展名取自源（无扩展名兜底 .mp3），MIME 由扩展名映射；
  // 未识别的扩展名保留原样（copy 产物容器不变，强改容器标签会产出坏文件）
  const ext = path.extname(audio_key).toLowerCase() || ".mp3";

  // 独立临时目录：UUID 避免并发请求互相踩踏临时文件
  const tmpDir = path.resolve(
    localStorage.baseDir,
    "_tmp",
    `audio_clip_${process.pid}_${randomUUID()}`,
  );

  try {
    const clip = await extractAudioClip(
      audioPath,
      path.join(tmpDir, `clip${ext}`),
      { start, end },
      request.signal,
    );

    const stored = await persistDerived({
      userId: auth.user.id,
      tmpPath: clip.path,
      ext,
      mime: AUDIO_MIME_BY_EXT[ext] ?? "audio/mpeg",
    });

    return c.json(ok({ ...stored, ext, mime: AUDIO_MIME_BY_EXT[ext] ?? "audio/mpeg" }));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Audio clip extraction failed";
    const code = typeof err === "object" && err !== null && "code" in err
      ? err.code
      : undefined;

    // 客户端断开：不记 error 级别，也无需向已断开的一端回复杂信息
    if ((err as Error).name === "AbortError") {
      logger.debug({ audioKey: audio_key }, "Audio clip extraction aborted by client");
      return failCode(499, "clip.cancelled");
    }

    // ffmpeg 缺失或截取失败的底层信息只进日志，运维细节不下发给客户端
    logger.error({ err, audioKey: audio_key }, "Audio clip extraction failed");

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

export { router as extractAudioClipRouter };
