// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { ReactFlow, ReactFlowProvider, useStoreApi } from "@xyflow/react";
import { useLayoutEffect } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { EdgeBaseWidthVariable } from "@/features/canvas/controls/EdgeBaseWidthVariable";
import { EDGE_BASE_STROKE_WIDTH_VAR_NAME } from "@/lib/constants";

afterEach(cleanup);

function SeedZoom({ zoom }: { zoom: number }) {
  const store = useStoreApi();

  useLayoutEffect(() => {
    store.setState({ transform: [0, 0, zoom] });
  }, [store, zoom]);

  return null;
}

function View({ zoom }: { zoom: number }) {
  return (
    <div className="react-flow">
      <ReactFlowProvider>
        <SeedZoom zoom={zoom} />
        <EdgeBaseWidthVariable />
      </ReactFlowProvider>
    </div>
  );
}

describe("EdgeBaseWidthVariable", () => {
  it("converts the target screen width back to world units on zoom changes", () => {
    const { container, rerender, unmount } = render(<View zoom={0.5} />);
    const root = container.querySelector<HTMLElement>(".react-flow")!;

    // 1px 屏幕宽 ÷ 0.5 缩放 = 2px 世界坐标
    expect(root.style.getPropertyValue(EDGE_BASE_STROKE_WIDTH_VAR_NAME)).toBe("2px");

    rerender(<View zoom={2} />);

    // 1px 屏幕宽 ÷ 2 缩放 = 0.5px 世界坐标
    expect(root.style.getPropertyValue(EDGE_BASE_STROKE_WIDTH_VAR_NAME)).toBe("0.5px");

    unmount();
    expect(root.style.getPropertyValue(EDGE_BASE_STROKE_WIDTH_VAR_NAME)).toBe("");
  });

  it("resolves the root through the real canvas mount", () => {
    // 直接挂载真实 <ReactFlow>：锁定组件必须位于画布子树内，且根节点查找与
    // React Flow 的实际 DOM 结构一致（移除挂载或结构变化必须失败）。
    const { container } = render(
      <ReactFlow
        nodes={[]}
        edges={[]}
        defaultViewport={{ x: 0, y: 0, zoom: 0.5 }}
        minZoom={0.1}
        maxZoom={5}
      >
        <EdgeBaseWidthVariable />
      </ReactFlow>
    );
    const root = container.querySelector<HTMLElement>(".react-flow")!;

    // 1px 屏幕宽 ÷ 首帧视口 0.5 缩放 = 2px 世界坐标
    expect(root.style.getPropertyValue(EDGE_BASE_STROKE_WIDTH_VAR_NAME)).toBe("2px");
  });
});
