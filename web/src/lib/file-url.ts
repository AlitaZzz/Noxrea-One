import { getManagedStorageKey, resolveFileUrl } from "@noxrea/shared/url";

/** 逻辑 URL 的三段拆分（pathname / search / hash）；托管判定由 hasManagedStorageKey 承担 */
function splitUrl(url: string): { pathname: string; search: URLSearchParams; hash: string } {
  const hashIndex = url.indexOf("#");
  const hash = hashIndex >= 0 ? url.slice(hashIndex) : "";
  const withoutHash = hashIndex >= 0 ? url.slice(0, hashIndex) : url;
  const queryIndex = withoutHash.indexOf("?");
  return {
    pathname: queryIndex >= 0 ? withoutHash.slice(0, queryIndex) : withoutHash,
    search: new URLSearchParams(queryIndex >= 0 ? withoutHash.slice(queryIndex + 1) : ""),
    hash,
  };
}

/**
 * 判断值是否为服务端托管的文件 URL。
 *
 * 与访问解析层同一判定（`getManagedStorageKey`）：畸形百分号编码与空 key 不是托管值，
 * 不得在此通过而在解析层被拒——否则 `?w=` 会拼到一个必然 400 的地址上。
 * 裸存储 key 不在此列；需要同时接受 key 的判定时用解析层的 `isManagedMediaValue`。
 */
export function hasManagedStorageKey(value: string | null | undefined): value is string {
  return getManagedStorageKey(value) !== null;
}

/**
 * 托管 URL 上的缩放档位（`?w=`）：非托管值或未设置/非法宽度返回 `null`。
 *
 * 只做 URL 解析，不含任何领域判定——档位语义（哪些值参与 LOD、如何计重）属于
 * 画布领域（`features/canvas/shared/image-lod.ts`）。
 */
export function managedFileWidthOf(url: string | null | undefined): number | null {
  if (!hasManagedStorageKey(url)) return null;
  const raw = splitUrl(url).search.get("w");
  if (raw === null) return null;
  const width = Number.parseInt(raw, 10);
  return Number.isFinite(width) && width > 0 ? width : null;
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

/**
 * 为托管文件设置缩略宽度，保留已有查询参数和 hash；存储 key 入参先派生为 URL。
 *
 * 这里只构造**逻辑 URL**（`?w=`）。最终媒体地址由访问解析层
 * （`lib/file-access/`）按后端形态换取：S3 为签名直连 URL，local 为应用流式 URL。
 * 派生缓存版本已内嵌在对象 key（`_cache/v2/...`），不再需要 `rv` 击穿参数。
 */
export function withManagedFileWidth(url: string, width: number): string;
export function withManagedFileWidth(url: null | undefined, width: number): undefined;
export function withManagedFileWidth(url: string | null | undefined, width: number): string | undefined;
export function withManagedFileWidth(url: string | null | undefined, width: number): string | undefined {
  if (!url) return undefined;
  // 派生一次再判定：外部 URL（含 data:/blob:）不走托管缩略参数，原样返回
  const derived = managedFileUrl(url);
  if (!hasManagedStorageKey(derived)) return url;
  // 只设置 w：其余查询参数与 hash 原样保留（片段只属于客户端）
  const { pathname, search, hash } = splitUrl(derived);
  search.set("w", String(width));
  return `${pathname}?${search.toString()}${hash}`;
}
