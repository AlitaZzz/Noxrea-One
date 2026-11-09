/**
 * 资产库前后端共享契约：批量上限、名称长度与分页游标编解码。
 * 只包含值契约，不依赖 zod 或任何运行环境。
 */

/** 单次批量操作（创建 / 更新 / 删除）的素材数量上限；前端按同一上限分片提交，服务端仅作兜底校验。 */
export const ASSET_BATCH_LIMIT = 200;

/** 素材名称长度上限；前端输入限制与服务端校验共用。 */
export const ASSET_NAME_MAX_LENGTH = 200;

/** 资产列表 keyset 游标：`<createdAt 毫秒>_<id>`，前后端共用同一编解码契约。 */
export interface AssetCursor {
  createdAtMs: number;
  id: number;
}

export function encodeAssetCursor(createdAtMs: number, id: number): string {
  return `${createdAtMs}_${id}`;
}

export function parseAssetCursor(raw: string): AssetCursor | null {
  const match = /^(\d+)_(\d+)$/.exec(raw);
  if (!match) return null;
  return { createdAtMs: Number(match[1]), id: Number(match[2]) };
}
