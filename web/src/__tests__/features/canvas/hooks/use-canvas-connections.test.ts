/**
 * useCanvasConnections 生产 hook 的连线语义。
 *
 * 覆盖：松手建边与多选扇出的全有或全无、已连去重、合法性判定与磁吸反馈
 * 同口径、拖线落点分流（节点本体直接建边 / 空白弹创建菜单）、菜单创建的
 * 节点与连线同批写入。事件处理器读取 store 实时状态，本文件不依赖渲染期节点闭包。
 */
// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import type { Connection, Edge, FinalConnectionState } from "@xyflow/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useCanvasConnections } from "@/features/canvas/hooks/use-canvas-connections";
import {
  type CanvasSaveIntent,
  subscribeCanvasSaveIntent,
} from "@/features/canvas/persistence/save-intent";
import { saveManager } from "@/features/canvas/persistence/save-manager";
import { useCanvasStore } from "@/features/canvas/stores/canvas-store";
import type { AnyNode } from "@/features/canvas/types";
import { NODE_TYPE } from "@/lib/constants";

function node(
  id: string,
  overrides: Record<string, unknown> = {},
): AnyNode {
  return {
    id,
    type: NODE_TYPE.TEXT,
    position: { x: 0, y: 0 },
    data: { label: id, content: "" },
    style: { width: 100, height: 100 },
    ...overrides,
  } as AnyNode;
}

function renderConnections(screenPosition = { x: 0, y: 0 }) {
  const screenToFlowPosition = vi.fn(() => screenPosition);
  const onConnectStart = vi.fn();
  const onConnectEnd = vi.fn();
  const hook = renderHook(() =>
    useCanvasConnections({
      nodes: useCanvasStore.getState().nodes,
      screenToFlowPosition,
      onConnectStart,
      onConnectEnd,
    }),
  );
  return { ...hook, screenToFlowPosition, onConnectStart, onConnectEnd };
}

function endState(source: AnyNode, target: AnyNode | null): FinalConnectionState {
  return {
    fromNode: source,
    fromHandle: null,
    toNode: target,
    toHandle: null,
  } as unknown as FinalConnectionState;
}

function pointerUp(x = 0, y = 0): MouseEvent {
  return new MouseEvent("pointerup", { bubbles: true, cancelable: true, clientX: x, clientY: y });
}

let intents: CanvasSaveIntent[] = [];
let unsubscribe: (() => void) | null = null;

beforeEach(() => {
  useCanvasStore.setState({ nodes: [], edges: [] });
  saveManager.resetForProjectSwitch();
  intents = [];
  unsubscribe = subscribeCanvasSaveIntent((intent) => intents.push(intent));
});

afterEach(() => {
  unsubscribe?.();
  unsubscribe = null;
  saveManager.resetForProjectSwitch();
});

describe("松手建边", () => {
  it("单条连线写入 store 并立即保存", () => {
    useCanvasStore.setState({ nodes: [node("a"), node("b")] });
    const { result } = renderConnections();

    act(() => result.current.handleConnect({ source: "a", target: "b" }));

    const edges = useCanvasStore.getState().edges;
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ source: "a", target: "b" });
    expect(intents).toEqual([{ kind: "immediate" }]);
  });

  it("多选扇出：所有选中节点与对端建边", () => {
    useCanvasStore.setState({
      nodes: [
        node("a", { selected: true }),
        node("b", { selected: true }),
        node("c"),
      ],
    });
    const { result } = renderConnections();

    act(() => result.current.handleConnect({ source: "a", target: "c" }));

    const pairs = useCanvasStore.getState().edges
      .map((e) => `${e.source}->${e.target}`)
      .sort();
    expect(pairs).toEqual(["a->c", "b->c"]);
  });

  it("自连不建边", () => {
    useCanvasStore.setState({ nodes: [node("a")] });
    const { result } = renderConnections();

    act(() => result.current.handleConnect({ source: "a", target: "a" }));

    expect(useCanvasStore.getState().edges).toEqual([]);
    expect(intents).toEqual([]);
  });

  it("已存在的连线静默去重，只补缺失的边", () => {
    useCanvasStore.setState({
      nodes: [node("a"), node("b"), node("c")],
      edges: [{ id: "e0", source: "a", target: "b" }] as Edge[],
    });
    const { result } = renderConnections();

    act(() => result.current.batchConnectHandlers.onConnect([
      { source: "a", target: "b" },
      { source: "b", target: "c" },
    ]));

    const pairs = useCanvasStore.getState().edges
      .map((e) => `${e.source}->${e.target}`)
      .sort();
    expect(pairs).toEqual(["a->b", "b->c"]);
  });

  it("全部已连时不写 store、不标脏", () => {
    useCanvasStore.setState({
      nodes: [node("a"), node("b")],
      edges: [{ id: "e0", source: "a", target: "b" }] as Edge[],
    });
    const { result } = renderConnections();

    act(() => result.current.batchConnectHandlers.onConnect([{ source: "a", target: "b" }]));

    expect(useCanvasStore.getState().edges).toHaveLength(1);
    expect(intents).toEqual([]);
  });
});

