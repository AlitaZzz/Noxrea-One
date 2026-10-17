/**
 * 浏览器下载触发工具。
 *
 * 引用值经 managedFileUrl 派生访问 URL；下载参数（download / filename）仅对托管
 * 分发路由追加（服务端据此回 Content-Disposition）；外部 URL 与 data:/blob: 原样
 * 直链——外链追加 query 可能破坏签名参数，data: URI 的 ? 后属于数据本身不可用。
 * a.download 作同源文件名提示，跨域外部 URL 由浏览器忽略。
 */

import { isManagedFileUrl, managedFileUrl, withQueryParams } from "@/lib/file-url";
import { sanitizeFileName } from "@/lib/utils/file-name";

export function downloadManagedFile(value: string | null | undefined, suggestedName?: string): void {
  const url = managedFileUrl(value);
  if (!url) return;
  const fileName = sanitizeFileName(suggestedName ?? "");
  let href = url;
  if (isManagedFileUrl(url)) {
    const params: Record<string, string> = { download: "true" };
    if (fileName) params.filename = fileName;
    href = withQueryParams(url, params);
  }
  const a = document.createElement("a");
  a.href = href;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}
