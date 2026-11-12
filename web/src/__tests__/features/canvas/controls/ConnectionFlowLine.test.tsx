// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import {
  type ConnectionLineComponentProps,
  Position,
  ReactFlowProvider,
} from "@xyflow/react";
import { afterEach, describe, expect, it } from "vitest";

import ConnectionFlowLine from "@/features/canvas/controls/ConnectionFlowLine";
import { useCanvasStore } from "@/features/canvas/stores/canvas-store";
import type { AnyNode } from "@/features/canvas/types";
import {
  EDGE_BASE_COLOR,
  EDGE_BASE_OPACITY,
  EDGE_BASE_STROKE_WIDTH_VAR,
  NODE_TYPE,
} from "@/lib/constants";

afterEach(() => {
  cleanup();
  useCanvasStore.setState({ nodes: [], edges: [] });
});

function makeNode(id: string, selected = false): AnyNode {
  return {
    id,
    type: NODE_TYPE.TEXT,
    position: { x: 0, y: 0 },
    data: {},
    selected,
    style: { width: 120, height: 80 },
  } as unknown as AnyNode;
}

function makeProps(fromNode: AnyNode): ConnectionLineComponentProps {
  return {
    connectionLineType: "bezier",
    fromNode,
    fromHandle: {
      id: "h1",
      type: "source",
      position: Position.Right,
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      nodeId: fromNode.id,
    },
    fromX: 120,
    fromY: 40,
    toX: 300,
    toY: 100,
    fromPosition: Position.Right,
    toPosition: Position.Left,
    connectionStatus: null,
    toNode: null,
    toHandle: null,
    pointer: { x: 300, y: 100 },
  } as unknown as ConnectionLineComponentProps;
}

function renderLine(fromNode: AnyNode) {
  return render(
    <ReactFlowProvider>
      <svg>
        <ConnectionFlowLine {...makeProps(fromNode)} />
      </svg>
    </ReactFlowProvider>
  );
}

function expectBasePaths(container: HTMLElement, count: number) {
  const paths = container.querySelectorAll<SVGPathElement>(".react-flow__edge-path");
  expect(paths).toHaveLength(count);
  for (const path of paths) {
    expect(path.style.stroke).toBe(EDGE_BASE_COLOR);
    expect(path.style.strokeWidth).toBe(EDGE_BASE_STROKE_WIDTH_VAR);
    expect(path.style.opacity).toBe(String(EDGE_BASE_OPACITY));
  }
}

describe("ConnectionFlowLine", () => {
  it("draws the preview base path with the shared screen-constant width", () => {
    const { container } = renderLine(makeNode("n1"));
    expectBasePaths(container, 1);
  });

  it("draws every multi-select bundle base path with the same width contract", () => {
    useCanvasStore.setState({
      nodes: [makeNode("n1", true), makeNode("n2", true)],
    });

    const { container } = renderLine(makeNode("n1", true));
    expectBasePaths(container, 2);
  });
});
