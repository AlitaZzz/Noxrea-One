// ============================================================
// 资产领域类型（纯类型）。
// AssetType 定义在 lib/types/assets（lib/constants.ts 需要引用，避免反向依赖领域层），
// 此处转出作为资产公共契约的一部分；MediaType 由共享类型层提供，不重定义也不转出。
// ============================================================

import type { AssetType } from "@/lib/types/assets";
import type { MediaType } from "@/types/media";

export type { AssetType } from "@/lib/types/assets";

/** 资产归属范围；system 为预留值，当前业务仅启用 personal。 */
export type AssetScope = "personal" | "system";

export interface AssetFolder {
  id: string;
  name: string;
  scope: AssetScope;
  kind: "normal" | "uncategorized";
  parentId?: string;
  createdAt: number;
  count: number;
}

export interface AssetItem {
  id: string;
  name: string;
  type: AssetType;
  mediaType: MediaType;
  width: number;
  height: number;
  /** 源文件大小（字节），服务端按 hash 关联 file_objects 得出；缺失为 0 */
  size: number;
  /** 媒体时长（秒），同出自 file_objects 的落盘探测；缺失为 0 */
  duration: number;
  description: string;
  createdAt: number;
  updatedAt: number;
  tags: string[];
  prompt: string;
  folderId?: string;
  scope: AssetScope;
  /** 来源引用：存储 key 或外部 URL（与画布节点 src 同值域）；读地址由解析层按需换取 */
  fileKey?: string;
  sourceType?: string;
}

/** 资产单项更新可写字段；与 store 的实际映射一致，未列字段不允许静默传入。 */
export interface AssetUpdatePatch {
  name?: string;
  type?: AssetType;
  folderId?: string | null;
  tags?: string[];
  prompt?: string;
}

/** 资产批量更新可写字段；后端与 store 只支持 folderId / type。 */
export interface AssetBatchUpdate {
  folderId?: string | null;
  type?: AssetType;
}

export interface CreateAssetInput {
  name: string;
  type: AssetType;
  mediaType?: MediaType;
  description?: string;
  tags?: string[];
  prompt?: string;
  fileKey?: string;
  sourceType?: string;
  folderId?: string;
  scope?: AssetScope;
}
