import { describe, expect, it } from "vitest";

import {
  resolveSnap,
  type SnapBounds,
  type SnapFrame,
  type SnapSessionState,
  type SnapTarget,
} from "@/features/canvas/shared/snap-engine";
import { LAYOUT_GAP } from "@/lib/constants";

const box = (x: number, y: number, width = 100, height = 100): SnapBounds => ({
  x,
  y,
  width,
  height,
});

const target = (
  id: string,
  x: number,
  y: number,
  order = 0,
  width = 100,
  height = 100,
): SnapTarget => ({ id, order, bounds: box(x, y, width, height) });

const frame = (overrides: Partial<SnapFrame> = {}): SnapFrame => ({
  subject: box(0, 0),
  targets: [],
  zoom: 1,
  // 对齐开启、网格关闭（步长 0）；总开关关闭的用例单独覆盖
  settings: { enabled: true, gridSize: 0 },
  modifiers: { bypass: false, lockAxis: null },
  state: { x: null, y: null },
  ...overrides,
});

const resolve = (overrides: Partial<SnapFrame> = {}) => resolveSnap(frame(overrides));

describe("resolveSnap", () => {
  it("进入阈值按屏幕像素除以缩放换算", () => {
    const targets = [target("t", 200, 0)];

    // zoom 1：进入阈值 5，恰好等于阈值（≤）仍吸附
    expect(resolve({ subject: box(96, 0), targets }).offset.x).toBeCloseTo(4);
    expect(resolve({ subject: box(95, 0), targets }).offset.x).toBeCloseTo(5);
    expect(resolve({ subject: box(94.9, 0), targets }).offset.x).toBe(0);

    // zoom 2：进入阈值 2.5
    expect(resolve({ subject: box(97.6, 0), targets, zoom: 2 }).offset.x).toBeCloseTo(2.4);
    expect(resolve({ subject: box(97.4, 0), targets, zoom: 2 }).offset.x).toBe(0);

    // zoom 0.5（验收 1 的字面场景）：进入阈值 10px
    expect(resolve({ subject: box(95, 0), targets, zoom: 0.5 }).offset.x).toBeCloseTo(5);
    expect(resolve({ subject: box(89, 0), targets, zoom: 0.5 }).offset.x).toBe(0);
  });

  it("每轴锁定保持 8px，超出后释放并需回到 5px 内重新进入", () => {
    const targets = [target("t", 200, 300)];
    let state: SnapSessionState = { x: null, y: null };
    const step = (x: number) => {
      const result = resolveSnap(frame({ subject: box(x, 0), targets, state }));
      state = result.state;
      return result;
    };

    expect(step(96).offset.x).toBeCloseTo(4);
    expect(state.x).not.toBeNull();

    // 偏差 -8px：仍在保持阈值内，即使已超出进入阈值
    expect(step(108).offset.x).toBeCloseTo(-8);
    expect(state.x).not.toBeNull();

    // 偏差 -8.5px：释放，且超过进入阈值 → 不吸附
    expect(step(108.5).offset.x).toBe(0);
    expect(state.x).toBeNull();

    // 6px 仍不重新进入，5px 时重新锁定
    expect(step(106).offset.x).toBe(0);
    expect(state.x).toBeNull();
    expect(step(105).offset.x).toBeCloseTo(-5);
    expect(state.x).not.toBeNull();
  });

  it("锁定目标消失时清除锁定并按进入阈值重新选择", () => {
    const targets = [target("t", 200, 300)];
    const first = resolve({ subject: box(96, 0), targets });
    expect(first.state.x?.targetId).toBe("t");

    const missing = resolveSnap(
      frame({ subject: box(96, 0), targets: [], state: first.state }),
    );
    expect(missing.offset.x).toBe(0);
    expect(missing.state.x).toBeNull();
  });

  it("锁定超出保持阈值时按进入阈值重选，可接管另一关系", () => {
    const targets = [target("a", 200, 300), target("b", 212, 500)];
    const first = resolve({ subject: box(96, 0), targets });
    expect(first.state.x?.targetId).toBe("a");

    // 主体右边缘 209：与 a 左边缘差 -9（超出保持阈值 8）；与 b 左边缘差 3（进入阈值内）
    const next = resolveSnap(frame({ subject: box(109, 0), targets, state: first.state }));
    expect(next.offset.x).toBeCloseTo(3);
    expect(next.state.x).toMatchObject({
      targetId: "b",
      subjectAnchor: "end",
      targetAnchor: "start",
      isGap: false,
    });
  });

  it("关系排序：|offset| → 同锚点 → 目标顺序 → 锚点顺序", () => {
    // 同偏移时同锚点优先于目标顺序：t1 异锚点，t2 同锚点且 order 更大
    const cross = target("cross", 100, 0, 0);
    const same = target("same", 0, 0, 1);
    expect(resolve({ subject: box(0, 0), targets: [cross, same] }).state.x).toMatchObject({
      targetId: "same",
      subjectAnchor: "start",
      targetAnchor: "start",
      isGap: false,
    });

    // 同锚点、同偏移时按目标顺序
    const first = target("first", 0, 0, 0);
    const second = target("second", 0, 0, 1);
    expect(resolve({ subject: box(0, 0), targets: [first, second] }).state.x?.targetId).toBe(
      "first",
    );

    // 锚点顺序 start → center → end
    expect(resolve({ subject: box(0, 0), targets: [first] }).state.x).toMatchObject({
      subjectAnchor: "start",
      targetAnchor: "start",
    });
  });

  it("间距关系只吸附并保持 LAYOUT_GAP，不产生辅助线", () => {
    const targets = [target("t", 300, 300)];
    // 主体右边缘 236，目标左边缘 300：目标左边缘 - LAYOUT_GAP = 240 → 偏移 4
    const subject = box(300 - LAYOUT_GAP - 4 - 100, 0);
    const result = resolve({ subject, targets });

    expect(result.offset.x).toBeCloseTo(4);
    expect(result.state.x).toMatchObject({ targetId: "t", isGap: true });
    expect(result.guides).toEqual([]);
  });

  it("辅助线只画当前偏移下恰好成立的关系", () => {
    // t1 被吸附（偏移 4）；t2 距主体 7px，仅在阈值邻近范围内，未被吸附
    const targets = [target("t1", 200, 300), target("t2", 203, 500)];
    const result = resolve({ subject: box(96, 0), targets });

    expect(result.offset.x).toBeCloseTo(4);
    expect(result.guides).toEqual([
      { type: "vertical", position: 200, start: 100, end: 300 },
    ]);
  });

  it("辅助线跨度：相离取间隙、重叠取并集、中心对中心连中心", () => {
    const disjoint = resolve({
      subject: box(100, 0),
      targets: [target("t", 200, 200)],
    });
    expect(disjoint.guides).toEqual([
      { type: "vertical", position: 200, start: 100, end: 200 },
    ]);

    // 跨轴重叠且无锚点重合（避免该轴也产生对齐），跨度取两盒并集
    const overlap = resolve({
      subject: box(100, 0),
      targets: [target("t", 200, -20, 0, 100, 100)],
    });
    expect(overlap.guides).toEqual([
      { type: "vertical", position: 200, start: -20, end: 100 },
    ]);

    const center = resolve({
      subject: box(0, 0),
      targets: [target("t", 25, 25, 0, 50, 50)],
    });
    expect(center.guides).toEqual([
      { type: "vertical", position: 50, start: 50, end: 50 },
      { type: "horizontal", position: 50, start: 50, end: 50 },
    ]);
  });

  it("同轴同坐标且跨度重叠的辅助线合并为并集", () => {
    const result = resolve({
      subject: box(0, 0),
      targets: [target("t1", 100, 300), target("t2", 100, 350)],
    });
    expect(result.guides).toEqual([
      { type: "vertical", position: 100, start: 100, end: 350 },
    ]);
  });

  it("同轴同坐标但跨度不相交的辅助线保留为多条", () => {
    // 上下两个目标与主体右边缘同一 X，跨度分别为负半轴与正半轴，互不相交
    const result = resolve({
      subject: box(0, 0),
      targets: [target("above", 100, -300), target("below", 100, 300)],
    });

    expect(result.offset).toEqual({ x: 0, y: 0 });
    expect(result.guides).toEqual([
      { type: "vertical", position: 100, start: -200, end: 0 },
      { type: "vertical", position: 100, start: 100, end: 300 },
    ]);
  });

  it("同轴同坐标且首尾相接的辅助线按重叠合并", () => {
    // 两个目标与主体中心同 x：中心连线分别为 [-70,50] 与 [50,130]，在主体中心 50 相接
    const result = resolve({
      subject: box(0, 0),
      targets: [target("above", 30, -90, 0, 40, 40), target("below", 30, 110, 0, 40, 40)],
    });

    expect(result.guides).toEqual([
      { type: "vertical", position: 50, start: -70, end: 130 },
    ]);
  });

  it("网格只作用于无对齐的轴，并受屏幕步长门槛限制", () => {
    const gridOn = { enabled: true, gridSize: 20 };

    // 无目标：两轴按并集左上角取整
    expect(resolve({ subject: box(10, 10), settings: gridOn }).offset).toEqual({
      x: 10,
      y: 10,
    });
    // 已对齐的轴不再取整
    const aligned = resolve({
      subject: box(10, 10),
      targets: [target("t", 10, 300)],
      settings: gridOn,
    });
    expect(aligned.offset).toEqual({ x: 0, y: 10 });
    expect(aligned.state.x).not.toBeNull();
    expect(aligned.state.y).toBeNull();
    expect(aligned.guides.every((guide) => guide.type === "vertical")).toBe(true);

    // 20 × 0.4 = 8px 达到门槛；20 × 0.3 = 6px 关闭
    expect(resolve({ subject: box(10, 10), settings: gridOn, zoom: 0.4 }).offset).toEqual({
      x: 10,
      y: 10,
    });
    expect(resolve({ subject: box(10, 10), settings: gridOn, zoom: 0.3 }).offset).toEqual({
      x: 0,
      y: 0,
    });

    // 已在网格上的原点不产生位移
    expect(resolve({ subject: box(20, 40), settings: gridOn }).offset).toEqual({
      x: 0,
      y: 0,
    });
    // 轴限只允许主导轴取整
    expect(
      resolve({
        subject: box(10, 10),
        settings: gridOn,
        modifiers: { bypass: false, lockAxis: "x" },
      }).offset,
    ).toEqual({ x: 10, y: 0 });
  });

  it("旁路关闭对齐与网格，也不产生辅助线", () => {
    const result = resolve({
      subject: box(96, 0),
      targets: [target("t", 200, 0)],
      settings: { enabled: true, gridSize: 20 },
      modifiers: { bypass: true, lockAxis: null },
    });
    expect(result.offset).toEqual({ x: 0, y: 0 });
    expect(result.state).toEqual({ x: null, y: null });
    expect(result.guides).toEqual([]);
  });

  it("总开关关闭时对齐、网格与辅助线全部不生效，锁定状态清空", () => {
    const result = resolve({
      subject: box(96, 10),
      targets: [target("t", 200, 0)],
      settings: { enabled: false, gridSize: 20 },
      state: {
        x: { targetId: "t", subjectAnchor: "start", targetAnchor: "start", isGap: false },
        y: null,
      },
    });
    expect(result.offset).toEqual({ x: 0, y: 0 });
    expect(result.state).toEqual({ x: null, y: null });
    expect(result.guides).toEqual([]);
  });

  it("无效缩放或主体尺寸不吸附", () => {
    const targets = [target("t", 200, 0)];
    for (const zoom of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = resolve({ subject: box(96, 0), targets, zoom });
      expect(result.offset).toEqual({ x: 0, y: 0 });
      expect(result.state).toEqual({ x: null, y: null });
      expect(result.guides).toEqual([]);
    }

    expect(resolve({ subject: box(96, 0, 0, 100), targets }).offset).toEqual({
      x: 0,
      y: 0,
    });
  });
});
