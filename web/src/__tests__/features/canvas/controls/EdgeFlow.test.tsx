// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { ReactFlowProvider, useStoreApi } from "@xyflow/react";
import { useLayoutEffect } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { FlowLines } from "@/features/canvas/controls/EdgeFlow";
import { buildFlowPattern } from "@/features/canvas/flow/flow-taper";

afterEach(cleanup);

function SeedZoom({ zoom }: { zoom: number }) {
  const store = useStoreApi();

  useLayoutEffect(() => {
    store.setState({ transform: [0, 0, zoom] });
  }, [store, zoom]);

  return null;
}

function renderedWidths(container: HTMLElement): number[] {
  return Array.from(container.querySelectorAll("path"), (path) =>
    Number(path.getAttribute("stroke-width"))
  );
}

describe("FlowLines", () => {
  const { layers } = buildFlowPattern(100);
  const headScreenWidth = layers[layers.length - 1].width;
  const tailScreenWidth = layers[0].width;

  it.each([0.5, 1, 2, 5])("缩放 %s 时流光保持屏幕宽度", (zoom) => {
    const { container } = render(
      <ReactFlowProvider>
        <SeedZoom zoom={zoom} />
        <svg>
          <FlowLines path="M 0 0 L 100 0" />
        </svg>
      </ReactFlowProvider>
    );

    const widths = renderedWidths(container);
    expect(widths).toHaveLength(layers.length);
    // 属性值是世界坐标线宽；乘回缩放应恢复 flow-taper 定义的屏幕宽度
    expect(Math.max(...widths) * zoom).toBeCloseTo(headScreenWidth);
    expect(Math.min(...widths) * zoom).toBeCloseTo(tailScreenWidth);
  });
});
