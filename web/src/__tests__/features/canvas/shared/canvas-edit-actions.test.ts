/**
 * 复制/粘贴/创建副本的连线语义回归测试。
 *
 * 覆盖场景（画布：图片A → 图片B、图片A → 视频A → 文本C）：
 * 1. 单选视频A「创建副本」：副本保留上游外部连线（图片A → 视频A副本），
 *    但不接入下游（不产生 副本→文本C）
 * 2. 单选图片B 复制粘贴：不继承任何外部连线
 * 3. 多选图片A+B 复制粘贴：副本之间保留内部连线
 * 4. 全选三个 复制粘贴：所有内部连线还原到副本
 * 5. 多选图片A+视频A「创建副本」：集内边还原到副本，下游外部边（→图片B、→文本C）不还原
 *
 * 历史回归点：
 * - 内部边的集内判定曾错用重映射后的副本 id 查 idMap（键为原 id），
 *   导致普通粘贴的内部边全部被误判为外部边丢弃——场景 3/4 即其回归防线。
 * - 副本模式曾把下游外部边一并还原（副本抢占原节点的下游消费者）——场景 1/5 防线。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// upload 链的传递依赖，防测试环境加载真实 API 客户端（与 transform-baking.test.ts 同约定）
vi.mock("@/lib/api/client", () => ({
  apiUploadWithProgress: vi.fn(),
  UnauthorizedError: class UnauthorizedError extends Error {},
  BASE: "http://test",
  getTokenHeader: () => ({ Authorization: "Bearer test-token" }),
}));

// 保存器涉及定时器与真实请求，测试内无需落盘
vi.mock("@/features/project/save-manager", () => ({
  saveManager: {
    markDirty: vi.fn(),
    markDirtyImmediate: vi.fn(),
    markDirtyUndo: vi.fn(),
    resetForProjectSwitch: vi.fn(),
  },
}));

import {
  createAudioNode,
  createGroupNode,
  createImageNode,
  createTextNode,
  createVideoNode,
  directorNode,
} from "@/features/canvas/node-defaults";
import {
  canUndoNow,
  CLIPBOARD_NODE_MARKER,
  copySelection,
  deleteSelection,
  duplicateSelection,
  nudgeSelectedNodes,
  pasteClipboard,
  pasteFromClipboardContent,
  redoAction,
  undoAction,
} from "@/features/canvas/shared/canvas-edit-actions";
import { getLiveViewport, takeCanvasSnapshot, useCanvasStore } from "@/features/canvas/stores/canvas-store";
import { useHistoryStore } from "@/features/canvas/stores/history-store";
import { useSelectionStore } from "@/features/canvas/stores/selection-store";
import type { AnyEdge, AnyNode } from "@/features/canvas/types";
import { NODE_TYPE } from "@/lib/constants";

function makeNode(id: string, type: string, x: number, y: number): AnyNode {
  return { id, type, position: { x, y }, data: { label: id }, selected: false } as AnyNode;
}

function makeEdge(source: string, target: string): AnyEdge {
  return { id: `e-${source}-${target}`, source, target } as AnyEdge;
}

/** 画布初始状态：图片A(0,0) → 图片B(200,0)；图片A → 视频A(0,200) → 文本C(200,200) */
function seedCanvas(): void {
  useCanvasStore.setState({
    nodes: [
      makeNode("imgA", NODE_TYPE.IMAGE, 0, 0),
      makeNode("imgB", NODE_TYPE.IMAGE, 200, 0),
      makeNode("vidA", NODE_TYPE.VIDEO, 0, 200),
      makeNode("textC", NODE_TYPE.TEXT, 200, 200),
    ],
    edges: [makeEdge("imgA", "imgB"), makeEdge("imgA", "vidA"), makeEdge("vidA", "textC")],
  });
}

/** 选中指定 id 的节点（其余去选中） */
function select(...ids: string[]): void {
  const idSet = new Set(ids);
  useCanvasStore.setState((s) => ({
    nodes: s.nodes.map((n) => ({ ...n, selected: idSet.has(n.id) })),
  }));
}

