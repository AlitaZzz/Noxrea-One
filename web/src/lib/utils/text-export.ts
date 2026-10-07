/**
 * 文本导出工具：复制到剪贴板、下载为本地文件。
 */

/**
 * 复制文本到剪贴板。
 * @returns 是否复制成功
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
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
