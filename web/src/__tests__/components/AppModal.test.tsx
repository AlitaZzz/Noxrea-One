// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { type ReactNode, type Ref, StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import AppModal from "@/components/ui/AppModal";

vi.mock("antd", () => ({
  Modal: ({ open, panelRef, style, children }: { open: boolean; panelRef?: Ref<HTMLDivElement>; style?: React.CSSProperties; children: ReactNode }) => open ? (
    <div data-testid="wrap"><div data-testid="panel" ref={panelRef} style={{ marginTop: 8, ...style }}>{children}</div></div>
  ) : null,
}));

let panelHeight: number;
let viewportHeight: number;
let callbacks: (() => void)[];
let disconnects: ReturnType<typeof vi.fn>[];

beforeEach(() => {
  panelHeight = 520;
  viewportHeight = 844;
  callbacks = [];
  disconnects = [];
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.dataset.testid === "panel" ? panelHeight : 0;
  });
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.dataset.testid === "wrap" ? viewportHeight : 0;
  });
  vi.stubGlobal("ResizeObserver", class {
    observe = vi.fn();
    disconnect = vi.fn();
    constructor(callback: () => void) {
      callbacks.push(callback);
      disconnects.push(this.disconnect);
    }
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("modal positioning", () => {
  it("includes mobile margins, recomputes after content and viewport changes, and releases observers", () => {
    const { getByTestId, unmount } = render(<StrictMode><AppModal title="Dialog" open onCancel={vi.fn()} footer={null}>Content</AppModal></StrictMode>);
    const panel = getByTestId("panel");
    expect(panel.style.top).toBe("154px");
    panelHeight = 600;
    act(() => callbacks.at(-1)!());
    expect(panel.style.top).toBe("114px");
    viewportHeight = 900;
    act(() => window.dispatchEvent(new Event("resize")));
    expect(panel.style.top).toBe("142px");
    panelHeight = 1200;
    act(() => callbacks.at(-1)!());
    expect(panel.style.top).toBe("0px");
    unmount();
    expect(disconnects.every((disconnect) => disconnect.mock.calls.length > 0)).toBe(true);
  });

  it("preserves an explicit top when centering is disabled", () => {
    const { getByTestId } = render(<AppModal title="Dialog" open centered={false} style={{ top: 70 }} onCancel={vi.fn()}>Content</AppModal>);
    expect(getByTestId("panel").style.top).toBe("70px");
    expect(callbacks).toHaveLength(0);
  });
});
