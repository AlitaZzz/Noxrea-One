// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CANVAS_NODE_TYPES } from "@/features/canvas/nodes/canvas-node-types";
import { memoCanvasNode } from "@/features/canvas/shared/memo-canvas-node";
import { NODE_TYPE } from "@/lib/constants";

/**
 * 节点渲染边界回归：React Flow 注入的运行时 prop 不能触发节点子树重渲染——
 * positionAbsoluteX/Y（组拖动每帧变化，曾是「组内有节点时拖动更不跟手」的根因）、
 * selected（单次选中 10–30ms、Ctrl+A 191ms）、dragging（起拖）与 zIndex
 * （选中抬升 internals.z 0 → 1000，会抵消 selected 的拦截）都是运行时状态，
 * 由包装层类/独立订阅承载。业务 prop（data 等）变化仍必须重渲染。
 */

interface ProbeProps {
  id: string;
  data: Record<string, unknown>;
  selected: boolean;
  dragging: boolean;
  positionAbsoluteX: number;
  positionAbsoluteY: number;
  zIndex: number;
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
    dragging: false,
    positionAbsoluteX: 0,
    positionAbsoluteY: 0,
    zIndex: 0,
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

  it("选中/拖拽/选中抬升 zIndex 不重渲染，业务 prop 变化仍然重渲染", () => {
    const props = probeProps();
    const { rerender } = render(<MemoProbe {...props} />);

    // 选中时 React Flow 同时改写 selected 与 zIndex（elevateNodesOnSelect 抬升 1000）
    rerender(<MemoProbe {...props} selected zIndex={1000} />);
    rerender(<MemoProbe {...props} selected dragging zIndex={1000} />);
    expect(probeRender).toHaveBeenCalledTimes(1);

    const dataB = { label: "b" };
    rerender(<MemoProbe {...props} selected dragging zIndex={1000} data={dataB} />);
    expect(probeRender).toHaveBeenCalledTimes(2);

    rerender(
      <MemoProbe {...props} selected dragging zIndex={1000} data={dataB} positionAbsoluteX={40} />,
    );
    expect(probeRender).toHaveBeenCalledTimes(2);
  });

  it("注册表覆盖全部节点类型", () => {
    expect(Object.keys(CANVAS_NODE_TYPES).sort()).toEqual(Object.values(NODE_TYPE).sort());
  });
});
