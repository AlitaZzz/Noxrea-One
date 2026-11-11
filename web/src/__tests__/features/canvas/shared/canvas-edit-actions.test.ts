/**
 * 复制/粘贴/创建副本的语义回归测试。
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
 * - 系统剪贴板曾把节点 JSON 作为 text/plain 写入，导致输入框收到 JSON；
 *   现在非文本选择不写 text/plain，纯文本选择只写可读 plainText。
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
vi.mock("@/features/canvas/persistence/save-manager", () => ({
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
  CANVAS_CLIPBOARD_KIND,
  CANVAS_CLIPBOARD_MIME,
  CANVAS_CLIPBOARD_VERSION,
  CANVAS_CLIPBOARD_WEB_MIME,
  type CanvasClipboardPayload,
} from "@/features/canvas/shared/canvas-clipboard-format";
import {
  canUndoNow,
  clearSelection,
  copySelection,
  deleteSelection,
  duplicateSelection,
  nudgeSelectedNodes,
  pasteClipboard,
  pasteFromClipboardContent,
  redoAction,
  undoAction,
} from "@/features/canvas/shared/canvas-edit-actions";
import type { CanvasClipboardWriteResult } from "@/features/canvas/shared/canvas-system-clipboard";
import { getLiveViewport, takeCanvasSnapshot, useCanvasStore } from "@/features/canvas/stores/canvas-store";
import { useHistoryStore } from "@/features/canvas/stores/history-store";
import { useSelectionStore } from "@/features/canvas/stores/selection-store";
import type { AnyEdge, AnyNode } from "@/features/canvas/types";
import { NODE_TYPE } from "@/lib/constants";

class FakeBlob {
  readonly type: string;
  readonly content: string;

  constructor(parts: BlobPart[], options?: { type?: string }) {
    this.type = options?.type ?? "";
    this.content = parts.map((part) => String(part)).join("");
  }

  text(): Promise<string> {
    return Promise.resolve(this.content);
  }
}

class FakeClipboardItem {
  static supports: (type: string) => boolean = vi.fn(
    (type: string) => type === CANVAS_CLIPBOARD_WEB_MIME,
  );

  readonly items: Record<string, FakeBlob>;

  constructor(items: Record<string, FakeBlob>) {
    this.items = items;
  }
}

function stubSystemClipboard(write = vi.fn().mockResolvedValue(undefined)) {
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { clipboard: { write, writeText } });
  vi.stubGlobal("ClipboardItem", FakeClipboardItem);
  vi.stubGlobal("Blob", FakeBlob);
  FakeClipboardItem.supports = vi.fn((type: string) => type === CANVAS_CLIPBOARD_WEB_MIME);
  return { write, writeText };
}

function writtenItem(write: ReturnType<typeof vi.fn>) {
  return write.mock.calls[0]?.[0]?.[0] as FakeClipboardItem;
}

function systemPayloadOf(item: FakeClipboardItem): CanvasClipboardPayload {
  return JSON.parse(item.items[CANVAS_CLIPBOARD_WEB_MIME].content) as CanvasClipboardPayload;
}

function makeNode(id: string, type: string, x: number, y: number): AnyNode {
  return { id, type, position: { x, y }, data: { label: id }, selected: false } as AnyNode;
}

function makeEdge(source: string, target: string): AnyEdge {
  return { id: `e-${source}-${target}`, source, target } as AnyEdge;
}

/** 通过真实工厂构造可通过系统载荷校验的节点 */
function validNode(
  factory: (position: { x: number; y: number }) => AnyNode,
  id: string,
  position = { x: 0, y: 0 },
  data: Record<string, unknown> = {},
): AnyNode {
  const node = factory(position);
  return { ...node, id, data: { ...node.data, label: id, ...data } } as AnyNode;
}

const validImage = (id: string, position = { x: 0, y: 0 }, data: Record<string, unknown> = {}) =>
  validNode(createImageNode, id, position, data);
const validText = (id: string, plainText = id, position = { x: 0, y: 0 }) =>
  validNode(createTextNode, id, position, {
    content: `<p>${plainText}</p>`,
    plainText,
  });
const validVideo = (id: string, position = { x: 0, y: 0 }) =>
  validNode(createVideoNode, id, position);
const validAudio = (id: string, position = { x: 0, y: 0 }) =>
  validNode(createAudioNode, id, position);
const validDirector = (id: string, position = { x: 0, y: 0 }) =>
  validNode(directorNode, id, position);
