/**
 * 派生节点「宫格找空位」落位算法测试。
 *
 * 核心语义：
 *   - 空画布 → 基准槽位 = 源节点右边缘 + DERIVED_BASE_GAP_X；
 *   - 槽位被任何节点占用（含同批已落位节点、用户手动摆放的）→ 行优先顺延；
 *   - 返回位置与现有节点永不重叠；
 *   - 批量派生（findDerivedBatchOrigin）整批包围盒无碰撞才落，被占则整体平移。
 */

import { describe, expect, it } from "vitest";

import { NODE_TITLE_HEIGHT } from "@/lib/constants";
import {
  computeDerivedGrid,
  DERIVED_BASE_GAP_X,
  DERIVED_SLOT_COLS,
  findDerivedBatchOrigin,
  findDerivedSlot,
  type LayoutNode,
} from "@/lib/utils/image-utils";

/** 构造测试节点（左上角 + 显示尺寸） */
function nodeAt(x: number, y: number, w: number, h: number): LayoutNode {
  return { position: { x, y }, style: { width: w, height: h } };
}

/** 源节点：位于 (100, 200)，600×400 */
const SOURCE = nodeAt(100, 200, 600, 400);
/** 派生基准点：源右边缘 + 60 */
const BASE = { x: 100 + 600 + DERIVED_BASE_GAP_X, y: 200 };

describe("findDerivedSlot（单产物宫格找空位）", () => {
  it("空画布：落在基准槽位 (0,0)", () => {
    const pos = findDerivedSlot([], SOURCE, { width: 300, height: 200 });
    expect(pos).toEqual(BASE);
  });

  it("源节点缺失：以原点为基准", () => {
    const pos = findDerivedSlot([], undefined, { width: 300, height: 200 });
    expect(pos.x).toBe(600 + DERIVED_BASE_GAP_X);
    expect(pos.y).toBe(0);
  });

  it("槽位 (0,0) 被占用：顺延到 (1,0)", () => {
    const occupied = nodeAt(BASE.x, BASE.y, 300, 200);
    const pos = findDerivedSlot([occupied], SOURCE, { width: 300, height: 200 });
    const step = 300 + 12; // DERIVED_CELL_GAP
    expect(pos).toEqual({ x: BASE.x + step, y: BASE.y });
  });

  it("首行槽位全满：换行到 (0,1)", () => {
    const stepX = 300 + 12;
    const stepY = 200 + 12;
    const row1 = Array.from({ length: DERIVED_SLOT_COLS }, (_, i) =>
      nodeAt(BASE.x + i * stepX, BASE.y, 300, 200),
    );
    const pos = findDerivedSlot(row1, SOURCE, { width: 300, height: 200 });
    expect(pos).toEqual({ x: BASE.x, y: BASE.y + stepY });
  });

  it("用户手动摆放的节点占据目标区：同样跳过", () => {
    // 与派生产物无关的节点被用户拖到基准槽位上
    const manual = nodeAt(BASE.x - 50, BASE.y - 50, 500, 500);
    const pos = findDerivedSlot([manual], SOURCE, { width: 300, height: 200 });
    expect(pos.x).toBeGreaterThan(BASE.x);
    // 落点不与手动节点重叠
    expect(pos.x).toBeGreaterThanOrEqual(manual.position.x + 500);
  });

  it("不同尺寸产物互不重叠（模拟同源连续派生）", () => {
    const nodes: LayoutNode[] = [];
    const sizeA = { width: 600, height: 478 };
    const sizeB = { width: 200, height: 160 };
    // 第一次派生（大尺寸）
    const p1 = findDerivedSlot(nodes, SOURCE, sizeA);
    nodes.push(nodeAt(p1.x, p1.y, sizeA.width, sizeA.height));
    // 第二次派生（小尺寸）：不得与第一次产物重叠
    const p2 = findDerivedSlot(nodes, SOURCE, sizeB);
    const overlaps =
      p2.x < p1.x + sizeA.width && p2.x + sizeB.width > p1.x &&
      p2.y < p1.y + sizeA.height && p2.y + sizeB.height > p1.y;
    expect(overlaps).toBe(false);
  });

  it("同批多节点传入（模拟上传管道批量落位）：依次填格不重叠", () => {
    const size = { width: 300, height: 200 };
    const batch: LayoutNode[] = [];
    const positions = [];
    for (let i = 0; i < 5; i++) {
      const pos = findDerivedSlot([SOURCE, ...batch], SOURCE, size);
      positions.push(pos);
      batch.push(nodeAt(pos.x, pos.y, size.width, size.height));
    }
    // 任意两产物不重叠
    for (let i = 0; i < positions.length; i++) {
      for (let j = i + 1; j < positions.length; j++) {
        const a = positions[i];
        const b = positions[j];
        const overlaps =
          a.x < b.x + size.width && a.x + size.width > b.x &&
          a.y < b.y + size.height && a.y + size.height > b.y;
        expect(overlaps).toBe(false);
      }
    }
    // 前 3 个填满首行（列数 = DERIVED_SLOT_COLS），第 4 个换行
    expect(positions[DERIVED_SLOT_COLS].y).toBeGreaterThan(positions[0].y);
  });
});

describe("findDerivedBatchOrigin（批量派生整体找空位）", () => {
  const layout = computeDerivedGrid(SOURCE, 400, 300, 3); // 显示 400×300+title
  const COUNT = 6; // 2 行 × 3 列

  it("区域空闲：起点即基准点（不平移）", () => {
    const origin = findDerivedBatchOrigin([], SOURCE, layout, COUNT);
    expect(origin).toEqual({ x: layout.baseX, y: layout.baseY });
  });

  it("整批包围盒不与源节点重叠（基准点在源右侧）", () => {
    const rows = Math.ceil(COUNT / layout.cols);
    const bboxW = layout.cols * layout.stepX - 12;
    const bboxH = rows * layout.stepY - 12;
    expect(layout.baseX).toBeGreaterThanOrEqual(SOURCE.position.x + 600 + DERIVED_BASE_GAP_X);
    expect(bboxW).toBeGreaterThan(0);
    expect(bboxH).toBeGreaterThan(0);
  });

  it("目标区域被上一批占据：整体平移到无碰撞起点", () => {
    // 上一批 2×3 宫格铺在基准区域
    const cellH = layout.displayH + NODE_TITLE_HEIGHT;
    const prev: LayoutNode[] = [];
    for (let i = 0; i < COUNT; i++) {
      const col = i % layout.cols;
      const row = Math.floor(i / layout.cols);
      prev.push(
        nodeAt(
          layout.baseX + col * layout.stepX,
          layout.baseY + row * layout.stepY,
          layout.displayW,
          cellH,
        ),
      );
    }
    const origin = findDerivedBatchOrigin(prev, SOURCE, layout, COUNT);
    // 平移后的整批包围盒不与上一批任何节点重叠
    const rows = Math.ceil(COUNT / layout.cols);
    const bboxW = layout.cols * layout.stepX - 12;
    const bboxH = rows * layout.stepY - 12;
    const overlaps = prev.some((n) =>
      origin.x < n.position.x + layout.displayW &&
      origin.x + bboxW > n.position.x &&
      origin.y < n.position.y + cellH &&
      origin.y + bboxH > n.position.y,
    );
    expect(overlaps).toBe(false);
    // 且不是原基准点（原点已被占）
    expect(origin).not.toEqual({ x: layout.baseX, y: layout.baseY });
  });
});
