// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { type InternalNode, type Node, ReactFlowProvider, useStoreApi } from "@xyflow/react";
import { type ReactNode, StrictMode, useLayoutEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { makeStorageKey } from "@/__tests__/test-utils/storage-fixtures";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ImageLoadScheduler } from "@/features/canvas/services/image-load-scheduler";
import CanvasImage from "@/features/canvas/shared/CanvasImage";
import CanvasMediaLoadingProvider, {
  CanvasImageLoadingContext,
  type CanvasMediaViewport,
  CanvasMediaViewportContext,
} from "@/features/canvas/shared/CanvasMediaLoadingProvider";
import type { ImagePlacement } from "@/features/canvas/shared/image-visibility";
vi.mock("@/lib/use-file-access-url", async (importOriginal) => {
  const mock = await import("@/__tests__/test-utils/file-access-mock");
  const actual = await importOriginal<typeof import("@/lib/use-file-access-url")>();
  // scriptedSigned=true 时按 signed 语义返回：访问地址带签名，与逻辑 URL 不同
  return {
    ...actual,
    useFileAccessUrl: (value: string | null | undefined) =>
      (globalThis as { __scriptedSigned?: boolean }).__scriptedSigned
        ? { url: value ? `${value}?X-Amz-Signature=abc` : undefined, failed: false, refresh: async () => undefined, retrySigned: async () => null, reloadToken: 0 }
        : mock.useFileAccessUrl(value),
  };
});

vi.mock("react-i18next", async (original) => ({ ...await original<typeof import("react-i18next")>(), useTranslation: () => ({ t: (key: string) => key }) }));

class BrowserImage {
  static instances: BrowserImage[] = [];
  src = "";
  decoding = "";
  naturalWidth = 1600;
  naturalHeight = 900;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  decode = vi.fn(() => Promise.resolve());
  removeAttribute = vi.fn();
  constructor() { BrowserImage.instances.push(this); }
}

let flowStore: ReturnType<typeof useStoreApi>;
function node(id: string, x: number, y = 0, size = { width: 400, height: 328 }): InternalNode {
  const userNode: Node = { id, position: { x, y }, data: {}, measured: size };
  return { ...userNode, measured: size, internals: { positionAbsolute: { x, y }, z: 0, userNode } };
}
const initialNodes = new Map([["near", node("near", 0)], ["far", node("far", 5000)], ["second", node("second", 900)]]);

function StoreBridge({ children, nodes = initialNodes }: { children: ReactNode; nodes?: Map<string, InternalNode> }) {
  const api = useStoreApi();
  useLayoutEffect(() => {
    flowStore = api;
    api.setState({ width: 800, height: 600, transform: [0, 0, 1], nodeLookup: new Map(nodes) });
  }, [api, nodes]);
  return children;
}

type Item = { nodeId: string; src: string; alt: string; placement?: ImagePlacement; onLoad?: () => void; className?: string; style?: React.CSSProperties; aspect?: number; naturalWidth?: number };
function Scene({ items, project = "first" }: { items: Item[]; project?: string }) {
  return (
    <ReactFlowProvider>
      <StoreBridge>
        <TooltipProvider><CanvasMediaLoadingProvider key={project}>
          {items.map((item) => <CanvasImage key={item.nodeId} {...item} />)}
        </CanvasMediaLoadingProvider></TooltipProvider>
      </StoreBridge>
    </ReactFlowProvider>
  );
}

