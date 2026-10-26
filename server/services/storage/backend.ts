/**
 * 存储后端抽象（specs/storage-s3-backend.md 业务规则 3）。
 * 命名对齐对象存储主流动词（put/get/stat/delete/list）；
 * 「对象存储」与「本地工作区（临时文件、原子写）」职责分离——临时区统一在本地盘
 * （workspace.ts），任何后端下派生产物都先写工作区临时文件再发布。
 */

import type { Readable } from "stream";

import { isStorageKey } from "@noxrea/shared/url";
import { derivedCandidatesOf } from "./derived-keys";
import type { StorageCapabilities, StorageProvider } from "./providers";

/** 直传在途暂存命名空间（staging/{userId}/{uuid}，归属编码在 key 里）；直传、staging 清扫、迁移/审计分类共用 */
export const STAGING_PREFIX = "staging/";

/**
 * staging key 严格形态：{prefix}{userId}/{uuid-v4}。
 * 直传 ticket 校验与归属解析（ownership.ts）共用同一形态知识，防止两份拷贝漂移。
 */
export const STAGING_KEY_PATTERN = new RegExp(
  `^${STAGING_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\d+)/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`,
);

/**
 * 派生产物命名空间前缀（本地与对象存储同构；迁移/审计分类与派生 TTL 清扫的根清单同源于此）。
 * `_tmp` 是工作区临时区，不属对象命名空间，不在此列（审计计数另行并入）。
 * 派生删除联动经 listDerivedArtifactKeys 覆盖全部四根（specs/derived-deletion-linkage.md 规则 1）。
 */
export const DERIVED_ROOT_PREFIXES = ["_cache/", "_posters/", "_sprite/", "_proxy/"] as const;

/**
 * 启动探测对象命名空间（specs/storage-provider-portability.md 规则 3.2）：
 * 不在可读键域内，也不属于派生四根；删除失败由 GC 的独立按龄清扫兜底。
 */
export const PROBE_ROOT_PREFIX = "_probe/";

export interface StorageBackend {
  /**
   * 保存（服务端直写：派生产物、AI 结果、local 中转上传）；S3 按 key 扩展名写 Content-Type。
   * 未知长度的 ReadableStream 需先落工作区 tmp 再上传（S3 单请求上传要求已知 Content-Length）；
   * 现有调用方（ensureArtifact / media-ops）实际都先经 tmp 文件。
   * 内容寻址（key 即内容 hash）语义：目标已存在且大小一致 ⇒ 内容一致，视为成功（幂等 PUT）。
   */
  put(key: string, source: string | Buffer | ReadableStream): Promise<void>;
  /** 读取流（Node Readable）；range 供流式字节路由透传 Range（206/416 语义由路由层组装） */
  get(
    key: string,
    opts?: {
      range?: { start: number; end?: number };
      signal?: AbortSignal;
    },
  ): Promise<Readable>;
  /**
   * 文件信息；null = 不存在（S3：HeadObject 404）。key 逃出后端命名空间（路径穿越）时抛 StorageTraversalError。
   * 接口只携带传输必需的最小信息（size/mtime）；ETag 等后端特定字段不进接口——
   * ETag 消费方（迁移脚本）直接以 SDK 读对象 ETag，不经 stat。
   */
  stat(key: string): Promise<{ size: number; mtimeMs: number } | null>;
  /** 删除该 key 的一切：主对象 + 四命名空间派生（经 listDerivedArtifactKeys 精准 shard 枚举）；不存在视为成功 */
  delete(key: string): Promise<void>;
  /** 按前缀枚举（派生清理、staging 清扫、全 bucket 审计）；lastModifiedMs 供按龄清扫判定 */
  list(prefix: string): Promise<Array<{ key: string; size: number; lastModifiedMs: number }>>;
  /**
   * 子前缀列举能力：prefix 下一层的「目录型子前缀」（含查询前缀本身与尾随 /，
   * 如 "_posters/" → ["_posters/v1/", "_posters/v2/"]）。派生删除联动的版本段发现
   * 是其唯一消费方（specs/derived-deletion-linkage.md 规则 2）；不支持的后端不实现，
   * 联动对 `_posters` 退化为全前缀 list 兜底（联动语义完整，成本回到全扫描）。
   */
  listCommonPrefixes?(prefix: string): Promise<string[]>;
  /** 预签名 GET（浏览器直连描述、媒体工具输入、上游引用）；不支持的后端不实现 */
  presignGet?(key: string, opts?: {
    ttlSeconds?: number;
    /**
     * 签名时间窗（正整数秒）：窗口内同一 key 签出字节一致的 URL，长度即缓存寿命上限。缺省为
     * 后端既有的 TTL/4 对齐窗口——能力型凭据（上游拉取、媒体工具输入）用它保持
     * 「URL 可作进程内缓存键、有效期短」的语义；浏览器读路径显式传长窗口以延长缓存寿命
     * （两者均见 specs/storage-signed-direct-delivery.md 规则 4.2 / 4.6）。
     */
    windowSeconds?: number;
    /** 预签名响应应携带的 Content-Disposition 头值（调用方组装，单一来源 file-response.ts） */
    responseContentDisposition?: string;
    cacheControl?: string;
  }): Promise<string>;
  /** 预签名 PUT（直传）；不支持的后端不实现 */
  presignPut?(key: string, opts?: { contentType?: string }): Promise<string>;
  /**
   * 本地路径能力：把存储 key 解析为本地绝对路径（后端命名空间内）；不支持的后端不实现。
   * 媒体源解析（media-source.ts）据此分派：有 presignGet 走 URL，否则要求本能力。
   */
  resolveLocalPath?(key: string): string;
  /**
   * 同后端服务端复制（直传提升：staging → 内容寻址 key）；不支持的后端不实现。
   * S3 为 CopyObject（同 bucket 服务端复制，字节不出网）；目标已存在时覆盖。
   */
  copy?(fromKey: string, toKey: string): Promise<void>;
  /**
   * 进程级能力位（规则 4.1）：能签预签名 URL 的后端必须实现，供读路径判定
   * `response-*` 覆盖与下载形态（二者成对出现，缺一按「不支持签名直达」处理）。
   * 不支持预签名的后端不实现。
   */
  capabilities?(): StorageCapabilities;
  /**
   * 启动探测（S3：六项连通/写/读/stat/预签名回读/覆盖头，失败即启动失败）；
   * 返回能力摘要供启动日志与健康检查展示（规则 3.7）。不支持的后端不实现。
   */
  probe?(): Promise<StorageProbeReport>;
}

