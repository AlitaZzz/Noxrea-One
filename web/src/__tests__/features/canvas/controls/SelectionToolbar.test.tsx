// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement, type ReactNode, useEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  computeSelectionToolbarPlacement,
  SelectionToolbar,
  SelectionToolbarLayer,
} from "@/features/canvas/controls/SelectionToolbar";

// 容器层只依赖 Panel 的挂载点、视口变换与视口尺寸；展示层测试同样走这份轻量替身。
vi.mock("@xyflow/react", () => ({
  Panel: ({ children }: { children?: ReactNode }) => createElement("div", null, children),
  useViewport: () => ({ x: 0, y: 0, zoom: 1 }),
  useStore: (selector: (state: { width: number; height: number }) => unknown) =>
    selector({ width: 1000, height: 800 }),
}));

vi.mock("react-i18next", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-i18next")>()),
  useTranslation: () => ({
    t: (key: string, options?: { count?: number }) =>
      options?.count === undefined ? key : `${key}:${options.count}`,
    i18n: { language: "en" },
  }),
}));

// 展示层测试不触达真实画布动作；容器层只在 InfiniteCanvas 中挂载。
vi.mock("@/features/canvas/shared/canvas-edit-actions", () => ({
  copySelection: vi.fn(),
  deleteSelection: vi.fn(),
  duplicateSelection: vi.fn(),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

interface ToolbarHarnessProps {
  count?: number;
  hasGroup?: boolean;
  selectionKey?: string;
  onGroup?: () => void;
  onUngroup?: () => void;
  onDuplicate?: () => void;
  onCopy?: () => void;
  onDelete?: () => void;
}

function ToolbarHarness({
  count = 3,
  hasGroup = false,
  selectionKey = "a",
  onGroup = vi.fn(),
  onUngroup = vi.fn(),
  onDuplicate = vi.fn(),
  onCopy = vi.fn(),
  onDelete = vi.fn(),
}: ToolbarHarnessProps) {
  return (
    <SelectionToolbar
      count={count}
      hasGroup={hasGroup}
      selectionKey={selectionKey}
      onGroup={onGroup}
      onUngroup={onUngroup}
      onDuplicate={onDuplicate}
      onCopy={onCopy}
      onDelete={onDelete}
    />
  );
}

async function openMoreMenu() {
  const trigger = screen.getByRole("button", { name: "common.moreActions" });
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  await act(async () => {});
  await waitFor(() => expect(screen.getByRole("menu")).toBeInTheDocument());
}

// jsdom 默认返回全 0 的 rect，容器层会一直处于隐藏态；给工具条一个稳定尺寸。
function mockToolbarRect() {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    width: 240,
    height: 50,
    top: 0,
    right: 240,
    bottom: 50,
    left: 0,
    toJSON: () => ({}),
  } as DOMRect);
}

describe("SelectionToolbar", () => {
  it("shows the count and the non-group action set", () => {
    render(<ToolbarHarness count={4} />);

    const count = screen.getByText("canvas.selection.count:4");
    expect(count).toHaveAttribute("aria-live", "polite");
    expect(screen.getByRole("button", { name: "common.group" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "common.ungroup" })).toBeNull();
    expect(screen.getByRole("button", { name: "common.duplicate" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "common.moreActions" })).toBeInTheDocument();
  });

  it("renders an icon on every primary action button", () => {
    const { rerender } = render(<ToolbarHarness />);

    expect(screen.getByRole("button", { name: "common.group" }).querySelector("svg")).not.toBeNull();
    expect(
      screen.getByRole("button", { name: "common.duplicate" }).querySelector("svg"),
    ).not.toBeNull();

    rerender(<ToolbarHarness hasGroup />);
    expect(
      screen.getByRole("button", { name: "common.ungroup" }).querySelector("svg"),
    ).not.toBeNull();
  });

  it("swaps 编组 for 解组 when the selection contains a group", () => {
    render(<ToolbarHarness hasGroup />);

    expect(screen.getByRole("button", { name: "common.ungroup" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "common.group" })).toBeNull();
  });

  it("keeps the keyboard order group/ungroup → duplicate → more", () => {
    const { container } = render(<ToolbarHarness />);
    const names = Array.from(container.querySelectorAll("button")).map((button) =>
      button.getAttribute("aria-label") ?? button.textContent,
    );
    expect(names).toEqual(["common.group", "common.duplicate", "common.moreActions"]);
  });

  it("invokes the primary actions without duplicating their implementations", () => {
    const onGroup = vi.fn();
    const onUngroup = vi.fn();
    const onDuplicate = vi.fn();
    const { rerender } = render(
      <ToolbarHarness onGroup={onGroup} onUngroup={onUngroup} onDuplicate={onDuplicate} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "common.group" }));
    fireEvent.click(screen.getByRole("button", { name: "common.duplicate" }));
    expect(onGroup).toHaveBeenCalledTimes(1);
    expect(onDuplicate).toHaveBeenCalledTimes(1);

    rerender(
      <ToolbarHarness hasGroup onGroup={onGroup} onUngroup={onUngroup} onDuplicate={onDuplicate} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "common.ungroup" }));
    expect(onUngroup).toHaveBeenCalledTimes(1);
  });

  it("offers 复制 and 删除 in the more menu", async () => {
    const onCopy = vi.fn();
    const onDelete = vi.fn();
    render(<ToolbarHarness onCopy={onCopy} onDelete={onDelete} />);

    await openMoreMenu();
    expect(screen.getByRole("menuitem", { name: "common.copy" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "common.delete" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("menuitem", { name: "common.copy" }));
    expect(onCopy).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());

    await openMoreMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "common.delete" }));
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it("does not steal focus on mount", () => {
    render(<ToolbarHarness />);
    expect(document.activeElement).toBe(document.body);
  });

  it("lets the first Escape close the menu without reaching the canvas handler", async () => {
    const canvasEscape = vi.fn();
    function EscapeProbe() {
      useEffect(() => {
        const handler = (event: KeyboardEvent) => {
          if (event.key === "Escape" && !event.defaultPrevented) canvasEscape();
        };
        window.addEventListener("keydown", handler);
        return () => window.removeEventListener("keydown", handler);
      }, []);
      return null;
    }

    render(
      <>
        <EscapeProbe />
        <ToolbarHarness />
      </>,
    );
    await openMoreMenu();

    fireEvent.keyDown(document.body, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(canvasEscape).not.toHaveBeenCalled();

    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(canvasEscape).toHaveBeenCalledTimes(1);
  });

  it("closes the more menu when the selection changes", async () => {
    mockToolbarRect();
    const bounds = {
      count: 2,
      hasGroup: false,
      bbox: { x: 100, y: 100, width: 200, height: 100 },
      frameVisible: true,
      containerBbox: { x: 60, y: 32, width: 280, height: 208 },
    };

    const { rerender } = render(
      <SelectionToolbarLayer bounds={bounds} selectionKey="a" />,
    );
    await act(async () => {});
    const liveRegion = screen.getByText("canvas.selection.count:2");
    await openMoreMenu();

    // 选区签名变化 → 「更多」菜单按 key 重挂载并关闭；展示层不重挂载，
    // aria-live 节点必须保留，否则计数变化对读屏不可见。
    rerender(<SelectionToolbarLayer bounds={bounds} selectionKey="b" />);
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(screen.getByText("canvas.selection.count:2")).toBe(liveRegion);
  });

  it("caps the toolbar width to the viewport so the row wraps instead of overflowing", async () => {
    mockToolbarRect();
    const bounds = {
      count: 2,
      hasGroup: false,
      bbox: { x: 100, y: 100, width: 200, height: 100 },
      frameVisible: true,
      containerBbox: { x: 60, y: 32, width: 280, height: 208 },
    };

    const { container } = render(
      <SelectionToolbarLayer bounds={bounds} selectionKey="a" />,
    );
    const positioned = container.querySelector<HTMLElement>(".absolute");

    // 视口 1000px，左右各留 8px → 工具条容器最大 984px；Card 用 flex-wrap 换行。
    await waitFor(() => expect(positioned?.style.maxWidth).toBe("984px"));
  });

  it("anchors to the derived container bounds instead of the raw node union", async () => {
    mockToolbarRect();
    const bounds = {
      count: 2,
      hasGroup: false,
      bbox: { x: 100, y: 100, width: 200, height: 100 },
      frameVisible: true,
      containerBbox: { x: 60, y: 32, width: 280, height: 208 },
    };

    const { container } = render(
      <SelectionToolbarLayer bounds={bounds} selectionKey="a" />,
    );
    const positioned = container.querySelector<HTMLElement>(".absolute");

    // 若误用 bbox，top 会是 212；containerBbox 已包含四边 40px 与顶部标题带，工具条落在容器框下方 12px。
    await waitFor(() => expect(positioned?.style.left).toBe("80px"));
    expect(positioned?.style.top).toBe("252px");
  });
});

