import { getBezierPath, Position } from "@xyflow/react";
import { describe, expect, it } from "vitest";

import {
  type BezierCurve,
  computeEdgePath,
  cubicLength,
} from "@/features/canvas/shared/edge-geometry";
import { insetEdgeAnchor } from "@/lib/constants";

const positions = [Position.Left, Position.Right, Position.Top, Position.Bottom];

const coordinateCases = [
  { sourceX: 100, sourceY: 100, targetX: 300, targetY: 100 },
  { sourceX: 100, sourceY: 100, targetX: 40, targetY: 260 },
  { sourceX: 10, sourceY: 400, targetX: 500, targetY: 20 },
  { sourceX: -50, sourceY: -20, targetX: -50, targetY: 300 },
];

/** 高密度折线逼近：验证 32 段近似的误差上限 */
function referenceLength(curve: BezierCurve, samples: number): number {
  const { start, control1, control2, end } = curve;
  let length = 0;
  let prevX = start.x;
  let prevY = start.y;
  for (let i = 1; i <= samples; i++) {
    const t = i / samples;
    const mt = 1 - t;
    const a = mt * mt * mt;
    const b = 3 * mt * mt * t;
    const c = 3 * mt * t * t;
    const d = t * t * t;
    const x = a * start.x + b * control1.x + c * control2.x + d * end.x;
    const y = a * start.y + b * control1.y + c * control2.y + d * end.y;
    length += Math.hypot(x - prevX, y - prevY);
    prevX = x;
    prevY = y;
  }
  return length;
}

describe("computeEdgePath", () => {
  it("路径与标签锚点与 getBezierPath 逐字节一致（全部方位组合）", () => {
    for (const sourcePosition of positions) {
      for (const targetPosition of positions) {
        for (const point of coordinateCases) {
          const geometry = computeEdgePath({ ...point, sourcePosition, targetPosition });
          // 比较对象是「收回轨道宽之后」的端点：SVG 与画布流光层都从这组控制点派生
          const start = insetEdgeAnchor(sourcePosition, point.sourceX, point.sourceY);
          const end = insetEdgeAnchor(targetPosition, point.targetX, point.targetY);
          const [path, labelX, labelY] = getBezierPath({
            sourceX: start.x,
            sourceY: start.y,
            sourcePosition,
            targetX: end.x,
            targetY: end.y,
            targetPosition,
          });
          expect(geometry.path).toBe(path);
          expect(geometry.labelX).toBe(labelX);
          expect(geometry.labelY).toBe(labelY);
          // 控制点是路径字符串的唯一来源：起终点与 C 段都从这里派生
          expect(geometry.curve.start).toEqual(start);
          expect(geometry.curve.end).toEqual(end);
          expect(geometry.path).toBe(
            `M${geometry.curve.start.x},${geometry.curve.start.y} C${geometry.curve.control1.x},${geometry.curve.control1.y} ${geometry.curve.control2.x},${geometry.curve.control2.y} ${geometry.curve.end.x},${geometry.curve.end.y}`,
          );
        }
      }
    }
  });
});

describe("cubicLength", () => {
  it("32 段近似的相对误差 < 0.5%（2000 段参考值）", () => {
    for (const sourcePosition of positions) {
      for (const targetPosition of positions) {
        for (const point of coordinateCases) {
          const { curve, length } = computeEdgePath({ ...point, sourcePosition, targetPosition });
          // computeEdgePath 返回的弧长就是同一曲线的 cubicLength
          expect(cubicLength(curve)).toBe(length);
          const reference = referenceLength(curve, 2000);
          expect(reference).toBeGreaterThan(0);
          expect(Math.abs(length - reference) / reference).toBeLessThan(0.005);
        }
      }
    }
  });
});