/** 启动探测摘要（规则 3.7）：结构化日志与健康检查共用的只读口径 */
export interface StorageProbeReport {
  provider: StorageProvider;
  capabilities: StorageCapabilities;
  /** 端点相对本机的时钟偏差（秒，正数表示端点更快；SigV4 容差 15 分钟） */
  clockSkewSeconds: number;
  /** 非致命发现（CORS 未放行、暴露头缺失、探测对象删除失败等） */
  warnings: string[];
}

/**
 * 直传双模式可用性（业务规则 6）：预签名 PUT（客户端直传链路入口）与服务端复制
 * （staging 提升到内容寻址 key）是同一条链路的两半，缺一不可。mode 通告
 * （upload-limits）、ticket、complete 三处共用此单一判定：杜绝「通告可直传但
 * complete 必 409」的口径漂移，并把不可用失败提前到票据签发处（客户端字节
 * 尚未出发）。类型谓词同时收窄 presignPut / copy 为必实现，调用点免非空断言。
 * 单能力分支（presignGet / resolveLocalPath 各自的特性分派）仍由调用点方法探测，
 * TS 收窄可用，不另造能力对象。
 */
export type DirectUploadBackend = StorageBackend & {
  presignPut: NonNullable<StorageBackend["presignPut"]>;
  copy: NonNullable<StorageBackend["copy"]>;
};

export function supportsDirectUpload(
  backend: StorageBackend,
): backend is DirectUploadBackend {
  return typeof backend.presignPut === "function" && typeof backend.copy === "function";
}

/**
 * 签名直连读的成对能力：`presignGet` 与 `capabilities` 缺一不可——读路径要用能力位
 * 决定覆盖头与下载形态（specs/storage-provider-portability.md 规则 4.2 / 4.3），
 * 少任一项即按「不支持签名直达」走应用流，避免在能力未知时盲目签址。
 */
export type SignedReadBackend = StorageBackend & {
  presignGet: NonNullable<StorageBackend["presignGet"]>;
  capabilities: NonNullable<StorageBackend["capabilities"]>;
};

export function supportsSignedRead(
  backend: StorageBackend,
): backend is SignedReadBackend {
  return typeof backend.presignGet === "function" && typeof backend.capabilities === "function";
}

/** key 试图逃出后端命名空间（本地路径穿越）；由后端在解析 key 时抛出，路由层映射 403 */
export class StorageTraversalError extends Error {
  constructor(key: string) {
    super(`Storage key escapes backend namespace: ${key}`);
    this.name = "StorageTraversalError";
  }
}

/**
 * 接口层 key 的形态守卫（全仓唯一实现）：绝对形态与含 `..` 的路径段一律不可寻址。
 *
 * 这两种形态在 local 后端是路径穿越（`path.resolve` 会以 `/` 起首的 key 整体替换
 * base），在对象存储则是永不写入的脏 key。读管线据此回 403 `invalid_path`，各后端
 * 在寻址前据此抛 {@link StorageTraversalError}——两处必须是同一条判定，否则一处
 * 放宽就是另一处的洞。
 *
 * 只判形态，不判包含关系：真实落盘路径的包含判定仍由 `core/paths.ts` 的
 * `isPathWithinBase` 负责（Windows 反斜杠、盘符等平台差异只有解析后的路径能看到）。
 */
export function isKeyWithinNamespace(key: string): boolean {
  return !key.startsWith("/") && !key.split("/").some((segment) => segment.includes(".."));
}

/**
 * 业务规则 9 的枚举半边（接口级规则，各后端共享不变量：「派生产物只挂内容寻址 key」）：
 * 按 specs/derived-deletion-linkage.md 规则 1/2 以精准 shard 前缀枚举四命名空间派生产物
 * （构造、解析、枚举三面知识同址 derived-keys.ts）。staging / 派生 / 畸形 key 短路返回 []——
 * staging 清扫等逐 key 删除不为每个 key 付 list 流量；staging 源的派生缓存由 TTL 清扫兜底。
 * 删除力学（含空目录回收）由各后端自理。
 */
export async function listDerivedArtifactKeys(
  backend: StorageBackend,
  key: string,
): Promise<string[]> {
  if (!isStorageKey(key)) return [];
  const posterVersions = (await backend.listCommonPrefixes?.("_posters/")) ?? null;
  const candidates = derivedCandidatesOf(key, posterVersions);
  const hits: string[] = [];
  for (const candidate of candidates) {
    for (const entry of await backend.list(candidate.prefix)) {
      if (candidate.test(entry.key)) hits.push(entry.key);
    }
  }
  return hits;
}
