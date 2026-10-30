/**
 * 画布通用几何类型与浮点比较。
 *
 * 容差用于世界坐标下的浮点比较（位移一致性、对齐判定、线段合并）：同一段
 * 几何量经不同算法反推会产生末位舍入差异（实测 ~1e-13），严格相等会把等价
 * 结果误判为不同。容差需远大于浮点噪声、远小于任何可感知位移。
 * 该容差只用于等价判定，不用于阈值比较（如框选激活距离、命中边界）：
 * 阈值需要明确的区间语义，容差会把边界附近明确小于/大于的输入吞进模糊区间。
 */

/** 二维值：位置或位移，数值语义由持有它的字段决定 */
export interface Point {
  x: number;
  y: number;
}

/** 轴对齐矩形；坐标系（flow / 屏幕）由持有它的字段决定 */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 世界坐标浮点比较容差 */
export const GEOMETRY_EPSILON = 1e-6;

/** 两个位置/位移在容差内相同（逐分量比较） */
export function samePoint(a: Point, b: Point): boolean {
  return (
    Math.abs(a.x - b.x) <= GEOMETRY_EPSILON && Math.abs(a.y - b.y) <= GEOMETRY_EPSILON
  );
}
