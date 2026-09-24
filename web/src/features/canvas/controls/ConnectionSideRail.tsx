/**
 * 节点侧边连接轨道（参考 open-ai-canvas 的 ConnectionSideRail）。
 * 轨道本体就是 React Flow 的 <Handle>：透明、贴节点边缘外侧（宽 RAIL_WIDTH，
 * 高 min(节点高, RAIL_HEIGHT)），圆点为轨道内子元素，静止于贴节点边缘的偏移位。
 *
 * 交互（纯视觉反馈，连线锚点永远是节点边缘垂直正中，见 constants.ts）：
 * - hover 轨道时圆点在 ±RAIL_FOLLOW_LIMIT 屏幕像素内二维跟随鼠标（斜向也跟随），
 *   越靠近轨道中心越放大（最多 1.1×）；离开复位到静止位；
 * - 起线/落点完全交给 React Flow 的 Handle 机制，此处不捕获锚点。
 */
"use client";

import { Handle, Position } from "@xyflow/react";
import { type PointerEvent as ReactPointerEvent, useRef } from "react";

import { getLiveViewport } from "@/features/canvas/stores/canvas-store";
import { RAIL_FOLLOW_LIMIT, RAIL_REST_OFFSET } from "@/lib/constants";

export type RailSide = "left" | "right";

interface Props {
  side: RailSide;
  type: "source" | "target";
  zIndex?: number;
}

export default function ConnectionSideRail({ side, type, zIndex }: Props) {
  const dotRef = useRef<HTMLSpanElement>(null);
  // 静止位：从轨道中心向节点边缘偏移（左轨向右、右轨向左），视觉上贴着节点
  const restTransform = `translate(${side === "left" ? RAIL_REST_OFFSET : -RAIL_REST_OFFSET}px, 0) scale(1)`;

  const resetHandle = () => {
    if (dotRef.current) dotRef.current.style.transform = restTransform;
  };

  // 圆点二维跟随：位移取指针相对轨道中心的屏幕偏移，钳制 ±RAIL_FOLLOW_LIMIT 后
  // 换算为节点本地 px（÷zoom）；越靠近中心放大越明显（1.0–1.1×）
  const updateHandle = (e: ReactPointerEvent<HTMLDivElement>) => {
    const bounds = e.currentTarget.getBoundingClientRect();
    const limit = RAIL_FOLLOW_LIMIT;
    const ox = Math.max(-limit, Math.min(limit, e.clientX - (bounds.left + bounds.width / 2)));
    const oy = Math.max(-limit, Math.min(limit, e.clientY - (bounds.top + bounds.height / 2)));
    const focus = 1 + Math.max(0, 1 - Math.hypot(ox, oy) / limit) * 0.1;
    const inverseZoom = 1 / Math.max(getLiveViewport().zoom || 1, 0.05);
    if (dotRef.current) {
      dotRef.current.style.transform = `translate(${ox * inverseZoom}px, ${oy * inverseZoom}px) scale(${focus})`;
    }
  };

  return (
    <Handle
      type={type}
      position={side === "left" ? Position.Left : Position.Right}
      className={`connection-rail connection-rail-${side}`}
      style={{ top: "50%", ...(zIndex != null ? { zIndex } : {}) }}
      onPointerEnter={updateHandle}
      onPointerMove={updateHandle}
      onPointerLeave={resetHandle}
    >
      <span ref={dotRef} className="connection-rail-dot" style={{ transform: restTransform }} />
    </Handle>
  );
}
