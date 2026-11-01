/**
 * 管道流光的分层参数（全库唯一实现）。
 *
 * 流光形态为「沿路径推进的水滴状线段」：连线本身像管道，流光是管道里向前推进的
 * 流体，前端粗、向后逐渐收细变淡。用 stroke-dasharray 画出断续线段，对
 * stroke-dashoffset 做动画让线段流动；收细的拖尾由多层「粗细 / 长度」递变的线段
 * 末端对齐叠加而成。
 *
 * 长度一律按「路径长度的比例」表达：SVG 预览传 100（等价原来的 `pathLength={100}`
 * 归一化），画布流光层传实际弧长，两端得到同一视觉
 * （specs/canvas-flow-layer.md 规则 2）。
 */

// ── 流光动画可调参数 ──
// 调效果只动这一块：
//   颜色 → EDGE_FLOW_COLOR（lib/constants）
//   快慢 → FLOW_DURATION_S（秒，流光从起点流到终点的时间，越小越快；与段数无关）
//   疏密 → FLOW_SEGMENT_COUNT（整条线上同时流动的流光段数量）
//   长短 → FLOW_SEGMENT_FILL（0~1，头部段占一格的比例，越大流光越长、间隔越小）
//   拖尾 → FLOW_TAPER_STRETCH（拖尾相对头部的拉长倍数，1 = 无拖尾、前后等粗）
//   收细 → FLOW_TAPER_RATIO（0~1，尾端线宽相对头部的比例，越小尾巴越尖）
//   粗细 → FLOW_WIDTH（头部线宽，需略大于连线本身，否则会被连线淹没）
// 只在模块内使用：调参直接改这里的值，不对外导出（导出即无人引用的公共 API）。
const FLOW_DURATION_S = 3.2;
const FLOW_SEGMENT_COUNT = 2;
const FLOW_SEGMENT_FILL = 0.26;
const FLOW_TAPER_STRETCH = 2.1;
const FLOW_TAPER_RATIO = 0.15;
const FLOW_WIDTH = 4;

// ── 流光几何细节（通常无需改动）──
// 显式标注 number：否则会被推导成字面量，下方除零保护判断会被 TS 判为永假
const TAPER_LAYERS: number = 6; // 拖尾的渐变层数，越多越平滑（代价是每帧多一次描边）
const TAIL_FADE = 0.4; // 尾端相对头部的不透明度衰减，越大尾巴越淡

/** 一段流光 + 一段空白的推进时长（毫秒）：所有边共用同一相位节奏 */
export const FLOW_CYCLE_DURATION_MS = (FLOW_DURATION_S * 1000) / FLOW_SEGMENT_COUNT;

/** 一层流光线段：长度单位与传入的路径长度一致 */
export interface FlowLayer {
  /** 线段长度 */
  dash: number;
  /** 线段之间的空白 */
  gap: number;
  /** 周期起点的 dashoffset */
  offsetFrom: number;
  /** 每周期位移（负 = 源 → 目标） */
  drift: number;
  width: number;
  opacity: number;
}

export interface FlowPattern {
  /** 一个周期（一段流光 + 一段空白）的长度 */
  cycle: number;
  /** 绘制顺序：细长的尾层在前、粗短的头层在后（头层压在最上） */
  layers: FlowLayer[];
}

/**
 * 按路径长度生成流光分层。
 *
 * `pathLength = 100` 时与迁移前 `FlowLines` 的 SVG 参数完全一致：
 * cycle = 50、headLen = 13、tailLen = 27.3、每层 dash 由 13 递增到 27.3、
 * 宽度由 4 收细到 0.6、不透明度由 1 衰减到 0.6。
 */
export function buildFlowPattern(length: number): FlowPattern {
  const cycle = length / FLOW_SEGMENT_COUNT;
  if (!(cycle > 0)) return { cycle: 0, layers: [] };
  const headLen = cycle * FLOW_SEGMENT_FILL;
  // 拖尾拉长到 TAPER_STRETCH 倍，上限留 8% 间隙，避免拖尾与下一段首尾相连
  const tailLen = Math.min(headLen * FLOW_TAPER_STRETCH, cycle * 0.92);
  // dashoffset 递减 → 图案沿路径向终点推进（源 → 目标）
  const drift = -cycle;

  const layers = Array.from({ length: TAPER_LAYERS }, (_, i) => {
    const t = TAPER_LAYERS === 1 ? 0 : i / (TAPER_LAYERS - 1); // 0 = 头部，1 = 尾端
    const dash = headLen + (tailLen - headLen) * t;
    return {
      dash,
      gap: cycle - dash,
      // dash 段占据 [tailLen - dash, tailLen]，末端统一对齐到头部前端
      offsetFrom: dash - tailLen,
      drift,
      width: FLOW_WIDTH * (1 - (1 - FLOW_TAPER_RATIO) * t),
      opacity: 1 - TAIL_FADE * t,
    };
  });
  return { cycle, layers: layers.reverse() };
}
