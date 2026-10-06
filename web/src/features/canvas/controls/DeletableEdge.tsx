/**
 * 自定义连线组件（贝塞尔曲线）。
 * 连线端点恒落在节点边缘垂直正中：xyflow 给出的坐标在轨道上，按方位收回轨道宽
 * 即达节点边缘（见 constants.ts 的注释）。
 * 交互三态：
 * - 常态：2px 中性灰
 * - 强调（hover / 选中 / 关联节点选中）：提亮加粗 + 管道流光。hover 服务于辨认
 *   连线走向，选中是它的驻留版。
 * - 删除按钮：跟随 hover 指针，指针停稳约 1s 后出现在指针在连线上的投影位置
 *   （不脱离连线），指针在连线或按钮上移动都持续跟随；沿线移动会重置驻留计时
 *   （4px 内的微动视为静止），滚轮缩放/平移后按指针位置重新投影。指针移到
 *   按钮上时按钮保活不闪（此时连线 hover 已断，靠按钮自身 hover 维持显示）。
 *   键盘 Delete 仍可删除选中连线（见 use-canvas-keyboard）。
 */
"use client";

import {
  BaseEdge,
  EdgeLabelRenderer,
  type EdgeProps,
  getBezierPath,
  useReactFlow,
} from "@xyflow/react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { ScissorOutlined } from "@/components/ui/AppIcon";
import { Button } from "@/components/ui/button";
import { useCanvasStore } from "@/features/canvas/stores/canvas-store";
import { EDGE_BASE_COLOR, insetEdgeAnchor } from "@/lib/constants";
import { useHighlightedEdges } from "@/providers/EdgeHighlightContext";

import { FlowLines } from "./EdgeFlow";

/** 删除按钮的出现延迟（驻留时长）：指针在连线上停稳 1s 才出现；沿线移动会重置计时 */
const DELETE_BUTTON_DELAY_MS = 1000;

/** 重置驻留计时的最小指针位移（屏幕像素）：低于阈值视为手抖静止，不重置 */
const MOVE_RESET_THRESHOLD_PX = 4;

/** 投影定位的粗采样数；粗采样后接三分搜索细化 */
const PATH_SAMPLES = 48;

type FlowPoint = { x: number; y: number };

