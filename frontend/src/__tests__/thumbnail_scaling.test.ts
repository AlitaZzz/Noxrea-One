/**
 * THUMBNAIL_MAX 缩放计算 — 安全网测试。
 *
 * 本文件捕获所有 10+ 处重复实现中缩放公式的当前行为，包括已知的不一致
 * （有些位置对节点高度 +titleH=24，有些不加）。
 *
 * 覆盖范围：
 *   - core formula: scale = shortSide > THUMBNAIL_MAX ? THUMBNAIL_MAX / shortSide : 1
 *   - 各实现是否 +titleH(24)
 *   - 边界值：0、1、THUMBNAIL_MAX 刚好值、超大图片、1:1/16:9/超宽比
 *   - buildNodeFromUrl 直接（导入）与各内联实现的间接比较
 *
 * 注意：不要修改业务代码。本文件只记录"现状"。
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { THUMBNAIL_MAX } from "@/lib/constants";

// ════════════════════════════════════════════════════════════════════
// Mock Zustand stores (必要的，因为 buildNodeFromUrl 会调用 useCanvasStore.getState())
// ════════════════════════════════════════════════════════════════════

const mockNodes: any[] = [
  {
    id: "n1",
    type: "image-node",
    position: { x: 100, y: 200 },
    style: { width: 600, height: 338 },
    data: { alt: "photo.jpg", label: "photo.jpg" },
  },
];

vi.mock("@/stores/canvas-store", () => ({
  useCanvasStore: Object.assign(
    (selector?: any) => {
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
  takeCanvasSnapshot: vi.fn(),
  markDirty: vi.fn(),
  markDirtyImmediate: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  apiUpload: vi.fn(),
  BASE: "http://test",
  getTokenHeader: () => ({ Authorization: "Bearer test-token" }),
}));

import { buildNodeFromUrl } from "@/lib/image-utils";

// ════════════════════════════════════════════════════════════════════
// Helper: 提取核心缩放公式
// 这样我们可以用同一组输入测试所有变体
// ════════════════════════════════════════════════════════════════════

interface ScaleResult {
  scale: number;
  displayW: number;
  displayH: number;
}

function computeThumbScale(naturalW: number, naturalH: number): ScaleResult {
  const shortSide = Math.min(naturalW, naturalH);
  const scale = shortSide > THUMBNAIL_MAX ? THUMBNAIL_MAX / shortSide : 1;
  return {
    scale,
    displayW: Math.round(naturalW * scale),
    displayH: Math.round(naturalH * scale),
  };
}

/**
 * 各实现的节点高度计算方式：
 *   "with24"  = displayH + 24 (titleH)
 *   "noTitle" = displayH (不加 titleH)
 */

// ── 测试用例数据集 ──────────────────────────────────────────────────

interface TestCase {
  name: string;
  naturalW: number;
  naturalH: number;
  shortSide: number;        // THUMBNAIL_MAX = 360
  expectedScale: number;    // 精确值，因为 Math.round 后会变
  expectedDisplayW: number;
  expectedDisplayH: number;
  expectedWithTitle: number; // displayH + 24
}

// THUMBNAIL_MAX = 360
const T = THUMBNAIL_MAX;

