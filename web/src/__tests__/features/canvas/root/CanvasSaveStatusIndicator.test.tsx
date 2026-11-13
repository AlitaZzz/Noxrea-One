// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import CanvasSaveStatusIndicator from "@/features/canvas/root/CanvasSaveStatusIndicator";

const mocks = vi.hoisted(() => {
  let phase = "unknown";
  const listeners = new Set<() => void>();
  return {
    listeners,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    get: vi.fn(() => phase),
    set: (next: string) => {
      phase = next;
      for (const listener of listeners) listener();
    },
  };
});

vi.mock("react-i18next", () => import("@/__tests__/test-utils/react-i18next-mock"));
vi.mock("@/features/canvas/persistence/save-manager", () => ({
  saveManager: {
    subscribeSavePhase: mocks.subscribe,
    getSavePhase: mocks.get,
  },
}));

function status() {
  return screen.getByTestId("canvas-save-status");
}

beforeEach(() => {
  vi.useFakeTimers();
  mocks.set("unknown");
});

afterEach(() => {
  cleanup();
  mocks.listeners.clear();
  vi.useRealTimers();
});

describe("CanvasSaveStatusIndicator", () => {
  it("shows unsaved immediately and delays saving by 500ms", () => {
    render(<CanvasSaveStatusIndicator />);
    expect(screen.queryByTestId("canvas-save-status")).toBeNull();

    act(() => mocks.set("unsaved"));
    expect(status()).toHaveTextContent("canvas.save.unsaved");
    expect(status()).toHaveAttribute("data-phase", "unsaved");

    act(() => mocks.set("saving"));
    expect(status()).toHaveTextContent("canvas.save.unsaved");
    act(() => vi.advanceTimersByTime(499));
    expect(status()).toHaveTextContent("canvas.save.unsaved");
    act(() => vi.advanceTimersByTime(1));
    expect(status()).toHaveTextContent("canvas.save.saving");
    expect(status()).toHaveAttribute("data-phase", "saving");
    expect(status()).toHaveClass("pointer-events-none");
    expect(status()).not.toHaveAttribute("aria-live");
    expect(screen.getByTestId("canvas-save-status-dot")).toHaveClass("motion-safe:animate-pulse");
    expect(screen.getByTestId("canvas-save-status-dot")).toHaveAttribute("aria-hidden", "true");
  });

  it("keeps saving visible for at least 200ms before showing saved", () => {
    render(<CanvasSaveStatusIndicator />);
    act(() => mocks.set("unsaved"));
    act(() => mocks.set("saving"));
    act(() => vi.advanceTimersByTime(500));
    expect(status()).toHaveTextContent("canvas.save.saving");

    act(() => mocks.set("saved"));
    expect(status()).toHaveTextContent("canvas.save.saving");
    act(() => vi.advanceTimersByTime(199));
    expect(status()).toHaveTextContent("canvas.save.saving");
    act(() => vi.advanceTimersByTime(1));
    expect(status()).toHaveTextContent("canvas.save.saved");
    expect(status()).toHaveAttribute("data-phase", "saved");
    expect(screen.queryByTestId("canvas-save-status-dot")).toBeNull();
  });

  it("switches to unsaved immediately when a pending save appears", () => {
    render(<CanvasSaveStatusIndicator />);
    act(() => mocks.set("unsaved"));
    act(() => mocks.set("saving"));
    act(() => vi.advanceTimersByTime(500));
    expect(status()).toHaveTextContent("canvas.save.saving");

    act(() => mocks.set("unsaved"));
    expect(status()).toHaveTextContent("canvas.save.unsaved");
    act(() => vi.advanceTimersByTime(1_000));
    expect(status()).toHaveTextContent("canvas.save.unsaved");
  });

  it("leaves saving immediately for blocked / offline / expired", () => {
    render(<CanvasSaveStatusIndicator />);
    act(() => mocks.set("unsaved"));
    act(() => mocks.set("saving"));
    act(() => vi.advanceTimersByTime(500));
    expect(status()).toHaveTextContent("canvas.save.saving");

    // 可行动状态优先：不等待 200ms 最短展示
    act(() => mocks.set("blocked"));
    expect(status()).toHaveTextContent("canvas.save.blocked");
    act(() => mocks.set("offline"));
    expect(status()).toHaveTextContent("canvas.save.offline");

    act(() => mocks.set("saving"));
    act(() => vi.advanceTimersByTime(500));
    expect(status()).toHaveTextContent("canvas.save.saving");

    act(() => mocks.set("expired"));
    expect(screen.queryByTestId("canvas-save-status")).toBeNull();
  });

  it("never falls back to saved during the saving delay", () => {
    render(<CanvasSaveStatusIndicator />);
    act(() => mocks.set("saved"));
    expect(status()).toHaveTextContent("canvas.save.saved");

    act(() => mocks.set("saving"));
    expect(status()).toHaveTextContent("canvas.save.unsaved");
    act(() => vi.advanceTimersByTime(500));
    expect(status()).toHaveTextContent("canvas.save.saving");
  });

  it("uses the SaveManager phase, not navigator.onLine, to decide offline", () => {
    const original = Object.getOwnPropertyDescriptor(window.navigator, "onLine");
    Object.defineProperty(window.navigator, "onLine", { configurable: true, get: () => false });
    try {
      render(<CanvasSaveStatusIndicator />);
      // 离线判定只属于 SaveManager：浏览器报告离线但相位为 saved 时仍显示已保存
      act(() => mocks.set("saved"));
      expect(status()).toHaveTextContent("canvas.save.saved");
    } finally {
      if (original) Object.defineProperty(window.navigator, "onLine", original);
      else Reflect.deleteProperty(window.navigator, "onLine");
    }
  });

  it("shows blocked and offline immediately with the destructive / amber dot", () => {
    render(<CanvasSaveStatusIndicator />);
    const liveRegion = screen.getByRole("status");

    act(() => mocks.set("blocked"));
    expect(status()).toHaveTextContent("canvas.save.blocked");
    expect(screen.getByTestId("canvas-save-status-dot")).toHaveClass("bg-destructive");
    expect(screen.getByRole("status")).toBe(liveRegion);
    expect(screen.getByRole("status")).toHaveTextContent("canvas.save.blocked");

    act(() => mocks.set("offline"));
    expect(status()).toHaveTextContent("canvas.save.offline");
    expect(screen.getByTestId("canvas-save-status-dot")).toHaveClass("bg-amber-400");
    expect(screen.getByRole("status")).toBe(liveRegion);
    expect(screen.getByRole("status")).toHaveTextContent("canvas.save.offline");

    act(() => mocks.set("saved"));
    expect(status()).toHaveTextContent("canvas.save.saved");
    expect(screen.queryByTestId("canvas-save-status-dot")).toBeNull();
    expect(screen.getByRole("status")).toBeEmptyDOMElement();

    // saved / blocked 常驻，不因计时器自动隐藏
    act(() => vi.advanceTimersByTime(60_000));
    expect(status()).toHaveTextContent("canvas.save.saved");
    act(() => mocks.set("blocked"));
    act(() => vi.advanceTimersByTime(60_000));
    expect(status()).toHaveTextContent("canvas.save.blocked");
  });

  it("renders no capsule for unknown / expired but keeps the live region", () => {
    render(<CanvasSaveStatusIndicator />);
    expect(screen.queryByTestId("canvas-save-status")).toBeNull();
    expect(screen.getByRole("status")).toBeEmptyDOMElement();

    act(() => mocks.set("expired"));
    expect(screen.queryByTestId("canvas-save-status")).toBeNull();
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
  });

  it("bails out when the parent re-renders with an unchanged phase", () => {
    function Parent({ tick }: { tick: number }) {
      return (
        <>
          <span data-testid="parent-tick">{tick}</span>
          <CanvasSaveStatusIndicator />
        </>
      );
    }

    const view = render(<Parent tick={0} />);
    act(() => mocks.set("saved"));
    expect(status()).toHaveTextContent("canvas.save.saved");

    mocks.get.mockClear();
    for (let tick = 1; tick <= 10; tick += 1) {
      view.rerender(<Parent tick={tick} />);
    }

    // memo 子组件在 props 未变时不得因父级重渲染而提交
    expect(mocks.get).not.toHaveBeenCalled();
    expect(status()).toHaveTextContent("canvas.save.saved");
  });

  it("cancels pending timers on unmount", () => {
    const view = render(<CanvasSaveStatusIndicator />);
    act(() => mocks.set("saving"));
    // 定时器仍挂起时卸载：清理必须真正撤销它，不能只依赖卸载后的空树断言
    expect(vi.getTimerCount()).toBe(1);
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
    act(() => vi.advanceTimersByTime(1_000));
    expect(screen.queryByTestId("canvas-save-status")).toBeNull();
  });
});
