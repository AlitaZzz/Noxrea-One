/**
 * 帧序列雪碧图路由。
 *
 * 为帧序列面板提供整条轨道的缩略图：一次 ffmpeg 解码后按等间隔采样，把结果拼成
 * 一张雪碧图（storyboard），前端用背景偏移逐格取图。
 *
 * 这是剪辑软件与视频站点的通行做法（Premiere 的 .pek、DaVinci 的 .TMB、YouTube
 * 的 storyboard）：缩略图本质就是「几十张小图」，用位图承载只需几十 KB；若改用
 * 视频代理再逐时间点 seek，产物是 MB 级且抽帧更慢。因此雪碧图与
 * /api/files/video-proxy 的 scrub 代理是两套独立产物，各司其职。
 *
 * 雪碧图文件名内嵌源键并携带帧数与参数版本（`_sprite/{源键去ext}_c{帧数}v{版本}.webp`），
 * 生成一次后长期复用；归属可按内嵌源键解析（specs/file-access-ownership.md）。
 */
import { Hono } from "hono";
import { z } from "zod";
import { createFrameSprite } from "@server/services/storage/video-frames";
import { probeVideoIntegrity, probeVideoMetaCached } from "@server/services/storage/media-probe";
import { ensureArtifact } from "@server/services/storage/artifact";
import { spriteKeyOf } from "@server/services/storage/derived-keys";
import { buildFileUrl } from "@server/services/storage/service";
import { ok, failCode } from "@server/core/response";
import { createMediaEditRoute } from "./media-edit";

const frameSpriteSchema = z.object({
  video_key: z.string().min(1),
});

/** 单格宽度（px）：与轨道上单格的显示宽度同量级，再大只是白白增加体积 */
const CELL_WIDTH = 160;
/** 目标粒度：每格约 0.5 秒，让不同时长视频的选帧手感一致 */
const TARGET_SEC_PER_FRAME = 0.5;
/**
 * 帧数上下限。上限 20 同时兜住两件事：单格显示宽度不低于 50px（再窄认不出画面），
 * 雪碧图体积可控；下限 8 避免短视频只剩稀疏几格。
 */
const MIN_FRAMES = 8;
const MAX_FRAMES = 20;
/**
 * 雪碧图参数版本：采样或编码参数变化后自动生成新图，不命中旧缓存。
 * v2：截断文件的采样时长从容器声明值收敛为实际可解码时长，旧图的
 * 超出部分是坏帧，必须整体重生成。
 */
const SPRITE_VERSION = 2;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

const router = new Hono();

router.post(
  "/api/files/frame-sprite",
  createMediaEditRoute({
    schema: frameSpriteSchema,
    resolveKey: (d) => d.video_key,
    name: "sprite",
    failureCode: "frame_sprite.generation_failed",
    // 只产出可缓存的派生产物，不落库新文件：不计数（限流保护的是存储增长），
    // 重型开销由媒体池的个人与全局限额约束
    persistsFileObject: false,
    async run({ c, sourceKey, sourceInput, userId, signal }) {
      const meta = await probeVideoMetaCached(sourceInput);
      const declaredDuration = meta?.duration ?? null;
      // 拿不到时长就无法把格子映射到时间轴，采样间隔无从计算——此时只能放弃缩略图。
      // 面板退化为「只有播放头」仍可定位与截取：成片抽帧走后端精确 seek
      if (!declaredDuration) {
        return failCode(422, "frame_sprite.duration_unavailable");
      }

      // 容器声明时长可能大于实际数据（下载中断的截断文件：moov 完整、mdat 只有前段）。
      // 按声明时长采样会把超出部分铺满坏帧，且与代理、播放器的时长对不上；
      // 这里把采样收敛到实际可解码范围，并随响应下发标记，前端在面板上给出警示
      const integrity = await probeVideoIntegrity(sourceInput, declaredDuration, { signal, owner: userId });
      const duration =
        integrity.truncated && integrity.decodableDuration
          ? integrity.decodableDuration
          : declaredDuration;
      const truncated = integrity.truncated && integrity.decodableDuration !== null;

      // 密度由时长决定（每格约 TARGET_SEC_PER_FRAME 秒）后钳到上下限：
      // 10 秒内的视频能拿到 0.5 秒粒度，更长的视频固定 20 格、粒度随之变粗
      const count = clamp(Math.ceil(duration / TARGET_SEC_PER_FRAME), MIN_FRAMES, MAX_FRAMES);
      const fps = meta?.fps ?? null;

      // 图名内嵌源键并携带帧数与参数版本（_c{count}v{N}）：调整任一参数自动生成
      // 新图，不命中旧规格缓存；构造与解析同址于 derived-keys，归属可解析
      // （specs/file-access-ownership.md 规则 7）
      const spriteKey = spriteKeyOf(sourceKey, count, SPRITE_VERSION);

      const payload = {
        url: buildFileUrl(spriteKey),
        count,
        cell_width: CELL_WIDTH,
        duration,
        fps,
        truncated,
        declared_duration: declaredDuration,
      };

      await ensureArtifact({
        key: spriteKey,
        signal,
        produce: (tmpPath, genSignal) =>
          createFrameSprite(sourceInput, tmpPath, { count, cellWidth: CELL_WIDTH, duration }, userId, genSignal),
      });
      return c.json(ok(payload));
    },
  }),
);

export { router };
