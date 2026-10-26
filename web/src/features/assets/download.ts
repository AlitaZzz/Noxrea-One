/**
 * 资产下载：走统一的下载工具（downloadManagedFile），与节点/预览浮层同一套
 * 访问描述契约——先向解析层换取下载地址（signed 把附件名签入 URL，stream 带查询参数），
 * 失败时由该工具发出轻量错误消息（重复点击允许重复提示）。
 */
import { downloadManagedFile } from "@/lib/utils/download";

import type { AssetItem } from "./types";

/** 触发浏览器下载单个素材（来源引用为 key 或外部 URL，展示时派生访问 URL）。 */
export function downloadAsset(asset: Pick<AssetItem, "fileKey" | "name">) {
  void downloadManagedFile(asset.fileKey, asset.name);
}