const validGroup = (id: string, position = { x: 0, y: 0 }) =>
  validNode((p) => createGroupNode(p, { width: 400, height: 300 }), id, position);

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

  it("选中组时自动带上全部成员", () => {
    const group = validGroup("group", { x: 100, y: 200 });
    const memberA = { ...validImage("imgA", { x: 20, y: 40 }), parentId: "group" };
    const memberB = { ...validImage("imgB", { x: 220, y: 40 }), parentId: "group" };
    useCanvasStore.setState({
      nodes: [group, memberA, memberB],
      edges: [makeEdge("imgA", "imgB")],
    });
    select("group");
    expect(copySelection()).toBe(true);
    const clip = useSelectionStore.getState().clipboard!;
    expect(clip.nodes.map((n) => n.id)).toEqual(["group", "imgA", "imgB"]);
    expect(clip.nodes.filter((n) => n.parentId === "group")).toHaveLength(2);
  });

  it("内部剪贴板保存规范快照：剥离运行时字段与嵌套共享引用", () => {
    const base = validImage("img", { x: 0, y: 0 }, {
      taskBinding: { taskId: "task-1", status: "pending" },
    });
    useCanvasStore.setState({
      nodes: [
        {
          ...base,
          selected: true,
          measured: { width: 320, height: 240 },
          data: {
            ...base.data,
            upload: { uploading: true, previewUrl: "blob:http://x/1" },
            rotation: 90,
          },
        } as AnyNode,
      ],
      edges: [],
    });

    expect(copySelection()).toBe(true);
    const clip = useSelectionStore.getState().clipboard!;
    expect(clip.nodes[0]).not.toHaveProperty("measured");
    expect(clip.nodes[0].data).not.toHaveProperty("taskBinding");
    expect(clip.nodes[0].data).not.toHaveProperty("upload");
    expect(clip.nodes[0].data).not.toHaveProperty("rotation");

    (clip.nodes[0].data as { genSettings: { refOrder: string[] } }).genSettings.refOrder.push("x");
    const live = useCanvasStore.getState().nodes[0].data as { genSettings: { refOrder: string[] } };
    expect(live.genSettings.refOrder).not.toContain("x");
  });
});

describe("上传失败节点：复制与创建副本只继承已落定内容", () => {
  const failedUpload = {
    uploading: false,
    version: 1,
    previewUrl: "blob:http://x/1",
    error: { category: "network" as const, message: "网络错误", retryable: true },
  };

  it("复制失败节点：内部快照与系统载荷都不含 upload", () => {
    const failed = validImage("failed", { x: 0, y: 0 }, { upload: failedUpload });
    useCanvasStore.setState({ nodes: [{ ...failed, selected: true }], edges: [] });
    const { write } = stubSystemClipboard();

    expect(copySelection()).toBe(true);

    const clip = useSelectionStore.getState().clipboard!;
    expect(clip.nodes[0].data).not.toHaveProperty("upload");
    expect(systemPayloadOf(writtenItem(write)).nodes[0].data).not.toHaveProperty("upload");
  });

  it("创建副本：剥离上传会话，保留已落定 src；没有 src 时得到空占位节点", () => {
    const withSrc = validImage("withSrc", { x: 0, y: 0 }, {
      src: "/api/files/old.png",
      upload: failedUpload,
    });
    const withoutSrc = validImage("withoutSrc", { x: 200, y: 0 }, {
      src: "",
      upload: failedUpload,
    });
    useCanvasStore.setState({ nodes: [withSrc, withoutSrc], edges: [] });
    select("withSrc", "withoutSrc");

    expect(duplicateSelection()).toBe(true);

    const nodes = useCanvasStore.getState().nodes;
    const withSrcCopy = nodes.findLast(
      (n) => (n.data as { label?: string }).label === "withSrc",
    ) as AnyNode;
    const withoutSrcCopy = nodes.findLast(
      (n) => (n.data as { label?: string }).label === "withoutSrc",
    ) as AnyNode;

    expect(withSrcCopy.id).not.toBe("withSrc");
    expect((withSrcCopy.data as { src: string }).src).toBe("/api/files/old.png");
    expect(withSrcCopy.data).not.toHaveProperty("upload");

    expect(withoutSrcCopy.id).not.toBe("withoutSrc");
    expect((withoutSrcCopy.data as { src: string }).src).toBe("");
    expect(withoutSrcCopy.data).not.toHaveProperty("upload");
  });
});