/** LOD 场景：视口上下文直接注入（不经过 200 ms 缩放结算），调度器用可控 loader */
const LOD_KEY = makeStorageKey("lod-image", ".png");
const LOD_URL = `/api/files/${LOD_KEY}`;
const LOD_VIEWPORT: CanvasMediaViewport = { settledZoom: 0.1, dpr: 1, zoomingOut: false };
type LoadCall = { src: string; resolve: () => void; reject: () => void };
function controlledScheduler() {
  const calls: LoadCall[] = [];
  const scheduler = new ImageLoadScheduler((src) => new Promise((resolve, reject) => {
    calls.push({
      src,
      resolve: () => resolve({ url: src, width: 600, height: 400 }),
      reject: () => reject(new Error("tier failed")),
    });
  }));
  return { calls, scheduler };
}
function LodScene({ items, nodes, viewport = LOD_VIEWPORT, scheduler }: { items: Item[]; nodes?: Map<string, InternalNode>; viewport?: CanvasMediaViewport; scheduler: ImageLoadScheduler }) {
  return (
    <ReactFlowProvider>
      <StoreBridge nodes={nodes}>
        <CanvasImageLoadingContext.Provider value={scheduler}>
          <CanvasMediaViewportContext.Provider value={viewport}>
            <TooltipProvider>{items.map((item) => <CanvasImage key={item.nodeId} lod {...item} />)}</TooltipProvider>
          </CanvasMediaViewportContext.Provider>
        </CanvasImageLoadingContext.Provider>
      </StoreBridge>
    </ReactFlowProvider>
  );
}
const WIDE_NODES = new Map([["near", node("near", 0, 0, { width: 600, height: 400 })]]);

async function flush() { await act(async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); }); }

/**
 * 假调度器：只实现 CanvasImage 消费的租约契约，用于驱动真实调度器不会产生的
 * 结算序列（同一 src 先 ready 再 failed）。
 */
class ScriptedScheduler {
  private notify: ((result: unknown) => void) | null = null;
  private lease = {
    setPriority: () => {},
    setWeight: () => {},
    retry: () => {},
    release: () => {},
  };
  acquire(_src: string, notify: (result: unknown) => void) {
    this.notify = notify;
    return this.lease;
  }
  emit(result: unknown) {
    this.notify?.(result);
  }
  clear() {}
}

async function loaded(image: BrowserImage) {
  await act(async () => { image.onload?.(); for (let i = 0; i < 12; i++) await Promise.resolve(); });
}

