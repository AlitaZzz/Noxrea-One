/**
 * 预览代理视频路由。
 *
 * 为帧序列面板的拖动预览提供低分辨率副本：原视频多为长 GOP（x264 默认 250 帧
 * 一个关键帧），直接拖动要从 GOP 起点一路解码过来，明显发涩。副本取 1 秒 GOP——
 * 刻意不用全 I 帧：全 I 帧 seek 最快，但放弃帧间预测后同画质码率是长 GOP 的
 * 3～5 倍，代理文件反而比原视频还大；1 秒 GOP 下 seek 最多解码 1 秒画面（几十
 * 毫秒），拖动已经无感，体积则降到全 I 帧的三分之一左右。
 *
 * 轨道缩略图不走这里，改由 /api/files/frame-sprite 出雪碧图（几十 KB）：
 * 缩略图与 scrub 代理是两套独立产物，这也是剪辑软件的通行做法。
 *
 * 截断文件（moov 声明时长 > 实际数据）：ffmpeg 解码到数据断点即止且正常退出，
 * 转出的代理天然只含可解码前缀，与雪碧图收敛后的时长（见 probeVideoIntegrity）
 * 一致，因此这里不做额外校验。
 *
 * 代理文件名内嵌源键并携带宽度与参数版本（`_proxy/{源键去ext}_w{宽度}v{版本}.mp4`），
 * 生成一次后长期复用；成片抽帧仍走原视频。归属可按内嵌源键解析（specs/file-access-ownership.md）。
 * v3：宽度从 720 降到 480——刻意压低代理画质，模糊即可肉眼分辨当前播放源。
 */
import { Hono } from "hono";
import { z } from "zod";
import { createScrubProxy } from "@server/services/storage/video-frames";
import { probeVideoMetaCached } from "@server/services/storage/media-probe";
import { ensureArtifact } from "@server/services/storage/artifact";
import { proxyKeyOf } from "@server/services/storage/derived-keys";
import { cleanupStaleDerived } from "@server/services/storage/derived-cleanup";
import { mediaSourceInput, resolveMediaSource } from "@server/services/storage/media-source";
import { buildFileUrl } from "@server/services/storage/service";
import { ok } from "@server/core/response";
import { createMediaEditRoute } from "./media-edit";

const videoProxySchema = z.object({
  video_key: z.string().min(1),
});

/** 代理宽度：480 刻意低于节点显示宽度，画质发虚便于肉眼区分当前播放的是
    代理还是原视频（模糊 = 代理）；选帧面板只做定位预览，清晰度可让 */
const PROXY_WIDTH = 480;
/** 代理参数版本：编码参数变化后自动生成新代理，不命中旧缓存 */
const PROXY_VERSION = 3;
/** 代理存活时间：过期后删除，下次打开面板会自动重建 */
const PROXY_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** 读取代理文件的真实时长（探一次后进缓存）；拿不到返回 null */
async function proxyDurationOf(proxyKey: string): Promise<number | null> {
  const source = await resolveMediaSource(proxyKey);
  return (await probeVideoMetaCached(mediaSourceInput(source)))?.duration ?? null;
}

const router = new Hono();

router.post(
  "/api/files/video-proxy",
  createMediaEditRoute({
    schema: videoProxySchema,
    resolveKey: (d) => d.video_key,
    name: "proxy",
    failureCode: "video_proxy.generation_failed",
    // 只产出可缓存的派生产物，不落库新文件：不计数（限流保护的是存储增长），
    // 重型开销由媒体池的个人与全局限额约束
    persistsFileObject: false,
    async run({ c, sourceKey, sourceInput, userId, signal }) {
      // 帧率与分辨率：读取容器信息，开销可忽略。
      // 分辨率用来避免把小视频放大——源本身不足 PROXY_WIDTH 时按原尺寸生成；
      // 帧率用来把关键帧间隔定成 1 秒——探测结果在雪碧图路由间共用，只跑一次
      const meta = await probeVideoMetaCached(sourceInput);
      const width = meta?.width && meta.width > 0
        ? Math.min(PROXY_WIDTH, meta.width)
        : PROXY_WIDTH;

      // 代理名内嵌源键并携带宽度与参数版本（_w{width}v{N}）：同一视频反复打开面板
      // 直接命中缓存；宽度或版本变化自动生成新代理，不命中旧缓存；构造与解析同址
      // 于 derived-keys，归属可解析（specs/file-access-ownership.md 规则 7）
      const proxyKey = proxyKeyOf(sourceKey, width, PROXY_VERSION);
      const fps = meta?.fps ?? null;

      // 顺带做一次低频清理，不阻塞本次请求
      void cleanupStaleDerived("_proxy/", PROXY_TTL_MS);

      await ensureArtifact({
        key: proxyKey,
        signal,
        produce: (tmpPath, genSignal) => createScrubProxy(sourceInput, tmpPath, width, fps, userId, genSignal),
      });
      return c.json(ok({ url: buildFileUrl(proxyKey), fps, duration: await proxyDurationOf(proxyKey) }));
    },
  }),
);

export { router };
