// @vitest-environment jsdom
/**
 * 播放元素 Hook（specs/canvas-audio-peaks-cache.md 规则 4.2 / 4.3 / 4.7 / 4.8）。
 *
 * 波形与播放解耦后，节点与截取面板共用这份元素生命周期，锁定：
 * - 元素命令式创建、不进入 DOM，卸载暂停并清空 src（规则 4.8）；
 * - 地址只在换源 / 新地址 / 重挂令牌变化时写入，同地址重挂走 load()（规则 4.3）；
 * - 失败按「地址 + 重挂令牌」记账，新地址或重挂后自动失效（规则 4.6）；
 * - 元素 error → 重新描述一次，拿不到新地址或重试后仍失败才进入失败态（规则 4.7）。
 */
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { stubMediaElementMethods } from "@/__tests__/test-utils/audio-fixtures";
import { mutableFileAccessState } from "@/__tests__/test-utils/file-access-mock";

const access = vi.hoisted(() => ({ useFileAccessUrl: vi.fn() }));

vi.mock("@/lib/use-file-access-url", () => access);

import { useAudioElement } from "@/lib/use-audio-element";

const accessState = mutableFileAccessState("/audio.mp3");

beforeEach(() => {
  accessState.reset();
  access.useFileAccessUrl.mockImplementation(() => accessState.current);
  stubMediaElementMethods();
});

function fireError(element: HTMLAudioElement | null): void {
  act(() => {
    element?.dispatchEvent(new Event("error"));
  });
}

function fireLoadedMetadata(element: HTMLAudioElement | null): void {
  act(() => {
    element?.dispatchEvent(new Event("loadedmetadata"));
  });
}

/** 冲掉重描述 Promise 的微任务：error 处理器的失败态在重描述结束后才落定 */
async function flushRetry(): Promise<void> {
  await act(async () => {});
}

describe("元素生命周期（规则 4.2 / 4.8）", () => {
  it("创建脱离文档的 preload=metadata 元素并写入当前地址", () => {
    const { result } = renderHook(() => useAudioElement("1/aa/a.mp3"));
    const element = result.current.mediaRef.current!;

    expect(element).toBeInstanceOf(HTMLAudioElement);
    expect(element.isConnected).toBe(false);
    expect(element.preload).toBe("metadata");
    expect(element.getAttribute("src")).toBe("/audio.mp3");
    expect(element.hasAttribute("crossorigin")).toBe(false);
  });

  it("卸载时暂停、清空地址并重新加载（中止在途请求）", () => {
    const { result, unmount } = renderHook(() => useAudioElement("1/bb/b.mp3"));
    const element = result.current.mediaRef.current!;
    const load = vi.mocked(HTMLMediaElement.prototype.load);

    unmount();

    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled();
    expect(element.hasAttribute("src")).toBe(false);
    expect(load).toHaveBeenCalled();
  });
});

describe("地址同步（规则 4.3）", () => {
  it("新地址只写 src，重建元素后才会强制 load", () => {
    const load = vi.mocked(HTMLMediaElement.prototype.load);
    const { result, rerender } = renderHook(() => useAudioElement("1/cc/c.mp3"));
    const element = result.current.mediaRef.current!;
    expect(load).not.toHaveBeenCalled();

    accessState.set({ url: "https://signed.example/c.mp3?sig=2" });
    rerender();

    expect(element.getAttribute("src")).toBe("https://signed.example/c.mp3?sig=2");
    expect(load).not.toHaveBeenCalled();
    expect(result.current.mediaRef.current).toBe(element);
  });

  it("同地址且重挂令牌递增时调用 load() 强制重载", () => {
    const load = vi.mocked(HTMLMediaElement.prototype.load);
    const { rerender } = renderHook(() => useAudioElement("1/dd/d.mp3"));

    accessState.set({ reloadToken: 1 });
    rerender();

    expect(load).toHaveBeenCalledTimes(1);
  });

  it("换源后新地址未就绪时清空上一段音频", () => {
    const { result, rerender } = renderHook(({ value }) => useAudioElement(value), {
      initialProps: { value: "1/ee/e.mp3" },
    });
    const element = result.current.mediaRef.current!;

    accessState.set({ url: undefined, reloadToken: 0 });
    rerender({ value: "1/ff/f.mp3" });

    expect(element.hasAttribute("src")).toBe(false);
  });

  it("同一逻辑源的地址失效（会话切换）时同样清空，旧账号的音频不能继续播放", () => {
    const { result, rerender } = renderHook(() => useAudioElement("1/nn/n.mp3"));
    const element = result.current.mediaRef.current!;
    expect(element.getAttribute("src")).toBe("/audio.mp3");

    // 会话切换：useFileAccessUrl 作废旧作用域、清掉地址，但不改变逻辑源
    accessState.set({ url: undefined });
    rerender();

    expect(element.hasAttribute("src")).toBe(false);
  });
});

