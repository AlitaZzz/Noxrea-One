// @vitest-environment jsdom
/**
 * 编辑面板 window 指针会话：只接受主指针左键启动，四条收尾路径必须成套注册。
 *
 * 回归点：只注册 pointerup / pointercancel 时，窗口失焦后浏览器可能不再补发
 * 二者，拖拽会话残留并在回到窗口后继续跟随未按键的移动；右键 / 中键 /
 * 额外手指则不应建立会话。
 */
import { describe, expect, it, vi } from "vitest";

import {
  fireWindowBlur,
  fireWindowPointerCancel,
  fireWindowPointerMove,
  fireWindowPointerUp,
} from "@/__tests__/test-utils/pointer-events";
import {
  isPrimaryLeftPointerDown,
  startWindowPointerSession,
} from "@/features/canvas/editing/window-pointer-session";

function createHandlers() {
  return {
    onMove: vi.fn(),
    onUp: vi.fn(),
    onCancel: vi.fn(),
    onBlur: vi.fn(),
  };
}

describe("isPrimaryLeftPointerDown", () => {
  it("只接受主指针左键；右键、中键与额外手指不建立会话", () => {
    expect(isPrimaryLeftPointerDown({ isPrimary: true, button: 0 })).toBe(true);
    expect(isPrimaryLeftPointerDown({ isPrimary: true, button: 1 })).toBe(false);
    expect(isPrimaryLeftPointerDown({ isPrimary: true, button: 2 })).toBe(false);
    expect(isPrimaryLeftPointerDown({ isPrimary: false, button: 0 })).toBe(false);
  });
});

describe("startWindowPointerSession", () => {
  it("注册四条 window 监听：move / up / cancel / blur 各收到一次", () => {
    const handlers = createHandlers();
    const detach = startWindowPointerSession(handlers);

    fireWindowPointerMove(120, 7);
    fireWindowPointerUp(120, 7);
    fireWindowPointerCancel(7);
    fireWindowBlur();

    expect(handlers.onMove).toHaveBeenCalledTimes(1);
    expect(handlers.onUp).toHaveBeenCalledTimes(1);
    expect(handlers.onCancel).toHaveBeenCalledTimes(1);
    expect(handlers.onBlur).toHaveBeenCalledTimes(1);

    detach();
  });

  it("清理函数按函数身份移除全部监听：失焦后残留会话不再响应", () => {
    const handlers = createHandlers();
    const detach = startWindowPointerSession(handlers);

    detach();
    fireWindowPointerMove(200);
    fireWindowPointerUp(200);
    fireWindowPointerCancel();
    fireWindowBlur();

    expect(handlers.onMove).not.toHaveBeenCalled();
    expect(handlers.onUp).not.toHaveBeenCalled();
    expect(handlers.onCancel).not.toHaveBeenCalled();
    expect(handlers.onBlur).not.toHaveBeenCalled();
  });
});
