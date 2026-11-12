/**
 * 指针事件测试助手。
 *
 * jsdom 没有实现 PointerEvent：用 MouseEvent 承载坐标 / 按键，再补上
 * `pointerId`，React 的 onPointerDown 与 window 上的原生 pointermove /
 * pointerup 监听都能收到同一形状的事件。坐标相关用例还需要调用方把轨道的
 * `getBoundingClientRect` 换成固定矩形（见 `stubElementRect`）。
 */
import { fireEvent } from "@testing-library/react";
import { vi } from "vitest";

interface PointerInit {
  pointerId?: number;
  clientX?: number;
  button?: number;
  isPrimary?: boolean;
}

function pointerEvent(type: string, init: PointerInit): MouseEvent {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: init.clientX ?? 0,
    button: init.button ?? 0,
  });
  Object.defineProperty(event, "pointerId", {
    configurable: true,
    value: init.pointerId ?? 1,
  });
  // jsdom 的 MouseEvent 没有 isPrimary：默认按主指针构造，额外手指显式传 false
  Object.defineProperty(event, "isPrimary", {
    configurable: true,
    value: init.isPrimary ?? true,
  });
  return event;
}

export function firePointerDown(target: Element, init: PointerInit = {}): MouseEvent {
  const event = pointerEvent("pointerdown", init);
  fireEvent(target, event);
  return event;
}

export function fireWindowPointerMove(clientX: number, pointerId = 1): void {
  fireEvent(window, pointerEvent("pointermove", { clientX, pointerId }));
}

export function fireWindowPointerUp(clientX: number, pointerId = 1): void {
  fireEvent(window, pointerEvent("pointerup", { clientX, pointerId }));
}

export function fireWindowPointerCancel(pointerId = 1): void {
  fireEvent(window, pointerEvent("pointercancel", { pointerId }));
}

export function fireWindowBlur(): void {
  fireEvent(window, new Event("blur"));
}

/** 轨道等元素的固定测量矩形：jsdom 的默认 rect 全为 0，比例换算会得到 null */
export function stubElementRect(
  element: Element,
  rect: Partial<DOMRect> = {},
): void {
  const left = rect.left ?? 0;
  const top = rect.top ?? 0;
  const width = rect.width ?? 1000;
  const height = rect.height ?? 56;
  vi.spyOn(element, "getBoundingClientRect").mockReturnValue({
    x: left,
    y: top,
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    toJSON: () => ({}),
  } as DOMRect);
}
