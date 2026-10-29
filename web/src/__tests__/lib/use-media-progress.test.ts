// @vitest-environment jsdom
/**
 * 播放进度逐帧跟随（specs/canvas-audio-peaks-cache.md 规则 4.5 / 5.2）。
 *
 * 节点波形、音频截取面板与视频编辑面板共用这份循环，锁定：
 * - 未激活或时间源未就绪（读取返回 null）不启动循环，卸载取消在途帧；
 * - 只在时间变化超过阈值时回调进度，静止不产生渲染；
 * - `onFrame` 每帧都收到当前时间，且在进度回调之后（循环约束可覆盖进度写入）；
 * - 调用方重建回调不重启循环；读取函数身份变化视为换源，以新源当前值重启。
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useMediaProgress } from "@/lib/use-media-progress";

/** 手控 rAF 队列：逐帧驱动，不依赖真实帧率；取消会真正移除回调 */
let frames = new Map<number, FrameRequestCallback>();
let nextId = 1;

beforeEach(() => {
  frames = new Map();
  nextId = 1;
  vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => {
    const id = nextId++;
    frames.set(id, callback);
    return id;
  }));
  vi.stubGlobal("cancelAnimationFrame", vi.fn((id: number) => {
    frames.delete(id);
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** 可写 currentTime 的媒体元素替身（jsdom 不实现播放时间推进） */
function mediaAt(currentTime: number): HTMLAudioElement {
  const element = document.createElement("audio");
  Object.defineProperty(element, "currentTime", {
    configurable: true,
    writable: true,
    value: currentTime,
  });
  return element;
}

/** 执行当前排队的帧；tick 会在执行中排下一帧 */
function runFrame(): void {
  const pending = [...frames.values()];
  frames.clear();
  act(() => {
    for (const callback of pending) callback(0);
  });
}

describe("循环生命周期", () => {
  it("未激活时不启动循环", () => {
    renderHook(() => useMediaProgress(() => 0, false, vi.fn()));

    expect(requestAnimationFrame).not.toHaveBeenCalled();
  });

  it("卸载时取消在途帧", () => {
    const readTime = () => 0;
    const { unmount } = renderHook(() => useMediaProgress(readTime, true, vi.fn()));

    expect(requestAnimationFrame).toHaveBeenCalledTimes(1);
    unmount();

    expect(cancelAnimationFrame).toHaveBeenCalledWith(1);
  });

  it("时间源尚未就绪（读取返回 null）时不启动循环", () => {
    renderHook(() => useMediaProgress(() => null, true, vi.fn()));

    expect(requestAnimationFrame).not.toHaveBeenCalled();
  });
});

describe("进度去重与逐帧回调", () => {
  it("时间变化不超过阈值不回调进度，超过才回调", () => {
    const element = mediaAt(0);
    const onProgress = vi.fn();
    renderHook(() => useMediaProgress(() => element.currentTime, true, onProgress));

    runFrame();
    expect(onProgress).not.toHaveBeenCalled();

    element.currentTime = 0.002;
    runFrame();
    expect(onProgress).not.toHaveBeenCalled();

    element.currentTime = 0.01;
    runFrame();
    expect(onProgress).toHaveBeenCalledTimes(1);
    expect(onProgress).toHaveBeenCalledWith(0.01);

    // 静止的后续帧不重复回调
    runFrame();
    expect(onProgress).toHaveBeenCalledTimes(1);
  });

  it("onFrame 每帧都收到当前时间，不受进度阈值影响", () => {
    const element = mediaAt(5);
    const onFrame = vi.fn();
    renderHook(() => useMediaProgress(() => element.currentTime, true, vi.fn(), onFrame));

    runFrame();
    expect(onFrame).toHaveBeenCalledTimes(1);
    expect(onFrame).toHaveBeenCalledWith(5);

    runFrame();
    expect(onFrame).toHaveBeenCalledTimes(2);
  });

  it("同一帧内先回调进度，再执行每帧回调", () => {
    const element = mediaAt(0);
    const calls: string[] = [];
    renderHook(() => useMediaProgress(
      () => element.currentTime,
      true,
      () => calls.push("progress"),
      () => calls.push("frame"),
    ));

    element.currentTime = 1;
    runFrame();
    expect(calls).toEqual(["progress", "frame"]);

    runFrame();
    expect(calls).toEqual(["progress", "frame", "frame"]);
  });

  it("回调身份变化不重启循环，下一帧使用最新回调", () => {
    const element = mediaAt(0);
    // 读取函数身份必须稳定（真实调用方来自 useCallback）：每次渲染新建函数会重启 effect
    const readTime = () => element.currentTime;
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = renderHook(
      ({ onProgress }) => useMediaProgress(readTime, true, onProgress),
      { initialProps: { onProgress: first } },
    );
    expect(requestAnimationFrame).toHaveBeenCalledTimes(1);

    rerender({ onProgress: second });
    expect(requestAnimationFrame).toHaveBeenCalledTimes(1);

    element.currentTime = 1;
    runFrame();

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith(1);
  });

  it("读取函数身份变化视为换源：旧循环取消，新循环从新源当前值起算", () => {
    const firstElement = mediaAt(0);
    const secondElement = mediaAt(5);
    const onProgress = vi.fn();
    const { rerender } = renderHook(
      ({ readTime }) => useMediaProgress(readTime, true, onProgress),
      { initialProps: { readTime: () => firstElement.currentTime } },
    );
    expect(requestAnimationFrame).toHaveBeenCalledTimes(1);

    rerender({ readTime: () => secondElement.currentTime });

    // 旧循环的 cleanup 取消在途帧，新循环立即启动
    expect(cancelAnimationFrame).toHaveBeenCalledWith(1);
    expect(requestAnimationFrame).toHaveBeenCalledTimes(2);

    // 新源当前值作为 last，不误发一次进度
    runFrame();
    expect(onProgress).not.toHaveBeenCalled();

    secondElement.currentTime = 6;
    runFrame();
    expect(onProgress).toHaveBeenCalledWith(6);
  });
});
