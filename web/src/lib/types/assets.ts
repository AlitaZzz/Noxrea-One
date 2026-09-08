/**
 * 资产的纯类型（目前仅分类枚举）。
 *
 * 下沉到 lib 层的原因同 lib/types/canvas.ts：
 * `lib/constants.ts` 的 ASSET_CATEGORIES 需要它，而 lib 不允许反向依赖 feature 层。
 * features/assets/types.ts 会从这里转出，上层导入路径保持不变。
 */

export type AssetType = "character" | "scene" | "object" | "style" | "audio" | "other";
