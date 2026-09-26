/**
 * 音频变速路由。
 * 对整条音频应用变速（ffmpeg atempo 链式滤镜，保留音调），重编码为 m4a，
 * 落盘去重后返回可访问地址。产物走流式哈希与文件拷贝落盘；
 * 客户端断开经 request.signal 传导到 ffmpeg SIGKILL。
 */
import { Hono } from "hono";
import { z } from "zod";
import { changeAudioSpeed } from "@server/services/storage/media-edit";
import { ok } from "@server/core/response";
import { createMediaEditRoute, persistDerived } from "./media-edit";
import path from "path";

const applyAudioSpeedSchema = z.object({
  audio_key: z.string().min(1),
  /** 变速倍率（保留音调）：0.1–4，超出部分由服务端拒绝 */
  speed: z.number().finite().min(0.1).max(4),
});

const router = new Hono();

router.post(
  "/api/files/apply-audio-speed",
  createMediaEditRoute({
    schema: applyAudioSpeedSchema,
    resolveKey: (d) => d.audio_key,
    name: "audio_speed",
    failureCode: "speed.failed",
    async run({ c, data, sourcePath, userId, signal, tmpDir }) {
      const result = await changeAudioSpeed(
        sourcePath,
        path.join(tmpDir, "speed.m4a"),
        data.speed,
        signal,
      );

      const stored = await persistDerived({
        userId,
        tmpPath: result.path,
        ext: ".m4a",
        mime: "audio/mp4",
      });

      return c.json(ok({ ...stored, ext: ".m4a", mime: "audio/mp4" }));
    },
  }),
);

export { router as applyAudioSpeedRouter };