describe("系统剪贴板：规范载荷", () => {
  it.each([
    { type: NODE_TYPE.TEXT, node: validText("node", "内容") },
    { type: NODE_TYPE.IMAGE, node: validImage("node") },
    { type: NODE_TYPE.VIDEO, node: validVideo("node") },
    { type: NODE_TYPE.AUDIO, node: validAudio("node") },
    { type: NODE_TYPE.DIRECTOR, node: validDirector("node") },
  ])("真实 $type 节点经过复制和系统粘贴后保留内容", ({ type, node }) => {
    useCanvasStore.setState({ nodes: [{ ...node, selected: true }], edges: [] });
    const { write } = stubSystemClipboard();
    expect(copySelection()).toBe(true);
    const payload = systemPayloadOf(writtenItem(write));
    expect(payload.nodes).toHaveLength(1);
    const canonical = payload.nodes[0];

    useSelectionStore.setState({ clipboard: null });
    expect(
      pasteFromClipboardContent(
        { payloadJson: JSON.stringify(payload), imageFiles: [], text: "" },
        { x: 500, y: 500 },
      ),
    ).toBe(true);

    const copy = useCanvasStore.getState().nodes.at(-1)!;
    expect(copy.id).not.toBe(node.id);
    expect(copy.type).toBe(type);
    expect(copy.position).toEqual({ x: 500, y: 500 });
    expect(copy.data).toEqual(canonical.data);
    expect(copy.style).toEqual(canonical.style);
    expect(copy.selected).toBe(true);
    expect(useCanvasStore.getState().nodes[0].selected).toBe(false);
  });

  it("非文本选择不写 text/plain，节点 JSON 不进入可读文本", () => {
    select("imgA");
    const { write, writeText } = stubSystemClipboard();
    expect(copySelection()).toBe(true);

    const item = writtenItem(write);
    expect(Object.keys(item.items).sort()).toEqual(
      [CANVAS_CLIPBOARD_WEB_MIME, "text/html"].sort(),
    );
    expect(item.items[CANVAS_CLIPBOARD_WEB_MIME].type).toBe(CANVAS_CLIPBOARD_MIME);
    expect(item.items["text/html"].content).not.toContain("noxrea-nodes:");
    expect(writeText).not.toHaveBeenCalled();
  });

  it("系统写入结果经回调交给调用方提示，不直接依赖全局消息", async () => {
    select("imgA");
    vi.stubGlobal("ClipboardItem", undefined);
    vi.stubGlobal("navigator", { clipboard: undefined });

    const result = await new Promise<CanvasClipboardWriteResult>((resolve) => {
      expect(copySelection(resolve)).toBe(true);
    });

    expect(result).toEqual({ ok: false, reason: "unsupported" });
  });

  it("纯文本选择在 text/plain 与 HTML 中只提供可读 plainText", () => {
    useCanvasStore.setState({
      nodes: [
        validText("t1", "第一段", { x: 0, y: 0 }),
        validText("t2", "第二段", { x: 300, y: 0 }),
      ],
      edges: [],
    });
    select("t1", "t2");
    const { write } = stubSystemClipboard();
    expect(copySelection()).toBe(true);

    const item = writtenItem(write);
    expect(item.items["text/plain"].content).toBe("第一段\n\n第二段");
    expect(item.items["text/plain"].content).not.toContain("noxrea.canvas-selection");
    const html = item.items["text/html"].content;
    expect(html).toContain("第一段<br><br>第二段");
    expect(html).not.toContain("noxrea-nodes:");
  });

  it("系统载荷只含内部连线；粘贴恢复布局与内部边", () => {
    useCanvasStore.setState({
      nodes: [
        validImage("imgA", { x: 0, y: 0 }),
        validImage("imgB", { x: 200, y: 0 }),
        validVideo("vidA", { x: 0, y: 200 }),
        validText("textC", "C", { x: 200, y: 200 }),
      ],
      edges: [makeEdge("imgA", "imgB"), makeEdge("imgA", "vidA"), makeEdge("vidA", "textC")],
    });
    select("imgA", "imgB");
    const { write } = stubSystemClipboard();
    expect(copySelection()).toBe(true);
    const payload = systemPayloadOf(writtenItem(write));
    expect(payload.nodes.map((n) => n.id)).toEqual(["imgA", "imgB"]);
    // imgA→vidA 的上游外部边只留在内部剪贴板，不进入系统载荷
    expect(payload.edges.map((e) => `${e.source}→${e.target}`)).toEqual(["imgA→imgB"]);

    useSelectionStore.setState({ clipboard: null });
    expect(
      pasteFromClipboardContent(
        { payloadJson: JSON.stringify(payload), imageFiles: [], text: "" },
        { x: 500, y: 500 },
      ),
    ).toBe(true);

    const aCopy = copyIdOf("imgA");
    const bCopy = copyIdOf("imgB");
    expect(useCanvasStore.getState().nodes.slice(-2).map((n) => n.position)).toEqual([
      { x: 500, y: 500 },
      { x: 700, y: 500 },
    ]);
    expect(edgePairs()).toEqual(["imgA→imgB", "imgA→vidA", "vidA→textC", `${aCopy}→${bCopy}`]);
    expect(useSelectionStore.getState().clipboard?.nodes.map((n) => n.id)).toEqual(["imgA", "imgB"]);
  });

  it("保留分组成员的相对坐标，并重映射父组和内部连线", () => {
    const group = validGroup("group", { x: 100, y: 200 });
    const memberA = { ...validImage("imgA", { x: 20, y: 40 }), parentId: "group" };
    const memberB = { ...validImage("imgB", { x: 220, y: 40 }), parentId: "group" };
    useCanvasStore.setState({
      nodes: [group, memberA, memberB],
      edges: [makeEdge("imgA", "imgB")],
    });
    // 只选组成员：父组不在选择范围时通过复制导出会被展平；这里先选组，
    // 由选择快照自动带上成员，验证保留相对坐标的路径
    select("group");
    const { write } = stubSystemClipboard();
    expect(copySelection()).toBe(true);
    const payload = systemPayloadOf(writtenItem(write));
    expect(payload.nodes.filter((n) => n.parentId === "group")).toHaveLength(2);

    useSelectionStore.setState({ clipboard: null });
    expect(
      pasteFromClipboardContent(
        { payloadJson: JSON.stringify(payload), imageFiles: [], text: "" },
        { x: 500, y: 500 },
      ),
    ).toBe(true);

    const groupCopy = copyIdOf("group");
    const aCopy = copyIdOf("imgA");
    const bCopy = copyIdOf("imgB");
    const [copyGroup, a, b] = useCanvasStore.getState().nodes.slice(-3);
    expect(copyGroup.position).toEqual({ x: 500, y: 500 });
    expect(a).toMatchObject({ parentId: groupCopy, position: { x: 20, y: 40 } });
    expect(b).toMatchObject({ parentId: groupCopy, position: { x: 220, y: 40 } });
    expect(edgePairs()).toContain(`${aCopy}→${bCopy}`);
  });

  it("单独复制分组成员时按世界坐标展平，粘贴为独立节点", () => {
    const group = validGroup("group", { x: 100, y: 200 });
    const member = { ...validImage("img", { x: 20, y: 40 }), parentId: "group" };
    useCanvasStore.setState({ nodes: [group, member], edges: [] });
    select("img");
    const { write } = stubSystemClipboard();
    expect(copySelection()).toBe(true);
    const payload = systemPayloadOf(writtenItem(write));
    expect(payload.nodes[0].parentId).toBeUndefined();
    expect(payload.nodes[0].position).toEqual({ x: 120, y: 240 });

    useSelectionStore.setState({ clipboard: null });
    expect(
      pasteFromClipboardContent(
        { payloadJson: JSON.stringify(payload), imageFiles: [], text: "" },
        { x: 500, y: 500 },
      ),
    ).toBe(true);
    const copy = useCanvasStore.getState().nodes.at(-1)!;
    expect(copy.position).toEqual({ x: 500, y: 500 });
    expect(copy.parentId).toBeUndefined();
  });

  it("拒绝非有限坐标，且不修改画布、内部剪贴板或降级为文本节点", () => {
    const nodes = useCanvasStore.getState().nodes;
    const edges = useCanvasStore.getState().edges;
    useSelectionStore.getState().copySelected([validText("saved")], []);
    const clipboard = useSelectionStore.getState().clipboard;
    const json =
      `{"kind":"${CANVAS_CLIPBOARD_KIND}","version":${CANVAS_CLIPBOARD_VERSION},` +
      '"nodes":[{"id":"text","type":"text-node","position":{"x":1e400,"y":0},' +
      '"data":{"label":"text","content":"","plainText":""}}],"edges":[]}';

    expect(
      pasteFromClipboardContent({ payloadJson: json, imageFiles: [], text: "" }, { x: 500, y: 500 }),
    ).toBe(false);

    expect(useCanvasStore.getState().nodes).toBe(nodes);
    expect(useCanvasStore.getState().edges).toBe(edges);
    expect(useSelectionStore.getState().clipboard).toBe(clipboard);
  });

  it.each([
    {
      name: "错误 kind",
      json: JSON.stringify({
        kind: "other",
        version: CANVAS_CLIPBOARD_VERSION,
        nodes: [validText("t")],
        edges: [],
      }),
    },
    {
      name: "错误 version",
      json: JSON.stringify({
        kind: CANVAS_CLIPBOARD_KIND,
        version: 2,
        nodes: [validText("t")],
        edges: [],
      }),
    },
    {
      name: "空节点列表",
      json: JSON.stringify({
        kind: CANVAS_CLIPBOARD_KIND,
        version: CANVAS_CLIPBOARD_VERSION,
        nodes: [],
        edges: [],
      }),
    },
    {
      name: "非法节点数据",
      json: JSON.stringify({
        kind: CANVAS_CLIPBOARD_KIND,
        version: CANVAS_CLIPBOARD_VERSION,
        nodes: [{ id: "t", type: NODE_TYPE.TEXT, position: { x: 0, y: 0 }, data: { label: "t" } }],
        edges: [],
      }),
    },
    {
      name: "非法连线",
      json: JSON.stringify({
        kind: CANVAS_CLIPBOARD_KIND,
        version: CANVAS_CLIPBOARD_VERSION,
        nodes: [validText("t")],
        edges: [{ id: "e", source: "t", target: "t" }],
      }),
    },
  ])("非法载荷整包拒绝：$name", ({ json }) => {
    const nodes = useCanvasStore.getState().nodes;
    const edges = useCanvasStore.getState().edges;
    useSelectionStore.getState().copySelected([validText("saved")], []);
    const clipboard = useSelectionStore.getState().clipboard;

    expect(
      pasteFromClipboardContent({ payloadJson: json, imageFiles: [], text: "" }, { x: 500, y: 500 }),
    ).toBe(false);

    expect(useCanvasStore.getState().nodes).toBe(nodes);
    expect(useCanvasStore.getState().edges).toBe(edges);
    expect(useSelectionStore.getState().clipboard).toBe(clipboard);
  });

  it("旧 noxrea-nodes: 文本按普通文本创建文本节点，永不还原为节点", () => {
    useCanvasStore.setState({ nodes: [], edges: [] });
    const legacy =
      "noxrea-nodes:" + JSON.stringify({ nodes: [validText("legacy")], edges: [] });

    expect(
      pasteFromClipboardContent({ imageFiles: [], text: legacy }, { x: 100, y: 200 }),
    ).toBe(true);

    const nodes = useCanvasStore.getState().nodes;
    expect(nodes).toHaveLength(1);
    expect(nodes[0].type).toBe(NODE_TYPE.TEXT);
    expect((nodes[0].data as { plainText: string }).plainText).toBe(legacy);
  });

  it("系统写入被拒时内部剪贴板仍可粘贴，不产生未处理 rejection", async () => {
    select("imgA");
    stubSystemClipboard(vi.fn().mockRejectedValue(new Error("denied")));

    expect(copySelection()).toBe(true);
    expect(useSelectionStore.getState().clipboard?.nodes).toHaveLength(1);
    await Promise.resolve();
    await Promise.resolve();

    expect(pasteClipboard({ x: 500, y: 500 })).toBe(true);
    expect(useCanvasStore.getState().nodes).toHaveLength(5);
  });
});