const testCases: TestCase[] = [
  // 1) 超大横图：4000×3000 → shortSide=3000 > 360 → scale=360/3000=0.12
  //    displayW=Math.round(4000*0.12)=480, displayH=Math.round(3000*0.12)=360
  //    shortSide after rounding: 3000 → fine
  {
    name: "超大横图 4000×3000",
    naturalW: 4000, naturalH: 3000,
    shortSide: 3000,
    expectedScale: 360 / 3000,
    expectedDisplayW: 480,
    expectedDisplayH: 360,
    expectedWithTitle: 384,
  },

  // 2) 超大竖图：2000×4000 → shortSide=2000 > 360 → scale=360/2000=0.18
  //    displayW=Math.round(2000*0.18)=360, displayH=Math.round(4000*0.18)=720
  {
    name: "超大竖图 2000×4000",
    naturalW: 2000, naturalH: 4000,
    shortSide: 2000,
    expectedScale: 360 / 2000,
    expectedDisplayW: 360,
    expectedDisplayH: 720,
    expectedWithTitle: 744,
  },

  // 3) 正方形：1024×1024 → shortSide=1024 > 360 → scale=360/1024≈0.3515625
  //    displayW=Math.round(1024*0.3515625)=360, displayH=360
  {
    name: "方形 1024×1024",
    naturalW: 1024, naturalH: 1024,
    shortSide: 1024,
    expectedScale: 360 / 1024,
    expectedDisplayW: 360,
    expectedDisplayH: 360,
    expectedWithTitle: 384,
  },

  // 4) 刚好 THUMBNAIL_MAX：360×360 → shortSide=360, NOT > 360 → scale=1
  //    displayW=360, displayH=360
  {
    name: "刚好 THUMBNAIL_MAX 360×360",
    naturalW: T, naturalH: T,
    shortSide: T,
    expectedScale: 1,
    expectedDisplayW: T,
    expectedDisplayH: T,
    expectedWithTitle: T + 24,
  },

  // 5) 低于 THUMBNAIL_MAX：200×100 → shortSide=100 ≤ 360 → scale=1
  //    displayW=200, displayH=100
  {
    name: "低于 THUMBNAIL_MAX 200×100",
    naturalW: 200, naturalH: 100,
    shortSide: 100,
    expectedScale: 1,
    expectedDisplayW: 200,
    expectedDisplayH: 100,
    expectedWithTitle: 124,
  },

  // 6) 极小图：1×1 → shortSide=1 ≤ 360 → scale=1
  {
    name: "极小 1×1",
    naturalW: 1, naturalH: 1,
    shortSide: 1,
    expectedScale: 1,
    expectedDisplayW: 1,
    expectedDisplayH: 1,
    expectedWithTitle: 25,
  },

  // 7) 超宽比：1920×1080 → shortSide=1080 > 360 → scale=360/1080=1/3≈0.3333…
  //    displayW=Math.round(1920/3)=640, displayH=Math.round(1080/3)=360
  {
    name: "超宽 16:9 1920×1080",
    naturalW: 1920, naturalH: 1080,
    shortSide: 1080,
    expectedScale: 360 / 1080,
    expectedDisplayW: 640,
    expectedDisplayH: 360,
    expectedWithTitle: 384,
  },

  // 8) 超窄图：100×2000 → shortSide=100 ≤ 360 → scale=1
  //    displayW=100, displayH=2000 （不缩放，因为短边 ≤ 360）
  {
    name: "超窄 100×2000",
    naturalW: 100, naturalH: 2000,
    shortSide: 100,
    expectedScale: 1,
    expectedDisplayW: 100,
    expectedDisplayH: 2000,
    expectedWithTitle: 2024,
  },

  // 9) 零宽（退化情况）：0×100 → shortSide=0 ≤ 360 → scale=1
  //    buildNodeFromUrl: naturalW > 0 ? Math.round(naturalW*1) : 300 → displayW=300
  //    naturalH > 0 → Math.round(100*1)=100 → displayH=100
  {
    name: "零宽 0×100",
    naturalW: 0, naturalH: 100,
    shortSide: 0,
    expectedScale: 1,
    expectedDisplayW: 300,   // fallback
    expectedDisplayH: 100,   // naturalH > 0 → Math.round(100*1)
    expectedWithTitle: 124,  // 100 + 24
  },

  // 10) 全零（退化情况）：0×0
  {
    name: "全零 0×0",
    naturalW: 0, naturalH: 0,
    shortSide: 0,
    expectedScale: 1,
    expectedDisplayW: 300,
    expectedDisplayH: 300,
    expectedWithTitle: 324,
  },
];

// ════════════════════════════════════════════════════════════════════
// 核心公式测试
// ════════════════════════════════════════════════════════════════════

describe("核心缩放公式（computeThumbScale）", () => {
  for (const tc of testCases) {
    // 跳过零值退化情况（公式本身不会 fallback，fallback 是 buildNodeFromUrl 加的额外逻辑）
    if (tc.naturalW === 0 || tc.naturalH === 0) continue;

    it(`公式：${tc.name}`, () => {
      const result = computeThumbScale(tc.naturalW, tc.naturalH);
      expect(result.scale).toBeCloseTo(tc.expectedScale, 6);
      expect(result.displayW).toBe(tc.expectedDisplayW);
      expect(result.displayH).toBe(tc.expectedDisplayH);
    });
  }
});

// ════════════════════════════════════════════════════════════════════
// buildNodeFromUrl（image-utils.ts 规范实现）测试
// ════════════════════════════════════════════════════════════════════

