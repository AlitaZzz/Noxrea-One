// @vitest-environment jsdom
/**
 * 画布媒体视口结算（specs/canvas-media-resolution-lod.md 规则 5.1 / 5.7）：
 * 缩放连续变化期间不为已加载图片换档；停止 200 ms 后才结算一次；
 * `zoomingOut` 只在方向变化时翻转，结算后归 false；DPR 走外部源订阅。
 */
import { act, cleanup, render, screen } from "@testing-library/react";
import { ReactFlowProvider, useStoreApi } from "@xyflow/react";
import { useContext, useLayoutEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import CanvasMediaLoadingProvider, {
  CanvasMediaViewportContext,
} from "@/features/canvas/shared/CanvasMediaLoadingProvider";
import { getLiveViewport, syncLiveViewport } from "@/features/canvas/stores/canvas-store";

let flowStore: ReturnType<typeof useStoreApi>;

function StoreBridge() {
  const api = useStoreApi();
  useLayoutEffect(() => {
    flowStore = api;
    api.setState({ width: 800, height: 600, transform: [0, 0, 1] });
  }, [api]);
  return null;
}

/** 记录每一次上下文取值：用于断言结算次数与中间值 */
const seen: Array<{ zoom: number; dpr: number; out: boolean }> = [];

function Probe() {
  const { settledZoom, dpr, zoomingOut } = useContext(CanvasMediaViewportContext);
  seen.push({ zoom: settledZoom, dpr, out: zoomingOut });
  return <div data-testid="probe" data-zoom={settledZoom} data-dpr={dpr} data-out={String(zoomingOut)} />;
}

function Scene() {
  return (
    <ReactFlowProvider>
      <StoreBridge />
      <CanvasMediaLoadingProvider><Probe /></CanvasMediaLoadingProvider>
    </ReactFlowProvider>
  );
}

function zoomTo(zoom: number) {
  act(() => flowStore.setState({ transform: [0, 0, zoom] }));
}

beforeEach(() => {
  vi.useFakeTimers();
  seen.length = 0;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("CanvasMediaLoadingProvider", () => {
  it("连续缩放期间不换档，停止 200 ms 后只结算一次最终值", async () => {
    render(<Scene />);
    expect(screen.getByTestId("probe").dataset.zoom).toBe("1");
    zoomTo(0.8);
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    zoomTo(0.5);
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    zoomTo(0.1);
    await act(async () => { await vi.advanceTimersByTimeAsync(199); });
    expect(screen.getByTestId("probe").dataset.zoom).toBe("1");
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(screen.getByTestId("probe").dataset.zoom).toBe("0.1");
    // 结算只发生一次：中间缩放值从未进入上下文
    expect(seen.filter((value) => value.zoom === 0.8 || value.zoom === 0.5)).toHaveLength(0);
  });

  it("zoomingOut 在缩小手势中为真，放大手势与结算后为假", async () => {
    render(<Scene />);
    expect(screen.getByTestId("probe").dataset.out).toBe("false");
    zoomTo(0.5);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByTestId("probe").dataset.out).toBe("true");
    // 手势继续缩小：保持 true，不因每次变化重新渲染成 false
    zoomTo(0.2);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByTestId("probe").dataset.out).toBe("true");
    // 结算后归 false，并结算最终缩放
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    expect(screen.getByTestId("probe").dataset.out).toBe("false");
    expect(screen.getByTestId("probe").dataset.zoom).toBe("0.2");
    // 放大手势：zoomingOut 保持 false
    zoomTo(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByTestId("probe").dataset.out).toBe("false");
  });

  it("同一手势内反向时 zoomingOut 立即翻转（按相邻帧方向，不按手势起点）", async () => {
    render(<Scene />);
    zoomTo(3);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByTestId("probe").dataset.out).toBe("false");
    // 手势尚未结算（< 200ms）就反向回缩：方向是缩小，必须翻转
    zoomTo(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByTestId("probe").dataset.out).toBe("true");
    // 再反向放大：方向是放大
    zoomTo(2.5);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByTestId("probe").dataset.out).toBe("false");
    // 结算后归 false，最终值取最后一次缩放
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    expect(screen.getByTestId("probe").dataset.out).toBe("false");
    expect(screen.getByTestId("probe").dataset.zoom).toBe("2.5");
  });

  it("初始结算值取恢复后的视口，不先按默认 1.0 请求一轮", () => {
    // 恢复流程在 Provider 挂载前写入 live viewport（0.1 是本次问题的主场景）
    const previous = getLiveViewport();
    syncLiveViewport({ x: 0, y: 0, zoom: 0.1 });
    try {
      render(<Scene />);
      expect(screen.getByTestId("probe").dataset.zoom).toBe("0.1");
    } finally {
      syncLiveViewport(previous);
    }
  });

  it("DPR 来自设备像素比并按 1..3 截断", () => {
    const original = window.devicePixelRatio;
    Object.defineProperty(window, "devicePixelRatio", { value: 4, configurable: true });
    try {
      render(<Scene />);
      expect(screen.getByTestId("probe").dataset.dpr).toBe("3");
    } finally {
      Object.defineProperty(window, "devicePixelRatio", { value: original, configurable: true });
    }
  });
});
