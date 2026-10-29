// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CANVAS_NODE_TYPES } from "@/features/canvas/nodes/canvas-node-types";
import { memoCanvasNode } from "@/features/canvas/shared/memo-canvas-node";
import { NODE_TYPE } from "@/lib/constants";

/**
 * 节点渲染边界回归：React Flow 在父节点移动时会给每个成员节点注入新的
 * positionAbsoluteX/Y，这两个 prop 不能触发节点子树重渲染（组拖动每帧
 * 重渲染全部成员曾是「组内有节点时拖动更不跟手」的根因）。
 */

interface ProbeProps {
  id: string;
  data: Record<string, unknown>;
  selected: boolean;
  positionAbsoluteX: number;
  positionAbsoluteY: number;
}

const probeRender = vi.hoisted(() => vi.fn());

function Probe(props: ProbeProps) {
  probeRender(props);
  return <div data-testid="probe" />;
}

const MemoProbe = memoCanvasNode(Probe);

function probeProps(overrides: Partial<ProbeProps> = {}): ProbeProps {
  return {
    id: "node-1",
    data: { label: "a" },
    selected: false,
    positionAbsoluteX: 0,
    positionAbsoluteY: 0,
    ...overrides,
  };
}

describe("memoCanvasNode", () => {
  beforeEach(() => {
    probeRender.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  it("仅在绝对位置变化时保持不重渲染", () => {
    const props = probeProps();
    const { rerender } = render(<MemoProbe {...props} />);
    expect(probeRender).toHaveBeenCalledTimes(1);

    rerender(<MemoProbe {...props} positionAbsoluteX={320} positionAbsoluteY={-64} />);
    rerender(<MemoProbe {...props} positionAbsoluteX={840} positionAbsoluteY={512} />);

    expect(probeRender).toHaveBeenCalledTimes(1);
  });

  it("业务 prop 变化仍然重渲染", () => {
    const props = probeProps();
    const { rerender } = render(<MemoProbe {...props} />);

    rerender(<MemoProbe {...props} selected />);
    expect(probeRender).toHaveBeenCalledTimes(2);

    const dataB = { label: "b" };
    rerender(<MemoProbe {...props} selected data={dataB} />);
    expect(probeRender).toHaveBeenCalledTimes(3);

    rerender(<MemoProbe {...props} selected data={dataB} positionAbsoluteX={40} />);
    expect(probeRender).toHaveBeenCalledTimes(3);
  });

  it("注册表覆盖全部节点类型", () => {
    expect(Object.keys(CANVAS_NODE_TYPES).sort()).toEqual(Object.values(NODE_TYPE).sort());
  });
});