beforeEach(() => {
  BrowserImage.instances = [];
  vi.stubGlobal("Image", BrowserImage);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("CanvasImage", () => {
  it("retries a failed shared source once and recovers every consumer without changing the URL", async () => {
    render(<Scene items={[{ nodeId: "near", src: "/shared.png", alt: "first" }, { nodeId: "second", src: "/shared.png", alt: "second" }]} />);
    await flush();
    await act(async () => BrowserImage.instances[0].onerror!());
    const retry = screen.getAllByRole("button", { name: "media.retry" });
    expect(retry).toHaveLength(2);
    fireEvent.click(retry[0]);
    fireEvent.click(retry[1]);
    await flush();
    expect(BrowserImage.instances).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "media.retry" })).toBeNull();
    await loaded(BrowserImage.instances[1]);
    expect(screen.getByRole("img", { name: "first" }).getAttribute("src")).toBe("/shared.png");
    expect(screen.getByRole("img", { name: "second" }).getAttribute("src")).toBe("/shared.png");
  });

  it("preserves presentation while an upload preview is loading or fails", async () => {
    render(<Scene items={[{ nodeId: "near", src: "/upload.png", alt: "upload", className: "blur-sm animate-breathe", style: { opacity: 0.5 } }]} />);
    await flush();
    const placeholder = screen.getByRole("img", { name: "upload" });
    expect(placeholder).toHaveClass("blur-sm", "animate-breathe");
    expect(placeholder).toHaveStyle({ opacity: 0.5 });
    await act(async () => BrowserImage.instances[0].onerror!());
    expect(screen.getByRole("group", { name: "upload" })).toHaveClass("blur-sm", "animate-breathe");
    expect(screen.getByRole("group", { name: "upload" })).toHaveStyle({ opacity: 0.5 });
  });
  it("does not request a distant image until panning brings it near the viewport", async () => {
    render(<Scene items={[{ nodeId: "far", src: "/far.png", alt: "far" }]} />);
    await flush();
    expect(BrowserImage.instances).toHaveLength(0);
    expect(screen.getByRole("img", { name: "far" }).tagName).toBe("SPAN");
    act(() => flowStore.setState({ transform: [-5000, 0, 1] }));
    await flush();
    expect(BrowserImage.instances[0].src).toBe("/far.png");
    await loaded(BrowserImage.instances[0]);
    expect(screen.getByRole("img", { name: "far" }).getAttribute("src")).toBe("/far.png");
    act(() => flowStore.setState({ transform: [0, 0, 1] }));
    await flush();
    expect(screen.getByRole("img", { name: "far" }).getAttribute("src")).toBe("/far.png");
    expect(BrowserImage.instances).toHaveLength(1);
  });

  it("uses live absolute positions when a parent moves its child into view", async () => {
    render(<Scene items={[{ nodeId: "far", src: "/child.png", alt: "child" }]} />);
    await flush();
    const child = { ...node("far", 5000), parentId: "group", position: { x: 10, y: 10 } };
    act(() => flowStore.setState({ nodeLookup: new Map([["far", child]]) }));
    await flush();
    expect(BrowserImage.instances).toHaveLength(0);
    act(() => flowStore.setState({ nodeLookup: new Map([["far", { ...child, internals: { ...child.internals, positionAbsolute: { x: 10, y: 10 } } }]]) }));
    await flush();
    expect(BrowserImage.instances[0].src).toBe("/child.png");
  });

  it("loads an expanded card visible above a distant main node", async () => {
    render(<Scene items={[{ nodeId: "far", src: "/expanded.png", alt: "expanded", placement: { row: -6 } }]} />);
    act(() => flowStore.setState({ nodeLookup: new Map([["far", node("far", 100, 2000)]]) }));
    await flush();
    expect(BrowserImage.instances[0].src).toBe("/expanded.png");
  });

  it("shares preparations and keeps the request alive when one of two consumers unmounts", async () => {
    const first: Item = { nodeId: "near", src: "/shared.png", alt: "first" };
    const second: Item = { nodeId: "second", src: "/shared.png", alt: "second" };
    const view = render(<Scene items={[first, second]} />);
    await flush();
    expect(BrowserImage.instances).toHaveLength(1);
    view.rerender(<Scene items={[second]} />);
    await flush();
    expect(BrowserImage.instances[0].removeAttribute).not.toHaveBeenCalled();
    await loaded(BrowserImage.instances[0]);
    expect(screen.getByRole("img", { name: "second" }).getAttribute("src")).toBe("/shared.png");
  });

  it("aborts unfinished loading after leaving the prefetch range and restarts on return", async () => {
    render(<Scene items={[{ nodeId: "near", src: "/near.png", alt: "near" }]} />);
    await flush();
    const first = BrowserImage.instances[0];
    act(() => flowStore.setState({ transform: [5000, 0, 1] }));
    await flush();
    expect(first.removeAttribute).toHaveBeenCalledWith("src");
    act(() => flowStore.setState({ transform: [0, 0, 1] }));
    await flush();
    expect(BrowserImage.instances).toHaveLength(2);
    await loaded(BrowserImage.instances[1]);
    expect(screen.getByRole("img", { name: "near" }).getAttribute("src")).toBe("/near.png");
  });

  it("ignores stale decoding results after the node source changes", async () => {
    const view = render(<Scene items={[{ nodeId: "near", src: "/old.png", alt: "near" }]} />);
    await flush();
    let completeDecode!: () => void;
    const old = BrowserImage.instances[0];
    old.decode.mockImplementation(() => new Promise<void>((resolve) => { completeDecode = resolve; }));
    act(() => old.onload!());
    view.rerender(<Scene items={[{ nodeId: "near", src: "/new.png", alt: "near" }]} />);
    await flush();
    await act(async () => completeDecode());
    expect(screen.getByRole("img", { name: "near" }).getAttribute("src")).not.toBe("/old.png");
    await loaded(BrowserImage.instances.at(-1)!);
    expect(screen.getByRole("img", { name: "near" }).getAttribute("src")).toBe("/new.png");
  });

  // 回归：stale 守卫曾拿访问地址与逻辑 URL 比较（signed 下永不相等），
  // 「同一地址 ready → failed 必须显示失败态」的分支因此永不生效。
  it("same address goes ready → failed：显示失败态，不用旧图顶住", async () => {
    (globalThis as { __scriptedSigned?: boolean }).__scriptedSigned = true;
    const scheduler = new ScriptedScheduler();
    render(
      <ReactFlowProvider>
        <StoreBridge>
          <CanvasImageLoadingContext.Provider value={scheduler as never}>
            <TooltipProvider>
              <CanvasImage nodeId="near" src="/same.png" alt="same" />
            </TooltipProvider>
          </CanvasImageLoadingContext.Provider>
        </StoreBridge>
      </ReactFlowProvider>,
    );
    await flush();
    // signed 形态：访问地址 = 逻辑 URL + 签名参数，与 displayUrl 不同
    const accessUrl = "/same.png?X-Amz-Signature=abc";
    await act(async () => scheduler.emit({ status: "ready", url: accessUrl, width: 10, height: 10 }));
    expect(screen.getByRole("img", { name: "same" }).tagName).toBe("IMG");

    // 同一地址转为 failed：stale 记录的正是这个地址，不得再拿它顶住失败态
    await act(async () => scheduler.emit({ status: "failed" }));
    expect(screen.getByRole("group", { name: "same" })).toHaveAttribute("data-image-status", "failed");
    expect(screen.getByRole("button", { name: "media.retry" })).toBeInTheDocument();
    (globalThis as { __scriptedSigned?: boolean }).__scriptedSigned = false;
  });

  it("clears pending work when the project changes and releases it on unmount", async () => {
    const items: Item[] = [{ nodeId: "near", src: "/image.png", alt: "near" }];
    const view = render(<Scene items={items} />);
    await flush();
    const old = BrowserImage.instances[0];
    view.rerender(<Scene items={items} project="second" />);
    await flush();
    expect(old.removeAttribute).toHaveBeenCalledWith("src");
    expect(BrowserImage.instances).toHaveLength(2);
    view.unmount();
    expect(BrowserImage.instances[1].removeAttribute).toHaveBeenCalledWith("src");
  });

  it("works during Strict Mode effect replay and preserves the image load callback", async () => {
    const onLoad = vi.fn();
    render(<StrictMode><Scene items={[{ nodeId: "near", src: "/image.png", alt: "near", onLoad }]} /></StrictMode>);
    await flush();
    expect(BrowserImage.instances).toHaveLength(1);
    await loaded(BrowserImage.instances[0]);
    const image = screen.getByRole("img", { name: "near" });
    fireEvent.load(image);
    expect(onLoad).toHaveBeenCalledOnce();
    expect(image).toHaveAttribute("decoding", "async");
  });

  it("shows a failed placeholder instead of silently retrying an invalid image", async () => {
    render(<Scene items={[{ nodeId: "near", src: "/broken.png", alt: "broken" }]} />);
    await flush();
    await act(async () => BrowserImage.instances[0].onerror!());
    expect(screen.getByRole("group", { name: "broken" })).toHaveAttribute("data-image-status", "failed");
    act(() => flowStore.setState({ transform: [1, 0, 1] }));
    await flush();
    expect(BrowserImage.instances).toHaveLength(1);
  });

  it("renders a delayed skeleton with the content-type icon while pending and drops it once ready", async () => {
    render(<Scene items={[{ nodeId: "near", src: "/slow.png", alt: "slow" }]} />);
    await flush();
    const placeholder = screen.getByRole("img", { name: "slow" });
    expect(placeholder).toHaveAttribute("data-image-status", "pending");
    // 骨架（延迟淡入 + 静态块）与内容类型图标在 pending 期存在
    const reveal = placeholder.querySelector(".animate-in")!;
    expect(reveal).toHaveClass("fade-in", "delay-150", "fill-mode-backwards");
    expect(reveal.querySelector('[data-slot="skeleton"]')).toHaveClass("animate-none");
    expect(reveal.querySelector("svg")).not.toBeNull();
    await loaded(BrowserImage.instances[0]);
    // ready 后骨架整体卸载，由 img 接管
    expect(screen.getByRole("img", { name: "slow" }).tagName).toBe("IMG");
    expect(document.querySelector(".animate-in")).toBeNull();
  });

  it("shapes the skeleton to the known media aspect ratio and falls back to full bleed", async () => {
    render(<Scene items={[
      { nodeId: "near", src: "/shaped.png", alt: "shaped", aspect: 1.6 },
      { nodeId: "second", src: "/plain.png", alt: "plain" },
    ]} />);
    await flush();
    // 已知宽高比：骨架为按比例定形的居中块（容器查询单位做完美 contain），图标居中叠加
    const shaped = screen.getByRole("img", { name: "shaped" }).querySelector('[data-slot="skeleton"]') as HTMLElement;
    expect(shaped).toHaveStyle({ aspectRatio: "1.6" });
    expect(shaped.style.width).toBe("min(100cqw, 160cqh)");
    expect(shaped).toHaveClass("rounded-md");
    // 未知宽高比：满铺
    const plain = screen.getByRole("img", { name: "plain" }).querySelector('[data-slot="skeleton"]') as HTMLElement;
    expect(plain).toHaveClass("absolute", "inset-0");
  });
});

