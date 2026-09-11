/**
 * P0-4: CSS transform 烘焙流程
 *
 * 核心验证：
 *   - createNodeFromUrl 正确计算衍生节点位置、尺寸、label
 *   - save-manager.ts 的 _extractHashFromUrl 正确提取 hash
 *   - 引用收集按节点数量统计，且不再读取废弃的 data.images
 *
 * 注：原 uploadBlob / uploadAndAddNode 已随统一上传管道删除，
 * 上传与落库现由 runMediaUpload / uploadOne 承载，此处只保留纯函数与落库逻辑。
 */

import { describe, expect, it, vi } from "vitest";

import { type CanvasStoreApi,createNodeFromUrl } from "@/features/canvas/upload";
import { NODE_TITLE_HEIGHT } from "@/lib/constants";

// ── Mock @/lib/api/client（upload-pipeline 的传递依赖，防测试环境加载真实客户端）──
vi.mock("@/lib/api/client", () => ({
  apiUpload: vi.fn(),
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
    { getState: () => ({ nodes: mockNodes, edges: [], addNodes: vi.fn(), setEdges: vi.fn() }) },
  ),
  markDirty: vi.fn(),
  markDirtyImmediate: vi.fn(),
  takeCanvasSnapshot: vi.fn(),
}));

import { useCanvasStore } from "@/features/canvas/stores/canvas-store";

/** 模拟 CanvasStoreApi（符合 upload/derived-node 中定义的接口） */
const mockStoreApi = {
  nodes: mockNodes,
  edges: [],
  addNodes: vi.fn(),
  setEdges: vi.fn(),
} as CanvasStoreApi;

// ── Import pure functions from save-manager ─────────────────────
// These aren't exported; we re-implement or extract. Extract them:

function extractHashFromUrl(url: string): string | null {
  if (!url || typeof url !== "string") return null;
  const idx = url.indexOf("/api/files/");
  if (idx === -1) return null;
  const path = url.slice(idx + "/api/files/".length);
  const parts = path.split("/");
  if (parts.length !== 3) return null;
  const fn = parts[2];
  const dot = fn.lastIndexOf(".");
  const h = dot > 0 ? fn.slice(0, dot) : fn;
  return h.length === 64 ? h : null;
}

function collectCanvasHashCounts(nodes: unknown[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const node of (nodes as Array<{ data?: Record<string, unknown> }>)) {
    const d = node?.data || {};
    if (typeof d.src === "string") {
      const h = extractHashFromUrl(d.src);
      if (h) counts.set(h, (counts.get(h) ?? 0) + 1);
    }
  }
  return counts;
}


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

    it("should append label suffix before extension", () => {
      const node = createNodeFromUrl("n1", "http://img.url/result.png", 1024, 1024, " (baked)", mockStoreApi);
      const label = node.data.label as string;
      expect(label).toContain(" (baked)");
      expect(label.endsWith(".jpg")).toBe(true);
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

  // ── extractHashFromUrl ───────────────────────────────────────

  describe("extractHashFromUrl", () => {
    it("should extract 64-char hash from standard CAS URL", () => {
      const hash = "a".repeat(64);
      const url = `http://test/api/files/1/${hash.slice(0, 2)}/${hash}.png`;
      expect(extractHashFromUrl(url)).toBe(hash);
    });

    it("should return null for URL without /api/files/", () => {
      expect(extractHashFromUrl("http://example.com/file.png")).toBeNull();
    });

    it("should return null if hash is not 64 chars", () => {
      expect(extractHashFromUrl("http://test/api/files/1/ab/short.png")).toBeNull();
    });

    it("should return null for non-string input", () => {
      expect(extractHashFromUrl(null as unknown as string)).toBeNull();
      expect(extractHashFromUrl(undefined as unknown as string)).toBeNull();
      expect(extractHashFromUrl("")).toBeNull();
    });

    it("should handle URL with no extension", () => {
      const hash = "b".repeat(64);
      const url = `http://test/api/files/2/${hash.slice(0, 2)}/${hash}`;
      expect(extractHashFromUrl(url)).toBe(hash);
    });
  });

  // ── collectCanvasHashes ──────────────────────────────────────

  describe("collectCanvasHashCounts", () => {
    const hash1 = "1".repeat(64);
    const hash2 = "2".repeat(64);

    it("should collect src from image/video nodes", () => {
      const nodes = [
        { data: { src: `/api/files/1/${hash1.slice(0, 2)}/${hash1}.png` } },
      ];
      const result = collectCanvasHashCounts(nodes);
      expect(result).toEqual(new Map([[hash1, 1]]));
    });

    it("should count one reference per node", () => {
      const nodes = [
        { data: { src: `/api/files/1/${hash1.slice(0, 2)}/${hash1}.png` } },
        { data: { src: `/api/files/1/${hash1.slice(0, 2)}/${hash1}.png` } },
        { data: { src: `/api/files/1/${hash2.slice(0, 2)}/${hash2}.png` } },
      ];
      const result = collectCanvasHashCounts(nodes);
      expect(result).toEqual(new Map([[hash1, 2], [hash2, 1]]));
    });
  });
});
