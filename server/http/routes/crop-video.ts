/**
 * 视频画面裁剪路由。
 * 按源像素矩形 crop 并重编码整段视频，落盘去重后返回可访问地址。
 * 与片段截取同构（同步长请求 + 流式落盘 + 客户端断开中断），
 * 矩形由服务端做偶数钳位与边界校验（yuv420p 色度采样要求）。
 */
import { Hono } from "hono";
import { z } from "zod";
import { cropVideoRegion } from "@server/services/storage/media-edit";
import { probeVideoMetaCached } from "@server/services/storage/media-probe";
import { ok, failCode } from "@server/core/response";
import { createMediaEditRoute, persistDerived } from "./media-edit";
import path from "path";

const cropVideoSchema = z.object({
  video_key: z.string().min(1),
  x: z.number().int().min(0),
  y: z.number().int().min(0),
  width: z.number().int().min(2),
  height: z.number().int().min(2),
});

const router = new Hono();

/** 把矩形钳进源画面，且偏移/宽高全部取偶（yuv420p 色度采样要求） */
export function clampRect(
  rect: { x: number; y: number; width: number; height: number },
  srcW: number,
  srcH: number,
): { x: number; y: number; width: number; height: number } {
  const even = (v: number) => v - (v % 2);
  let width = Math.min(even(rect.width), even(srcW));
  let height = Math.min(even(rect.height), even(srcH));
  let x = Math.min(even(rect.x), even(srcW - width));
  let y = Math.min(even(rect.y), even(srcH - height));
  width = Math.max(2, width);
  height = Math.max(2, height);
  x = Math.max(0, x);
  y = Math.max(0, y);
  return { x, y, width, height };
}

router.post(
  "/api/files/crop-video",
  createMediaEditRoute({
    schema: cropVideoSchema,
    resolveKey: (d) => d.video_key,
    name: "crop",
    failureCode: "crop.failed",
    async run({ c, data, sourcePath, userId, signal, tmpDir }) {
      // 源分辨率用于钳位；探测失败按无法裁剪处理（源画面尺寸都拿不到时裁剪无从谈起）
      const meta = await probeVideoMetaCached(sourcePath);
      if (!meta?.width || !meta?.height) {
        return failCode(422, "crop.invalid_rect");
      }
      const rect = clampRect(data, meta.width, meta.height);
      if (rect.width < 2 || rect.height < 2) {
        return failCode(422, "crop.invalid_rect");
      }

      const crop = await cropVideoRegion(
        sourcePath,
        path.join(tmpDir, "crop.mp4"),
        rect,
        signal,
      );

      const stored = await persistDerived({
        userId,
        tmpPath: crop.path,
        ext: crop.ext,
        mime: crop.mime,
      });

      return c.json(
        ok({ ...stored, ext: crop.ext, mime: crop.mime, width: rect.width, height: rect.height })
      );
    },
  }),
);

export { router };