/** 按 label 取「最新一个」节点（副本追加在数组尾部，原节点在前——
 *  粘贴/复制场景下同 label 必有原节点，find 会取到原件导致断言失效） */
function copyIdOf(label: string): string {
  const node = useCanvasStore
    .getState()
    .nodes.findLast((n) => (n.data as { label?: string }).label === label);
  if (!node) throw new Error(`node with label ${label} not found`);
  return node.id;
}

function edgePairs(): string[] {
  return useCanvasStore.getState().edges.map((e) => `${e.source}→${e.target}`);
}

beforeEach(() => {
  seedCanvas();
  useSelectionStore.setState({ clipboard: null });
});

afterEach(() => vi.unstubAllGlobals());

describe("复制：捕获任一端在选中集内的连线", () => {
  it("多选 imgA+imgB 时，imgA→imgB 与 imgA→vidA 都进剪贴板，vidA→textC 不进", () => {
    select("imgA", "imgB");
    expect(copySelection()).toBe(true);
    const clip = useSelectionStore.getState().clipboard!;
    expect(clip.nodes.map((n) => (n.data as { label: string }).label)).toEqual(["imgA", "imgB"]);
    expect(clip.edges.map((e) => `${e.source}→${e.target}`)).toEqual(["imgA→imgB", "imgA→vidA"]);
  });
});

