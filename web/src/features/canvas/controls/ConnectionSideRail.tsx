/**
 * 节点侧边连接轨道（参考 open-ai-canvas 的 ConnectionSideRail）。
 * 轨道本体就是 React Flow 的 <Handle>：透明、贴节点边缘外侧（宽 RAIL_WIDTH，
 * 高 min(节点高, RAIL_HEIGHT)），圆点为轨道内子元素，静止于贴节点边缘的偏移位。
 *
 * 交互：起线/落点完全交给 React Flow 的 Handle 机制，此处不捕获锚点；
 * hover 轨道的圆点二维跟随（纯视觉反馈）抽到 use-rail-dot-follow，
 * 与组节点的批量输出轨道（GroupConnectRail，不走 Handle 机制）共用。
 */
"use client";

import { Handle, Position } from "@xyflow/react";

import { type RailSide,useRailDotFollow } from "./use-rail-dot-follow";

interface Props {
  side: RailSide;
  type: "source" | "target";
  zIndex?: number;
}

export default function ConnectionSideRail({ side, type, zIndex }: Props) {
  const { dotRef, restTransform, onPointerEnter, onPointerMove, onPointerLeave } =
    useRailDotFollow(side);

  return (
    <Handle
      type={type}
      position={side === "left" ? Position.Left : Position.Right}
      className={`connection-rail connection-rail-${side}`}
      style={{ top: "50%", ...(zIndex != null ? { zIndex } : {}) }}
      onPointerEnter={onPointerEnter}
      onPointerMove={onPointerMove}
      onPointerLeave={onPointerLeave}
    >
      <span ref={dotRef} className="connection-rail-dot" style={{ transform: restTransform }} />
    </Handle>
  );
}
