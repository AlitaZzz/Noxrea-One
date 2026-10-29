// @vitest-environment jsdom
/**
 * 媒体事件 → 播放镜像（specs/canvas-audio-peaks-cache.md 规则 4.5 / 4.6）。
 *
 * 节点波形与截取面板共用这份映射，锁定：
 * - play / pause / ended / timeupdate / loadedmetadata 各改哪个字段；
 * - 非有限时长与 0 不覆盖已知时长；
 * - 镜像按身份记账：换身份即回到初始值；
 * - 附加回调只在对应事件执行（面板的循环约束与结束续播依赖事件时机）。
 */
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useMediaPlaybackMirror } from "@/lib/use-media-playback-mirror";

const INITIAL = { playing: false, progress: 0, duration: 0 };

function makeElement(): HTMLAudioElement {
  const element = document.createElement("audio");
  Object.defineProperty(element, "currentTime", {
    configurable: true,
    writable: true,
    value: 0,
  });
  Object.defineProperty(element, "duration", {
    configurable: true,
    writable: true,
    value: 0,
  });
  return element;
}

/** `duration` 在 DOM 类型里只读：jsdom 下按可写属性重新定义来模拟元数据到达 */
function setDuration(element: HTMLAudioElement, value: number): void {
  Object.defineProperty(element, "duration", { configurable: true, value });
}

function fire(element: HTMLAudioElement, type: string): void {
  act(() => {
    element.dispatchEvent(new Event(type));
  });
}

describe("useMediaPlaybackMirror", () => {
  it("事件推进镜像：play 同步位置，timeupdate 跟随，pause / ended 收尾", () => {
    const element = makeElement();
    element.currentTime = 12.5;
    const { result } = renderHook(() =>
      useMediaPlaybackMirror({ current: element }, "a", INITIAL),
    );

    // 暂停期间 currentTime 可能被外部改写：起播时同步一次
    fire(element, "play");
    expect(result.current.mirror).toEqual({ playing: true, progress: 12.5, duration: 0 });

    element.currentTime = 13;
    fire(element, "timeupdate");
    expect(result.current.mirror).toEqual({ playing: true, progress: 13, duration: 0 });

    fire(element, "pause");
    expect(result.current.mirror.playing).toBe(false);

    fire(element, "play");
    fire(element, "ended");
    expect(result.current.mirror.playing).toBe(false);
  });

  it("媒体时长只在元数据给出有限正值时更新", () => {
    const element = makeElement();
    const { result } = renderHook(() => useMediaPlaybackMirror({ current: element }, "a", INITIAL));

    setDuration(element, Number.POSITIVE_INFINITY);
    fire(element, "loadedmetadata");
    expect(result.current.mirror.duration).toBe(0);

    setDuration(element, 21);
    fire(element, "loadedmetadata");
    expect(result.current.mirror.duration).toBe(21);
  });

  it("逐帧进度回写与 timeupdate 写同一个维度，不影响其它字段", () => {
    const element = makeElement();
    element.currentTime = 4;
    const { result } = renderHook(() => useMediaPlaybackMirror({ current: element }, "a", INITIAL));

    fire(element, "play");
    act(() => {
      result.current.reportProgress(7.5);
    });
    expect(result.current.mirror).toEqual({ playing: true, progress: 7.5, duration: 0 });
  });

  it("换身份即回到初始值，不继承旧源的播放态与进度", () => {
    const element = makeElement();
    element.currentTime = 8;
    const { result, rerender } = renderHook(
      ({ identity }: { identity: string }) =>
        useMediaPlaybackMirror({ current: element }, identity, INITIAL),
      { initialProps: { identity: "a" } },
    );

    fire(element, "play");
    expect(result.current.mirror.playing).toBe(true);

    rerender({ identity: "b" });
    expect(result.current.mirror).toEqual(INITIAL);
  });

  it("附加回调只在对应事件执行", () => {
    const element = makeElement();
    const onTimeUpdate = vi.fn();
    const onEnded = vi.fn();
    renderHook(() =>
      useMediaPlaybackMirror({ current: element }, "a", INITIAL, {
        timeupdate: onTimeUpdate,
        ended: onEnded,
      }),
    );

    fire(element, "timeupdate");
    expect(onTimeUpdate).toHaveBeenCalledTimes(1);
    expect(onEnded).not.toHaveBeenCalled();

    fire(element, "ended");
    expect(onEnded).toHaveBeenCalledTimes(1);
  });
});