describe("CanvasImage LOD（specs/canvas-media-resolution-lod.md 规则 6）", () => {
  async function settled() {
    await act(async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); });
  }

  it("0.1 缩放下首次请求低档位，不请求原图", async () => {
    const { calls, scheduler } = controlledScheduler();
    render(<LodScene scheduler={scheduler} nodes={WIDE_NODES} items={[{ nodeId: "near", src: LOD_KEY, alt: "lod" }]} />);
    await settled();
    expect(calls.map((call) => call.src)).toEqual([`${LOD_URL}?w=64`]);
    expect(calls.some((call) => call.src === LOD_URL)).toBe(false);
    scheduler.clear();
  });

  it("档位切换保留旧图直到新档位就绪", async () => {
    const { calls, scheduler } = controlledScheduler();
    const items: Item[] = [{ nodeId: "near", src: LOD_KEY, alt: "lod" }];
    const view = render(<LodScene scheduler={scheduler} nodes={WIDE_NODES} items={items} />);
    await settled();
    await act(async () => calls[0].resolve());
    const low = `${LOD_URL}?w=64`;
    expect(screen.getByRole("img", { name: "lod" }).getAttribute("src")).toBe(low);

    // 缩放到 1.0：新档位 640 在途期间仍显示旧图，不闪骨架
    view.rerender(<LodScene scheduler={scheduler} nodes={WIDE_NODES} items={items} viewport={{ settledZoom: 1, dpr: 1, zoomingOut: false }} />);
    await settled();
    expect(calls.map((call) => call.src)).toEqual([low, `${LOD_URL}?w=640`]);
    expect(screen.getByRole("img", { name: "lod" }).getAttribute("src")).toBe(low);

    await act(async () => calls[1].resolve());
    expect(screen.getByRole("img", { name: "lod" }).getAttribute("src")).toBe(`${LOD_URL}?w=640`);
    scheduler.clear();
  });

  it("逻辑源变化回到骨架，不复用旧图片", async () => {
    const { calls, scheduler } = controlledScheduler();
    const view = render(<LodScene scheduler={scheduler} nodes={WIDE_NODES} items={[{ nodeId: "near", src: LOD_KEY, alt: "lod" }]} />);
    await settled();
    await act(async () => calls[0].resolve());
    expect(screen.getByRole("img", { name: "lod" }).tagName).toBe("IMG");

    const nextKey = makeStorageKey("lod-image-next", ".png");
    view.rerender(<LodScene scheduler={scheduler} nodes={WIDE_NODES} items={[{ nodeId: "near", src: nextKey, alt: "lod" }]} />);
    await settled();
    expect(screen.getByRole("img", { name: "lod" }).tagName).toBe("SPAN");
    expect(calls.at(-1)!.src).toBe(`/api/files/${nextKey}?w=64`);
    scheduler.clear();
  });

  it("新档位失败时保留旧图，不显示失败态", async () => {
    const { calls, scheduler } = controlledScheduler();
    const items: Item[] = [{ nodeId: "near", src: LOD_KEY, alt: "lod" }];
    const view = render(<LodScene scheduler={scheduler} nodes={WIDE_NODES} items={items} />);
    await settled();
    await act(async () => calls[0].resolve());
    const low = `${LOD_URL}?w=64`;

    view.rerender(<LodScene scheduler={scheduler} nodes={WIDE_NODES} items={items} viewport={{ settledZoom: 1, dpr: 1, zoomingOut: false }} />);
    await settled();
    await act(async () => calls[1].reject());
    expect(screen.getByRole("img", { name: "lod" }).getAttribute("src")).toBe(low);
    expect(screen.queryByRole("button", { name: "media.retry" })).toBeNull();
    scheduler.clear();
  });

  it("首次档位失败（无旧图）显示失败态与手动重试", async () => {
    const { calls, scheduler } = controlledScheduler();
    render(<LodScene scheduler={scheduler} nodes={WIDE_NODES} items={[{ nodeId: "near", src: LOD_KEY, alt: "lod" }]} />);
    await settled();
    await act(async () => calls[0].reject());
    expect(screen.getByRole("group", { name: "lod" })).toHaveAttribute("data-image-status", "failed");
    expect(screen.getByRole("button", { name: "media.retry" })).toBeInTheDocument();
    scheduler.clear();
  });

  it("缩小手势中中止在途高档位，已就绪旧图继续显示且不闪骨架", async () => {
    const { calls, scheduler } = controlledScheduler();
    const items: Item[] = [{ nodeId: "near", src: LOD_KEY, alt: "lod" }];
    const view = render(<LodScene scheduler={scheduler} nodes={WIDE_NODES} items={items} />);
    await settled();
    const low = `${LOD_URL}?w=64`;
    await act(async () => calls[0].resolve());
    expect(screen.getByRole("img", { name: "lod" }).getAttribute("src")).toBe(low);

    // 放大到 1.0：640 档位在途（旧图占位）
    view.rerender(<LodScene scheduler={scheduler} nodes={WIDE_NODES} items={items} viewport={{ settledZoom: 1, dpr: 1, zoomingOut: false }} />);
    await settled();
    expect(calls[1].src).toBe(`${LOD_URL}?w=640`);
    expect(screen.getByRole("img", { name: "lod" }).getAttribute("src")).toBe(low);

    // 立即缩回（实时 zoom 0.5）：在途 640 被中止，旧图不消失
    view.rerender(<LodScene scheduler={scheduler} nodes={WIDE_NODES} items={items} viewport={{ settledZoom: 1, dpr: 1, zoomingOut: true }} />);
    act(() => flowStore.setState({ transform: [0, 0, 0.5] }));
    await settled();
    await act(async () => calls[1].resolve());
    // 被中止 job 的结果不通知，仍显示旧图而不是新档位
    expect(screen.getByRole("img", { name: "lod" }).getAttribute("src")).toBe(low);
    scheduler.clear();
  });
});
