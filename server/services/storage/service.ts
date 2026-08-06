/**
 * 存储服务入口。
 * 聚合存储后端，提供上传保存、下载 URL 与密钥构建等统一访问入口。
 */

import { localStorage } from "./backends/local";
import type { StorageBackend } from "./backend";

const currentBackend: StorageBackend = localStorage;

/** 从文件路径保存上传文件 */
export async function saveUploadFromPath(
  key: string,
  tempPath: string
): Promise<void> {
  await currentBackend.save(key, tempPath);
}

/**
 * 构建存储路径（对齐 Python persist.py）：
 * {userId}/{hash[:2]}/{hash}{ext}
 *
 * 示例：3/04/04cfb9ad9ba34116ba7524bb9b15c600.png
 */
export function buildStorageKey(
  userId: number,
  hash: string,
  ext: string
): string {
  const sub = hash.slice(0, 2);
  return `${userId}/${sub}/${hash}${ext}`;
}

/** 构建前端可访问的 URL（对齐 Python settings.PUBLIC_URL + /api/files/...） */
export function buildFileUrl(storageKey: string): string {
  return `/api/files/${storageKey}`;
}
