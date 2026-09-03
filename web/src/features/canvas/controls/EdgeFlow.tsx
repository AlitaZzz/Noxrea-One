/**
 * 连线流光（管道流光）相关常量与组件。
 * 选中节点时连线、拖拽连接预览线均复用此处，保证视觉一致。
 *
 * 流光形态为「沿路径推进的水滴状线段」：连线本身像管道，
 * 流光是管道里向前推进的流体，前端粗、向后逐渐收细变淡。
 *
 * 实现：stroke-dasharray 画出断续线段，对 stroke-dashoffset 做动画让线段流动；
 * 收细的拖尾由多层「粗细 / 长度」递变的线段末端对齐叠加而成。
 */
import { getBezierPath } from "@xyflow/react";
import { useId } from "react";

/** 流光（管道里的流体）颜色；管道本体色见 constants.ts 的 EDGE_BASE_COLOR */
export const DOT_COLOR = "#1D9E75";

// ── 流光动画可调参数 ──
// 调效果只动这一块：
//   颜色 → DOT_COLOR
//   快慢 → DURATION（秒，流光从起点流到终点的时间，越小越快；与段数无关）
//   疏密 → SEGMENT_COUNT（整条线上同时流动的流光段数量）
//   长短 → SEGMENT_FILL（0~1，头部段占一格的比例，越大流光越长、间隔越小）
//   拖尾 → TAPER_STRETCH（拖尾相对头部的拉长倍数，1 = 无拖尾、前后等粗）
//   收细 → TAPER_RATIO（0~1，尾端线宽相对头部的比例，越小尾巴越尖）
//   粗细 → FLOW_WIDTH（头部线宽，需略大于连线本身，否则会被连线淹没）
//   方向 → REVERSE（false = 源 → 目标，true = 目标 → 源）
//   发光 → GLOW（是否叠一层模糊光晕）
export const DURATION = 3.2;
export const SEGMENT_COUNT = 2;
export const SEGMENT_FILL = 0.26;
export const TAPER_STRETCH = 2.1;
export const TAPER_RATIO = 0.15;
export const FLOW_WIDTH = 4;
export const REVERSE = false;
export const GLOW = false;

// ── 流光几何细节（通常无需改动）──
// 显式标注 number：否则会被推导成字面量，下方除零保护判断会被 TS 判为永假
const TAPER_LAYERS: number = 6; // 拖尾的渐变层数，越多越平滑（代价是每条连线多一个 path）
const TAIL_FADE = 0.4; // 尾端相对头部的不透明度衰减，越大尾巴越淡
const GLOW_SCALE = 2.2; // 发光层相对头部线宽的倍数
const GLOW_OPACITY = 0.45; // 发光层不透明度
const GLOW_BLUR = 2.2; // 发光层高斯模糊强度

/**
 * 管道流光：SEGMENT_COUNT 段水滴形流光沿路径匀速推进。
 *
 * 用 pathLength 把路径长度归一化为 100，dasharray / dashoffset 因此都用相对
 * 单位——无论实际连线多长，线上都稳定分布同样数量的流光段，且首尾无缝循环。
 */
export function FlowLines({ path, color = DOT_COLOR }: { path: string; color?: string }) {
  const uid = useId();
  const glowId = `${uid}-flow-glow`;

  // 归一化后每「格」的长度 = 一段流光 + 一段空白
  const cycle = 100 / SEGMENT_COUNT;
  // 头部（最粗那层）长度；拖尾拉长到 TAPER_STRETCH 倍，
  // 上限留 8% 间隙，避免拖尾与下一首尾相连
  const headLen = cycle * SEGMENT_FILL;
  const tailLen = Math.min(headLen * TAPER_STRETCH, cycle * 0.92);
  // 走完一格的时间：DURATION 是跑完整条连线的秒数，平摊到每格
  const cycleDuration = DURATION / SEGMENT_COUNT;
  // dashoffset 递减 → 图案沿路径向终点推进（源 → 目标）；递增则反向
  const drift = REVERSE ? cycle : -cycle;

  // 由「粗短」到「细长」逐层叠加：各层末端对齐，越细的层向后延伸越远，
  // 于是前端所有层重叠最粗、越往后覆盖的层越少，收出前粗后细的水滴形。
  const layers = Array.from({ length: TAPER_LAYERS }, (_, i) => {
    const t = TAPER_LAYERS === 1 ? 0 : i / (TAPER_LAYERS - 1); // 0 = 头部，1 = 尾端
    const dash = headLen + (tailLen - headLen) * t;
    return {
      dash,
      // dash 段占据 [tailLen - dash, tailLen]，末端统一对齐到头部前端
      offsetFrom: dash - tailLen,
      width: FLOW_WIDTH * (1 - (1 - TAPER_RATIO) * t),
      opacity: 1 - TAIL_FADE * t,
    };
  });

  return (
    <g>
      {/* 发光层：覆盖含拖尾的整段，模糊出流体在管道里晕开的光；GLOW 关闭时整块不渲染 */}
      {GLOW && (
        <>
          <defs>
            {/* 滤镜区域放大，避免粗线模糊后被裁边 */}
            <filter id={glowId} x="-100%" y="-100%" width="300%" height="300%">
              <feGaussianBlur stdDeviation={GLOW_BLUR} />
            </filter>
          </defs>
          <path
            d={path}
            pathLength={100}
            fill="none"
            stroke={color}
            strokeWidth={FLOW_WIDTH * GLOW_SCALE}
            strokeLinecap="round"
            strokeDasharray={`${tailLen} ${cycle - tailLen}`}
            opacity={GLOW_OPACITY}
            filter={`url(#${glowId})`}
          >
            <animate
              attributeName="stroke-dashoffset"
              from={0}
              to={drift}
              dur={`${cycleDuration}s`}
              repeatCount="indefinite"
            />
          </path>
        </>
      )}

      {/* 渐变层：细长的先画、粗短的后画，保证头部压在最上层、不被半透明尾层稀释 */}
      {[...layers].reverse().map((layer, i) => (
        <path
          key={i}
          d={path}
          pathLength={100}
          fill="none"
          stroke={color}
          strokeWidth={layer.width}
          strokeLinecap="round"
          strokeDasharray={`${layer.dash} ${cycle - layer.dash}`}
          opacity={layer.opacity}
        >
          <animate
            attributeName="stroke-dashoffset"
            from={layer.offsetFrom}
            to={layer.offsetFrom + drift}
            dur={`${cycleDuration}s`}
            repeatCount="indefinite"
          />
        </path>
      ))}
    </g>
  );
}

/** 根据起止坐标计算贝塞尔路径，供流光沿路径运动使用。 */
export function useEdgePath(points: {
  sourceX: number;
  sourceY: number;
  sourcePosition: import("@xyflow/react").Position;
  targetX: number;
  targetY: number;
  targetPosition: import("@xyflow/react").Position;
}) {
  return getBezierPath(points);
}
