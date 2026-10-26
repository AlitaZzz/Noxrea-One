// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { type InternalNode, type Node, ReactFlowProvider, useStoreApi } from "@xyflow/react";
import { useLayoutEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { makeStorageKey } from "@/__tests__/test-utils/storage-fixtures";
import { useCanvasImageLod } from "@/features/canvas/hooks/use-canvas-image-lod";
import {
  type CanvasMediaViewport,
  CanvasMediaViewportContext,
} from "@/features/canvas/shared/CanvasMediaLoadingProvider";

const KEY = makeStorageKey("lod-hook", ".png");
const OTHER_KEY = makeStorageKey("lod-hook-other", ".jpg");
const URL_OF = (key: string) => `/api/files/${key}`;
const at = (settledZoom: number, dpr = 1, zoomingOut = false): CanvasMediaViewport => ({ settledZoom, dpr, zoomingOut });

function makeNode(id: string, width: number, height: number, measured = true): InternalNode {
  const userNode: Node = measured
    ? { id, position: { x: 0, y: 0 }, data: {}, measured: { width, height } }
    // 首帧尚未测量：只有节点声明宽高（媒体节点创建时的真实状态）
    : { id, position: { x: 0, y: 0 }, data: {}, style: { width, height } };
  return {
    ...userNode,
    measured: measured ? { width, height } : {},
    internals: { positionAbsolute: { x: 0, y: 0 }, z: 0, userNode },
  } as InternalNode;
}

/** 渲染期记录全部显示 URL：用于断言「从未请求原图/高档位」这类否定条件 */
let rendered: string[] = [];

type ProbeProps = {
  nodeId: string;
  src: string;
  aspect?: number;
  naturalWidth?: number;
};

function Probe({ nodeId, src, aspect, naturalWidth }: ProbeProps) {
  const { url, suspend } = useCanvasImageLod({ nodeId, src, aspect, naturalWidth });
  rendered.push(url ?? "");
  // data-resolved 区分「未就绪」与「就绪但地址为空」：未就绪必须是 undefined 哨兵
  return <div data-testid="probe" data-url={url ?? ""} data-resolved={String(url !== undefined)} data-suspend={String(suspend)} />;
}

function StoreInit({ nodeId, zoom, size, measured }: { nodeId: string; zoom: number; size: { width: number; height: number }; measured: boolean }) {
  const api = useStoreApi();
  const { width, height } = size;
  useLayoutEffect(() => {
    api.setState({
      width: 800,
      height: 600,
      transform: [0, 0, zoom],
      nodeLookup: new Map([[nodeId, makeNode(nodeId, width, height, measured)]]),
    });
  }, [api, nodeId, zoom, width, height, measured]);
  return null;
}

type SceneProps = ProbeProps & {
  viewport: CanvasMediaViewport;
  zoom: number;
  size: { width: number; height: number };
  /** false = 节点尚未被测量，只有声明宽高 */
  measured?: boolean;
};

function Scene({ viewport, zoom, size, measured = true, ...probe }: SceneProps) {
  return (
    <ReactFlowProvider>
      <StoreInit nodeId={probe.nodeId} zoom={zoom} size={size} measured={measured} />
      <CanvasMediaViewportContext.Provider value={viewport}>
        <Probe {...probe} />
      </CanvasMediaViewportContext.Provider>
    </ReactFlowProvider>
  );
}

function current() {
  const el = screen.getByTestId("probe");
  return {
    url: el.dataset.url ?? "",
    /** false = 钩子返回 undefined（尚未测量/首档未定），不是「地址为空串」 */
    resolved: el.dataset.resolved === "true",
    suspend: el.dataset.suspend === "true",
  };
}

/** 冲掉订阅回调的微任务与随之而来的重渲染 */
async function flush() {
  await act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); });
}

const NODE = { nodeId: "near", size: { width: 600, height: 400 } };

