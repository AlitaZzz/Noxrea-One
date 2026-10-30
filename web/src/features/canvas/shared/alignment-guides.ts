/**
 * 对齐辅助线的共享类型与按值比较。
 *
 * 辅助线是拖动期的瞬态数据：吸附引擎生成，`preview-guides` 按值短路后
 * 只驱动 `AlignmentGuides` 渲染。类型放在 shared 层，避免引擎与渲染层
 * 通过 hooks 目录互相依赖（specs/canvas-snap-alignment.md 技术影响 1）。
 */
export interface AlignmentGuide {
  type: "horizontal" | "vertical";
  /** 对齐线在画布坐标中的位置（垂直线=X，水平线=Y） */
  position: number;
  /** 垂直线段在 Y 轴的起点 */
  start: number;
  /** 垂直线段在 Y 轴的终点 */
  end: number;
}

/**
 * 辅助线列表按值相等（同序；同 type/position/start/end）。
 * 状态更新前用它判断是否真的有变化：拖动位置帧大多没有对齐参考，
 * 或沿同一条参考线滑动，此时不应提交新数组、重渲染辅助线层。
 */
export function sameAlignmentGuides(a: AlignmentGuide[], b: AlignmentGuide[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x.type !== y.type || x.position !== y.position || x.start !== y.start || x.end !== y.end) {
      return false;
    }
  }
  return true;
}
