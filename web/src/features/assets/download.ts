/**
 * 资产下载：走统一的浏览器下载触发工具（downloadManagedFile），
 * 与节点/预览浮层同一套 URL 构造契约（?download=true&filename=）。
 */
import { downloadManagedFile } from "@/lib/utils/download";

import type { AssetItem } from "./types";

/** 触发浏览器下载单个素材（来源引用为 key 或外部 URL，展示时派生访问 URL）。 */
export function downloadAsset(asset: Pick<AssetItem, "fileKey" | "name">) {
  downloadManagedFile(asset.fileKey, asset.name);
}
