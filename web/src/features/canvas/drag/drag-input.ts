/**
 * 拖动开始事件输入。
 *
 * React Flow 的 `onNodeDragStart` 透传 d3 的 sourceEvent；拖动开始时已经按住的
 * Ctrl/Meta（旁路）或 Shift（轴限）必须在首帧即生效，后续变化由会话的键盘
 * 监听接管（specs/canvas-snap-alignment.md 规则 8.3）。触屏拖动没有修饰键，
 * 会话不监听键盘，也不采用事件上的修饰键初值（规则 8.5），因此触屏判定与
 * 修饰键读取同属这一份事件输入。
 */
import type { DragSnapModifiers } from "./drag-snap";

/** 拖动开始事件提供的会话初值 */
export interface DragInput {
  /** 事件发生时的修饰键（触屏事件没有这些字段，读取结果恒为未按下） */
  modifiers: DragSnapModifiers;
  /** 触屏拖动（规则 8.5）：无修饰键，不监听键盘，也不采用初值 */
  touch: boolean;
}

/** TouchEvent 判定只看 `touches` 字段：鼠标/指针事件没有该字段 */
function isTouchEvent(event: unknown): boolean {
  return typeof event === "object" && event !== null && "touches" in event;
}

/** 修饰键判定（规则 8.2）：拖动开始事件与拖动期键盘事件共用同一规则 */
export function dragModifiersFromEvent(event: unknown): DragSnapModifiers {
  if (!event || typeof event !== "object") return { bypass: false, shift: false };
  const keys = event as { ctrlKey?: unknown; metaKey?: unknown; shiftKey?: unknown };
  return {
    bypass: keys.ctrlKey === true || keys.metaKey === true,
    shift: keys.shiftKey === true,
  };
}

/** 一次读取拖动开始事件的全部会话初值（修饰键 + 触屏判定） */
export function dragInputFromEvent(event: unknown): DragInput {
  return { modifiers: dragModifiersFromEvent(event), touch: isTouchEvent(event) };
}
