/**
 * 连接轨道圆点的「二维跟随」视觉反馈（ConnectionSideRail / GroupConnectRail 共用）。
 * - hover 轨道时圆点在 ±RAIL_FOLLOW_LIMIT 屏幕像素内二维跟随鼠标（斜向也跟随），
 *   越靠近轨道中心越放大（最多 1.1×）；离开复位到静止位；
 * - 纯视觉反馈，不捕获连线锚点（锚点恒为节点边缘垂直正中，见 constants.ts）。
 */
"use client";

import { useRef } from "react";

import { getLiveViewport } from "@/features/canvas/stores/canvas-store";
import { RAIL_FOLLOW_LIMIT, RAIL_REST_OFFSET } from "@/lib/constants";

export type RailSide = "left" | "right";

export function useRailDotFollow(side: RailSide) {
  const dotRef = useRef<HTMLSpanElement>(null);
  // 静止位：从轨道中心向节点边缘偏移（左轨向右、右轨向左），视觉上贴着节点
  const restTransform = `translate(${side === "left" ? RAIL_REST_OFFSET : -RAIL_REST_OFFSET}px, 0) scale(1)`;

  const resetDot = () => {
    if (dotRef.current) dotRef.current.style.transform = restTransform;
  };

  // 圆点二维跟随：位移取指针相对轨道中心的屏幕偏移，钳制 ±RAIL_FOLLOW_LIMIT 后
  // 换算为节点本地 px（÷zoom）；越靠近中心放大越明显（1.0–1.1×）
  const updateDot = (e: React.PointerEvent<HTMLDivElement>) => {
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

  return {
    dotRef,
    restTransform,
    onPointerEnter: updateDot,
    onPointerMove: updateDot,
    onPointerLeave: resetDot,
  };
}