describe("系统剪贴板：仅接受当前节点与连线结构", () => {
  it.each([
    { type: NODE_TYPE.TEXT, create: createTextNode },
    { type: NODE_TYPE.IMAGE, create: createImageNode },
    { type: NODE_TYPE.VIDEO, create: createVideoNode },
    { type: NODE_TYPE.AUDIO, create: createAudioNode },
    { type: NODE_TYPE.DIRECTOR, create: directorNode },
    { type: NODE_TYPE.GROUP, create: (position: { x: number; y: number }) => createGroupNode(position, { width: 400, height: 300 }) },
  ])("真实 $type 节点经过复制和系统粘贴后保留内容及设置", ({ type, create }) => {
    const source = { ...create({ x: -100, y: -200 }), selected: true };
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    useCanvasStore.setState({ nodes: [source], edges: [] });
    expect(copySelection()).toBe(true);
    const text = writeText.mock.calls[0][0];
    useSelectionStore.setState({ clipboard: null });

    expect(pasteFromClipboardContent({ imageFiles: [], text }, { x: 500, y: 500 })).toBe(true);

    const copy = useCanvasStore.getState().nodes.at(-1)!;
    expect(copy.id).not.toBe(source.id);
    expect(copy.type).toBe(type);
    expect(copy.position).toEqual({ x: 500, y: 500 });
    expect(copy.data).toEqual(source.data);
    expect(copy.style).toEqual(source.style);
    expect(copy.selected).toBe(true);
    expect(useCanvasStore.getState().nodes[0].selected).toBe(false);
  });

  it("复制输出的 JSON 可通过系统粘贴入口还原节点、布局和内部连线", () => {
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    select("imgA", "imgB");
    expect(copySelection()).toBe(true);
    expect(writeText).toHaveBeenCalledTimes(1);
    const text = writeText.mock.calls[0][0];
    expect(text.startsWith(CLIPBOARD_NODE_MARKER)).toBe(true);
    const payload = JSON.parse(text.slice(CLIPBOARD_NODE_MARKER.length));
    expect(payload.nodes.map((n: AnyNode) => n.id)).toEqual(["imgA", "imgB"]);
    expect(payload.edges.map((e: AnyEdge) => `${e.source}→${e.target}`)).toEqual(["imgA→imgB", "imgA→vidA"]);
    useSelectionStore.setState({ clipboard: null });

    expect(pasteFromClipboardContent({ imageFiles: [], text }, { x: 500, y: 500 })).toBe(true);

    const aCopy = copyIdOf("imgA");
    const bCopy = copyIdOf("imgB");
    expect(useCanvasStore.getState().nodes.slice(-2).map((n) => n.position)).toEqual([
      { x: 500, y: 500 },
      { x: 700, y: 500 },
    ]);
    expect(edgePairs()).toEqual(["imgA→imgB", "imgA→vidA", "vidA→textC", `${aCopy}→${bCopy}`]);
    expect(useSelectionStore.getState().clipboard?.nodes.map((n) => n.id)).toEqual(["imgA", "imgB"]);
  });

  it("接受显式包含空连线数组的节点载荷", () => {
    const text = CLIPBOARD_NODE_MARKER + JSON.stringify({
      nodes: [makeNode("text", NODE_TYPE.TEXT, 0, 0)],
      edges: [],
    });

    expect(pasteFromClipboardContent({ imageFiles: [], text }, { x: 500, y: 500 })).toBe(true);

    expect(useCanvasStore.getState().nodes).toHaveLength(5);
    expect(useCanvasStore.getState().nodes.at(-1)?.position).toEqual({ x: 500, y: 500 });
    expect(edgePairs()).toEqual(["imgA→imgB", "imgA→vidA", "vidA→textC"]);
    expect(useSelectionStore.getState().clipboard?.edges).toEqual([]);
  });

  it("保留分组成员的相对坐标，并重映射父组和内部连线", () => {
    const text = CLIPBOARD_NODE_MARKER + JSON.stringify({
      nodes: [
        makeNode("group", NODE_TYPE.GROUP, 100, 200),
        { ...makeNode("imgA", NODE_TYPE.IMAGE, 20, 40), parentId: "group" },
        { ...makeNode("imgB", NODE_TYPE.IMAGE, 220, 40), parentId: "group" },
      ],
      edges: [makeEdge("imgA", "imgB")],
    });

    expect(pasteFromClipboardContent({ imageFiles: [], text }, { x: 500, y: 500 })).toBe(true);

    const groupCopy = copyIdOf("group");
    const aCopy = copyIdOf("imgA");
    const bCopy = copyIdOf("imgB");
    const [group, a, b] = useCanvasStore.getState().nodes.slice(-3);
    expect(group.position).toEqual({ x: 500, y: 500 });
    expect(a).toMatchObject({ parentId: groupCopy, position: { x: 20, y: 40 } });
    expect(b).toMatchObject({ parentId: groupCopy, position: { x: 220, y: 40 } });
    expect(edgePairs()).toContain(`${aCopy}→${bCopy}`);
  });

  it("单独复制分组成员时粘贴为独立节点", () => {
    const text = CLIPBOARD_NODE_MARKER + JSON.stringify({
      nodes: [{ ...makeNode("img", NODE_TYPE.IMAGE, 20, 40), parentId: "group" }],
      edges: [],
    });

    expect(pasteFromClipboardContent({ imageFiles: [], text }, { x: 500, y: 500 })).toBe(true);

    const copy = useCanvasStore.getState().nodes.at(-1)!;
    expect(copy.position).toEqual({ x: 500, y: 500 });
    expect(copy.parentId).toBeUndefined();
  });

  it("拒绝 JSON 数字溢出产生的非有限坐标", () => {
    const nodes = useCanvasStore.getState().nodes;
    const text = CLIPBOARD_NODE_MARKER +
      '{"nodes":[{"id":"text","type":"text-node","position":{"x":1e400,"y":0},"data":{"label":"text"}}],"edges":[]}';

    expect(pasteFromClipboardContent({ imageFiles: [], text }, { x: 500, y: 500 })).toBe(false);

    expect(useCanvasStore.getState().nodes).toBe(nodes);
    expect(useSelectionStore.getState().clipboard).toBeNull();
  });

  it.each([
    { name: "旧节点数组", payload: [makeNode("text", NODE_TYPE.TEXT, 0, 0)] },
    { name: "缺失连线字段", payload: { nodes: [makeNode("text", NODE_TYPE.TEXT, 0, 0)] } },
    { name: "连线字段不是数组", payload: { nodes: [makeNode("text", NODE_TYPE.TEXT, 0, 0)], edges: null } },
    { name: "节点字段不是数组", payload: { nodes: null, edges: [] } },
    { name: "空节点列表", payload: { nodes: [], edges: [] } },
    { name: "缺失节点坐标", payload: { nodes: [{ ...makeNode("text", NODE_TYPE.TEXT, 0, 0), position: {} }], edges: [] } },
    { name: "非数值节点坐标", payload: { nodes: [{ ...makeNode("text", NODE_TYPE.TEXT, 0, 0), position: { x: "0", y: 0 } }], edges: [] } },
    { name: "空节点数据", payload: { nodes: [{ ...makeNode("text", NODE_TYPE.TEXT, 0, 0), data: null }], edges: [] } },
    { name: "节点数据不是对象", payload: { nodes: [{ ...makeNode("text", NODE_TYPE.TEXT, 0, 0), data: [] }], edges: [] } },
    { name: "无效节点标题", payload: { nodes: [{ ...makeNode("text", NODE_TYPE.TEXT, 0, 0), data: { label: 1 } }], edges: [] } },
    { name: "未知节点类型", payload: { nodes: [{ ...makeNode("text", NODE_TYPE.TEXT, 0, 0), type: "unknown-node" }], edges: [] } },
    { name: "无效父节点 ID", payload: { nodes: [{ ...makeNode("text", NODE_TYPE.TEXT, 0, 0), parentId: 1 }], edges: [] } },
    { name: "嵌套分组", payload: { nodes: [{ ...makeNode("group", NODE_TYPE.GROUP, 0, 0), parentId: "parent" }], edges: [] } },
    { name: "父节点不是分组", payload: { nodes: [makeNode("text", NODE_TYPE.TEXT, 0, 0), { ...makeNode("img", NODE_TYPE.IMAGE, 100, 0), parentId: "text" }], edges: [] } },
    { name: "空节点 ID", payload: { nodes: [makeNode("", NODE_TYPE.TEXT, 0, 0)], edges: [] } },
    { name: "重复节点 ID", payload: { nodes: [makeNode("text", NODE_TYPE.TEXT, 0, 0), makeNode("text", NODE_TYPE.TEXT, 200, 0)], edges: [] } },
    { name: "混合有效与无效节点", payload: { nodes: [makeNode("text", NODE_TYPE.TEXT, 0, 0), null], edges: [] } },
    { name: "无效连线", payload: { nodes: [makeNode("text", NODE_TYPE.TEXT, 0, 0)], edges: [null] } },
    { name: "缺失连线 ID", payload: { nodes: [makeNode("text", NODE_TYPE.TEXT, 0, 0)], edges: [{ source: "text", target: "textC" }] } },
    { name: "空连线端点", payload: { nodes: [makeNode("text", NODE_TYPE.TEXT, 0, 0)], edges: [makeEdge("", "text")] } },
    { name: "自连线", payload: { nodes: [makeNode("text", NODE_TYPE.TEXT, 0, 0)], edges: [makeEdge("text", "text")] } },
    { name: "空值", payload: null },
    { name: "数字", payload: 1 },
    { name: "字符串", payload: "text" },
  ])("拒绝$name，不修改画布、内部剪贴板或降级为文本节点", ({ payload }) => {
    useSelectionStore.getState().copySelected([makeNode("saved", NODE_TYPE.TEXT, 0, 0)], []);
    const nodes = useCanvasStore.getState().nodes;
    const edges = useCanvasStore.getState().edges;
    const clipboard = useSelectionStore.getState().clipboard;
    const text = CLIPBOARD_NODE_MARKER + JSON.stringify(payload);

    expect(pasteFromClipboardContent({ imageFiles: [], text }, { x: 500, y: 500 })).toBe(false);

    expect(useCanvasStore.getState().nodes).toBe(nodes);
    expect(useCanvasStore.getState().edges).toBe(edges);
    expect(useSelectionStore.getState().clipboard).toBe(clipboard);
  });
});

