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
  CLIPBOARD_NODE_MARKER,
  copySelection,
  duplicateSelection,
  pasteClipboard,
  pasteFromClipboardContent,
} from "@/features/canvas/shared/canvas-edit-actions";
import { useCanvasStore } from "@/features/canvas/stores/canvas-store";
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