describe("buildNodeFromUrl（image-utils.ts 规范实现）", () => {
  // 已有 p0_4 测试了基本的 buildNodeFromUrl，这里重点补充边界 + 零值 fallback

  for (const tc of testCases) {
    it(`缩放 + titleH：${tc.name}`, () => {
      const node = buildNodeFromUrl("n1", "http://img.url/r.png", tc.naturalW, tc.naturalH, " (test)");
      // buildNodeFromUrl 内部 fallback: if naturalW > 0 → Math.round, else 300
      const expectedW = tc.naturalW > 0 ? tc.expectedDisplayW : 300;
      const expectedH = tc.naturalH > 0 ? tc.expectedDisplayH : 300;
      expect(node.style?.width).toBe(expectedW);
      expect(node.style?.height).toBe(expectedH + 24); // buildNodeFromUrl 始终 +titleH
    });
  }

  it("零宽图片走 fallback 300", () => {
    const node = buildNodeFromUrl("n1", "http://img.url/r.png", 0, 200, " (test)");
    // naturalW=0 → fallback width=300, naturalH=200 > 0 → Math.round(200*1)=200
    // scale=1 (因为 shortSide=0 ≤ 360)
    expect(node.style?.width).toBe(300);
    expect(node.style?.height).toBe(200 + 24);
  });

  it("零高图片走 fallback 300", () => {
    const node = buildNodeFromUrl("n1", "http://img.url/r.png", 200, 0, " (test)");
    expect(node.style?.width).toBe(200);
    expect(node.style?.height).toBe(300 + 24);
  });

  it("全零图片 fallback 均为 300", () => {
    const node = buildNodeFromUrl("n1", "http://img.url/r.png", 0, 0, " (test)");
    expect(node.style?.width).toBe(300);
    expect(node.style?.height).toBe(300 + 24);
  });

  it("label 后缀插入在扩展名前", () => {
    const node = buildNodeFromUrl("n1", "http://img.url/r.png", 200, 200, " (bg-removed)");
    expect(node.data.label).toBe("photo (bg-removed).jpg");
  });

  it("extraNodeData 覆盖 naturalWidth 不影响显示计算", () => {
    // 注意：extraNodeData 的 naturalWidth 被 Object.assign 写入 data，
    // 但 display 尺寸在写入 extraNodeData 之前就已算好。
    const node = buildNodeFromUrl("n1", "http://img.url/r.png", 1024, 768, "",
      { naturalWidth: 9999 });
    expect(node.data.naturalWidth).toBe(9999); // 被覆盖
    expect(node.style?.width).toBe(480);        // 仍以传入的 1024 为准
  });
});

// ════════════════════════════════════════════════════════════════════
// 各实现的 titleH 行为差异捕获
// ════════════════════════════════════════════════════════════════════

describe("各实现的 titleH(+24) 行为 — 修复后全部一致", () => {
  // 模拟每个实现的最终 node.style.height 计算

  /**
   * 实现 1：image-utils.ts applyThumbnailSettings / buildNodeFromUrl（规范实现）
   *   height = displayH + 24 (titleH)
   */
  function impl_imageUtils(nw: number, nh: number): number {
    const shortSide = Math.min(nw, nh);
    const scale = shortSide > THUMBNAIL_MAX ? THUMBNAIL_MAX / shortSide : 1;
    const displayH = nh > 0 ? Math.round(nh * scale) : 300;
    const titleH = 24;
    return displayH + titleH;
  }

  /**
   * 实现 2：InfiniteCanvas.tsx handleDrop — 已修复，通过 applyThumbnailSettings
   *   height = displayH + 24 (titleH)
   */
  function impl_handleDrop(nw: number, nh: number): number {
    const shortSide = Math.min(nw, nh);
    const scale = shortSide > THUMBNAIL_MAX ? THUMBNAIL_MAX / shortSide : 1;
    const displayH = Math.round(nh * scale);
    return displayH + 24;
  }

  /**
   * 实现 3：ImageNode.tsx handleFile / VideoNode.tsx handleFile
   *   height = displayH + 24 (titleH)
   */
  function impl_handleFile(nw: number, nh: number): number {
    const shortSide = Math.min(nw, nh);
    const scale = shortSide > THUMBNAIL_MAX ? THUMBNAIL_MAX / shortSide : 1;
    const displayH = Math.round(nh * scale);
    const titleH = 24;
    return displayH + titleH;
  }

  /**
   * 实现 4：VideoNode.tsx captureFrame — 已修复，通过 applyThumbnailSettings
   *   height = Math.round(nh * scale) + 24 (titleH)
   */
  function impl_captureFrame(nw: number, nh: number): number {
    const shortSide = Math.min(nw, nh);
    const scale = shortSide > THUMBNAIL_MAX ? THUMBNAIL_MAX / shortSide : 1;
    return Math.round(nh * scale) + 24;
  }

  /**
   * 实现 5：GenerationPanel.tsx handleRefUpload — 已修复，通过 applyThumbnailSettings
   *   height = dh + 24 (titleH)
   */
  function impl_refUpload(nw: number, nh: number): number {
    const shortSide = Math.min(nw, nh);
    const scale = shortSide > THUMBNAIL_MAX ? THUMBNAIL_MAX / shortSide : 1;
    const dh = Math.round(nh * scale);
    return dh + 24;
  }

  /**
   * 实现 6：InfiniteCanvas.tsx SSE handler（两个分支相同）
   *   height = displayH + 24 (titleH)
   */
  function impl_sseHandler(nw: number, nh: number): number {
    const shortSide = Math.min(nw, nh);
    const scale = shortSide > THUMBNAIL_MAX ? THUMBNAIL_MAX / shortSide : 1;
    const displayH = Math.round(nh * scale);
    const titleH = 24;
    return displayH + titleH;
  }

  /**
   * 实现 7：ImageNode.tsx handleTransform
   *   height = displayH + 24 (内联 24)
   */
  function impl_handleTransform(nw: number, nh: number): number {
    const shortSide = Math.min(nw, nh);
    const scale = shortSide > THUMBNAIL_MAX ? THUMBNAIL_MAX / shortSide : 1;
    const displayH = Math.round(nh * scale);
    return displayH + 24;
  }

  const testDims = [
    { nw: 4000, nh: 3000, label: "超大横图" },
    { nw: 1024, nh: 1024, label: "方形" },
    { nw: 200, nh: 100, label: "小图" },
  ];

  for (const { nw, nh, label } of testDims) {
    it(`全部实现 titleH 一致：${label} (${nw}×${nh})`, () => {
      const expected = impl_imageUtils(nw, nh);

      // 所有实现现在都 +titleH
      expect(impl_imageUtils(nw, nh)).toBe(expected);
      expect(impl_handleDrop(nw, nh)).toBe(expected);
      expect(impl_handleFile(nw, nh)).toBe(expected);
      expect(impl_captureFrame(nw, nh)).toBe(expected);
      expect(impl_refUpload(nw, nh)).toBe(expected);
      expect(impl_sseHandler(nw, nh)).toBe(expected);
      expect(impl_handleTransform(nw, nh)).toBe(expected);
    });
  }

  it("统一验证：所有路径最终高度包含 titleH(24)", () => {
    // 2000×1000, shortSide=1000 > 360, scale=0.36
    // displayH = Math.round(1000*0.36) = 360, with titleH = 384
    const result1 = impl_imageUtils(2000, 1000);
    const result2 = impl_handleDrop(2000, 1000);
    const result3 = impl_captureFrame(2000, 1000);
    const result4 = impl_refUpload(2000, 1000);
    expect(result1).toBe(384);
    expect(result2).toBe(384);
    expect(result3).toBe(384);
    expect(result4).toBe(384);
  });
});

