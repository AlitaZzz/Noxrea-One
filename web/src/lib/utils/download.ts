/**
 * 浏览器下载触发工具。
 *
 * 托管引用先经访问解析层换取下载描述（specs/storage-signed-direct-delivery.md
 * 规则 3.5）：S3 后端把附件名签入预签名 URL（disposition 由服务端响应头强制），
 * local 后端在流式 URL 上带 `download=1&filename=`。外部 URL 与 data:/blob:
 * 由解析层原样返回（无 `delivery`）——外链追加 query 可能破坏签名参数，
 * data: URI 的 `?` 后属于数据本身。
 */

import { resolveMediaUrlWithRetry } from "@/lib/file-access";
import { managedFileUrl } from "@/lib/file-url";
import { showGlobalMessage } from "@/lib/global-message";
import i18n from "@/lib/i18n/config";
import { sanitizeFileName } from "@/lib/utils/file-name";

function triggerDownload(href: string, fileName: string): void {
  const a = document.createElement("a");
  a.href = href;
  a.rel = "noopener";
  if (fileName) a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

export async function downloadManagedFile(
  value: string | null | undefined,
  suggestedName?: string,
): Promise<void> {
  const logical = managedFileUrl(value);
  if (!logical) return;
  const fileName = sanitizeFileName(suggestedName ?? "");

  try {
    // 下载是「需要最终地址的非元素形态」：瞬时故障同样只重新描述一次（规则 3.6）
    const { url, delivery } = await resolveMediaUrlWithRetry(logical, {
      download: true,
      ...(fileName ? { filename: fileName } : {}),
    });
    // signed：文件名由服务端签入的 Content-Disposition 决定，跨域 href 的 download 属性无效；
    // stream：同源流式 URL 按约定带 download/filename，download 属性作双保险；
    // 外部 URL（无 delivery）：解析层原样返回，沿用调用方提供的 download 属性
    triggerDownload(url, delivery === "signed" ? "" : fileName);
  } catch {
    // 下载是用户点击的即时反馈，按 web/AGENTS.md 七.1 用轻量消息而不是通知
    // （失败原因不需要展开说明，消息条足以让用户知道「这次没成」并自行重试）
    showGlobalMessage().error(i18n.t("common.downloadFailed"));
  }
}
