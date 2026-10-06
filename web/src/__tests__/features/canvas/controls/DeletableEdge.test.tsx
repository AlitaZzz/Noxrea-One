// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { type EdgeProps, Position, ReactFlowProvider } from "@xyflow/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import DeletableEdge from "@/features/canvas/controls/DeletableEdge";
import { EDGE_BASE_COLOR, EDGE_FLOW_COLOR } from "@/lib/constants";
import { EdgeHighlightContext } from "@/providers/EdgeHighlightContext";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/features/canvas/stores/canvas-store", () => ({
  useCanvasStore: { getState: () => ({ removeEdges: vi.fn() }) },
}));

afterEach(cleanup);

const props: EdgeProps = {
  id: "e1", source: "n1", target: "n2",
  sourceX: 100, sourceY: 100, sourcePosition: Position.Right,
  targetX: 300, targetY: 100, targetPosition: Position.Left,
};

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
    },
  );

  it("keeps highlighted edges visible and uses the flow color for animation", () => {
    const { container } = render(
      <ReactFlowProvider>
        <EdgeHighlightContext.Provider value={new Set([props.id])}>
          <svg>
            <DeletableEdge {...props} style={{ stroke: "none" }} />
          </svg>
        </EdgeHighlightContext.Provider>
      </ReactFlowProvider>,
    );

    const path = container.querySelector<SVGPathElement>(".react-flow__edge-path");
    expect(path?.style.stroke).toBe(EDGE_BASE_COLOR);
    expect(path?.style.strokeWidth).toBe("2.5");
    expect(container.querySelector(`path[stroke="${EDGE_FLOW_COLOR}"] animate`)).not.toBeNull();
  });
});
