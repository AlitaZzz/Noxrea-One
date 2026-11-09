/**
 * 派生节点（图片 / 视频 / 音频）的撤销语义回归测试。
 *
 * 离散派生必须产生一条独立撤销记录；三个工厂若绕过批量守卫直接
 * addNodes + addEdges，二者只走 300ms 节流，距上次压栈不足 300ms
 * 时会被吞掉。
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/features/canvas/persistence/save-manager", () => ({
  saveManager: {
    markDirty: vi.fn(),
    markDirtyImmediate: vi.fn(),
    markDirtyUndo: vi.fn(),
    resetForProjectSwitch: vi.fn(),
  },
}));

import { useCanvasStore } from "@/features/canvas/stores/canvas-store";
import { useHistoryStore } from "@/features/canvas/stores/history-store";
import type { AnyEdge, AnyNode } from "@/features/canvas/types";
import {
  type CanvasStoreApi,
  commitDerivedNodes,
  createAudioNodeFromRef,
  createImageNodeFromRef,
  createVideoNodeFromRef,
} from "@/features/canvas/upload";
import { NODE_TYPE } from "@/lib/constants";

function makeSourceNode(): AnyNode {
  return {
    id: "source",
    type: NODE_TYPE.VIDEO,
    position: { x: 100, y: 200 },
    data: { label: "clip.mp4", src: "1/ab/source.mp4", naturalWidth: 640, naturalHeight: 360 },
    style: { width: 300, height: 170 },
  } as AnyNode;
}

type DerivedFactory = (storeApi: CanvasStoreApi) => AnyNode;

/**
 * 每次读取 Date.now 前进 1s：让同一批内的两次写入之间也跨过 300ms 节流窗口。
 * 若批量守卫缺失，第二次写入会再压一条撤销记录，下面的断言即可复现。
 */
function mockAdvancingClock(start = 1_000_000) {
  let clock = start;
  return vi.spyOn(Date, "now").mockImplementation(() => {
    clock += 1_000;
    return clock;
  });
}

const FACTORIES: ReadonlyArray<readonly [string, DerivedFactory]> = [
  [
    "图片",
    (storeApi) =>
      createImageNodeFromRef({
        sourceId: "source",
        ref: "1/ab/image.png",
        naturalWidth: 800,
        naturalHeight: 600,
        labelSuffix: " (image)",
        storeApi,
      }),
  ],
  [
    "音频",
    (storeApi) =>
      createAudioNodeFromRef({
        sourceId: "source",
        ref: "1/ab/audio.mp3",
        labelSuffix: " (audio)",
        storeApi,
      }),
  ],
  [
    "视频",
    (storeApi) =>
      createVideoNodeFromRef({
        sourceId: "source",
        ref: "1/ab/video.mp4",
        naturalWidth: 640,
        naturalHeight: 360,
        labelSuffix: " (video)",
        storeApi,
      }),
  ],
];

beforeEach(() => {
  useHistoryStore.getState().clear();
  useCanvasStore.setState({ nodes: [makeSourceNode()], edges: [] });
});

afterEach(() => {
  vi.restoreAllMocks();
});

for (const [name, create] of FACTORIES) {
  describe(`${name}工厂派生节点撤销语义`, () => {
    it("距上次压栈不足 300ms 时仍产生独立撤销记录", () => {
      // forceHistory 压栈后立即派生：节流窗口内也必须有自己的撤销步
      useCanvasStore.getState().updateNodeVisual("source", {
        data: { label: "renamed" },
        forceHistory: true,
      });
      const depth = useHistoryStore.getState().undoStack.length;

      const node = create(useCanvasStore.getState());

      expect(useHistoryStore.getState().undoStack.length).toBe(depth + 1);
      expect(useCanvasStore.getState().nodes.some((n) => n.id === node.id)).toBe(true);
      expect(
        useCanvasStore.getState().edges.some((e) => e.source === "source" && e.target === node.id),
      ).toBe(true);

      const snapshot = useHistoryStore.getState().undoStack.at(-1)!;
      expect(snapshot.nodes.some((n) => n.id === node.id)).toBe(false);
      expect(snapshot.edges.some((e) => e.source === "source" && e.target === node.id)).toBe(false);
    });
  });
}

describe("commitDerivedNodes 批量守卫", () => {
  it("两次写入之间跨过 300ms 节流窗口时仍只产生一条撤销记录", () => {
    const store = useCanvasStore.getState();
    const image = createImageNodeFromRef({
      sourceId: "source",
      ref: "1/ab/image.png",
      naturalWidth: 800,
      naturalHeight: 600,
      labelSuffix: " (image)",
      storeApi: store,
      options: { write: false },
    });
    const video = createVideoNodeFromRef({
      sourceId: "source",
      ref: "1/ab/video.mp4",
      naturalWidth: 640,
      naturalHeight: 360,
      labelSuffix: " (video)",
      storeApi: store,
      options: { write: false },
    });

    // 快照在追加无关连线之前取得：提交必须追加到最新 edges，而不是用旧快照覆盖。
    const existingEdge = { id: "existing", source: "source", target: "other" } as AnyEdge;
    useCanvasStore.setState({ edges: [existingEdge] });

    // 同一批内两次写入之间跨过节流窗口：没有批量守卫时 addEdges 会再压一条。
    const nowSpy = mockAdvancingClock();
    try {
      useCanvasStore.getState().updateNodeVisual("source", {
        data: { label: "renamed" },
        forceHistory: true,
      });
      const depth = useHistoryStore.getState().undoStack.length;
      commitDerivedNodes("source", [image, video], store);
      expect(useHistoryStore.getState().undoStack.length).toBe(depth + 1);
    } finally {
      nowSpy.mockRestore();
    }

    const ids = new Set([image.id, video.id]);
    expect(useCanvasStore.getState().nodes.filter((n) => ids.has(n.id))).toHaveLength(2);
    const edges = useCanvasStore.getState().edges;
    expect(edges.filter((e) => e.source === "source" && ids.has(e.target))).toHaveLength(2);
    expect(edges.some((e) => e.id === "existing")).toBe(true);

    const snapshot = useHistoryStore.getState().undoStack.at(-1)!;
    expect(snapshot.nodes.some((n) => ids.has(n.id))).toBe(false);
    expect(snapshot.edges.some((e) => e.source === "source" && ids.has(e.target))).toBe(false);
  });
});
