/**
 * 访问解析的协议层（specs/storage-signed-direct-delivery.md 规则 2 / 3）。
 *
 * 值域分流、请求归一、缓存键、stream 地址构造与描述边界校验都收敛在这里：
 * 全部是纯函数，不持有会话状态、不发请求、不读设备存储。协议变化（新增描述字段、
 * 调整 URL 形态）只改本文件，不会牵动缓存与批次调度。
 */
import {
  buildManagedFileQueryUrl,
  getManagedStorageKey,
  resolveFileUrl,
} from "@noxrea/shared/url";

export type FileDelivery = "signed" | "stream";

/**
 * 描述结果（规则 2.3）：`signed` 必须携带 `expiresAt`（Unix 秒），`refreshAt` 可选——
 * 缺省表示服务端未给出建议时刻，由 `expiryOf` 按「失效前 60 秒」兜底；`stream` 无
 * 寿命概念。用判别联合表达，缓存与过期判定无需对形态字段做防御。
 */
export type FileAccessDescriptor =
  | { url: string; delivery: "stream" }
  | { url: string; delivery: "signed"; expiresAt: number; refreshAt?: number };

/** 解析结果：外部 URL 原样返回（无 delivery），托管值由描述接口给出 */
export interface ResolvedMediaUrl {
  url: string;
  delivery?: FileDelivery;
}

/**
 * 访问描述（Hook 主动刷新用）：在最终地址之外保留 signed 的寿命字段。
 * 普通消费方只需要地址，`resolveMediaUrl` 返回收窄后的形态。
 */
export interface ResolvedMediaAccess extends ResolvedMediaUrl {
  expiresAt?: number;
  refreshAt?: number;
}

/**
 * 逐条描述失败（规则 2.3 / 2.4）：整批 200，失败条目只给错误码。
 * 错误码与接口信封同源，展示文案由 `error` 命名空间的 i18n 提供。
 */
export class FileAccessError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(`File access failed: ${code}`);
    this.name = "FileAccessError";
    this.code = code;
  }
}

export interface FileAccessOptions {
  /** 下载语义：signed 把 disposition 签入 URL，stream 在 URL 上带 download/filename */
  download?: boolean;
  filename?: string;
  /** 跳过缓存重新描述（媒体 403/404 时调用一次） */
  forceRefresh?: boolean;
  signal?: AbortSignal;
}

/** 归一化后的描述请求：缓存键、批量条目与流式 URL 构造都以它为准 */
export interface AccessRequest {
  key: string;
  width?: number;
  download?: boolean;
  filename?: string;
}

/** 无 `refreshAt` 时的提前失效余量：避免拿着即将过期的 URL 发起媒体请求（主动刷新共用） */
export const EXPIRY_SKEW_MS = 60_000;

/**
 * 托管引用值判定（解析层的唯一输入契约）：同时接受存储 key 与托管 URL，
 * 外部 http(s) / data: / blob: 与畸形托管路径返回 false。
 *
 * 直接以描述请求能否构造出来判定，不另写一遍值域分流：判定与解析共用同一条
 * 规则，杜绝「判为托管却不发请求」或反向的分类漂移。
 */
export function isManagedMediaValue(value: string | null | undefined): value is string {
  return typeof value === "string" && requestOf(value, {}) !== null;
}

/** 逻辑 URL / 存储 key → 描述请求；非托管值、畸形托管路径或空 key 返回 null */
export function requestOf(value: string, options: FileAccessOptions): AccessRequest | null {
  // 存储 key 先归一为托管路径（规则 3.1 值域分流：key 与托管 URL 同等对待）；
  // 片段只属于客户端，归一前剥离，带片段的 key（如 `key#t=0.1`）仍按托管值处理
  // 非空值一律有派生结果（key → 托管 URL，其余原样），空值在 shared 就返回 null
  const managed = resolveFileUrl(splitFragment(value).base);
  if (!managed) return null;
  // 判定单点在 shared：畸形编码 / 空 key / 非托管值都在这里被拒
  const key = getManagedStorageKey(managed);
  const parsed = parseUrl(managed);
  if (!key || !parsed) return null;

  // 宽度只有一个来源：逻辑 URL 的 `w`（LOD / 缩略图档位由调用方在 URL 上表达）
  const rawWidth = parsed.searchParams.get("w");
  const parsedWidth = rawWidth === null ? Number.NaN : Number.parseInt(rawWidth, 10);
  const width = Number.isFinite(parsedWidth) && parsedWidth > 0 ? parsedWidth : undefined;
  const download = options.download ?? parsed.searchParams.has("download");
  const filename = options.filename ?? parsed.searchParams.get("filename") ?? undefined;

  return {
    key,
    ...(width !== undefined ? { width } : {}),
    ...(download ? { download: true } : {}),
    ...(filename ? { filename } : {}),
  };
}

