/**
 * P0-4: CSS transform 烘焙流程
 *
 * 核心验证：
 *   - createNodeFromUrl 正确计算衍生节点位置、尺寸、label
 *
 * 注：原 uploadBlob / uploadAndAddNode 已随统一上传管道删除，
 * 上传与落库现由 runMediaUpload / uploadOne 承载，此处只保留纯函数与落库逻辑。
 * 引用 hash 提取已收敛到服务端（server/services/canvas/extract-hashes.ts），
 * 前端本地复刻实现与其安全网测试一并移除。
 */

import { describe, expect, it, vi } from "vitest";

import { type CanvasStoreApi,createNodeFromUrl } from "@/features/canvas/upload";
import { NODE_TITLE_HEIGHT } from "@/lib/constants";

// ── Mock @/lib/api/client（upload-pipeline 的传递依赖，防测试环境加载真实客户端）──
vi.mock("@/lib/api/client", () => ({
  apiUploadWithProgress: vi.fn(),
  UnauthorizedError: class UnauthorizedError extends Error {},
  BASE: "http://test",
  getTokenHeader: () => ({ Authorization: "Bearer test-token" }),
}));

// ── Mock Zustand stores ────────────────────────────────────────
const mockNodes: Array<{ id: string; type: string; position: { x: number; y: number }; style: { width: number; height: number }; data: { label: string } }> = [
  {
    id: "n1",
    type: "image-node",
    position: { x: 100, y: 200 },
    style: { width: 600, height: 324 },
    data: { label: "photo.jpg" },
  },
];

vi.mock("@/features/canvas/stores/canvas-store", () => ({
  useCanvasStore: Object.assign(
    (selector?: (s: Record<string, unknown>) => unknown) => {
      const state = {
        nodes: mockNodes,
        edges: [],
        addNodes: vi.fn(),
        setEdges: vi.fn(),
        getState: () => ({
          nodes: mockNodes,
          edges: [],
          addNodes: vi.fn(),
          setEdges: vi.fn(),
        }),
      };
      return selector ? selector(state) : state;
    },
    { getState: () => ({ nodes: mockNodes, edges: [], addNodes: vi.fn(), setEdges: vi.fn() }), subscribe: vi.fn() },
  ),
  markDirty: vi.fn(),
  markDirtyImmediate: vi.fn(),
  takeCanvasSnapshot: vi.fn(),
  withHistoryBatch: vi.fn((fn: () => unknown) => fn()),
}));

/** 模拟 CanvasStoreApi（符合 upload/derived-node 中定义的接口） */
const mockStoreApi = {
  nodes: mockNodes,
  edges: [],
  addNodes: vi.fn(),
  setEdges: vi.fn(),
} as CanvasStoreApi;

describe("P0-4: CSS transform baking flow", () => {

  // ── createNodeFromUrl ─────────────────────────────────────────

  describe("createNodeFromUrl", () => {
    it("should place derivative node to the right of source", () => {
      const node = createNodeFromUrl("n1", "http://img.url/result.png", 800, 600, " (baked)", mockStoreApi);
      expect(node).not.toBeNull();
      // x = source.x(100) + source width(600) + 60 = 760
      expect(node.position.x).toBe(760);
      expect(node.position.y).toBe(200);
    });

    it("should shift to the next grid slot when the default spot is occupied", () => {
      // 基准槽位 (760, 200) 被上一次派生产物占据（尺寸与本次相同）
      const occupied = {
        id: "occ",
        type: "image-node",
        position: { x: 760, y: 200 },
        style: { width: 600, height: 478 },
        data: { label: "prev" },
      };
      mockNodes.push(occupied as (typeof mockNodes)[number]);
      try {
        const node = createNodeFromUrl("n1", "http://img.url/result.png", 800, 600, " (baked)", mockStoreApi);
        // 不再与占用节点重叠：顺延到右侧下一格
        expect(node.position.x).toBe(760 + 600 + 12);
        expect(node.position.y).toBe(200);
      } finally {
        mockNodes.pop();
      }
    });

    it("should accept position override", () => {
      const node = createNodeFromUrl("n1", "http://img.url/result.png", 800, 600, " (baked)", mockStoreApi, undefined, { x: 999, y: 888 });
      expect(node.position.x).toBe(999);
      expect(node.position.y).toBe(888);
    });

    it("should scale display dimensions by NODE_DISPLAY_MAX", () => {
      const node = createNodeFromUrl("n1", "http://img.url/result.png", 4000, 3000, " (baked)", mockStoreApi);
      const w = node.style?.width as number;
      const h = node.style?.height as number;
      expect(w).toBe(600);
      expect(h).toBe(450 + NODE_TITLE_HEIGHT);
    });

    it("should append label suffix after extension-stripped source label", () => {
      const node = createNodeFromUrl("n1", "http://img.url/result.png", 1024, 1024, " (baked)", mockStoreApi);
      const label = node.data.label as string;
      expect(label).toContain(" (baked)");
      expect(label.endsWith(".jpg")).toBe(false);
    });

    it("should merge extraNodeData", () => {
      const node = createNodeFromUrl("n1", "http://img.url/result.png", 100, 100, "",
        mockStoreApi, { customField: "hello", naturalWidth: 999 }
      );
      expect((node.data as Record<string, unknown>).customField).toBe("hello");
    });

    it("should accept position override explicitly", () => {
      const pos = { x: 50, y: 60 };
      const node = createNodeFromUrl("n1", "http://img.url/r.png", 200, 200, "", mockStoreApi, undefined, pos);
      expect(node.position.x).toBe(50);
      expect(node.position.y).toBe(60);
    });
  });
});
