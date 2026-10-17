/**
 * 存储服务入口（specs/storage-s3-backend.md 规则 1）。
 * 引导期（initSettings 之后）构建进程级存储单例，业务侧经 getStorageBackend() 访问；
 * 不支持热切换——后端选择与连接参数变更一律重启生效。
 */

import { buildManagedFileUrl } from "@noxrea/shared/url";
import { LocalStorageBackend } from "./backends/local";
import type { StorageBackend } from "./backend";

let backend: StorageBackend | null = null;

/**
 * 引导期构建存储单例。selected 缺省构造 local 后端；
 * settings 键接线后由 bootstrap 按 `storage.backend` 传入 S3 或 local 实现。
 */
export function initStorageBackend(selected?: StorageBackend): void {
  // 双初始化即静默换后端（在途租约与已发布 URL 全部失效），宁可 fail-fast
  if (backend) {
    throw new Error("Storage backend already initialized; backend selection requires a restart");
  }
  backend = selected ?? new LocalStorageBackend();
}

/** 进程级存储后端单例；未引导（bootstrap 之前）访问即抛错 */
export function getStorageBackend(): StorageBackend {
  if (!backend) {
    throw new Error("Storage backend not initialized; call bootstrap() first");
  }
  return backend;
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

/** 构建前端可访问的 URL（/api/files/<storageKey>） */
export function buildFileUrl(storageKey: string): string {
  return buildManagedFileUrl(storageKey);
}