describe("场景1：单选视频A创建副本 → 只保留上游连线", () => {
  it("新边为 原图片A → 视频A副本；不产生 副本→文本C", () => {
    select("vidA");
    expect(duplicateSelection()).toBe(true);
    const vidCopy = copyIdOf("vidA");
    const pairs = edgePairs();
    // 3 条原边 + 1 条上游新边
    expect(pairs).toHaveLength(4);
    expect(pairs).toContain(`imgA→${vidCopy}`);
    expect(pairs).not.toContain(`${vidCopy}→textC`);
  });
});

describe("场景2：单选图片B复制粘贴 → 不继承外部连线", () => {
  it("新节点无任何新边", () => {
    select("imgB");
    copySelection();
    pasteClipboard({ x: 500, y: 500 });
    expect(useCanvasStore.getState().nodes).toHaveLength(5);
    expect(edgePairs()).toEqual(["imgA→imgB", "imgA→vidA", "vidA→textC"]);
  });
});

describe("场景3：多选图片A+B复制粘贴 → 副本之间保留内部连线", () => {
  it("新边为 图片A副本 → 图片B副本，不连任何原节点", () => {
    select("imgA", "imgB");
    copySelection();
    pasteClipboard({ x: 500, y: 500 });
    const aCopy = copyIdOf("imgA");
    const bCopy = copyIdOf("imgB");
    expect(useCanvasStore.getState().nodes).toHaveLength(6);
    expect(edgePairs()).toEqual(["imgA→imgB", "imgA→vidA", "vidA→textC", `${aCopy}→${bCopy}`]);
  });
});

