// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import { removeFlowEdge, setFlowEdge } from "@/features/canvas/flow/flow-registry";
import { createFlowRenderer, type FlowViewport } from "@/features/canvas/flow/flow-renderer";
import type { BezierCurve } from "@/features/canvas/shared/edge-geometry";

const curve: BezierCurve = {
  start: { x: 0, y: 0 },
  control1: { x: 50, y: 0 },
  control2: { x: 50, y: 0 },
  end: { x: 100, y: 0 },
};

/** 逐帧手动推进 rAF，可指定帧时间戳 */
function stubTimedRaf() {
  const queue = new Map<number, FrameRequestCallback>();
  let nextId = 1;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    const id = nextId++;
    queue.set(id, cb);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    queue.delete(id);
  });
  return {
    frame(timestamp: number) {
      const pending = [...queue.values()];
      queue.clear();
      for (const cb of pending) cb(timestamp);
    },
    get pending() {
      return queue.size;
    },
  };
}

interface StrokeRecord {
  offset: number;
  width: number;
  alpha: number;
}

function createFakeCanvas() {
  const strokes: StrokeRecord[] = [];
  const context = {
    lineDashOffset: 0,
    lineWidth: 0,
    globalAlpha: 1,
    strokeStyle: "",
    lineCap: "butt",
    setTransform: vi.fn(),
    clearRect: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    bezierCurveTo: vi.fn(),
    setLineDash: vi.fn(),
    stroke: () => {
      strokes.push({
        offset: context.lineDashOffset,
        width: context.lineWidth,
        alpha: context.globalAlpha,
      });
    },
  };
  const canvas = {
    width: 0,
    height: 0,
    style: {} as Record<string, string>,
    getContext: () => context,
  } as unknown as HTMLCanvasElement;
  return { canvas, context, strokes };
}

const viewport: FlowViewport = { tx: 0, ty: 0, zoom: 1, width: 800, height: 600 };

afterEach(() => {
  removeFlowEdge("e1");
  vi.unstubAllGlobals();
});

describe("createFlowRenderer", () => {
  it("相位按帧推进；400ms 长任务后单帧最多前进 32ms", () => {
    const raf = stubTimedRaf();
    const { canvas, strokes } = createFakeCanvas();
    setFlowEdge("e1", { curve, length: 100 });
    const renderer = createFlowRenderer(canvas, () => viewport);

    // 首帧：无前值，相位不动；每帧 6 层，头层最后画（dash 13、宽 4）
    raf.frame(0);
    expect(strokes).toHaveLength(6);
    const headOffset = () => strokes[strokes.length - 1].offset;
    expect(strokes[strokes.length - 1].width).toBe(4);
    expect(headOffset()).toBeCloseTo(-14.3);

    // +16ms → 相位 0.01，dashoffset 前进 drift(-50) × 0.01 = -0.5
    raf.frame(16);
    expect(headOffset()).toBeCloseTo(-14.8);

    // 400ms 长任务：按墙钟会跳 25 帧，这里钳制为 32ms → 只前进 2 帧
    strokes.length = 0;
    raf.frame(416);
    expect(headOffset()).toBeCloseTo(-15.8);

    renderer.destroy();
    expect(raf.pending).toBe(0);
  });

  it("画布盒抵消视口变换，后备缓冲按视口尺寸分配", () => {
    const raf = stubTimedRaf();
    const { canvas } = createFakeCanvas();
    setFlowEdge("e1", { curve, length: 100 });
    const zoomed: FlowViewport = { tx: 100, ty: 50, zoom: 2, width: 800, height: 600 };
    const renderer = createFlowRenderer(canvas, () => zoomed);

    raf.frame(0);

    expect(canvas.width).toBe(800);
    expect(canvas.height).toBe(600);
    expect(canvas.style.width).toBe("800px");
    expect(canvas.style.height).toBe("600px");
    expect(canvas.style.transform).toBe("translate(-50px, -25px) scale(0.5)");

    renderer.destroy();
  });

  it("注册表清空即停止循环，不再绘制", () => {
    const raf = stubTimedRaf();
    const { canvas, strokes } = createFakeCanvas();
    setFlowEdge("e1", { curve, length: 100 });
    const renderer = createFlowRenderer(canvas, () => viewport);

    raf.frame(0);
    expect(strokes).toHaveLength(6);

    removeFlowEdge("e1");
    expect(raf.pending).toBe(0);

    strokes.length = 0;
    raf.frame(16);
    expect(strokes).toHaveLength(0);

    renderer.destroy();
  });

  it("视口未测量（0×0）时不绘制，不报错", () => {
    const raf = stubTimedRaf();
    const { canvas, strokes } = createFakeCanvas();
    setFlowEdge("e1", { curve, length: 100 });
    const renderer = createFlowRenderer(canvas, () => ({ ...viewport, width: 0, height: 0 }));

    raf.frame(0);
    expect(strokes).toHaveLength(0);
    expect(canvas.width).toBe(0);

    renderer.destroy();
  });

  it("无 2D 上下文时为空实现（测试/受限环境）", () => {
    const canvas = {
      width: 0,
      height: 0,
      style: {},
      getContext: () => null,
    } as unknown as HTMLCanvasElement;
    setFlowEdge("e1", { curve, length: 100 });

    const renderer = createFlowRenderer(canvas, () => viewport);
    renderer.destroy();
  });
});
