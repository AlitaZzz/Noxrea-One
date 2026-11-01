// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { type ReactNode, useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import GenerationPanelHost, {
  type GenerationPanelTarget,
} from "@/features/canvas/panels/GenerationPanelHost";
import { useCanvasStore } from "@/features/canvas/stores/canvas-store";
import type { AnyNode } from "@/features/canvas/types";

const mounts = vi.hoisted(() => ({ image: 0, video: 0, text: 0 }));

vi.mock("@xyflow/react", () => ({
  NodeToolbar: ({ nodeId, children }: { nodeId: string; children?: ReactNode }) => (
    <div data-testid="node-toolbar" data-anchor={nodeId}>
      {children}
    </div>
  ),
  Position: { Bottom: "bottom" },
}));

function panelMock(kind: "image" | "video" | "text") {
  return () => ({
    default: function MockPanel({ nodeId, active }: { nodeId: string; active: boolean }) {
      useEffect(() => {
        mounts[kind] += 1;
      }, []);
      return (
        <div
          data-testid={`panel-${kind}`}
          data-node-id={nodeId}
          data-active={String(active)}
        />
      );
    },
  });
}

vi.mock("@/features/canvas/panels/ImageGenerationPanel", panelMock("image"));
vi.mock("@/features/canvas/panels/VideoGenerationPanel", panelMock("video"));
vi.mock("@/features/canvas/panels/TextGenerationPanel", panelMock("text"));

function updateLiveNodes(...ids: string[]) {
  act(() =>
    useCanvasStore.setState({
      nodes: ids.map(
        (id) =>
          ({
            id,
            type: "text-node",
            position: { x: 0, y: 0 },
            data: {},
            style: { width: 120, height: 80 },
          }) as unknown as AnyNode,
      ),
      edges: [],
    }),
  );
}

function renderHost(target: GenerationPanelTarget | null, ...liveIds: string[]) {
  updateLiveNodes(...liveIds);
  return render(<GenerationPanelHost target={target} />);
}

beforeEach(() => {
  mounts.image = 0;
  mounts.video = 0;
  mounts.text = 0;
});

afterEach(() => {
  cleanup();
  useCanvasStore.setState({ nodes: [], edges: [] });
});

describe("GenerationPanelHost", () => {
  it("没有目标时不挂载任何槽位", () => {
    const { container } = renderHost(null);

    expect(container).toBeEmptyDOMElement();
  });

  it("首次选中按类型挂载；切换同一类型的目标不重建实例", () => {
    const { rerender } = renderHost({ kind: "text", nodeId: "t1" }, "t1", "t2");

    const panel = screen.getByTestId("panel-text");
    expect(panel).toHaveAttribute("data-node-id", "t1");
    expect(panel).toHaveAttribute("data-active", "true");
    expect(screen.getByTestId("node-toolbar")).toHaveAttribute("data-anchor", "t1");
    expect(screen.queryByTestId("panel-image")).toBeNull();
    expect(mounts.text).toBe(1);

    rerender(<GenerationPanelHost target={{ kind: "text", nodeId: "t2" }} />);

    expect(screen.getByTestId("panel-text")).toHaveAttribute("data-node-id", "t2");
    expect(screen.getByTestId("panel-text")).toHaveAttribute("data-active", "true");
    expect(screen.getByTestId("node-toolbar")).toHaveAttribute("data-anchor", "t2");
    expect(mounts.text).toBe(1);
  });

  it("取消选中后面板隐藏但不卸载，锚点保留最后目标", () => {
    const { rerender } = renderHost({ kind: "text", nodeId: "t1" }, "t1");

    rerender(<GenerationPanelHost target={null} />);

    expect(screen.getByTestId("panel-text")).toHaveAttribute("data-active", "false");
    expect(screen.getByTestId("panel-text")).toHaveAttribute("data-node-id", "t1");
    expect(screen.getByTestId("node-toolbar")).toHaveAttribute("data-anchor", "t1");
    expect(mounts.text).toBe(1);
  });

  it("切换面板类型时旧槽位保留，新类型首次挂载", () => {
    const { rerender } = renderHost({ kind: "text", nodeId: "t1" }, "t1", "i1", "t3");

    rerender(<GenerationPanelHost target={{ kind: "image", nodeId: "i1" }} />);

    expect(screen.getByTestId("panel-text")).toHaveAttribute("data-active", "false");
    expect(screen.getByTestId("panel-text")).toHaveAttribute("data-node-id", "t1");
    expect(screen.getByTestId("panel-image")).toHaveAttribute("data-active", "true");
    expect(screen.getByTestId("node-toolbar")).toHaveAttribute("data-anchor", "i1");
    expect(mounts.text).toBe(1);
    expect(mounts.image).toBe(1);

    rerender(<GenerationPanelHost target={{ kind: "text", nodeId: "t3" }} />);

    expect(screen.getByTestId("panel-text")).toHaveAttribute("data-node-id", "t3");
    expect(screen.getByTestId("panel-text")).toHaveAttribute("data-active", "true");
    expect(mounts.text).toBe(1);
  });

  it("目标节点被删除后槽位卸载，不在下一次切换时挂回孤儿实例", () => {
    const { rerender } = renderHost({ kind: "text", nodeId: "t1" }, "t1");
    expect(screen.getByTestId("panel-text")).toHaveAttribute("data-node-id", "t1");

    // t1 被删除，选中另一个节点：文本槽位必须从记忆中剔除并卸载
    updateLiveNodes("i1");
    rerender(<GenerationPanelHost target={{ kind: "image", nodeId: "i1" }} />);

    expect(screen.queryByTestId("panel-text")).toBeNull();
    expect(screen.getByTestId("panel-image")).toHaveAttribute("data-node-id", "i1");
    expect(mounts.text).toBe(1);

    // 再次选中文本目标时重新挂载（旧实例已随删除丢弃）
    updateLiveNodes("i1", "t4");
    rerender(<GenerationPanelHost target={{ kind: "text", nodeId: "t4" }} />);

    expect(screen.getByTestId("panel-text")).toHaveAttribute("data-node-id", "t4");
    expect(mounts.text).toBe(2);
  });

  it("锚点被删除但其他槽位仍存在时改挂该槽位，实例保留", () => {
    const { rerender } = renderHost({ kind: "text", nodeId: "t1" }, "t1", "i1");
    rerender(<GenerationPanelHost target={{ kind: "image", nodeId: "i1" }} />);
    expect(screen.getByTestId("panel-text")).toHaveAttribute("data-active", "false");

    // i1 被删除并取消选中；t1 仍存在，宿主改以 t1 为锚点保留已挂载的文本实例
    updateLiveNodes("t1");
    rerender(<GenerationPanelHost target={null} />);

    expect(screen.queryByTestId("panel-image")).toBeNull();
    expect(screen.getByTestId("panel-text")).toHaveAttribute("data-node-id", "t1");
    expect(screen.getByTestId("panel-text")).toHaveAttribute("data-active", "false");
    expect(screen.getByTestId("node-toolbar")).toHaveAttribute("data-anchor", "t1");
    expect(mounts.text).toBe(1);
  });
});