beforeEach(() => {
  rendered = [];
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useCanvasImageLod", () => {
  it("0.1 缩放下首个请求就是低档位，不先请求原图或大档位", () => {
    render(<Scene {...NODE} viewport={at(0.1)} zoom={0.1} src={KEY} />);
    expect(current().url).toBe(`${URL_OF(KEY)}?w=64`);
    expect(rendered).not.toContain(URL_OF(KEY));
    expect(rendered.some((url) => url.includes("w=1280") || url.includes("w=1920"))).toBe(false);
  });

  it("节点尚未测量时退回声明宽高取档，不停在空 URL（规则 3.1）", () => {
    render(<Scene {...NODE} measured={false} viewport={at(0.1)} zoom={0.1} src={KEY} />);
    // 声明尺寸与实测路径给出同一档位：声明值不是另一种取档口径，只是测量前的回退
    expect(current().url).toBe(`${URL_OF(KEY)}?w=64`);
  });

  it("既无实测也无声明尺寸时不发请求（不猜测尺寸）", () => {
    render(<Scene nodeId="unmeasured" size={{ width: 0, height: 0 }} measured={false} viewport={at(1)} zoom={1} src={KEY} />);
    // 未就绪的唯一表示是 undefined；空串会让调用方误以为「已就绪但地址为空」
    expect(current()).toEqual({ url: "", resolved: false, suspend: false });
  });

  it("DPR 2 时同一节点取更高档位", () => {
    render(<Scene {...NODE} viewport={at(0.1, 2)} zoom={0.1} src={KEY} />);
    expect(current().url).toBe(`${URL_OF(KEY)}?w=200`);
  });

  it("已知宽高比时按 contain 后的实际显示宽度计算", () => {
    render(<Scene {...NODE} viewport={at(1)} zoom={1} src={KEY} aspect={1} />);
    // contain 后宽 372 → 档位 400
    expect(current().url).toBe(`${URL_OF(KEY)}?w=400`);
  });

  it("取档超过自然宽度时回退原图，避免请求比源图更大的派生档位", () => {
    render(<Scene {...NODE} viewport={at(1)} zoom={1} src={KEY} naturalWidth={500} />);
    expect(current().url).toBe(URL_OF(KEY));
  });

  it("自然宽度足够时仍使用档位", () => {
    render(<Scene {...NODE} viewport={at(1)} zoom={1} src={KEY} naturalWidth={2000} />);
    expect(current().url).toBe(`${URL_OF(KEY)}?w=640`);
  });

  it("节点改尺寸后尾随 200 ms 结算，结算窗口内不换档", async () => {
    vi.useFakeTimers();
    const view = render(<Scene {...NODE} viewport={at(1)} zoom={1} src={KEY} />);
    expect(current().url).toBe(`${URL_OF(KEY)}?w=640`);
    view.rerender(<Scene {...NODE} size={{ width: 1200, height: 400 }} viewport={at(1)} zoom={1} src={KEY} />);
    expect(current().url).toBe(`${URL_OF(KEY)}?w=640`);
    await act(async () => { await vi.advanceTimersByTimeAsync(199); });
    expect(current().url).toBe(`${URL_OF(KEY)}?w=640`);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(current().url).toBe(`${URL_OF(KEY)}?w=1280`);
  });

  it("缩放结算后按 25% 滞回降档：略低于当前档位时保留，低于 75% 才降", () => {
    const view = render(<Scene {...NODE} viewport={at(2.5)} zoom={2.5} src={KEY} naturalWidth={1500} />);
    // 目标 1500 达到自然宽度：使用原图
    expect(current().url).toBe(URL_OF(KEY));
    view.rerender(<Scene {...NODE} viewport={at(1.9)} zoom={1.9} src={KEY} naturalWidth={1500} />);
    // 目标 1140 只比原图宽度 1500 低 24%：保留原图
    expect(current().url).toBe(URL_OF(KEY));
    view.rerender(<Scene {...NODE} viewport={at(1.8)} zoom={1.8} src={KEY} naturalWidth={1500} />);
    // 目标 1080 < 1500 × 0.75：降档 1280
    expect(current().url).toBe(`${URL_OF(KEY)}?w=1280`);
  });

  it("缩小手势中止在途高档位，结算后按低档位重新加载", async () => {
    const view = render(<Scene {...NODE} viewport={at(1)} zoom={1} src={KEY} />);
    expect(current()).toEqual({ url: `${URL_OF(KEY)}?w=640`, resolved: true, suspend: false });
    // 手势开始：实时 zoom 0.5 → 目标 320 低于在途 640 → 中止（订阅回调在微任务里判定）
    view.rerender(<Scene {...NODE} viewport={at(1, 1, true)} zoom={0.5} src={KEY} />);
    await flush();
    expect(current().suspend).toBe(true);
    // 手势继续：实时 zoom 0.1
    view.rerender(<Scene {...NODE} viewport={at(1, 1, true)} zoom={0.1} src={KEY} />);
    await flush();
    expect(current().suspend).toBe(true);
    // 手势中不为已就绪图片换档
    expect(current().url).toBe(`${URL_OF(KEY)}?w=640`);
    // 结算：suspend 解除，按最终缩放换到低档位
    view.rerender(<Scene {...NODE} viewport={at(0.1)} zoom={0.1} src={KEY} />);
    await flush();
    expect(current()).toEqual({ url: `${URL_OF(KEY)}?w=64`, resolved: true, suspend: false });
  });

  it("在途原图在缩小手势中同样被中止（按自然宽度比较）", async () => {
    const view = render(<Scene {...NODE} viewport={at(2.5)} zoom={2.5} src={KEY} naturalWidth={1500} />);
    expect(current().url).toBe(URL_OF(KEY));
    view.rerender(<Scene {...NODE} viewport={at(2.5, 1, true)} zoom={1} src={KEY} naturalWidth={1500} />);
    await flush();
    expect(current().suspend).toBe(true);
  });

  it("放大手势不触发中止", () => {
    const view = render(<Scene {...NODE} viewport={at(0.1)} zoom={0.1} src={KEY} />);
    expect(current().url).toBe(`${URL_OF(KEY)}?w=64`);
    view.rerender(<Scene {...NODE} viewport={at(0.1, 1, false)} zoom={2} src={KEY} />);
    expect(current().suspend).toBe(false);
    // 手势中不换档
    expect(current().url).toBe(`${URL_OF(KEY)}?w=64`);
  });

  it("逻辑源变化立即清空旧档位，不用旧档位请求新图片", () => {
    const view = render(<Scene {...NODE} viewport={at(1)} zoom={1} src={KEY} />);
    expect(current().url).toBe(`${URL_OF(KEY)}?w=640`);
    rendered = [];
    view.rerender(<Scene {...NODE} viewport={at(0.1)} zoom={0.1} src={OTHER_KEY} />);
    expect(current().url).toBe(`${URL_OF(OTHER_KEY)}?w=64`);
    expect(rendered).not.toContain(`${URL_OF(OTHER_KEY)}?w=640`);
  });

  it("节点尚未测量时不发请求，首次测量立即取档（不等结算窗口）", () => {
    const view = render(<Scene {...NODE} size={{ width: 0, height: 0 }} viewport={at(1)} zoom={1} src={KEY} />);
    expect(current()).toEqual({ url: "", resolved: false, suspend: false });
    view.rerender(<Scene {...NODE} viewport={at(1)} zoom={1} src={KEY} />);
    expect(current().url).toBe(`${URL_OF(KEY)}?w=640`);
  });

  it("外部 URL 保持原图，不追加档位参数", () => {
    // 「关闭 LOD」现在由 CanvasImage 的 lod prop 决定（不挂载本 Hook），
    // Hook 内部不再保留 enabled 开关，因此这里只验证源形态资格
    render(<Scene {...NODE} viewport={at(0.1)} zoom={0.1} src="https://cdn.example.com/x.png" />);
    expect(current().url).toBe("https://cdn.example.com/x.png");
  });
});
