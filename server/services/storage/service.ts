/**
 * 存储服务入口（specs/storage-s3-backend.md 规则 1）。
 * 引导期（initSettings 之后）构建进程级存储 单例，业务侧经 getStorageBackend() 访问；
 * 不支持热切换——后端选择与连接参数变更一律重启生效。
 */

import { buildManagedFileUrl } from "@noxrea/shared/url";
import { getSetting } from "@server/core/settings";
import { LocalStorageBackend } from "./backends/local";
import { S3Backend, type S3BackendOptions } from "./backends/s3";
import type { StorageBackend, StorageProbeReport } from "./backend";
import { CAPABILITY_URL_TTL_SECONDS } from "./signing";

let backend: StorageBackend | null = null;
/** 启动探测摘要（规则 3.7）：健康检查与启动日志共用的只读口径 */
let probeReport: StorageProbeReport | null = null;

/**
 * 引导期构建存储单例（specs/storage-s3-backend.md 规则 1/2）。
 * selected 缺省时按 `storage.backend` 设置构建：local 直接构造；s3 先做必填键的
 * 跨项联合校验（缺失即抛错并指明键名，启动失败）再构造。
 * 不支持热切换：后端选择与连接参数变更一律重启生效；重复初始化 fail-fast。
 */
export function initStorageBackend(selected?: StorageBackend): void {
  // 双初始化即静默换后端（在途租约与已发布 URL 全部失效），宁可 fail-fast
  if (backend) {
    throw new Error("Storage backend already initialized; backend selection requires a restart");
  }
  backend = selected ?? buildBackendFromSettings();
}

/**
 * 站点来源（scheme + host）：CORS 探测要拿它当 `Origin`，与浏览器实际发出的值一致。
 * 空串（未配置公开地址）返回 undefined，由后端退回通配判定并在探测结论里说明。
 */
function publicOrigin(): string | undefined {
  const raw = getSetting("network.public_base_url");
  if (!raw) return undefined;
  try {
    return new URL(raw).origin;
  } catch {
    // 设置项已按 httpUrlOrEmpty 校验过；这里只防御历史脏值，退回未配置口径
    return undefined;
  }
}

/** S3 连接参数组装（规则 2 设置键 → S3BackendOptions）；后端构建与迁移脚本共用单一来源 */
export function s3OptionsFromSettings(): S3BackendOptions {
  return {
    endpoint: getSetting("storage.s3.endpoint"),
    bucket: getSetting("storage.s3.bucket"),
    region: getSetting("storage.s3.region"),
    accessKeyId: getSetting("storage.s3.access_key_id"),
    secretAccessKey: getSetting("storage.s3.secret_access_key"),
    // 寻址风格与能力基线由 provider profile 决定，不再有独立的寻址开关
    provider: getSetting("storage.s3.provider"),
    prefix: getSetting("storage.s3.prefix"),
    // 后端缺省预签名 TTL 服务能力凭据（上游引用 / 媒体输入 / 直传票据）：
    // 浏览器描述路由显式传自己的 TTL 与窗口，不依赖该缺省
    signedUrlTtlSeconds: CAPABILITY_URL_TTL_SECONDS,
    browserOrigin: publicOrigin(),
  };
}

function buildBackendFromSettings(): StorageBackend {
  if (getSetting("storage.backend") !== "s3") return new LocalStorageBackend();

  const missing = missingS3Settings();
  if (missing.length > 0) {
    throw new Error(`Storage backend s3 requires settings: ${missing.join(", ")}`);
  }

  return new S3Backend(s3OptionsFromSettings());
}

/**
 * S3 连接必填键判定（单一来源，后端构建与迁移脚本共用）：任一键为空即视为连接配置
 * 不完整，缺失键名以 `storage.s3.*` 形式返回。键值取自 s3OptionsFromSettings 组装
 * 结果——键清单与参数组装同源，不会漂移失同步。
 */
export function missingS3Settings(): string[] {
  const o = s3OptionsFromSettings();
  return (
    [
      ["endpoint", o.endpoint],
      ["bucket", o.bucket],
      ["region", o.region],
      ["access_key_id", o.accessKeyId],
      ["secret_access_key", o.secretAccessKey],
    ] as Array<[string, string]>
  )
    .filter(([, value]) => value.trim() === "")
    .map(([key]) => `storage.s3.${key}`);
}

/**
 * 启动探测（bootstrap 调用，specs/storage-provider-portability.md 规则 3.7）：
 * 结果留存供健康检查摘要使用。不支持探测的后端（local）返回 null。
 * 探测失败直接抛错终止启动——禁止带着不可用的签名路径进入服务态。
 */
export async function probeStorageBackend(): Promise<StorageProbeReport | null> {
  const current = getStorageBackend();
  if (!current.probe) return null;
  probeReport = await current.probe();
  return probeReport;
}

/**
 * 就绪口径的存储状态（specs/observability-baseline.md 规则 1.2）：
 * local 后端无探测项，恒为就绪；s3 后端要求启动探测已产出能力摘要。
 * 未初始化（引导未到存储步骤）按不就绪——此时服务确实不能提供文件能力。
 */
export function storageReady(): boolean {
  if (!backend) return false;
  if (!backend.probe) return true;
  return probeReport !== null;
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

/** 存储对象的线上视图（中转上传与直传票据/完成共用同一形状） */
export interface StoredFileView {
  key: string;
  url: string;
  size: number;
  mime_type: string;
  hash: string;
  width: number | null;
  height: number | null;
}

/**
 * 哈希 + 元数据 → 线上视图：key/url 派生与 size 收敛的单一来源，
 * 中转成功项、直传秒传 / 幂等完成 / 提升完成四处构造共用。
 * 入参形状即 file_objects 行的投影，行对象可直接传入。
 */
export function storedFileView(file: {
  userId: number;
  hash: string;
  ext: string;
  size: bigint | number;
  mimeType: string;
  width: number | null;
  height: number | null;
}): StoredFileView {
  const key = buildStorageKey(file.userId, file.hash, file.ext);
  return {
    key,
    url: buildFileUrl(key),
    size: Number(file.size),
    mime_type: file.mimeType,
    hash: file.hash,
    width: file.width,
    height: file.height,
  };
}
