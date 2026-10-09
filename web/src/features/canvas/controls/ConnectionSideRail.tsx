/**
 * 节点侧边连接轨道（参考 open-ai-canvas 的 ConnectionSideRail）。
 * 轨道本体就是 React Flow 的 <Handle>：透明、贴节点边缘外侧（宽 RAIL_WIDTH，
 * 高 min(节点高, 80px)），圆点为轨道内子元素，静止于贴节点边缘的偏移位。
 *
 * 交互：起线/落点完全交给 React Flow 的 Handle 机制，此处不捕获锚点；
 * hover 轨道的圆点二维跟随（纯视觉反馈）抽到 use-rail-dot-follow，
 * 与组节点的批量输出轨道（GroupConnectRail，不走 Handle 机制）共用。
 *
 * 成员条带宽度受所属组和框选外框两个容器钳制（同一规则：容器边缘即成员条带外界）：
 * - 两个容器统一由 canvas-derived 一次性几何投影计算；
 * - ≥2 非组节点选中时，
 *   最贴框缘成员的条带不得越过框缘，否则盖住外框批量轨道（BatchConnectHandle）
 *   的命中区接管 hover 链，成员轨道连锁亮起（选中节点 zIndex 高于批量轨道）。
 * 宽度经 --rail-width 注入 CSS（基样式 width 为 !important，内联样式无法直接覆盖）。
 */
"use client";

import { Handle, Position, useNodeId } from "@xyflow/react";
import type { CSSProperties } from "react";

import { canvasRailKey, getCanvasDerived } from "@/features/canvas/shared/canvas-derived";
import { useCanvasStore } from "@/features/canvas/stores/canvas-store";
import { RAIL_WIDTH, RAIL_Z_INDEX } from "@/lib/constants";

import { type RailSide, useRailDotFollow } from "./use-rail-dot-follow";

interface Props {
  side: RailSide;
  type: "source" | "target";
}

export default function ConnectionSideRail({ side, type }: Props) {
  // 宽度来自 canvas store 的一次性几何投影；每个轨道只做 Map 读取。
  const id = useNodeId();
  const width = useCanvasStore((s) => {
    const key = canvasRailKey(id, side);
    return key ? (getCanvasDerived(s.nodes, s.edges).railWidths.get(key) ?? RAIL_WIDTH) : RAIL_WIDTH;
  });
  const { dotRef, restTransform, onPointerEnter, onPointerMove, onPointerLeave } =
    useRailDotFollow(side, width);

  const style = {
    top: "50%",
    zIndex: RAIL_Z_INDEX,
    "--rail-width": `${width}px`,
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