describe("合法性判定", () => {
  it("已连 / 自连拒绝，新连线放行，未知节点放行给 React Flow 自处理", () => {
    useCanvasStore.setState({
      nodes: [node("a"), node("b"), node("c")],
      edges: [{ id: "e0", source: "a", target: "b" }] as Edge[],
    });
    const { result } = renderConnections();
    const check = (source: string, target: string) =>
      result.current.isValidConnection({ source, target } as Connection);

    expect(check("a", "b")).toBe(false);
    expect(check("a", "a")).toBe(false);
    expect(check("a", "c")).toBe(true);
    expect(check("ghost", "c")).toBe(true);
  });
});

describe("拖线落点分流", () => {
  it("落在空白：弹出创建菜单并记录起始 Handle 方向", () => {
    useCanvasStore.setState({ nodes: [node("a")] });
    const { result, screenToFlowPosition, onConnectStart, onConnectEnd } =
      renderConnections({ x: 1000, y: 1000 });

    act(() => {
      result.current.handleConnectStart({}, { handleType: "source" });
      result.current.handleConnectEnd(pointerUp(1000, 1000), endState(node("a"), null));
    });

    expect(onConnectStart).toHaveBeenCalledTimes(1);
    expect(onConnectEnd).toHaveBeenCalledTimes(1);
    expect(screenToFlowPosition).toHaveBeenCalledWith({ x: 1000, y: 1000 });
    expect(result.current.pendingConnectionCreate).toMatchObject({
      sourceNodeIds: ["a"],
      sourceNodeTypes: [NODE_TYPE.TEXT],
      direction: "output",
      canvasPosition: { x: 1000, y: 1000 },
    });
  });

  it("从输入 Handle 拖出：创建方向为 input", () => {
    useCanvasStore.setState({ nodes: [node("a")] });
    const { result } = renderConnections({ x: 1000, y: 1000 });

    act(() => {
      result.current.handleConnectStart({}, { handleType: "target" });
      result.current.handleConnectEnd(pointerUp(1000, 1000), endState(node("a"), null));
    });

    expect(result.current.pendingConnectionCreate?.direction).toBe("input");
  });

  it("落在节点本体：按连线判定直接建边，不弹菜单", () => {
    const target = node("b", { position: { x: 100, y: 200 } });
    useCanvasStore.setState({ nodes: [node("a"), target] });
    const { result } = renderConnections({ x: 150, y: 250 });

    act(() => {
      result.current.handleConnectStart({}, { handleType: "source" });
      result.current.handleConnectEnd(pointerUp(150, 250), endState(node("a"), null));
    });

    expect(result.current.pendingConnectionCreate).toBeNull();
    expect(useCanvasStore.getState().edges.map((e) => `${e.source}->${e.target}`)).toEqual([
      "a->b",
    ]);
  });

  it("待创建菜单期间的预览锚点取源节点右缘正中", () => {
    useCanvasStore.setState({ nodes: [node("a")] });
    const { result } = renderConnections({ x: 1000, y: 1000 });

    act(() => {
      result.current.handleConnectStart({}, { handleType: "source" });
      result.current.handleConnectEnd(pointerUp(1000, 1000), endState(node("a"), null));
    });

    expect(result.current.pendingPreviewAnchors).toEqual([{ x: 100, y: 50 }]);
  });
});

describe("菜单创建的连接节点", () => {
  it("节点与到发起节点的连线同批写入", () => {
    useCanvasStore.setState({ nodes: [node("a")] });
    const { result } = renderConnections({ x: 300, y: 400 });

    act(() => {
      result.current.handleConnectStart({}, { handleType: "source" });
      result.current.handleConnectEnd(pointerUp(300, 400), endState(node("a"), null));
    });
    act(() => result.current.handleCreateConnectedNode(NODE_TYPE.TEXT));

    expect(useCanvasStore.getState().nodes).toHaveLength(2);
    const created = useCanvasStore.getState().nodes.find((n) => n.id !== "a");
    expect(created?.position).toEqual({ x: 300, y: 400 });
    expect(useCanvasStore.getState().edges.map((e) => `${e.source}->${e.target}`)).toEqual([
      `a->${created?.id}`,
    ]);
    expect(intents.some((intent) => intent.kind === "immediate")).toBe(true);
  });

  it("未打开创建菜单时调用创建为 no-op", () => {
    useCanvasStore.setState({ nodes: [node("a")] });
    const { result } = renderConnections();

    act(() => result.current.handleCreateConnectedNode(NODE_TYPE.TEXT));

    expect(useCanvasStore.getState().nodes).toHaveLength(1);
    expect(useCanvasStore.getState().edges).toEqual([]);
  });
});
