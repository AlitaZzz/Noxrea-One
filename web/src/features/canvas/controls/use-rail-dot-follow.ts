/**
 * 连接轨道圆点的「二维跟随」视觉反馈（ConnectionSideRail / GroupConnectRail 共用）。
 * - hover 轨道时圆点在屏幕像素内二维跟随鼠标（斜向也跟随），越靠近轨道中心
 *   越放大（最多 1.1×）；离开复位到静止位；
 * - 纯视觉反馈，不捕获连线锚点（锚点恒为节点边缘垂直正中，见 constants.ts）。
 * - width 为轨道条带实际宽度（组内成员按组边界夹窄，见 group-bounds
 *   memberRailWidth）：静止偏移与跟随范围都随条带等比收缩——静止位恒在
 *   节点边缘外 RAIL_DOT_EDGE_GAP，圆点外缘恒不越过条带外界（即组边缘）。
 */
"use client";

import { useRef } from "react";

import { getLiveViewport } from "@/features/canvas/stores/canvas-store";
import { RAIL_DOT, RAIL_DOT_EDGE_GAP, RAIL_FOLLOW_LIMIT, RAIL_WIDTH } from "@/lib/constants";

export type RailSide = "left" | "right";

export function useRailDotFollow(side: RailSide, width: number = RAIL_WIDTH) {
  const dotRef = useRef<HTMLSpanElement>(null);
  // 静止位：圆点停在节点边缘外 RAIL_DOT_EDGE_GAP。轨道中心离边缘 width/2，
  // 故从中心向节点边缘偏移 width/2 − RAIL_DOT_EDGE_GAP
  // （全宽 80 时即 RAIL_REST_OFFSET，左轨向右、右轨向左）
  const rest = width / 2 - RAIL_DOT_EDGE_GAP;
  const restTransform = `translate(${side === "left" ? rest : -rest}px, 0) scale(1)`;

  const resetDot = () => {
    if (dotRef.current) dotRef.current.style.transform = restTransform;
  };

  // 圆点二维跟随：位移取指针相对轨道中心的屏幕偏移，钳制 ±limit 后换算为
  // 节点本地 px（÷zoom）；越靠近中心放大越明显（1.0–1.1×）。
  // limit 随条带宽度收缩（width/2 − 半圆点），保证圆点外缘不出条带外界
  const limit = Math.min(RAIL_FOLLOW_LIMIT, width / 2 - RAIL_DOT / 2);

  const updateDot = (e: React.PointerEvent<HTMLDivElement>) => {
    const bounds = e.currentTarget.getBoundingClientRect();
    const ox = Math.max(-limit, Math.min(limit, e.clientX - (bounds.left + bounds.width / 2)));
    const oy = Math.max(-limit, Math.min(limit, e.clientY - (bounds.top + bounds.height / 2)));
    const focus = 1 + Math.max(0, 1 - Math.hypot(ox, oy) / RAIL_FOLLOW_LIMIT) * 0.1;
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
