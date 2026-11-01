/**
 * 画布流光渲染循环（specs/canvas-flow-layer.md 规则 3 / 5 / 6）。
 *
 * 每帧读取视口变换：画布盒（CSS 尺寸 = 视口尺寸）用自身 transform 抵消视口变换，
 * 后备缓冲按 dpr 分配、缩放不重建；随后以流坐标描边注册表中的强调边。
 *
 * 相位按帧推进（单帧最多 32ms）：长任务后流光最多前进 2 帧 @60Hz，不按墙钟追赶
 * ——迁移前的 SMIL 按墙钟推进，400ms 阻塞后会跳约 23 帧。
 */
import { EDGE_FLOW_COLOR } from "@/lib/constants";

import { flowEdgeIds, getFlowDrawable, hasFlowEdges, subscribeFlowEdges } from "./flow-registry";
import { FLOW_CYCLE_DURATION_MS } from "./flow-taper";

/** 单帧最大推进时长（毫秒） */
const MAX_FRAME_DELTA_MS = 32;

/** 视口快照（React Flow store 的 transform 与画布容器尺寸，单位 px） */
export interface FlowViewport {
  tx: number;
  ty: number;
  zoom: number;
  width: number;
  height: number;
}

export interface FlowRenderer {
  destroy(): void;
}

export function createFlowRenderer(canvas: HTMLCanvasElement, readViewport: () => FlowViewport): FlowRenderer {
  const canvasContext = canvas.getContext("2d");
  // 无 2D 上下文（测试环境等）：保持空实现，不影响注册表与强调态
  if (!canvasContext) return { destroy() {} };
  const context: CanvasRenderingContext2D = canvasContext;

  let frameId: number | null = null;
  let lastTimestamp: number | null = null;
  /** 0~1 的周期相位：所有边共用，保证同一节奏 */
  let phase = 0;
  let cssWidth = -1;
  let cssHeight = -1;
  let backingDpr = -1;
  let lastTransform = "";

  function clear(): void {
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, canvas.width, canvas.height);
  }

  function draw(): void {
    const viewport = readViewport();
    const width = Math.round(viewport.width);
    const height = Math.round(viewport.height);
    if (!(width > 0 && height > 0) || !(viewport.zoom > 0)) {
      clear();
      return;
    }

    const dpr = window.devicePixelRatio || 1;
    if (width !== cssWidth || height !== cssHeight || dpr !== backingDpr) {
      cssWidth = width;
      cssHeight = height;
      backingDpr = dpr;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
    }

    // 抵消视口变换：画布盒与视口同尺寸，坐标经 ctx 变换直接使用流坐标
    const transform = `translate(${-viewport.tx / viewport.zoom}px, ${-viewport.ty / viewport.zoom}px) scale(${1 / viewport.zoom})`;
    if (transform !== lastTransform) {
      canvas.style.transform = transform;
      lastTransform = transform;
    }

    const scale = viewport.zoom * dpr;
    clear();
    context.setTransform(scale, 0, 0, scale, viewport.tx * dpr, viewport.ty * dpr);
    context.strokeStyle = EDGE_FLOW_COLOR;
    context.lineCap = "round";

    for (const id of flowEdgeIds()) {
      const drawable = getFlowDrawable(id);
      if (!drawable || drawable.pattern.layers.length === 0) continue;
      const { curve, offset } = drawable.geometry;
      const dx = offset?.x ?? 0;
      const dy = offset?.y ?? 0;
      // 路径每帧只构建一次，各分层复用并只改 dash 参数
      context.beginPath();
      context.moveTo(curve.start.x + dx, curve.start.y + dy);
      context.bezierCurveTo(
        curve.control1.x + dx,
        curve.control1.y + dy,
        curve.control2.x + dx,
        curve.control2.y + dy,
        curve.end.x + dx,
        curve.end.y + dy,
      );
      for (const layer of drawable.pattern.layers) {
        context.globalAlpha = layer.opacity;
        context.lineWidth = layer.width;
        context.setLineDash([layer.dash, layer.gap]);
        context.lineDashOffset = layer.offsetFrom + layer.drift * phase;
        context.stroke();
      }
    }

    context.globalAlpha = 1;
    context.setLineDash([]);
    context.lineDashOffset = 0;
  }

  function tick(timestamp: number): void {
    frameId = null;
    const delta =
      lastTimestamp === null ? 0 : Math.min(Math.max(timestamp - lastTimestamp, 0), MAX_FRAME_DELTA_MS);
    lastTimestamp = timestamp;
    if (delta > 0) phase = (phase + delta / FLOW_CYCLE_DURATION_MS) % 1;
    draw();
    frameId = requestAnimationFrame(tick);
  }

  function start(): void {
    if (frameId !== null) return;
    lastTimestamp = null;
    frameId = requestAnimationFrame(tick);
  }

  function stop(): void {
    if (frameId !== null) {
      cancelAnimationFrame(frameId);
      frameId = null;
    }
    lastTimestamp = null;
    clear();
  }

  const unsubscribe = subscribeFlowEdges(() => {
    if (hasFlowEdges()) start();
    else stop();
  });
  if (hasFlowEdges()) start();

  return {
    destroy() {
      unsubscribe();
      stop();
    },
  };
}