describe("computeSelectionToolbarPlacement", () => {
  const viewport = { x: 0, y: 0, zoom: 1 };
  const viewportSize = { width: 1000, height: 800 };
  const toolbarSize = { width: 240, height: 50 };

  it("centers the toolbar 12px above the selection", () => {
    expect(
      computeSelectionToolbarPlacement({
        bounds: { x: 400, y: 300, width: 200, height: 100 },
        viewport,
        viewportSize,
        toolbarSize,
      }),
    ).toEqual({ left: 380, top: 238 });
  });

  it("moves below the selection when the top edge lacks room", () => {
    expect(
      computeSelectionToolbarPlacement({
        bounds: { x: 400, y: 10, width: 200, height: 100 },
        viewport,
        viewportSize,
        toolbarSize,
      }),
    ).toEqual({ left: 380, top: 122 });
  });

  it("clamps inside the viewport when neither side fits", () => {
    expect(
      computeSelectionToolbarPlacement({
        bounds: { x: 400, y: 20, width: 200, height: 160 },
        viewport,
        viewportSize: { width: 1000, height: 200 },
        toolbarSize,
      }),
    ).toEqual({ left: 380, top: 142 });
  });

  it("keeps 8px horizontal clearance at both viewport edges", () => {
    expect(
      computeSelectionToolbarPlacement({
        bounds: { x: 0, y: 300, width: 100, height: 100 },
        viewport,
        viewportSize,
        toolbarSize,
      })?.left,
    ).toBe(8);
    expect(
      computeSelectionToolbarPlacement({
        bounds: { x: 900, y: 300, width: 100, height: 100 },
        viewport,
        viewportSize,
        toolbarSize,
      })?.left,
    ).toBe(752);
  });

  it("projects flow coordinates through the viewport transform", () => {
    expect(
      computeSelectionToolbarPlacement({
        bounds: { x: 200, y: 200, width: 400, height: 200 },
        viewport: { x: 100, y: 100, zoom: 0.5 },
        viewportSize,
        toolbarSize,
      }),
    ).toEqual({ left: 180, top: 138 });
  });

  it("returns null when the selection is fully outside the viewport", () => {
    expect(
      computeSelectionToolbarPlacement({
        bounds: { x: 2000, y: 0, width: 200, height: 100 },
        viewport,
        viewportSize,
        toolbarSize,
      }),
    ).toBeNull();
    expect(
      computeSelectionToolbarPlacement({
        bounds: { x: 0, y: -200, width: 200, height: 100 },
        viewport,
        viewportSize,
        toolbarSize,
      }),
    ).toBeNull();
  });
});
