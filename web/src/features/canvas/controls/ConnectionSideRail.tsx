/**
 * 节点侧边连接轨道（参考 open-ai-canvas 的 ConnectionSideRail）。
 * 轨道本体就是 React Flow 的 <Handle>：透明、贴节点边缘外侧（宽 RAIL_WIDTH，
 * 高 min(节点高, 80px)），圆点为轨道内子元素，静止于贴节点边缘的偏移位。
 *
 * 交互：起线/落点完全交给 React Flow 的 Handle 机制，此处不捕获锚点；
 * hover 轨道的圆点二维跟随（纯视觉反馈）抽到 use-rail-dot-follow，
 * 与组节点的批量输出轨道（GroupConnectRail，不走 Handle 机制）共用。
 *
 * 成员条带宽度受两个容器钳制取小（同一规则：容器边缘即成员条带外界）：
 * - 所属组（memberRailWidth，口径在 group-bounds）——与组自身轨道命中区分区；
 * - 框选外框（frameRailWidth，口径在 selection-frame）——≥2 非组节点选中时，
 *   最贴框缘成员的条带不得越过框缘，否则盖住外框批量轨道（BatchConnectHandle）
 *   的命中区接管 hover 链，成员轨道连锁亮起（选中节点 zIndex 高于批量轨道）。
 * 宽度经 --rail-width 注入 CSS（基样式 width 为 !important，内联样式无法直接覆盖）。
 */
"use client";

import { Handle, Position, useNodeId } from "@xyflow/react";
import type { CSSProperties } from "react";

import { memberRailWidth } from "@/features/canvas/shared/group-bounds";
import { frameRailWidth } from "@/features/canvas/shared/selection-frame";
import { useCanvasStore } from "@/features/canvas/stores/canvas-store";

import { type RailSide, useRailDotFollow } from "./use-rail-dot-follow";

interface Props {
  side: RailSide;
  type: "source" | "target";
  zIndex?: number;
}

export default function ConnectionSideRail({ side, type, zIndex }: Props) {
  // 宽度全量从 store 现取（含成员与组双方最新位置），不依赖节点快照
  const id = useNodeId();
  const width = useCanvasStore((s) =>
    Math.min(memberRailWidth(s.nodes, id, side), frameRailWidth(s.nodes, id, side))
  );
  const { dotRef, restTransform, onPointerEnter, onPointerMove, onPointerLeave } =
    useRailDotFollow(side, width);

  const style = {
    top: "50%",
    "--rail-width": `${width}px`,
    ...(zIndex != null ? { zIndex } : {}),
  } as CSSProperties;

  return (
    <Handle
      type={type}
      position={side === "left" ? Position.Left : Position.Right}
      className={`connection-rail connection-rail-${side}`}
      style={style}
      onPointerEnter={onPointerEnter}
      onPointerMove={onPointerMove}
      onPointerLeave={onPointerLeave}
    >
      <span ref={dotRef} className="connection-rail-dot" style={{ transform: restTransform }} />
    </Handle>
  );
}
