/**
 * 视频抽帧路由。
 * 提供从视频文件中抽取指定帧并返回图片的接口。
 */
import { Hono } from "hono";
import { z } from "zod";
import path from "path";
import { captureVideoFrame } from "@server/services/storage/video-frames";
import { localStorage } from "@server/services/storage/backends/local";
import { computeBufferHash, sniffMime, normalizeExt } from "@server/services/storage/hash";
import { buildStorageKey } from "@server/services/storage/service";
import { persistFileObject } from "@server/services/storage/persist";
import { ok } from "@server/core/response";
import { createMediaEditRoute } from "./media-edit";
import fs from "fs/promises";
import { randomUUID } from "crypto";

const captureFrameSchema = z.object({
  video_key: z.string().min(1),
  time: z.number().min(0).optional(),
});

const router = new Hono();

router.post(
  "/api/files/capture-frame",
  createMediaEditRoute({
    schema: captureFrameSchema,
    resolveKey: (d) => d.video_key,
    name: "frame",
    failureCode: "capture_frame.capture_failed",
    async run({ c, data, sourcePath, userId, signal, tmpDir }) {
      // 用 UUID 而非 Date.now()：并发抽帧会撞名，两个 ffmpeg 同时写同一路径会导致内容交错
      const tmpFramePath = path.join(tmpDir, `frame_${randomUUID()}.jpg`);
      await captureVideoFrame(sourcePath, tmpFramePath, data.time ?? 1, signal);

      // 读取截取的帧，按标准流程落盘 + 落库
      const buffer = await fs.readFile(tmpFramePath);
      const hash = await computeBufferHash(buffer);
      const sniffed = sniffMime(buffer.subarray(0, 16));
      const finalExt = normalizeExt(sniffed.ext);
      const storageKey = buildStorageKey(userId, hash, finalExt);

      await localStorage.save(storageKey, buffer);
      await persistFileObject({
        userId,
        hash,
        size: buffer.length,
        mimeType: sniffed.mime,
        ext: finalExt,
        source: "derived",
      });

      return c.json(ok({ frame_key: storageKey, url: `/api/files/${storageKey}` }));
    },
  }),
);

export { router };
