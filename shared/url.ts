/** 前后端共同使用的托管文件 URL 前缀。 */
export const MANAGED_FILE_PATH = "/api/files/";

/** 提取托管文件 URL 的 pathname，忽略 query、hash 和非 HTTP 资源。 */
export function getManagedFilePathname(url: string | null | undefined): string | null {
  if (typeof url !== "string" || !url) return null;
  if (url.startsWith(MANAGED_FILE_PATH)) {
    const end = url.search(/[?#]/);
    return end === -1 ? url : url.slice(0, end);
  }
  if (!url.startsWith("//") && !/^https?:\/\//i.test(url)) return null;

  try {
    const parsed = new URL(url, "http://noxrea.invalid");
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.pathname.includes(MANAGED_FILE_PATH) ? parsed.pathname : null;
  } catch {
    return null;
  }
}

/** 去掉 URL 末尾的一个或多个斜杠。 */
export function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}
