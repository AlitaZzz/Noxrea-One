/**
 * 画布图片分辨率 LOD 的取档策略（specs/canvas-media-resolution-lod.md 规则 3/5）。
 *
 * 纯函数、无 React 依赖：档位选择与滞回是策略，`use-canvas-image-lod` 只负责
 * 订阅 store、结算时机与渲染编排。策略与编排分开后，规则本身可以脱离组件树验证。
 */
import { HEAVY_RESIZE_WIDTH, MAX_RESIZE_WIDTH, normalizeResizeWidth } from "@noxrea/shared/media-tiers";

import { hasManagedStorageKey, managedFileWidthOf } from "@/lib/file-url";

/** 档位等级：0 = 原图；其余为规范档位宽度 */
export const ORIGINAL_LEVEL = 0;

/**
 * 结算延迟（毫秒）：缩放手势与节点尺寸变化共用同一静置窗口，避免逐帧换档
 * （specs/canvas-media-resolution-lod.md 规则 5.1）。单一常量：两处各写一份 200
 * 会让「同一口径」只存在于注释里。
 */
export const LOD_SETTLE_MS = 200;

/** LOD 资格：托管 URL + 静态位图扩展名（GIF/WebP/未知扩展名与外部 URL 走原图） */
const LOD_IMAGE_EXTENSION = /\.(?:png|jpe?g)$/i;

/**
 * 是否适用画布分辨率 LOD（规则 2）：仅托管 `.png/.jpg/.jpeg`；
 * GIF/WebP/未知扩展名与外部 URL、data:、blob: 继续原图。
 *
 * 判定放在画布领域而不是 `lib/file-url`：扩展名白名单是 LOD 的业务规则
 * （哪些源能按档位派生），`lib` 只提供中性的托管/宽度解析。
 */
export function isLodEligibleImageUrl(url: string | null | undefined): url is string {
  if (!hasManagedStorageKey(url)) return false;
  const pathname = url.split(/[?#]/, 1)[0];
  return LOD_IMAGE_EXTENSION.test(pathname);
}

/**
 * 图片解码任务重量（规则 7）：档位 ≤1280 为 1、≥1920 为 2、托管原图为 3；
 * 外部/data:/blob: 无法预知尺寸，按 1。调度器以重量单位计费（容量 4），
 * 保证最多 1 张原图或 2 张大档位同时解码。
 */
export function imageLoadWeight(url: string | null | undefined): number {
  if (!hasManagedStorageKey(url)) return 1;
  const width = managedFileWidthOf(url);
  if (width === null) return 3;
  return normalizeResizeWidth(width) >= HEAVY_RESIZE_WIDTH ? 2 : 1;
}

/** 降档滞回：目标像素低于当前档位宽度的该比例才降档 */
const DOWNGRADE_RATIO = 0.75;

/** contain 后的实际显示宽度（已知宽高比时按比例收窄） */
export function lodCssWidth(width: number, height: number, aspect?: number): number {
  if (!(width > 0) || !(height > 0)) return 0;
  return aspect && aspect > 0 ? Math.min(width, height * aspect) : width;
}

/**
 * 目标像素 → 档位等级（规则 3.5）：
 * 超过最大档或达到自然宽度时回退原图，避免请求比源图更大的派生档位。
 */
export function chooseLodLevel(targetPx: number, naturalWidth?: number): number {
  if (!(targetPx > 0)) return ORIGINAL_LEVEL;
  if (targetPx > MAX_RESIZE_WIDTH) return ORIGINAL_LEVEL;
  const tier = normalizeResizeWidth(targetPx);
  if (naturalWidth && naturalWidth > 0 && (tier > naturalWidth || targetPx >= naturalWidth)) {
    return ORIGINAL_LEVEL;
  }
  return tier;
}

/**
 * 等级的有效像素宽度（原图按自然宽度，未知时按最大档估算）。
 * 用途是**滞回比较**：未知宽度的原图必须给一个有限值，否则降档永远不成立。
 */
export function levelWidth(level: number, naturalWidth?: number): number {
  if (level !== ORIGINAL_LEVEL) return level;
  return naturalWidth && naturalWidth > 0 ? naturalWidth : MAX_RESIZE_WIDTH;
}

/**
 * 在途任务的像素宽度（规则 3.9 的缩小中止比较）。
 *
 * 与 `levelWidth` 是两个问题：滞回要一个有限值，中止判定要「是否更高」。原图的自然
 * 宽度未知时规则明确「视为高于最大档位」——用最大档估算会让目标恰好落在最大档的
 * 缩小手势漏掉中止，在途原图继续解码。
 */
export function inFlightWidth(level: number, naturalWidth?: number): number {
  if (level !== ORIGINAL_LEVEL) return level;
  return naturalWidth && naturalWidth > 0 ? naturalWidth : Number.POSITIVE_INFINITY;
}

/** 换档决策：升级立即生效；降档仅在目标像素低于当前宽度 75% 时生效（规则 5.4） */
export function nextLodLevel(
  current: number | null,
  targetPx: number,
  desired: number,
  naturalWidth?: number,
): number {
  if (current === null) return desired;
  const currentWidth = levelWidth(current, naturalWidth);
  if (levelWidth(desired, naturalWidth) >= currentWidth) return desired;
  return targetPx < currentWidth * DOWNGRADE_RATIO ? desired : current;
}