export default function DeletableEdge(props: EdgeProps) {
  const {
    id,
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    selected,
    style = {},
  } = props;
  const { t } = useTranslation();
  const { screenToFlowPosition } = useReactFlow();

  // 端点从轨道收回节点边缘
  const source = insetEdgeAnchor(sourcePosition, sourceX, sourceY);
  const target = insetEdgeAnchor(targetPosition, targetX, targetY);

  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX: source.x, sourceY: source.y, sourcePosition,
    targetX: target.x, targetY: target.y, targetPosition,
  });

  const highlightedEdgeIds = useHighlightedEdges();
  const isHighlighted = highlightedEdgeIds.has(id);
  // 选中节点关联的边高亮：由组件自身按 Context 判断，避免父级逐边重建全部边对象
  const isConnected = isHighlighted || selected;

  // hover 与选中/高亮共用同一强调样式（见头注释三态说明）
  const [hovered, setHovered] = useState(false);
  const [buttonHovered, setButtonHovered] = useState(false);
  // 拖拽/平移中指针扫过不触发 hover（buttons!==0），避免动画随拖拽路径闪烁
  const handleEnter = (e: React.MouseEvent) => {
    if (e.buttons === 0) setHovered(true);
  };

  const pathRef = useRef<SVGPathElement>(null);
  // 删除按钮锚点（流坐标）：跟随指针在连线上的投影，指针离开即回退线中点
  const [anchor, setAnchor] = useState<FlowPoint | null>(null);

  /** 事件 handler 内调用（refs 仅允许在渲染外访问）：任意点到连线的最近点。
      粗采样定位区段，三分搜索细化（48+12 次查询，亚像素精度） */
  function projectOntoPath(pt: FlowPoint): FlowPoint | null {
    const path = pathRef.current;
    if (!path) return null;
    const len = path.getTotalLength();
    if (len === 0) return null;
    let bestT = 0;
    let bestD2 = Infinity;
    for (let i = 0; i <= PATH_SAMPLES; i++) {
      const t = (i / PATH_SAMPLES) * len;
      const p = path.getPointAtLength(t);
      const d2 = (p.x - pt.x) ** 2 + (p.y - pt.y) ** 2;
      if (d2 < bestD2) {
        bestD2 = d2;
        bestT = t;
      }
    }
    let lo = Math.max(0, bestT - len / PATH_SAMPLES);
    let hi = Math.min(len, bestT + len / PATH_SAMPLES);
    for (let i = 0; i < 12; i++) {
      const t1 = lo + (hi - lo) / 3;
      const t2 = hi - (hi - lo) / 3;
      const p1 = path.getPointAtLength(t1);
      const p2 = path.getPointAtLength(t2);
      const d1 = (p1.x - pt.x) ** 2 + (p1.y - pt.y) ** 2;
      const d2v = (p2.x - pt.x) ** 2 + (p2.y - pt.y) ** 2;
      if (d1 < d2v) hi = t2;
      else lo = t1;
    }
    const p = path.getPointAtLength((lo + hi) / 2);
    return { x: p.x, y: p.y };
  }

  // 投影跟随（连线与按钮共享）：按钮出现在指针正下方后，后续 mousemove 落在
  // 按钮上而非连线上——两处挂同一 handler 才能连续贴指针。微动下投影近似不变，
  // 引用不变触发 React bailout 避免逐事件重渲染；位移超阈值时重置驻留计时
  const lastScreenRef = useRef<{ x: number; y: number } | null>(null);
  const lastMoveRef = useRef<{ x: number; y: number } | null>(null);
  const [moveTick, setMoveTick] = useState(0);
  const reanchor = (e: React.MouseEvent) => {
    if (e.buttons !== 0) return;
    lastScreenRef.current = { x: e.clientX, y: e.clientY };
    const projected = projectOntoPath(screenToFlowPosition({ x: e.clientX, y: e.clientY }));
    if (projected) {
      setAnchor((prev) =>
        prev && Math.hypot(prev.x - projected.x, prev.y - projected.y) < 0.5 ? prev : projected
      );
    }
    const last = lastMoveRef.current;
    const dx = e.clientX - (last?.x ?? e.clientX);
    const dy = e.clientY - (last?.y ?? e.clientY);
    if (!last || Math.hypot(dx, dy) > MOVE_RESET_THRESHOLD_PX) {
      lastMoveRef.current = { x: e.clientX, y: e.clientY };
      setMoveTick((t) => t + 1);
    }
  };

  // 滚轮缩放/平移会改变指针下的流坐标但不产生 mousemove：按指针位置在
  // rAF（等 d3-zoom 先更新 transform）里重新投影存量屏幕坐标，按钮贴回指针
  const handleWheel = (e: React.WheelEvent) => {
    lastScreenRef.current = { x: e.clientX, y: e.clientY };
    requestAnimationFrame(() => {
      const last = lastScreenRef.current;
      if (!last) return;
      const projected = projectOntoPath(screenToFlowPosition(last));
      if (projected) setAnchor(projected);
    });
  };

  // 按钮可见性：连线或按钮任一 hover 即激活；驻留后才点亮，双端 hover 断开即复位
  // （指针从连线移到按钮上时连线 mouseleave 已触发，靠 buttonHovered 保活不闪）
  const active = hovered || buttonHovered;
  const [armed, setArmed] = useState(false);
  const [prevActive, setPrevActive] = useState(active);
  if (prevActive !== active) {
    setPrevActive(active);
    setArmed(false);
  }
  useEffect(() => {
    if (!active) return;
    const timer = setTimeout(() => setArmed(true), DELETE_BUTTON_DELAY_MS);
    return () => clearTimeout(timer);
  }, [active, moveTick]);

  // 几何变化（拖动端点节点等）时锚点回退线中点（恒在曲线上），渲染期前值同步
  const [prevEdgePath, setPrevEdgePath] = useState(edgePath);
  if (prevEdgePath !== edgePath) {
    setPrevEdgePath(edgePath);
    setAnchor(null);
  }

  const buttonX = anchor ? anchor.x : labelX;
  const buttonY = anchor ? anchor.y : labelY;
  const emphasized = isConnected || hovered || buttonHovered;

  return (
    <>
      <g onMouseEnter={handleEnter} onMouseMove={reanchor} onWheel={handleWheel} onMouseLeave={() => setHovered(false)}>
        {/* 投影测量用同几何路径：不参与绘制与命中，但保留在渲染树内保证几何 API 可用 */}
        <path ref={pathRef} d={edgePath} fill="none" stroke="none" pointerEvents="none" />
        {/* Base path */}
        <BaseEdge
          id={id}
          path={edgePath}
          style={{
            ...style,
            strokeWidth: emphasized ? 2.5 : 2,
            // 底线恒为中性灰（强调时提亮一档），彩色只留给流光：
            // 两者同色会糊成一片，流光的水滴形状就看不见了
            stroke: emphasized
              ? "var(--muted-foreground)"
              : (style.stroke as string || EDGE_BASE_COLOR),
          }}
        />

        {/* 管道流光（hover / 选中节点或边时叠加） */}
        {emphasized && <FlowLines path={edgePath} />}
      </g>

      <EdgeLabelRenderer>
        {armed && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={t("common.delete")}
            className="nodrag nopan absolute z-10 rounded-full border border-border bg-card text-foreground transition-none hover:bg-muted"
            onMouseEnter={() => setButtonHovered(true)}
            onMouseLeave={() => setButtonHovered(false)}
            onMouseMove={reanchor}
            onWheel={handleWheel}
            onClick={(e) => {
              e.stopPropagation();
              useCanvasStore.getState().removeEdges([id]);
            }}
            style={{
              left: buttonX,
              top: buttonY,
              transform: "translate(-50%, -50%)",
              pointerEvents: "all",
            }}
          >
            <ScissorOutlined className="size-4" />
          </Button>
        )}
      </EdgeLabelRenderer>
    </>
  );
}
