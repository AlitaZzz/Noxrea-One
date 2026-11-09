/**
 * 画布文档 store 与保存器之间的有界保存意图。
 *
 * 文档 store 是叶子：它只声明「发生了什么写入」，不导入保存器，也不决定保存时机。
 * 保存器在模块求值时订阅本信号，是唯一订阅者；意图取值是有界联合，新增保存语义
 * 必须同时更新保存器的 switch，避免任意字符串或跨模块事件总线式的通信。
 */
export type CanvasSaveIntent =
  | { kind: "debounced" }
  | { kind: "immediate" }
  | { kind: "undo" }
  | { kind: "project-restored"; clearExpired: boolean };

type CanvasSaveIntentListener = (intent: CanvasSaveIntent) => void;

const listeners = new Set<CanvasSaveIntentListener>();

/** 订阅保存意图；返回取消函数（保存器为进程级单例，正常生命周期内不取消） */
export function subscribeCanvasSaveIntent(listener: CanvasSaveIntentListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 发出保存意图（同步通知；文档 store 的写入已在此前完成） */
export function emitCanvasSaveIntent(intent: CanvasSaveIntent): void {
  for (const listener of listeners) listener(intent);
}