/** 客户端媒体片段（如 `#t=0.1`）：不参与 HTTP 请求与缓存键，解析结果按调用方输入保留 */
export function splitFragment(value: string): { base: string; fragment: string } {
  const index = value.indexOf("#");
  return index >= 0
    ? { base: value.slice(0, index), fragment: value.slice(index) }
    : { base: value, fragment: "" };
}

function parseUrl(value: string): URL | null {
  try {
    return new URL(value, "http://noxrea.invalid");
  } catch {
    return null;
  }
}

/** 最终地址本身不带片段（signed 描述与 stream 归一化构造均如此），按调用方输入原样接回 */
export function withFragment(url: string, fragment: string): string {
  return !fragment || url.includes("#") ? url : `${url}${fragment}`;
}

/** 内存缓存键：带进程内会话序号，会话切换后旧键自然失效 */
export function cacheKeyOf(scope: number, request: AccessRequest): string {
  return [
    scope,
    request.key,
    request.width ?? "",
    request.download ? 1 : 0,
    request.filename ?? "",
  ].join("\u0000");
}

/**
 * 持久化键（规则 3.2）：不含进程内的会话序号，跨刷新稳定；下载描述不持久化，
 * 因此键里只有对象与宽度。
 */
export function persistedKeyOf(request: AccessRequest): string {
  return [request.key, request.width ?? ""].join("\u0000");
}

/** 下载描述不持久化：附件名只对这一次下载有意义 */
export function isPersistable(request: AccessRequest): boolean {
  return request.download !== true;
}

/**
 * stream 形态下由归一化请求构造最终地址（不请求描述接口）：
 * 与服务端 local 分支共用 `buildManagedFileQueryUrl`，参数顺序、转义与
 * 「filename 只随 download 输出」的规则单一来源；显式宽度覆盖同样生效，
 * 逻辑 URL 上的其他查询参数按描述接口契约丢弃。
 */
export function streamDescriptorOf(value: string, request: AccessRequest): FileAccessDescriptor {
  const url = buildManagedFileQueryUrl(request.key, {
    width: request.width,
    download: request.download,
    filename: request.filename,
  });
  // 片段只属于客户端：构造完查询参数后原样接回
  return { url: withFragment(url, splitFragment(value).fragment), delivery: "stream" };
}

/**
 * 描述响应的边界校验（规则 2.3 的客户端一侧）：`signed` 必须带可用的 `expiresAt`。
 * 缺失时不能猜——按「永不过期」缓存会拿着失效 URL 渲染，按「立刻过期」缓存则每次
 * 挂载都重新描述、把契约错误变成静默的性能问题。边界处明确失败，调用方进入失败态。
 */
export function parseDescriptor(raw: unknown): FileAccessDescriptor {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("File access descriptor must be an object");
  }
  const { url, delivery, expiresAt, refreshAt } = raw as Record<string, unknown>;
  if (typeof url !== "string" || url.length === 0) {
    throw new Error("File access descriptor is missing url");
  }
  if (delivery !== "signed" && delivery !== "stream") {
    throw new Error(`Unsupported file delivery: ${String(delivery)}`);
  }
  if (delivery === "stream") return { url, delivery };
  if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt) || expiresAt <= 0) {
    throw new Error("Signed file descriptor is missing expiresAt");
  }
  return {
    url,
    delivery,
    expiresAt,
    ...(typeof refreshAt === "number" && Number.isFinite(refreshAt) && refreshAt > 0
      ? { refreshAt }
      : {}),
  };
}

/**
 * 内存有效期（规则 3.2）：signed 在 `refreshAt` 失效（此后应重新描述）；
 * 描述缺少 `refreshAt` 时退化为「失效前 60 秒」。
 */
export function expiryOf(descriptor: FileAccessDescriptor): number {
  if (descriptor.delivery !== "signed") return Number.POSITIVE_INFINITY;
  if (descriptor.refreshAt !== undefined) return descriptor.refreshAt * 1000;
  return descriptor.expiresAt * 1000 - EXPIRY_SKEW_MS;
}