describe("地址状态（规则 4.3）", () => {
  it("暴露当前应挂到元素上的地址，未解析时为 null", () => {
    const { result, rerender } = renderHook(({ value }) => useAudioElement(value), {
      initialProps: { value: "1/jj/j.mp3" },
    });
    expect(result.current.src).toBe("/audio.mp3");

    accessState.set({ url: undefined });
    rerender({ value: "1/kk/k.mp3" });

    expect(result.current.src).toBeNull();
  });
});

describe("失败记账与重试（规则 4.6 / 4.7）", () => {
  it("元素 error 先重新描述一次，拿不到新地址才进入失败态", async () => {
    const { result } = renderHook(() => useAudioElement("1/gg/g.mp3"));

    fireError(result.current.mediaRef.current);
    // 重描述在途：覆盖层不能先闪出来
    expect(result.current.mediaFailed).toBe(false);
    expect(accessState.current.retrySigned).toHaveBeenCalledTimes(1);

    await flushRetry();

    expect(result.current.mediaFailed).toBe(true);
  });

  it("重描述拿到新地址时保持非失败态；新地址再次失败才置位，且只重描述一次", async () => {
    accessState.set({ retrySigned: vi.fn(async () => "https://signed.example/h.mp3?sig=2") });
    const { result, rerender } = renderHook(() => useAudioElement("1/hh/h.mp3"));

    fireError(result.current.mediaRef.current);
    await flushRetry();
    expect(result.current.mediaFailed).toBe(false);

    // 新地址挂上去后再次失败：这个逻辑源的重描述预算已经用掉（规则 4.7）
    accessState.set({ url: "https://signed.example/h.mp3?sig=2", reloadToken: 1 });
    rerender();
    fireError(result.current.mediaRef.current);
    await flushRetry();

    expect(result.current.mediaFailed).toBe(true);
    expect(accessState.current.retrySigned).toHaveBeenCalledTimes(1);
  });

  it("元数据加载成功即清掉失败态（旧地址的迟到 error 不会永久误记新地址）", async () => {
    const { result } = renderHook(() => useAudioElement("1/ll/l.mp3"));
    fireError(result.current.mediaRef.current);
    await flushRetry();
    expect(result.current.mediaFailed).toBe(true);

    // 失败态只在换址 / 重挂时失效，若新地址本身加载成功也没有事件能清它——
    // loadedmetadata 是「当前地址确实可用」的唯一正面证据，必须收敛失败态
    fireLoadedMetadata(result.current.mediaRef.current);

    expect(result.current.mediaFailed).toBe(false);
  });

  it("同地址重挂（未签出新地址）同样让失败态失效", async () => {
    const { result, rerender } = renderHook(() => useAudioElement("1/ii/i.mp3"));
    fireError(result.current.mediaRef.current);
    await flushRetry();
    expect(result.current.mediaFailed).toBe(true);

    accessState.set({ reloadToken: 1 });
    rerender();

    expect(result.current.mediaFailed).toBe(false);
  });

  it("重描述期间换源：旧源的失败不记到新源上", async () => {
    let resolveRetry!: (url: string | null) => void;
    const retrySigned = vi.fn(
      () => new Promise<string | null>((resolve) => { resolveRetry = resolve; }),
    );
    accessState.set({ retrySigned });
    const { result, rerender } = renderHook(({ value }) => useAudioElement(value), {
      initialProps: { value: "1/oo/o.mp3" },
    });
    const element = result.current.mediaRef.current!;

    fireError(element);
    expect(retrySigned).toHaveBeenCalledTimes(1);

    accessState.set({ url: "/other.mp3", reloadToken: 0 });
    rerender({ value: "1/pp/p.mp3" });

    await act(async () => { resolveRetry(null); });

    expect(result.current.mediaFailed).toBe(false);
  });
});
