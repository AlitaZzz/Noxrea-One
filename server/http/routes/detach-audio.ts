/**
 * 音视频分离路由。
 * 从视频中无损拆出「独立音轨」与「静音视频」两个产物，落盘去重后返回可访问地址。
 *
 * 产物可能是几十 MB 的音频，全程走流式哈希与文件拷贝，不把产物整份读进内存。
 */
import { Hono } from "hono";
import { z } from "zod";
import {
  extractAudioTrack,
  extractMutedVideo,
  NoAudioTrackError,
} from "@server/services/storage/media-edit";
import { ok, failCode } from "@server/core/response";
import { createMediaEditRoute, persistDerived } from "./media-edit";
import path from "path";

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

router.post(
  "/api/files/detach-audio",
  createMediaEditRoute({
    schema: detachAudioSchema,
    resolveKey: (d) => d.video_key,
    name: "detach",
    failureCode: "detach_audio.extract_failed",
    mapError: (err) =>
      err instanceof NoAudioTrackError ? failCode(422, "detach_audio.no_audio_track") : undefined,
    async run({ c, sourceKey, sourcePath, userId, signal, tmpDir }) {
      const audio = await extractAudioTrack(sourcePath, tmpDir, "audio", signal);
      // 静音视频容器沿用源扩展名
      const sourceExt = path.extname(sourceKey).toLowerCase() || ".mp4";
      const mutedPath = path.join(tmpDir, `muted${sourceExt}`);
      await extractMutedVideo(sourcePath, mutedPath, signal);

      const audioStored = await persistDerived({
        userId,
        tmpPath: audio.path,
        ext: audio.ext,
        mime: audio.mime,
      });
      const videoStored = await persistDerived({
        userId,
        tmpPath: mutedPath,
        ext: sourceExt,
        mime: VIDEO_MIME_BY_EXT[sourceExt] ?? "video/mp4",
      });

      return c.json(
        ok({
          audio: { ...audioStored, mime: audio.mime, ext: audio.ext, format: audio.format },
          video: {
            ...videoStored,
            mime: VIDEO_MIME_BY_EXT[sourceExt] ?? "video/mp4",
            ext: sourceExt,
          },
        })
      );
    },
  }),
);

export { router };
