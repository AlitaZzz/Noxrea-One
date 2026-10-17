import {
  getManagedFilePathname,
  MANAGED_FILE_PATH,
  resolveFileUrl,
} from "@noxrea/shared/url";

/** 判断 URL 是否指向服务端托管文件（绝对/相对托管 URL 识别；下载参数判定与缩略参数派生用）。 */
export function isManagedFileUrl(url: string | null | undefined): url is string {
  return getManagedFilePathname(url) !== null;
}

/** 判断 URL 是否为本站根路径下的托管文件。 */
export function isManagedFilePath(url: string | null | undefined): url is string {
  return typeof url === "string" && url.startsWith(MANAGED_FILE_PATH);
}

/**
 * 引用值 → 可访问 URL（前端渲染期派生的唯一入口）。
 * 规则单点在 shared 的 resolveFileUrl：key 派生 `/api/files/{key}`，
 * 托管/外部 URL 原样透传（data:、blob:、http(s) 均不改动）。
 */
export function managedFileUrl(value: string | null | undefined): string | undefined {
  return resolveFileUrl(value) ?? undefined;
}

/**
 * 非空引用值 → 可访问 URL：值域内（key / 托管与外部 URL）必返回非空串。
 * 供确定值非空的消费点直接使用，替代 `managedFileUrl(x) ?? x` 形态。
 */
export function fileRefUrl(value: string): string {
  return managedFileUrl(value) ?? value;
}

/** 为托管文件设置缩略宽度，保留已有查询参数和 hash；存储 key 入参先派生为 URL。 */
export function withManagedFileWidth(url: string, width: number): string;
export function withManagedFileWidth(url: null | undefined, width: number): undefined;
export function withManagedFileWidth(url: string | null | undefined, width: number): string | undefined;
export function withManagedFileWidth(url: string | null | undefined, width: number): string | undefined {
  if (!url) return undefined;
  // 派生一次再判定：外部 URL（含 data:/blob:）不走托管缩略参数，原样返回
  const derived = managedFileUrl(url);
  if (!isManagedFileUrl(derived)) return url;
  return withQueryParams(derived, { w: String(width) });
}

/** 追加/覆盖查询参数，保留已有查询串与 hash。 */
export function withQueryParams(url: string, params: Record<string, string>): string {
  const hashIndex = url.indexOf("#");
  const hash = hashIndex >= 0 ? url.slice(hashIndex) : "";
  const withoutHash = hashIndex >= 0 ? url.slice(0, hashIndex) : url;
  const queryIndex = withoutHash.indexOf("?");
  const pathname = queryIndex >= 0 ? withoutHash.slice(0, queryIndex) : withoutHash;
  const query = queryIndex >= 0 ? withoutHash.slice(queryIndex + 1) : "";
  const search = new URLSearchParams(query);
  for (const [key, value] of Object.entries(params)) search.set(key, value);
  return `${pathname}?${search.toString()}${hash}`;
}
