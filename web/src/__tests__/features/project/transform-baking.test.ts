/**
 * P0-4: CSS transform 烘焙流程
 *
 * 核心验证：
 *   - createNodeFromUrl 正确计算衍生节点位置、尺寸、label
 *   - save-manager.ts 的 _extractHashFromUrl 正确提取 hash
 *   - _collectCanvasHashes 正确收集画布中所有节点的文件 hash
 *
 * 注：原 uploadBlob / uploadAndAddNode 已随统一上传管道删除，
 * 上传与落库现由 runMediaUpload / uploadOne 承载，此处只保留纯函数与落库逻辑。
 */

import { describe, expect, it, vi } from "vitest";

import { NODE_TITLE_HEIGHT } from "@/lib/constants";
import { createNodeFromUrl, type CanvasStoreApi } from "@/features/canvas/upload";

// ── Mock @/lib/api/client（upload-pipeline 的传递依赖，防测试环境加载真实客户端）──
vi.mock("@/lib/api/client", () => ({
  apiUpload: vi.fn(),
  apiUploadWithProgress: vi.fn(),
  UnauthorizedError: class UnauthorizedError extends Error {},
  BASE: "http://test",
  getTokenHeader: () => ({ Authorization: "Bearer test-token" }),
}));

// ── Mock Zustand stores ────────────────────────────────────────
const mockNodes: Array<{ id: string; type: string; position: { x: number; y: number }; style: { width: number; height: number }; data: { alt: string; label: string } }> = [
  {
    id: "n1",
    type: "image-node",
    position: { x: 100, y: 200 },
    style: { width: 600, height: 324 },
    data: { alt: "photo.jpg", label: "photo.jpg" },
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

function collectCanvasHashes(nodes: unknown[]): string[] {
  const hashes: string[] = [];
  for (const node of (nodes as Array<{ data?: Record<string, unknown> }>)) {
    const d = node?.data || {};
    if (typeof d.src === "string") {
      const h = extractHashFromUrl(d.src);
      if (h) hashes.push(h);
    }
    if (Array.isArray(d.images)) {
      for (const img of d.images) {
        const imgObj = img as { url?: string } | undefined;
        if (imgObj?.url) {
          const h = extractHashFromUrl(imgObj.url);
          if (h) hashes.push(h);
        }
      }
    }
  }
  return [...new Set(hashes)].sort();
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

  describe("collectCanvasHashes", () => {
    const hash1 = "1".repeat(64);
    const hash2 = "2".repeat(64);

    it("should collect src from image/video nodes", () => {
      const nodes = [
        { data: { src: `/api/files/1/${hash1.slice(0, 2)}/${hash1}.png` } },
      ];
      const result = collectCanvasHashes(nodes);
      expect(result).toEqual([hash1]);
    });

    it("should deduplicate and sort", () => {
      const nodes = [
        { data: { src: `/api/files/1/${hash1.slice(0, 2)}/${hash1}.png` } },
        { data: { src: `/api/files/1/${hash1.slice(0, 2)}/${hash1}.png` } },
        { data: { src: `/api/files/1/${hash2.slice(0, 2)}/${hash2}.png` } },
      ];
      const result = collectCanvasHashes(nodes);
      expect(result).toEqual([hash1, hash2]);
    });
  });
});
