/**
 * 统一的文件选择入口。
 *
 * 画布上所有「点击按钮选文件」的地方（节点内上传 / 替换、生成面板参考区、
 * 资产库上传）都通过它打开系统文件选择器，避免各自手写 input 元素。
 */

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
    if (options.accept) input.accept = options.accept;
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
