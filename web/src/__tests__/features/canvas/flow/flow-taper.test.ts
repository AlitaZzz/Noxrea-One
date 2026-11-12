import { describe, expect, it } from "vitest";

import { buildFlowPattern, FLOW_CYCLE_DURATION_MS } from "@/features/canvas/flow/flow-taper";

describe("buildFlowPattern", () => {
  it("pathLength=100 时按当前流形参数生成分层", () => {
    const { cycle, layers } = buildFlowPattern(100);

    expect(cycle).toBe(50);
    expect(layers).toHaveLength(6);

    // 绘制顺序：细长的尾层在前、粗短的头层在后
    const tail = layers[0];
    expect(tail.dash).toBeCloseTo(27.3);
    expect(tail.gap).toBeCloseTo(22.7);
    expect(tail.offsetFrom).toBeCloseTo(0);
    expect(tail.width).toBeCloseTo(0.3);
    expect(tail.opacity).toBeCloseTo(0.6);
    expect(tail.drift).toBe(-50);

    const head = layers[5];
    expect(head.dash).toBeCloseTo(13);
    expect(head.gap).toBeCloseTo(37);
    expect(head.offsetFrom).toBeCloseTo(-14.3);
    expect(head.width).toBe(2);
    expect(head.opacity).toBe(1);
    expect(head.drift).toBe(-50);
  });

  it("按路径长度等比缩放：画布弧长与 100 归一化得到同一形态", () => {
    const normalized = buildFlowPattern(100);
    const scaled = buildFlowPattern(250);

    expect(scaled.cycle / normalized.cycle).toBeCloseTo(2.5);
    normalized.layers.forEach((layer, i) => {
      expect(scaled.layers[i].dash / layer.dash).toBeCloseTo(2.5);
      expect(scaled.layers[i].gap / layer.gap).toBeCloseTo(2.5);
      expect(scaled.layers[i].drift / layer.drift).toBeCloseTo(2.5);
      // 线宽与不透明度是屏幕量，不随路径长度缩放
      expect(scaled.layers[i].width).toBeCloseTo(layer.width);
      expect(scaled.layers[i].opacity).toBeCloseTo(layer.opacity);
    });
  });

  it("零 / 负 / 非有限长度返回空分层，不除零", () => {
    expect(buildFlowPattern(0)).toEqual({ cycle: 0, layers: [] });
    expect(buildFlowPattern(-5)).toEqual({ cycle: 0, layers: [] });
    expect(buildFlowPattern(Number.NaN)).toEqual({ cycle: 0, layers: [] });
  });

  it("周期时长 = 流光全程时长 / 段数", () => {
    expect(FLOW_CYCLE_DURATION_MS).toBe(1600);
  });
});
