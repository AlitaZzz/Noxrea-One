// @vitest-environment jsdom
/**
 * 媒体元素事件订阅（specs/canvas-audio-peaks-cache.md 规则 4.5 / 5.2）。
 *
 * 节点波形与截取面板共用这份订阅，锁定：
 * - 订阅只建立一次，回调身份变化不重新挂载监听；
 * - 事件到达时调用最新一次渲染的回调（闭包里的时长、选区不会过期）；
 * - 后出现的回调同样生效（订阅表不随渲染变化）；
 * - 卸载摘掉全部监听；元素未就绪时什么都不做。
 */
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useMediaEvents } from "@/lib/use-media-events";

function fire(element: HTMLAudioElement, type: string): void {
  act(() => {
    element.dispatchEvent(new Event(type));
  });
}

describe("订阅生命周期", () => {
  it("挂载即订阅，卸载后不再回调", () => {
    const element = document.createElement("audio");
    const onPlay = vi.fn();
    const { unmount } = renderHook(() => useMediaEvents({ current: element }, { play: onPlay }));

    fire(element, "play");
    expect(onPlay).toHaveBeenCalledTimes(1);

    unmount();
    fire(element, "play");
    expect(onPlay).toHaveBeenCalledTimes(1);
  });

  it("元素未就绪时不抛错，也不留下监听", () => {
    expect(() => renderHook(() => useMediaEvents({ current: null }, { play: vi.fn() }))).not.toThrow();
  });
});

describe("回调更新", () => {
  it("订阅只建立一次，事件到达时用最新一次渲染的回调", () => {
    const element = document.createElement("audio");
    const add = vi.spyOn(element, "addEventListener");
    const seen: number[] = [];
    const ref = { current: element };
    const { rerender } = renderHook(
      ({ n }: { n: number }) => useMediaEvents(ref, { timeupdate: () => seen.push(n) }),
      { initialProps: { n: 1 } },
    );
    expect(add).toHaveBeenCalledTimes(5);

    rerender({ n: 2 });
    expect(add).toHaveBeenCalledTimes(5);

    fire(element, "timeupdate");
    expect(seen).toEqual([2]);
  });

  it("后出现的回调同样生效，不需要重新订阅", () => {
    const element = document.createElement("audio");
    const ref = { current: element };
    const { rerender } = renderHook(
      ({ onPlay }: { onPlay?: () => void }) => useMediaEvents(ref, onPlay ? { play: onPlay } : {}),
      { initialProps: { onPlay: undefined as (() => void) | undefined } },
    );

    fire(element, "play");

    const onPlay = vi.fn();
    rerender({ onPlay });
    fire(element, "play");
    expect(onPlay).toHaveBeenCalledTimes(1);
  });

  it("没有回调的事件被触发时什么都不发生", () => {
    const element = document.createElement("audio");
    renderHook(() => useMediaEvents({ current: element }, { play: vi.fn() }));

    expect(() => fire(element, "loadedmetadata")).not.toThrow();
  });
});
