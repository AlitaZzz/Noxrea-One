// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { type Edge, type EdgeProps, Position, ReactFlowProvider } from "@xyflow/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import DeletableEdge from "@/features/canvas/controls/DeletableEdge";
import { getFlowDrawable } from "@/features/canvas/flow/flow-registry";
import { computeEdgePath } from "@/features/canvas/shared/edge-geometry";
import { useCanvasStore } from "@/features/canvas/stores/canvas-store";
import type { AnyNode } from "@/features/canvas/types";
import { EDGE_BASE_COLOR } from "@/lib/constants";

vi.mock("react-i18next", () => import("@/__tests__/test-utils/react-i18next-mock"));

afterEach(() => {
  cleanup();
  useCanvasStore.setState({ nodes: [], edges: [] });
});

const props: EdgeProps = {
  id: "e1", source: "n1", target: "n2",
  sourceX: 100, sourceY: 100, sourcePosition: Position.Right,
  targetX: 300, targetY: 100, targetPosition: Position.Left,
};

function renderEdge() {
  return render(
    <ReactFlowProvider>
      <svg>
        <DeletableEdge {...props} style={{ stroke: "none" }} />
      </svg>
    </ReactFlowProvider>,
  );
}

describe("DeletableEdge", () => {
  it.each(["var(--canvas-text-muted)", "#abcdef", "none"])(
    "renders the current theme instead of stored appearance (%s)",
    (stroke) => {
      const { container } = render(
        <ReactFlowProvider>
          <svg>
            <DeletableEdge {...props} style={{ stroke, strokeWidth: 0, opacity: 0, display: "none" }} />
          </svg>
        </ReactFlowProvider>,
      );

      const path = container.querySelector<SVGPathElement>(".react-flow__edge-path");
      expect(path?.style.stroke).toBe(EDGE_BASE_COLOR);
      expect(path?.style.strokeWidth).toBe("2");
      expect(path?.style.opacity).toBe("");
      expect(path?.style.display).toBe("");
      // 非强调态不登记流光，也不挂载任何 SMIL
      expect(getFlowDrawable(props.id)).toBeUndefined();
      expect(container.querySelector("animate")).toBeNull();
    },
  );

  it("highlights edges connected to a selected node", () => {
    // 高亮来自画布共享投影（选中节点 → 关联边），组件逐边订阅这一推导
    useCanvasStore.setState({
      nodes: [{
        id: "n1",
        type: "text-node",
        position: { x: 0, y: 0 },
        data: {},
        selected: true,
        style: { width: 120, height: 80 },
      } as unknown as AnyNode],
      edges: [{ id: props.id, source: props.source, target: props.target } as Edge],
    });

    const { container } = renderEdge();

    const path = container.querySelector<SVGPathElement>(".react-flow__edge-path");
    expect(path?.style.stroke).toBe(EDGE_BASE_COLOR);
    expect(path?.style.strokeWidth).toBe("2.5");

    // 流光交给画布流光层：强调态只登记几何，DOM 里不再有 SMIL
    const geometry = computeEdgePath(props);
    expect(getFlowDrawable(props.id)?.geometry).toEqual({
      curve: geometry.curve,
      length: geometry.length,
    });
    expect(container.querySelector("animate")).toBeNull();
  });
});
