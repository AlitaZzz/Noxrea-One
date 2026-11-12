// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { Position, ReactFlow } from "@xyflow/react";
import { afterEach, describe, expect, it } from "vitest";

import PendingConnectionPreview from "@/features/canvas/controls/PendingConnectionPreview";
import {
  EDGE_BASE_COLOR,
  EDGE_BASE_OPACITY,
  EDGE_BASE_STROKE_WIDTH_VAR,
} from "@/lib/constants";

afterEach(cleanup);

describe("PendingConnectionPreview", () => {
  it("draws the pending preview base path with the shared screen-constant width", () => {
    // 挂在真实画布内：ViewportPortal 依赖 React Flow 的视口容器
    const { container } = render(
      <ReactFlow nodes={[]} edges={[]}>
        <PendingConnectionPreview
          from={{ x: 0, y: 0 }}
          to={{ x: 200, y: 100 }}
          fromPosition={Position.Right}
        />
      </ReactFlow>
    );

    const path = container.querySelector<SVGPathElement>(
      ".react-flow__viewport-portal path"
    );
    expect(path).not.toBeNull();
    expect(path?.style.stroke).toBe(EDGE_BASE_COLOR);
    expect(path?.style.strokeWidth).toBe(EDGE_BASE_STROKE_WIDTH_VAR);
    expect(path?.style.opacity).toBe(String(EDGE_BASE_OPACITY));
  });
});
