import { afterEach, describe, expect, it, vi } from "vitest";

import {
  clearFlowPreview,
  clearFlowPreviews,
  flowEdgeIds,
  getFlowDrawable,
  hasFlowEdges,
  removeFlowEdge,
  setFlowEdge,
  setFlowPreview,
  setFlowPreviewOffset,
  subscribeFlowEdges,
} from "@/features/canvas/flow/flow-registry";
import type { BezierCurve } from "@/features/canvas/shared/edge-geometry";

const curve: BezierCurve = {
  start: { x: 0, y: 0 },
  control1: { x: 50, y: 0 },
  control2: { x: 50, y: 0 },
  end: { x: 100, y: 0 },
};

const otherCurve: BezierCurve = {
  start: { x: 0, y: 0 },
  control1: { x: 80, y: 20 },
  control2: { x: 120, y: 20 },
  end: { x: 200, y: 0 },
};

const ids: string[] = [];

function register(id: string, length = 100): void {
  setFlowEdge(id, { curve, length });
  ids.push(id);
}

afterEach(() => {
  for (const id of ids.splice(0)) removeFlowEdge(id);
  clearFlowPreviews();
});

describe("flow-registry", () => {
  it("登记 / 注销驱动成员变化通知，几何更新不通知", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeFlowEdges(listener);

    expect(hasFlowEdges()).toBe(false);
    register("a");
    expect(listener).toHaveBeenCalledTimes(1);
    expect(hasFlowEdges()).toBe(true);
    expect([...flowEdgeIds()]).toEqual(["a"]);
    expect(getFlowDrawable("a")?.geometry).toEqual({ curve, length: 100 });

    // 同一 id 更新几何：成员集合未变，循环不需要重启
    setFlowEdge("a", { curve: otherCurve, length: 120 });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(getFlowDrawable("a")?.geometry).toEqual({ curve: otherCurve, length: 120 });

    removeFlowEdge("a");
    expect(listener).toHaveBeenCalledTimes(2);
    expect(hasFlowEdges()).toBe(false);

    // 注销幂等：重复注销不重复通知
    removeFlowEdge("a");
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
  });

  it("预览覆盖优先；长度不变时沿用登记分层，长度变化重建", () => {
    register("a");
    const base = getFlowDrawable("a");
    expect(base).toBeDefined();

    // 整段平移：同一弧长，沿用登记分层
    setFlowPreview("a", { curve, length: 100, offset: { x: 10, y: 0 } });
    const translated = getFlowDrawable("a");
    expect(translated?.geometry.offset).toEqual({ x: 10, y: 0 });
    expect(translated?.pattern).toBe(base?.pattern);

    // 端点重算：弧长变化，分层按新长度重建
    setFlowPreview("a", { curve: otherCurve, length: 200 });
    const rebuilt = getFlowDrawable("a");
    expect(rebuilt?.geometry).toEqual({ curve: otherCurve, length: 200 });
    expect(rebuilt?.pattern).not.toBe(base?.pattern);
    expect(rebuilt?.pattern.cycle).toBe(100);

    // 清除覆盖后回落到登记几何
    clearFlowPreview("a");
    expect(getFlowDrawable("a")).toBe(base);
  });

  it("先于登记到达的路径预览在登记时生效，未登记前不参与绘制", () => {
    setFlowPreview("ghost", { curve, length: 100 });
    expect(getFlowDrawable("ghost")).toBeUndefined();
    expect(hasFlowEdges()).toBe(false);
    expect([...flowEdgeIds()]).toEqual([]);

    register("ghost");
    expect(getFlowDrawable("ghost")?.geometry).toEqual({ curve, length: 100 });
  });

  it("先于登记到达的平移覆盖在登记时叠加到登记几何", () => {
    setFlowPreviewOffset("ghost", { x: 10, y: 5 });
    expect(getFlowDrawable("ghost")).toBeUndefined();

    register("ghost");
    const drawable = getFlowDrawable("ghost");
    expect(drawable?.geometry.offset).toEqual({ x: 10, y: 5 });
    expect(drawable?.geometry.curve).toEqual(curve);
    expect(drawable?.geometry.length).toBe(100);
  });

  it("注销时一并清除该边的预览覆盖", () => {
    register("a");
    setFlowPreview("a", { curve, length: 100, offset: { x: 10, y: 0 } });
    expect(getFlowDrawable("a")?.geometry.offset).toEqual({ x: 10, y: 0 });

    removeFlowEdge("a");
    expect(getFlowDrawable("a")).toBeUndefined();

    // 重新登记后不残留旧覆盖
    register("a");
    expect(getFlowDrawable("a")?.geometry.offset).toBeUndefined();
  });
});
