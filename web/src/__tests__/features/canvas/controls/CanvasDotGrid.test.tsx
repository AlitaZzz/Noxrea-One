// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { ReactFlow } from "@xyflow/react";
import { afterEach, describe, expect, it } from "vitest";

import { CanvasDotGrid } from "@/features/canvas/controls/CanvasDotGrid";

afterEach(cleanup);

function renderAtZoom(zoom: number) {
  return render(
    <ReactFlow
      nodes={[]}
      edges={[]}
      defaultViewport={{ x: 0, y: 0, zoom }}
      minZoom={0.1}
      maxZoom={5}
    >
      <CanvasDotGrid />
    </ReactFlow>
  );
}

function getPattern(container: HTMLElement) {
  const svg = container.querySelector<SVGSVGElement>(".react-flow__background");
  expect(svg).not.toBeNull();
  const pattern = svg!.querySelector("pattern");
  expect(pattern).not.toBeNull();
  return { svg: svg!, pattern: pattern! };
}

describe("CanvasDotGrid", () => {
  it("matches the Jimeng lattice geometry and keeps dots screen-constant", () => {
    const { container } = renderAtZoom(0.5);
    const { svg, pattern } = getPattern(container);
    const circle = pattern.querySelector("circle")!;

    // 18 世界像素 × 0.5 缩放 = 9px 屏幕间距
    expect(Number(pattern.getAttribute("width"))).toBeCloseTo(9, 5);
    expect(Number(pattern.getAttribute("height"))).toBeCloseTo(9, 5);
    // 1 屏幕像素直径 = 0.5px 半径，不随缩放变化
    expect(Number(circle.getAttribute("r"))).toBeCloseTo(0.5, 5);
    expect(svg.style.getPropertyValue("--xy-background-pattern-color-props")).toBe(
      "var(--canvas-dot-color)"
    );
  });

  it("keeps the 0.5px screen radius at high zoom", () => {
    const { container } = renderAtZoom(2);
    const { pattern } = getPattern(container);

    expect(Number(pattern.getAttribute("width"))).toBeCloseTo(36, 5);
    expect(
      Number(pattern.querySelector("circle")!.getAttribute("r"))
    ).toBeCloseTo(0.5, 5);
  });

  it("hides the lattice below the Jimeng LOD threshold (18 × zoom < 8)", () => {
    const { container } = renderAtZoom(0.44);
    expect(container.querySelector(".react-flow__background")).toBeNull();
  });

  it("renders the lattice at the Jimeng LOD threshold", () => {
    const { container } = renderAtZoom(0.45);
    expect(container.querySelector(".react-flow__background")).not.toBeNull();
  });
});
