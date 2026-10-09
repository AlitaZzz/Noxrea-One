import { getManagedFilePathname, MANAGED_FILE_PATH } from "@noxrea/shared/url";

/** 判断 URL 是否指向服务端托管文件。 */
export function isManagedFileUrl(url: string | null | undefined): url is string {
  return getManagedFilePathname(url) !== null;
}

/** 判断 URL 是否为本站根路径下的托管文件。 */
export function isManagedFilePath(url: string | null | undefined): url is string {
  return typeof url === "string" && url.startsWith(MANAGED_FILE_PATH);
}

/** 为托管文件设置缩略宽度，保留已有查询参数和 hash。 */
export function withManagedFileWidth(url: string, width: number): string;
export function withManagedFileWidth(url: null | undefined, width: number): undefined;
export function withManagedFileWidth(url: string | null | undefined, width: number): string | undefined;
export function withManagedFileWidth(url: string | null | undefined, width: number): string | undefined {
  if (!url || !isManagedFileUrl(url)) return url ?? undefined;

  const hashIndex = url.indexOf("#");
  const hash = hashIndex >= 0 ? url.slice(hashIndex) : "";
  const withoutHash = hashIndex >= 0 ? url.slice(0, hashIndex) : url;
  const queryIndex = withoutHash.indexOf("?");
  const pathname = queryIndex >= 0 ? withoutHash.slice(0, queryIndex) : withoutHash;
  const query = queryIndex >= 0 ? withoutHash.slice(queryIndex + 1) : "";
  const params = new URLSearchParams(query);
  params.set("w", String(width));
  return `${pathname}?${params.toString()}${hash}`;
}
