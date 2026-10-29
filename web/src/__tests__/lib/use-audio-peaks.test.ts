// @vitest-environment jsdom
/**
 * 峰值 Hook（specs/canvas-audio-peaks-cache.md 规则 1 / 4.6 / 5.3）。
 *
 * 锁定三条消费方依赖的契约：
 * - 内存缓存命中在渲染期直接生效：首帧即 ready，不闪占位、不重复取数；
 * - 换源后旧结果立即作废，不会短暂显示上一条音频的波形；
 * - 超限 / 解码失败时 `duration` 仍随结果返回，供节点回填时长（规则 5.3）。
 */
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const service = vi.hoisted(() => ({
  get: vi.fn(),
  peek: vi.fn(),
  peekFailure: vi.fn(),
  touch: vi.fn(),
}));

vi.mock("@/lib/audio-peaks", () => ({
  getAudioPeaks: service.get,
  peekAudioPeaks: service.peek,
  peekAudioPeaksFailure: service.peekFailure,
  touchAudioPeaks: service.touch,
}));

import { useAudioPeaks } from "@/lib/audio-peaks/use-audio-peaks";

const PEAKS = { channels: [new Float32Array([0.1, 0.2])], duration: 19 };

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeEach(() => {
  service.get.mockReset();
  service.peek.mockReset();
  service.peek.mockReturnValue(null);
  service.peekFailure.mockReset();
  service.peekFailure.mockReturnValue(null);
  service.touch.mockReset();
});

describe("内存缓存命中（规则 1.2）", () => {
  it("命中时首帧即 ready，不再发取数请求", () => {
    service.peek.mockReturnValue(PEAKS);

    const { result } = renderHook(() => useAudioPeaks("1/aa/a.mp3"));

    expect(result.current).toEqual({ peaks: PEAKS, duration: 19, status: "ready" });
    expect(service.get).not.toHaveBeenCalled();
  });

  it("命中后的使用时刻在提交阶段补记（规则 3.4：渲染期探测保持纯读）", () => {
    service.peek.mockReturnValue(PEAKS);

    renderHook(() => useAudioPeaks("1/aa/a.mp3"));

    expect(service.touch).toHaveBeenCalledWith("1/aa/a.mp3");
    // 渲染期探测不得写缓存；服务路径（IndexedDB 命中 / 解码完成）自己记账
    expect(service.get).not.toHaveBeenCalled();
  });

  it("本会话已确认不可解的托管值首帧即 unavailable，不闪占位、不再取数", () => {
    service.peekFailure.mockReturnValue({ status: "unavailable", duration: 12, error: "too_large" });

    const { result } = renderHook(() => useAudioPeaks("1/aa/long.mp3"));

    expect(result.current).toEqual({ peaks: null, duration: 12, status: "unavailable" });
    expect(service.get).not.toHaveBeenCalled();
  });
});

describe("异步取数与换源（规则 4.6 / 1.5）", () => {
  it("未命中时先 loading，结果到达后转 ready", async () => {
    const pending = deferred<{ status: "ready"; peaks: typeof PEAKS }>();
    service.get.mockReturnValue(pending.promise);

    const { result } = renderHook(() => useAudioPeaks("1/bb/b.mp3"));
    expect(result.current.status).toBe("loading");
    expect(service.get).toHaveBeenCalledWith("1/bb/b.mp3");
    // 未命中内存：使用时刻由服务路径记账，Hook 不重复补记
    expect(service.touch).not.toHaveBeenCalled();

    pending.resolve({ status: "ready", peaks: PEAKS });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.peaks).toBe(PEAKS);
  });

  it("换源后旧结果立即作废，不显示上一条音频的波形", async () => {
    const first = deferred<{ status: "ready"; peaks: typeof PEAKS }>();
    service.get.mockReturnValueOnce(first.promise);
    const second = deferred<{ status: "ready"; peaks: typeof PEAKS }>();
    service.get.mockReturnValueOnce(second.promise);

    const { result, rerender } = renderHook(({ value }) => useAudioPeaks(value), {
      initialProps: { value: "1/cc/c.mp3" },
    });
    first.resolve({ status: "ready", peaks: PEAKS });
    await waitFor(() => expect(result.current.status).toBe("ready"));

    rerender({ value: "1/dd/d.mp3" });
    expect(result.current).toEqual({ peaks: null, duration: null, status: "loading" });
    expect(service.get).toHaveBeenLastCalledWith("1/dd/d.mp3");

    const other = { channels: [new Float32Array([0.4])], duration: 3 };
    second.resolve({ status: "ready", peaks: other });
    await waitFor(() => expect(result.current.peaks).toBe(other));
  });

  it("A→B→A：切回未就绪的源重新订阅，结果到达后落定（不会永久停在 loading）", async () => {
    const first = deferred<{ status: "ready"; peaks: typeof PEAKS }>();
    const second = deferred<{ status: "ready"; peaks: typeof PEAKS }>();
    service.get
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      // 切回 A 时服务层单飞返回同一个在途 Promise
      .mockReturnValueOnce(first.promise);

    const { result, rerender } = renderHook(({ value }) => useAudioPeaks(value), {
      initialProps: { value: "1/gg/a.mp3" },
    });
    expect(service.get).toHaveBeenCalledTimes(1);

    rerender({ value: "1/hh/b.mp3" });
    expect(service.get).toHaveBeenCalledTimes(2);

    // 切走时 A 的订阅已解除，但 A 尚未落定：切回必须重新订阅，否则结果无人接收
    rerender({ value: "1/gg/a.mp3" });
    expect(service.get).toHaveBeenCalledTimes(3);
    expect(service.get).toHaveBeenLastCalledWith("1/gg/a.mp3");
    expect(result.current.status).toBe("loading");

    first.resolve({ status: "ready", peaks: PEAKS });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.peaks).toBe(PEAKS);
  });

  it("卸载不取消在途取数：不传中止信号，迟到结果照常落定（规则 1.5）", async () => {
    const pending = deferred<{ status: "ready"; peaks: typeof PEAKS }>();
    service.get.mockReturnValue(pending.promise);

    const { unmount } = renderHook(() => useAudioPeaks("1/ee/e.mp3"));
    // 只按引用值取数、不传 signal：单飞解码归服务层所有，卸载的组件不能把它一起取消，
    // 否则其他挂载同一文件的消费者拿不到结果
    expect(service.get).toHaveBeenCalledWith("1/ee/e.mp3");

    unmount();
    pending.resolve({ status: "ready", peaks: PEAKS });
    await pending.promise;

    // 卸载后不再发起新的取数，也不重复补记使用时刻
    expect(service.get).toHaveBeenCalledTimes(1);
    expect(service.touch).not.toHaveBeenCalled();
  });
});

describe("不可用结果仍带时长（规则 5.3）", () => {
  it("超限降级时返回探测到的时长，供节点回填", async () => {
    service.get.mockResolvedValue({ status: "unavailable", error: "too_large", duration: 1500 });

    const { result } = renderHook(() => useAudioPeaks("1/ff/f.mp3"));

    await waitFor(() => expect(result.current.status).toBe("unavailable"));
    expect(result.current).toEqual({ peaks: null, duration: 1500, status: "unavailable" });
  });
});
