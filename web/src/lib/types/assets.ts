/**
 * 资产的纯类型（目前仅分类枚举）。
 *
 * 下沉到 lib 层的原因同 lib/types/canvas.ts：
 * `lib/constants.ts` 的 ASSET_CATEGORIES 需要它，而 lib 不允许反向依赖领域层。
 * 资产实体类型从这里转出，作为 `@/entities/asset` 公共契约的一部分。
 */

export type AssetType = "character" | "scene" | "object" | "style" | "audio" | "other";
