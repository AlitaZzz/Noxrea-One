/**
 * 视频片段截取路由。
 * 从视频里按 [start, end] 区间截出一段，落盘去重后返回可访问地址。
 *
 * 同步长请求（前端用节点忙浮层反馈），客户端断开经 request.signal 传导到
 * ffmpeg SIGKILL。路由只做校验、派发与落盘。
 */
import { Hono } from "hono";
import { z } from "zod";
import { extractVideoClip } from "@server/services/storage/media-edit";
import { ok, failCode } from "@server/core/response";
import { createMediaEditRoute, persistDerived } from "./media-edit";
import path from "path";

const extractClipSchema = z
  .object({
    video_key: z.string().min(1),
    start: z.number().finite().min(0),
    end: z.number().finite(),
  })
  .refine((d) => d.end > d.start, { message: "invalid range" });

/** 区间下限（s）：短于此视为误操作；上限为同步请求封顶（前端轨道可选拖满全片） */
const MIN_CLIP_DURATION_S = 0.5;
const MAX_CLIP_DURATION_S = 600;

const router = new Hono();

router.post(
  "/api/files/extract-clip",
  createMediaEditRoute({
    schema: extractClipSchema,
    resolveKey: (d) => d.video_key,
    name: "clip",
    failureCode: "clip.extract_failed",
    async run({ c, data, sourcePath, userId, signal, tmpDir }) {
      // zod refine 已保证 end > start，这里再按业务语义限宽（1e-6 容差吃掉浮点误差：
      // 前端钳位极限处 end-start 可能是 0.49999999999999994 这类值）
      if (data.end - data.start < MIN_CLIP_DURATION_S - 1e-6) {
        return failCode(422, "clip.invalid_range");
      }
      if (data.end - data.start > MAX_CLIP_DURATION_S) {
        return failCode(422, "clip.range_too_long");
      }

      const clip = await extractVideoClip(
        sourcePath,
        path.join(tmpDir, "clip.mp4"),
        { start: data.start, end: data.end },
        signal,
      );

      const stored = await persistDerived({
        userId,
        tmpPath: clip.path,
        ext: clip.ext,
        mime: clip.mime,
      });

      return c.json(ok({ ...stored, ext: clip.ext, mime: clip.mime }));
    },
  }),
);

export { router };
