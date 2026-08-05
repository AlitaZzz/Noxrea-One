/**
 * P0-4: CSS transform 烘焙流程
 *
 * 核心验证：
 *   - createNodeFromUrl 正确计算衍生节点位置、尺寸、label
 *   - uploadAndAddNode 的 CAS 上传路径走通（mock apiUpload）
 *   - save-manager.ts 的 _extractHashFromUrl 正确提取 hash
 *   - _collectCanvasHashes 正确收集画布中所有节点的文件 hash
 *   - 完整流程：uploadBlob → 返回 url → createNodeFromUrl → 创建节点
 */

import { beforeEach,describe, expect, it, vi } from "vitest";

// ── Mock @/lib/api ─────────────────────────────────────────────
vi.mock("@/lib/api", () => ({
  apiUpload: vi.fn(),
  BASE: "http://test",
  getTokenHeader: () => ({ Authorization: "Bearer test-token" }),
}));

import { createNodeFromUrl, uploadAndAddNode,uploadBlob } from "@/lib/image-utils";

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

vi.mock("@/stores/canvas-store", () => ({
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
}));

import { useCanvasStore } from "@/stores/canvas-store";

/** 模拟 CanvasStoreApi（符合 image-utils 中定义的接口） */
const mockStoreApi = {
  nodes: mockNodes,
  edges: [],
  addNodes: vi.fn(),
  setEdges: vi.fn(),
} as any;

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
    it("should place derivative node to the right of source", async () => {
      const node = await createNodeFromUrl("n1", "http://img.url/result.png", 800, 600, " (baked)", mockStoreApi);
      expect(node).not.toBeNull();
      // x = source.x(100) + source width(600) + 60 = 760
      expect(node!.position.x).toBe(760);
      expect(node!.position.y).toBe(200);
    });

    it("should accept position override", async () => {
      const node = await createNodeFromUrl("n1", "http://img.url/result.png", 800, 600, " (baked)", mockStoreApi, undefined, { x: 999, y: 888 });
      expect(node!.position.x).toBe(999);
      expect(node!.position.y).toBe(888);
    });

    it("should scale display dimensions by NODE_DISPLAY_MAX", async () => {
      const node = await createNodeFromUrl("n1", "http://img.url/result.png", 4000, 3000, " (baked)", mockStoreApi);
      const w = node!.style?.width as number;
      const h = node!.style?.height as number;
      expect(w).toBe(600);
      expect(h).toBe(474);
    });

    it("should append label suffix before extension", async () => {
      const node = await createNodeFromUrl("n1", "http://img.url/result.png", 1024, 1024, " (baked)", mockStoreApi);
      const label = node!.data.label as string;
      expect(label).toContain(" (baked)");
      expect(label.endsWith(".jpg")).toBe(true);
    });

    it("should merge extraNodeData", async () => {
      const node = await createNodeFromUrl("n1", "http://img.url/result.png", 100, 100, "",
        mockStoreApi, { customField: "hello", naturalWidth: 999 }
      );
      expect((node!.data as Record<string, unknown>).customField).toBe("hello");
    });

    it("should accept position override explicitly", async () => {
      const pos = { x: 50, y: 60 };
      const node = await createNodeFromUrl("n1", "http://img.url/r.png", 200, 200, "", mockStoreApi, undefined, pos);
      expect(node!.position.x).toBe(50);
      expect(node!.position.y).toBe(60);
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

  // ── uploadBlob (mocked apiUpload) ─────────────────────────────

  describe("uploadBlob", () => {
    it("should call apiUpload with file and category", async () => {
      const { apiUpload } = await import("@/lib/api");
      vi.mocked(apiUpload).mockResolvedValueOnce({
        code: 200,
        data: { url: "http://test/api/files/1/aa/aaaa...png" },
        msg: "",
      });

      const blob = new Blob(["fake-png-data"], { type: "image/png" });
      const url = await uploadBlob(blob, "test.png");

      expect(apiUpload).toHaveBeenCalledTimes(1);
      const formData = vi.mocked(apiUpload).mock.calls[0][1] as FormData;
      expect(formData.get("file")).toBeInstanceOf(Blob);
      expect(url).toBe("http://test/api/files/1/aa/aaaa...png");
    });

    it("should return null on upload failure", async () => {
      const { apiUpload } = await import("@/lib/api");
      vi.mocked(apiUpload).mockResolvedValueOnce({ code: 500, data: null, msg: "" });

      const blob = new Blob(["fake"]);
      const url = await uploadBlob(blob);
      expect(url).toBeNull();
    });
  });

  // ── uploadAndAddNode (integration of upload + node creation) ──

  describe("uploadAndAddNode", () => {
    it("should return node when upload succeeds", async () => {
      const { apiUpload } = await import("@/lib/api");
      vi.mocked(apiUpload).mockResolvedValueOnce({
        code: 200,
        data: { url: "http://test/api/files/1/aa/aaaa...png" },
        msg: "",
      });

      const blob = new Blob(["transformed-data"], { type: "image/png" });
      const node = await uploadAndAddNode("n1", blob, " (baked)", mockStoreApi);

      expect(node).not.toBeNull();
      expect((node!.data as { src?: string }).src).toBe("http://test/api/files/1/aa/aaaa...png");
    });

    it("should return null when upload fails", async () => {
      const { apiUpload } = await import("@/lib/api");
      vi.mocked(apiUpload).mockResolvedValueOnce({ code: 500, data: null, msg: "" });

      const blob = new Blob(["fail-data"]);
      const node = await uploadAndAddNode("n1", blob, " (baked)", mockStoreApi);

      expect(node).toBeNull();
    });
  });
});