describe("场景4：全选三个复制粘贴 → 所有内部连线还原到副本", () => {
  it("两条内部边都重映射到副本，下游外部边（→文本C）不还原", () => {
    select("imgA", "imgB", "vidA");
    copySelection();
    pasteClipboard({ x: 500, y: 500 });
    const aCopy = copyIdOf("imgA");
    const bCopy = copyIdOf("imgB");
    const vCopy = copyIdOf("vidA");
    expect(useCanvasStore.getState().nodes).toHaveLength(7);
    expect(edgePairs()).toEqual([
      "imgA→imgB",
      "imgA→vidA",
      "vidA→textC",
      `${aCopy}→${bCopy}`,
      `${aCopy}→${vCopy}`,
    ]);
  });
});

describe("场景5：多选图片A+视频A创建副本 → 集内边还原、下游外部边丢弃", () => {
  it("新边仅 图片A副本 → 视频A副本；不产生 副本→图片B / 副本→文本C", () => {
    select("imgA", "vidA");
    expect(duplicateSelection()).toBe(true);
    const aCopy = copyIdOf("imgA");
    const vCopy = copyIdOf("vidA");
    const pairs = edgePairs();
    expect(pairs).toHaveLength(4);
    expect(pairs).toContain(`${aCopy}→${vCopy}`);
    expect(pairs).not.toContain(`${aCopy}→imgB`);
    expect(pairs).not.toContain(`${vCopy}→textC`);
  });
});

// ============================================================
// 撤销/重做链路（Spec: canvas-undo-redo-integrity）
// ============================================================

/** 本组用例共用基线：撤销栈归零 + 节点编辑态清空
 *  （文件内其余用例会累积撤销栈；守卫与悬空清理断言依赖干净基线） */
function resetUndoBaseline(): void {
  useHistoryStore.getState().clear();
  useCanvasStore.setState({
    annotatingNodeId: null,
    croppingNodeId: null,
    editingTextNodeId: null,
    frameCaptureNodeId: null,
    clipCaptureNodeId: null,
    audioClipNodeId: null,
    lightingNodeId: null,
    angleEditorNodeId: null,
    panoramaNodeId: null,
    multiExpandedNodeId: null,
  });
}

