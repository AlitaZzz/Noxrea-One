/**
 * 连线流光的 SVG 版本：只用于渲染在节点之上的预览线
 * （`ConnectionFlowLine`、`PendingConnectionPreview`）。
 *
 * 节点间连线的流光由画布流光层绘制（`features/canvas/flow/`），不再走 SVG/SMIL
 * ——见 specs/canvas-flow-layer.md。流形参数是唯一实现：`buildFlowPattern`，
 * 这里传 100 等价原来的 `pathLength={100}` 归一化。
 */
import { EDGE_FLOW_COLOR } from "@/lib/constants";

import { buildFlowPattern, FLOW_CYCLE_DURATION_MS } from "../flow/flow-taper";

/** 预览路径长度：dasharray 单位是「路径长度的百分比」，与 pathLength=100 一致 */
const PREVIEW_PATH_LENGTH = 100;

export function FlowLines({ path }: { path: string }) {
  const { layers } = buildFlowPattern(PREVIEW_PATH_LENGTH);

  return (
    <g>
      {/* 渐变层：细长的先画、粗短的后画，保证头部压在最上层、不被半透明尾层稀释 */}
      {layers.map((layer, i) => (
        <path
          key={i}
          d={path}
          pathLength={PREVIEW_PATH_LENGTH}
          fill="none"
          stroke={EDGE_FLOW_COLOR}
          strokeWidth={layer.width}
          strokeLinecap="round"
          strokeDasharray={`${layer.dash} ${layer.gap}`}
          opacity={layer.opacity}
        >
          <animate
            attributeName="stroke-dashoffset"
            from={layer.offsetFrom}
            to={layer.offsetFrom + layer.drift}
            dur={`${FLOW_CYCLE_DURATION_MS / 1000}s`}
            repeatCount="indefinite"
          />
        </path>
      ))}
    </g>
  );
}
