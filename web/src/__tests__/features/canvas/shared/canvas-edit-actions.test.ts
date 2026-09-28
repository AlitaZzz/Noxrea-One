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

import { beforeEach, describe, expect, it, vi } from "vitest";

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
  copySelection,
  duplicateSelection,
  pasteClipboard,
} from "@/features/canvas/shared/canvas-edit-actions";
import { useCanvasStore } from "@/features/canvas/stores/canvas-store";
import { useSelectionStore } from "@/features/canvas/stores/selection-store";
import type { AnyEdge, AnyNode } from "@/features/canvas/types";

const NODE_TYPE = { IMAGE: "image-node", VIDEO: "video-node", TEXT: "text-node" } as const;

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

describe("复制：捕获任一端在选中集内的连线", () => {
  it("多选 imgA+imgB 时，imgA→imgB 与 imgA→vidA 都进剪贴板，vidA→textC 不进", () => {
    select("imgA", "imgB");
    expect(copySelection()).toBe(true);
    const clip = useSelectionStore.getState().clipboard!;
    expect(clip.nodes.map((n) => (n.data as { label: string }).label)).toEqual(["imgA", "imgB"]);
    expect(clip.edges.map((e) => `${e.source}→${e.target}`)).toEqual(["imgA→imgB", "imgA→vidA"]);
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