describe("创建副本不触碰系统与内部剪贴板", () => {
  it("Ctrl+D 只修改画布，不覆盖系统剪贴板或已存在的内部快照", () => {
    const { write, writeText } = stubSystemClipboard();
    useSelectionStore.getState().copySelected([validText("sentinel")], []);
    const clipboard = useSelectionStore.getState().clipboard;
    select("imgA");

    expect(duplicateSelection()).toBe(true);

    expect(write).not.toHaveBeenCalled();
    expect(writeText).not.toHaveBeenCalled();
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

describe("清空选区（画布空白点击与 Esc 共用）", () => {
  it("同时清空节点与连线选中态；无选中项时不重建数组", () => {
    select("imgA");
    useCanvasStore.setState((s) => ({ edges: s.edges.map((e) => ({ ...e, selected: true })) }));

    clearSelection();

    const cleared = useCanvasStore.getState();
    expect(cleared.nodes.some((n) => n.selected)).toBe(false);
    expect(cleared.edges.some((e) => e.selected)).toBe(false);

    // 已无选中项：再次调用保持数组引用不变（否则每次点击空白都会触发下游派生重算）
    const { nodes, edges } = cleared;
    clearSelection();
    expect(useCanvasStore.getState().nodes).toBe(nodes);
    expect(useCanvasStore.getState().edges).toBe(edges);
  });
});