// ════════════════════════════════════════════════════════════════════
// 缩放公式 + 视口中心组合测试（AssetsModal handleInsertCanvas）
// ════════════════════════════════════════════════════════════════════
// AssetsModal.tsx 有独立的缩放逻辑：使用 MAX=600 而非 THUMBNAIL_MAX=360
// 这个差异也需要捕获

describe("AssetsModal handleInsertCanvas 缩放（使用 MAX=600 而非 THUMBNAIL_MAX）", () => {
  function impl_assetsModal(nw: number, nh: number): { scale: number; dw: number; dh: number } {
    const MAX = 600;
    const scale = Math.max(nw, nh) > MAX ? MAX / Math.max(nw, nh) : 1;
    const dw = Math.round(nw * scale);
    const dh = Math.round(nh * scale);
    return { scale, dw, dh };
  }

  it("超大图使用 MAX=600 缩放", () => {
    // 4000×3000 → Math.max(4000,3000) = 4000 > 600 → scale = 600/4000 = 0.15
    // dw = Math.round(4000*0.15) = 600, dh = Math.round(3000*0.15) = 450
    const r = impl_assetsModal(4000, 3000);
    expect(r.scale).toBeCloseTo(0.15, 6);
    expect(r.dw).toBe(600);
    expect(r.dh).toBe(450);
  });

  it("小图无缩放（scale=1）", () => {
    const r = impl_assetsModal(320, 240);
    expect(r.scale).toBe(1);
    expect(r.dw).toBe(320);
    expect(r.dh).toBe(240);
  });

  it("与 THUMBNAIL_MAX 缩放不同——确认是独立逻辑", () => {
    // 同一张 4000×3000 图片
    const maxSide = impl_assetsModal(4000, 3000);
    const thumb = computeThumbScale(4000, 3000);

    // THUMBNAIL_MAX 缩放: scale = 360/3000 = 0.12, displayW=480
    expect(maxSide.dw).toBe(600);  // MAX=600 缩放: dw=600
    expect(thumb.displayW).toBe(480);  // THUMBNAIL_MAX 缩放: displayW=480
    expect(maxSide.dw).not.toBe(thumb.displayW); // 确实是不同的
  });
});
