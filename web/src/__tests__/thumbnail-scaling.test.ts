/**
 * NODE_DISPLAY_MAX 缩放计算 — 安全网测试（长边约束 600px）。
 *
 * 统一后公式：longSide = Math.max(nw, nh); scale = longSide > 600 ? 600 / longSide : 1
 * 素材库、生成、上传、拖放、旋转、宫格等全部走同一算法。
 */

import { beforeEach,describe, expect, it, vi } from "vitest";

import { NODE_DISPLAY_MAX } from "@/lib/constants";

const mockNodes: Array<{ id: string; type: string; position: { x: number; y: number }; style: { width: number; height: number }; data: { alt: string; label: string } }> = [
  {
    id: "n1", type: "image-node",
    position: { x: 100, y: 200 },
    style: { width: 600, height: 338 },
    data: { alt: "photo.jpg", label: "photo.jpg" },
  },
];

vi.mock("@/stores/canvas-store", () => ({
  useCanvasStore: Object.assign(
    (selector?: (s: Record<string, unknown>) => unknown) => {
      const state = { nodes: mockNodes, edges: [], addNodes: vi.fn(), setEdges: vi.fn(), getState: () => ({ nodes: mockNodes, edges: [], addNodes: vi.fn(), setEdges: vi.fn() }) };
      return selector ? selector(state) : state;
    },
    { getState: () => ({ nodes: mockNodes, edges: [], addNodes: vi.fn(), setEdges: vi.fn() }) },
  ),
  takeCanvasSnapshot: vi.fn(),
  markDirty: vi.fn(),
  markDirtyImmediate: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  apiUpload: vi.fn(),
  BASE: "http://test",
  getTokenHeader: () => ({ Authorization: "Bearer test-token" }),
}));

import { computeThumbScale,createNodeFromUrl } from "@/lib/image-utils";

const D = NODE_DISPLAY_MAX; // 600

/** 模拟 CanvasStoreApi（符合 image-utils 中定义的接口） */
const mockStoreApi = {
  nodes: mockNodes,
  edges: [],
  addNodes: vi.fn(),
  setEdges: vi.fn(),
} as any;

interface TestCase {
  name: string;
  naturalW: number;
  naturalH: number;
  longSide: number;
  expectedScale: number;
  expectedDisplayW: number;
  expectedDisplayH: number;
  expectedWithTitle: number;
}

const testCases: TestCase[] = [
  // 4000×3000: longSide=4000>600, scale=600/4000=0.15, W=600, H=450
  { name: "超大横图 4000×3000", naturalW: 4000, naturalH: 3000, longSide: 4000, expectedScale: 600/4000, expectedDisplayW: 600, expectedDisplayH: 450, expectedWithTitle: 474 },
  // 2000×4000: longSide=4000>600, scale=0.15, W=300, H=600
  { name: "超大竖图 2000×4000", naturalW: 2000, naturalH: 4000, longSide: 4000, expectedScale: 600/4000, expectedDisplayW: 300, expectedDisplayH: 600, expectedWithTitle: 624 },
  // 1024×1024: longSide=1024>600, scale=600/1024≈0.5859375, W=600, H=600
  { name: "方形 1024×1024", naturalW: 1024, naturalH: 1024, longSide: 1024, expectedScale: 600/1024, expectedDisplayW: 600, expectedDisplayH: 600, expectedWithTitle: 624 },
  // 刚好 NODE_DISPLAY_MAX(600)×600: longSide=600 NOT > 600, scale=1
  { name: "刚好 NODE_DISPLAY_MAX 600×600", naturalW: D, naturalH: D, longSide: D, expectedScale: 1, expectedDisplayW: D, expectedDisplayH: D, expectedWithTitle: D + 24 },
  // 200×100: longSide=200 ≤ 600, scale=1
  { name: "小图 200×100", naturalW: 200, naturalH: 100, longSide: 200, expectedScale: 1, expectedDisplayW: 200, expectedDisplayH: 100, expectedWithTitle: 124 },
  // 1×1
  { name: "极小 1×1", naturalW: 1, naturalH: 1, longSide: 1, expectedScale: 1, expectedDisplayW: 1, expectedDisplayH: 1, expectedWithTitle: 25 },
  // 1920×1080: longSide=1920>600, scale=600/1920=0.3125, W=600, H=338 (Math.round(1080*0.3125)=338)
  { name: "超宽 16:9 1920×1080", naturalW: 1920, naturalH: 1080, longSide: 1920, expectedScale: 600/1920, expectedDisplayW: 600, expectedDisplayH: 338, expectedWithTitle: 362 },
  // 100×2000: longSide=2000>600, scale=600/2000=0.3, W=30, H=600
  // 以前短边约束 scale=1 → 100×2000 拉穿画布，长边约束修复了
  { name: "超窄 100×2000", naturalW: 100, naturalH: 2000, longSide: 2000, expectedScale: 600/2000, expectedDisplayW: 30, expectedDisplayH: 600, expectedWithTitle: 624 },
  // 0×100: degenerate
  { name: "零宽 0×100", naturalW: 0, naturalH: 100, longSide: 100, expectedScale: 1, expectedDisplayW: 300, expectedDisplayH: 100, expectedWithTitle: 124 },
  // 0×0
  { name: "全零 0×0", naturalW: 0, naturalH: 0, longSide: 0, expectedScale: 1, expectedDisplayW: 300, expectedDisplayH: 300, expectedWithTitle: 324 },
];

describe("核心缩放公式（computeThumbScale）— 长边约束 NODE_DISPLAY_MAX=600", () => {
  for (const tc of testCases) {
    if (tc.naturalW === 0 || tc.naturalH === 0) continue;

    it(`公式：${tc.name}`, () => {
      const result = computeThumbScale(tc.naturalW, tc.naturalH);
      expect(result.scale).toBeCloseTo(tc.expectedScale, 6);
      expect(result.displayW).toBe(tc.expectedDisplayW);
      expect(result.displayH).toBe(tc.expectedDisplayH);
    });
  }
});

describe("createNodeFromUrl — 统一使用 computeThumbScale", () => {
  for (const tc of testCases) {
    it(`缩放 + titleH：${tc.name}`, async () => {
      const node = await createNodeFromUrl("n1", "http://img.url/r.png", tc.naturalW, tc.naturalH, " (test)", mockStoreApi);
      const expectedW = tc.naturalW > 0 ? tc.expectedDisplayW : 300;
      const expectedH = tc.naturalH > 0 ? tc.expectedDisplayH : 300;
      expect(node?.style?.width).toBe(expectedW);
      expect(node?.style?.height).toBe(expectedH + 24);
    });
  }
});

describe("素材库与 computeThumbScale 已统一（都是长边 600）", () => {
  function impl_assetsModal(nw: number, nh: number) {
    const MAX = 600;
    const scale = Math.max(nw, nh) > MAX ? MAX / Math.max(nw, nh) : 1;
    return { dw: Math.round(nw * scale), dh: Math.round(nh * scale) };
  }

  it("4000×3000：两边结果一致", () => {
    const a = impl_assetsModal(4000, 3000);
    const b = computeThumbScale(4000, 3000);
    expect(a.dw).toBe(b.displayW); // 都是 600
    expect(a.dh).toBe(b.displayH); // 都是 450
  });
});
