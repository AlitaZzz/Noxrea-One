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
import { peekVideoMetaCached, probeVideoMetaCached, type VideoMeta } from "@server/services/storage/media-probe";
import { ensureArtifact, isPublishedArtifact, recordArtifactHit } from "@server/services/storage/artifact";
import { proxyKeyOf } from "@server/services/storage/derived-keys";
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

/** 读取代理文件的真实时长（按代理键缓存）；拿不到返回 null */
async function proxyDurationOf(proxyKey: string, signal?: AbortSignal): Promise<number | null> {
  const source = await resolveMediaSource(proxyKey);
  return (await probeVideoMetaCached(mediaSourceInput(source), proxyKey, signal))?.duration ?? null;
}

interface ProxyPlan {
  proxyKey: string;
  width: number;
  fps: number | null;
}

/**
 * 由源键与探测结果推导产物计划。常规链路与租约前预检查必须算出同一个产物键，
 * 两侧各写一遍迟早漂移，因此收敛为同一纯函数。
 */
function planProxy(sourceKey: string, meta: VideoMeta | null): ProxyPlan {
  // 分辨率用来避免把小视频放大——源本身不足 PROXY_WIDTH 时按原尺寸生成
  const width = meta?.width && meta.width > 0
    ? Math.min(PROXY_WIDTH, meta.width)
    : PROXY_WIDTH;

  // 代理名内嵌源键并携带宽度与参数版本（_w{width}v{N}）：同一视频反复打开面板
  // 直接命中缓存；宽度或版本变化自动生成新代理，不命中旧缓存；构造与解析同址
  // 于 derived-keys，归属可解析（specs/file-access-ownership.md 规则 7）
  return {
    proxyKey: proxyKeyOf(sourceKey, width, PROXY_VERSION),
    width,
    fps: meta?.fps ?? null,
  };
}

function proxyPayload(plan: ProxyPlan, duration: number | null) {
  return { url: buildFileUrl(plan.proxyKey), fps: plan.fps, duration };
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
    // 产物、源元数据与代理元数据缓存都热时，在源租约前直接返回：不再下载整段源。
    // precheck 契约（specs/media-processing-concurrency.md）禁止触发 ffprobe：
    // 代理元数据未缓存时退回常规链路，由 run 探测并填充缓存。产物 stat 放在最后：
    // 前面的缓存任一未热都不会真正复用，也就不该产生命中计数。
    async precheck({ c, sourceKey }) {
      const meta = peekVideoMetaCached(sourceKey);
      if (!meta) return null;
      const plan = planProxy(sourceKey, meta);
      const proxyMeta = peekVideoMetaCached(plan.proxyKey);
      if (!proxyMeta) return null;
      if (!(await isPublishedArtifact(plan.proxyKey))) return null;
      recordArtifactHit(plan.proxyKey);
      return c.json(ok(proxyPayload(plan, proxyMeta.duration)));
    },
    async run({ c, sourceKey, sourceInput, userId, signal }) {
      // 帧率与分辨率：读取容器信息，开销可忽略——探测结果按源键缓存，
      // 与雪碧图路由共用，只跑一次
      const meta = await probeVideoMetaCached(sourceInput, sourceKey, signal);
      const plan = planProxy(sourceKey, meta);

      await ensureArtifact({
        key: plan.proxyKey,
        signal,
        produce: (tmpPath, genSignal) =>
          createScrubProxy(sourceInput, tmpPath, plan.width, plan.fps, userId, genSignal),
      });
      return c.json(ok(proxyPayload(plan, await proxyDurationOf(plan.proxyKey, signal))));
    },
  }),
);

export { router };
