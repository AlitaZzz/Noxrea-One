/**
 * 视频抽帧路由。
 * 提供从视频文件中抽取指定帧并返回图片的接口。
 */
import { Hono } from "hono";
import { z } from "zod";
import { frameSelectionSchema } from "@noxrea/shared";
import path from "path";
import { captureVideoFrame } from "@server/services/storage/video-frames";
import { probeImageMeta } from "@server/services/storage/media-probe";
import { ok } from "@server/core/response";
import { createMediaEditRoute, persistDerived } from "./media-edit";
import { mimeByExt } from "@server/services/storage/mime";
import { randomUUID } from "crypto";

const captureFrameSchema = z.object({
  video_key: z.string().min(1),
  selection: frameSelectionSchema.default({ kind: "time", seconds: 1 }),
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
      const time = await captureVideoFrame(sourcePath, tmpFramePath, data.selection, signal);
      signal.throwIfAborted();
      const dimensions = await probeImageMeta(tmpFramePath);
      if (!dimensions) throw new Error("Captured frame dimensions unavailable");
      signal.throwIfAborted();

      // 产物落盘走工厂统一通道（流式哈希 + copyFile 落盘 + 文件对象登记，不整帧进内存）；
      // ffmpeg 抽帧产物恒为 JPEG，扩展名/MIME 定档不再嗅探
      const stored = await persistDerived({
        userId,
        tmpPath: tmpFramePath,
        ext: ".jpg",
        mime: mimeByExt(".jpg"),
      });

      return c.json(ok({ frame_key: stored.key, url: stored.url, time, ...dimensions }));
    },
  }),
);

export { router };
