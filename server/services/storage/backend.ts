/**
 * 存储后端抽象（specs/storage-s3-backend.md 业务规则 3）。
 * 命名对齐对象存储主流动词（put/get/stat/delete/list）；
 * 「对象存储」与「本地工作区（临时文件、原子写）」职责分离——临时区统一在本地盘
 * （workspace.ts），任何后端下派生产物都先写工作区临时文件再发布。
 */

import type { Readable } from "stream";

export interface StorageBackend {
  /**
   * 保存（服务端直写：派生产物、AI 结果、local 中转上传）；S3 按 key 扩展名写 Content-Type。
   * 未知长度的 ReadableStream 需先落工作区 tmp 再上传（S3 单请求上传要求已知 Content-Length）；
   * 现有调用方（ensureArtifact / media-ops）实际都先经 tmp 文件。
   * 内容寻址（key 即内容 hash）语义：目标已存在且大小一致 ⇒ 内容一致，视为成功（幂等 PUT）。
   */
  put(key: string, source: string | Buffer | ReadableStream): Promise<void>;
  /** 读取流（Node Readable）；range 供 proxy 分发模式透传 Range（206/416 语义由路由层组装） */
  get(
    key: string,
    opts?: {
      range?: { start: number; end?: number };
      signal?: AbortSignal;
    },
  ): Promise<Readable>;
  /** 文件信息；null = 不存在（S3：HeadObject 404）。key 逃出后端命名空间（路径穿越）时抛 StorageTraversalError */
  stat(key: string): Promise<{ size: number; mtimeMs: number } | null>;
  /** 删除该 key 的一切：主对象 + `_cache` / `_posters` 派生（经 list 按 stem 枚举）；不存在视为成功 */
  delete(key: string): Promise<void>;
  /** 按前缀枚举（派生清理、staging 清扫、全 bucket 审计）；lastModifiedMs 供按龄清扫判定 */
  list(prefix: string): Promise<Array<{ key: string; size: number; lastModifiedMs: number }>>;
  /** 预签名 GET（重定向分发、媒体工具输入）；不支持的后端不实现 */
  presignGet?(key: string, opts?: {
    ttlSeconds?: number;
    dispositionFilename?: string;
    cacheControl?: string;
  }): Promise<string>;
  /** 预签名 PUT（直传）；不支持的后端不实现 */
  presignPut?(key: string, opts?: { ttlSeconds?: number; contentType?: string }): Promise<string>;
  /**
   * 本地路径能力：把存储 key 解析为本地绝对路径（后端命名空间内）；不支持的后端不实现。
   * 媒体源解析（media-source.ts）据此分派：有 presignGet 走 URL，否则要求本能力。
   */
  resolveLocalPath?(key: string): string;
}

/** key 试图逃出后端命名空间（本地路径穿越）；由后端在解析 key 时抛出，路由层映射 403 */
export class StorageTraversalError extends Error {
  constructor(key: string) {
    super(`Storage key escapes backend namespace: ${key}`);
    this.name = "StorageTraversalError";
  }
}

/**
 * 业务规则 9 的枚举半边（接口级规则，各后端共享同一实现）：源 key 的派生产物——
 * `_cache` / `_posters` 下以 `/<stem>.webp` 结尾的对象。删除力学（含空目录回收）由各后端自理；
 * `_sprite` / `_proxy` 文件名由源键单向哈希派生、无法反查，不在此列，由 TTL 清扫兜底。
 */
export async function listDerivedArtifactKeys(
  backend: StorageBackend,
  key: string,
): Promise<string[]> {
  const stem = key.replace(/\.[^.]+$/, "");
  const hits: string[] = [];
  for (const root of ["_cache", "_posters"]) {
    for (const entry of await backend.list(`${root}/`)) {
      if (entry.key.endsWith(`/${stem}.webp`)) hits.push(entry.key);
    }
  }
  return hits;
}