describe("撤销/重做不恢复视口", () => {
  beforeEach(() => {
    resetUndoBaseline();
  });

  it("撤销恢复节点/连线，但 store viewport 与 _liveViewport 保持用户当前视角", () => {
    const vpAtEdit = { x: 10, y: 20, zoom: 1.5 };
    const vpNow = { x: -100, y: -50, zoom: 2 };
    useCanvasStore.getState().setViewport(vpAtEdit);
    select("vidA");
    deleteSelection();
    // 撤销前用户又平移缩放了画布（React Flow 实际视口经 setViewport/syncLiveViewport 同步）
    useCanvasStore.getState().setViewport(vpNow);

    expect(undoAction()).toBe(true);
    expect(useCanvasStore.getState().nodes.some((n) => n.id === "vidA")).toBe(true);
    expect(useCanvasStore.getState().viewport).toEqual(vpNow);
    expect(getLiveViewport()).toEqual(vpNow);
    expect(redoAction()).toBe(true);
    expect(useCanvasStore.getState().viewport).toEqual(vpNow);
    expect(getLiveViewport()).toEqual(vpNow);
  });
});

describe("撤销/重做恢复归属快照时的节点顺序", () => {
  beforeEach(() => {
    resetUndoBaseline();
  });

  it("历史快照中成员排在组之前时，恢复经 setNodes 归一化为组先于成员", () => {
    // 模拟旧数据写入的快照：直接 setState 绕过 store 写入边界
    const group = makeNode("g1", NODE_TYPE.GROUP, 100, 100);
    const member = { ...makeNode("m1", NODE_TYPE.TEXT, 20, 40), parentId: "g1" };
    useCanvasStore.setState({ nodes: [member, group] });
    useHistoryStore.getState().push(takeCanvasSnapshot());
    // 当前现场：成员已删除，仅剩组
    useCanvasStore.getState().setNodes([group]);

    expect(undoAction()).toBe(true);
    const nodes = useCanvasStore.getState().nodes;
    expect(nodes.map((n) => n.id)).toEqual(["g1", "m1"]);
    expect(nodes.find((n) => n.id === "m1")?.parentId).toBe("g1");
  });
});

describe("恢复快照的悬空编辑态清理", () => {
  beforeEach(() => {
    resetUndoBaseline();
  });

  it("宿主随快照消失的文本编辑态被清理（文本编辑态是唯一可穿透守卫的编辑面板）", () => {
    // 时刻一：textC 尚不存在
    useCanvasStore.setState((s) => ({ nodes: s.nodes.filter((n) => n.id !== "textC") }));
    useHistoryStore.getState().push(takeCanvasSnapshot());
    // 时刻二：textC 出现并进入文本编辑态（编辑面板打开不拦截画布级撤销，
    // Ctrl+Z 路由到画布撤销——撤销后宿主随快照消失，编辑态必须一并退出）
    useCanvasStore.setState((s) => ({
      nodes: [...s.nodes, makeNode("textC", NODE_TYPE.TEXT, 200, 200)],
      editingTextNodeId: "textC",
    }));
    expect(canUndoNow()).toBe(true);

    expect(undoAction()).toBe(true);
    const s = useCanvasStore.getState();
    expect(s.nodes.some((n) => n.id === "textC")).toBe(false);
    expect(s.editingTextNodeId).toBeNull();
  });

  it("宿主仍在的编辑态随撤销保留", () => {
    useHistoryStore.getState().push(takeCanvasSnapshot());
    useCanvasStore.setState({ editingTextNodeId: "textC" });

    expect(undoAction()).toBe(true);
    expect(useCanvasStore.getState().nodes.some((n) => n.id === "textC")).toBe(true);
    expect(useCanvasStore.getState().editingTextNodeId).toBe("textC");
  });
});

describe("画布级撤销/重做统一守卫（canUndoNow）", () => {
  beforeEach(() => {
    resetUndoBaseline();
  });

  it("生成中不可撤销/重做", () => {
    useHistoryStore.getState().push(takeCanvasSnapshot());
    expect(canUndoNow()).toBe(true);
    useCanvasStore.setState((s) => ({
      nodes: s.nodes.map((n) =>
        n.id === "imgA"
          ? ({ ...n, data: { ...n.data, taskBinding: { taskId: "t1", status: "pending", startedAt: 1 } } } as AnyNode)
          : n
      ),
    }));
    expect(canUndoNow()).toBe(false);
    expect(undoAction()).toBe(false);
  });

  it("媒体编辑面板打开时不可撤销/重做；文本编辑态不拦截（Ctrl+Z 路由到画布撤销）", () => {
    useHistoryStore.getState().push(takeCanvasSnapshot());
    useCanvasStore.setState({ annotatingNodeId: "imgA" });
    expect(canUndoNow()).toBe(false);
    expect(undoAction()).toBe(false);

    useCanvasStore.setState({ annotatingNodeId: null, editingTextNodeId: "textC" });
    expect(canUndoNow()).toBe(true);
  });
});

