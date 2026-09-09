/**
 * 统一的文件选择入口。
 *
 * 画布上所有「点击按钮选文件」的地方（节点内上传 / 替换、生成面板参考区、
 * 资产库上传）都通过它打开系统文件选择器，避免各自手写 input 元素。
 */

/**
 * 通配类型的扩展名兜底。
 * 系统文件选择器按注册表匹配 MIME，而 mkv / mov / avi 等容器在部分系统上
 * 未注册为 video/*，只写 "video/*" 会让这些文件在对话框里选不到，故补上扩展名。
 */
const EXT_FALLBACK: Record<string, string> = {
  "image/*": ".png,.jpg,.jpeg,.gif,.webp,.bmp,.svg,.avif",
  "video/*": ".mp4,.webm,.mov,.avi,.mkv,.m4v",
  "audio/*": ".mp3,.wav,.ogg,.m4a,.aac,.flac",
};

/** 给 accept 中的通配类型补齐常见扩展名（已显式列出的保持不变） */
export function expandAccept(accept: string): string {
  const parts = accept.split(",").map((s) => s.trim()).filter(Boolean);
  const extras = parts.map((p) => EXT_FALLBACK[p]).filter((v): v is string => Boolean(v));
  return Array.from(new Set([...parts, ...extras])).join(",");
}

export interface PickFilesOptions {
  /** accept 属性，如 "image/*" */
  accept?: string;
  /** 是否允许多选 */
  multiple?: boolean;
}

/**
 * 打开系统文件选择器并返回所选文件（用户取消时返回空数组）。
 */
export function pickFiles(options: PickFilesOptions = {}): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    if (options.accept) input.accept = expandAccept(options.accept);
    input.multiple = options.multiple ?? false;
    input.style.display = "none";

    let settled = false;
    const done = (files: File[]) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(files);
    };

    input.addEventListener("change", () => done(Array.from(input.files ?? [])));
    // 用户取消时部分浏览器不触发 change，用 cancel 事件兜底
    input.addEventListener("cancel", () => done([]));

    document.body.appendChild(input);
    input.click();
  });
}
