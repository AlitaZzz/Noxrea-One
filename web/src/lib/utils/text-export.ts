/**
 * 文本导出工具：复制到剪贴板、下载为本地文件。
 */

/**
 * 复制文本到剪贴板。
 * 优先使用 Clipboard API；在 http 等非安全上下文（如局域网直连 NAS）下该 API 不可用，
 * 回退到临时 textarea + execCommand，保证功能不失效。
 * @returns 是否复制成功
 */
export async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // 权限被拒或 API 调用失败，继续走兜底方案
    }
  }
  return legacyCopy(text);
}

/** 兜底复制：临时 textarea + execCommand，兼容非安全上下文 */
function legacyCopy(text: string): boolean {
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    document.body.removeChild(textarea);
  }
}

/** 清理文件名中的非法字符（Windows / macOS 通用），避免保存失败 */
export function sanitizeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, "_").trim();
}

/**
 * 将文本下载为本地文件。
 * @param fileName 含扩展名的完整文件名
 * @param text 文件内容
 * @param mime MIME 类型，默认 markdown
 */
export function downloadTextFile(fileName: string, text: string, mime = "text/markdown;charset=utf-8"): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