describe("离散操作压栈（批量守卫 + forceHistory）", () => {
  beforeEach(() => {
    resetUndoBaseline();
  });

  it("删除（节点+边）批量合并为一条撤销，一次恢复全部", () => {
    select("vidA");
    deleteSelection();
    expect(useHistoryStore.getState().undoStack.length).toBe(1);
    expect(undoAction()).toBe(true);
    expect(useCanvasStore.getState().nodes.some((n) => n.id === "vidA")).toBe(true);
    expect(edgePairs()).toContain("imgA→vidA");
    expect(edgePairs()).toContain("vidA→textC");
  });

  it("节流窗口内的离散删除仍产生独立撤销步，两次撤销逐级回退", () => {
    // 改名（forceHistory 必定压栈）后紧接删除：删除必须有自己的撤销步
    useCanvasStore.getState().updateNodeVisual("imgA", { data: { label: "renamed" }, forceHistory: true });
    select("imgB");
    deleteSelection();
    expect(useHistoryStore.getState().undoStack.length).toBe(2);

    expect(undoAction()).toBe(true);
    expect(useCanvasStore.getState().nodes.some((n) => n.id === "imgB")).toBe(true);
    expect((useCanvasStore.getState().nodes.find((n) => n.id === "imgA")!.data as { label?: string }).label).toBe("renamed");

    expect(undoAction()).toBe(true);
    expect((useCanvasStore.getState().nodes.find((n) => n.id === "imgA")!.data as { label?: string }).label).toBe("imgA");
  });

  it("粘贴（节点+连线）批量合并为一条撤销", () => {
    select("imgA", "vidA");
    expect(copySelection()).toBe(true);
    const depth = useHistoryStore.getState().undoStack.length;
    expect(pasteClipboard({ x: 1000, y: 1000 })).toBe(true);
    expect(useHistoryStore.getState().undoStack.length).toBe(depth + 1);
    expect(undoAction()).toBe(true);
    expect(useCanvasStore.getState().nodes.filter((n) => n.position.x === 1000)).toHaveLength(0);
    expect(edgePairs()).toEqual(["imgA→imgB", "imgA→vidA", "vidA→textC"]);
  });
});

describe("方向键微调入栈", () => {
  beforeEach(() => {
    resetUndoBaseline();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("连续微调合并为一条撤销，一次整段回退", () => {
    vi.useFakeTimers();
    // 快进到节流窗口之外：文件内先前用例的真实时间戳压栈不影响本例的确定性
    vi.setSystemTime(Date.now() + 60_000);
    // 总开关关闭：方向键按 5px 步进，不按网格步长（整理布局同口径）
    useCanvasStore.setState({ snapEnabled: false });
    select("imgA");
    const before = useCanvasStore.getState().nodes.find((n) => n.id === "imgA")!.position;

    expect(nudgeSelectedNodes({ x: 1, y: 0 }, 1)).toBe(true);
    vi.advanceTimersByTime(100);
    expect(nudgeSelectedNodes({ x: 1, y: 0 }, 1)).toBe(true);

    const after = useCanvasStore.getState().nodes.find((n) => n.id === "imgA")!.position;
    expect(after).toEqual({ x: before.x + 10, y: before.y });
    expect(useHistoryStore.getState().undoStack.length).toBe(1);

    expect(undoAction()).toBe(true);
    expect(useCanvasStore.getState().nodes.find((n) => n.id === "imgA")!.position).toEqual(before);
  });
});
