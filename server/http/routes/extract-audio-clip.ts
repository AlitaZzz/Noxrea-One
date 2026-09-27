/**
 * 音频片段截取路由。
 * 从音频里按 [start, end] 区间截出一段，落盘去重后返回可访问地址。
 *
 * 产物走流式哈希与文件拷贝落盘；同步长请求（前端用节点忙浮层反馈），
 * 客户端断开经 request.signal 传导到 ffmpeg SIGKILL。路由只做校验、派发与落盘。
 * 音频流直接 copy 不重编码（切点误差 ~20ms 远低于体感阈值），产物容器与源一致。
 */
import { Hono } from "hono";
import { z } from "zod";
import { extractAudioClip } from "@server/services/storage/media-ops";
import { ok, failCode } from "@server/core/response";
import { createMediaEditRoute, persistDerived } from "./media-edit";
import { mimeByExt } from "@server/services/storage/mime";
import path from "path";

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

const router = new Hono();

router.post(
  "/api/files/extract-audio-clip",
  createMediaEditRoute({
    schema: extractAudioClipSchema,
    resolveKey: (d) => d.audio_key,
    name: "audio_clip",
    failureCode: "clip.extract_failed",
    async run({ c, data, sourceKey, sourcePath, userId, signal, tmpDir }) {
      // zod refine 已保证 end > start，这里再按业务语义限宽（1e-6 容差吃掉浮点误差）
      if (data.end - data.start < MIN_CLIP_DURATION_S - 1e-6) {
        return failCode(422, "clip.invalid_range");
      }
      if (data.end - data.start > MAX_CLIP_DURATION_S) {
        return failCode(422, "clip.range_too_long");
      }

      // 产物容器与源一致：扩展名取自源（无扩展名兜底 .mp3），MIME 由扩展名映射；
      // 未识别的扩展名回退 mpeg（播放器按内容嗅探兜底）。
      // .webm 是音视频共用容器：本路由产物恒为音频流，按音频语境定档
      const ext = path.extname(sourceKey).toLowerCase() || ".mp3";
      const mime = ext === ".webm" ? "audio/webm" : mimeByExt(ext, "audio/mpeg");

      const clip = await extractAudioClip(
        sourcePath,
        path.join(tmpDir, `clip${ext}`),
        { start: data.start, end: data.end },
        signal,
      );

      const stored = await persistDerived({ userId, tmpPath: clip.path, ext, mime });

      return c.json(ok({ ...stored, ext, mime }));
    },
  }),
);

export { router as extractAudioClipRouter };
