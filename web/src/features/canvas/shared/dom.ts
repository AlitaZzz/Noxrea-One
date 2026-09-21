/**
 * 画布相关的 DOM 目标判定工具。
 */

/** 焦点在输入框/可编辑元素上时不接管按键：Esc、方向键等快捷键都要留给文本编辑 */
export function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
}
