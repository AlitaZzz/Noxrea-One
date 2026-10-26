/**
 * 媒体派生宽度档位与缓存版本契约（specs/canvas-media-resolution-lod.md 规则 4）。
 *
 * 前后端唯一来源：客户端按屏幕目标像素选档，服务端按同一张表归一化 `?w=`；
 * 档位表或缩放像素语义变化时同步提升 `RESIZE_CACHE_VERSION`，服务端派生键
 * 从该常量取得新的版本段（`_cache/v2/`），旧派生对象自然失效。
 */

/** 托管图片/视频海报的派生宽度档位（升序；服务端向上取档、最大档封顶） */
export const RESIZE_WIDTH_TIERS = [
  64, 112, 200, 300, 320, 400, 480, 640, 960, 1280, 1920, 2560,
] as const;

type ResizeWidthTier = (typeof RESIZE_WIDTH_TIERS)[number];

/** 最大派生宽度：目标像素超过它时直接使用原图（不再派生更大档位） */
export const MAX_RESIZE_WIDTH: ResizeWidthTier =
  RESIZE_WIDTH_TIERS[RESIZE_WIDTH_TIERS.length - 1];

/**
 * 大档位下界（含）：解码重量按它分段（specs/canvas-media-resolution-lod.md 规则 7.2）。
 * 与档位表同处一地——调整档位时重量分界必须一起看，不允许在消费点写字面量。
 */
export const HEAVY_RESIZE_WIDTH: ResizeWidthTier = 1920;

/**
 * `_cache` 派生键命名空间版本：缩放处理语义（方向、质量、算法、档位含义）变化时 +1。
 * 服务端只读写当前版本；版本段内嵌在对象 key 中，升级即换对象，浏览器缓存自然失效。
 */
export const RESIZE_CACHE_VERSION = 2;

/** 请求宽度向上归一到档位表；超过最大档一律最大档。 */
export function normalizeResizeWidth(width: number): number {
  for (const tier of RESIZE_WIDTH_TIERS) {
    if (width <= tier) return tier;
  }
  return MAX_RESIZE_WIDTH;
}
