// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { type InternalNode, type Node, ReactFlowProvider, useStoreApi } from "@xyflow/react";
import { type ReactNode, StrictMode, useLayoutEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";
import CanvasImage from "@/features/canvas/shared/CanvasImage";
import CanvasMediaLoadingProvider from "@/features/canvas/shared/CanvasMediaLoadingProvider";
import type { ImagePlacement } from "@/features/canvas/shared/image-visibility";

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

// jsdom 未实现 Blob object URL：fetch 桩把原始 src 挂到 Blob 上，
// createObjectURL 桩据此建立 objectURL → 原始 src 的映射，供断言回查
const objectSources = new Map<string, string>();
function sourceOf(url: string | null | undefined): string | undefined {
  return url ? objectSources.get(url) : undefined;
}

let flowStore: ReturnType<typeof useStoreApi>;
function node(id: string, x: number, y = 0): InternalNode {
  const userNode: Node = { id, position: { x, y }, data: {}, measured: { width: 400, height: 328 } };
  return { ...userNode, measured: { width: 400, height: 328 }, internals: { positionAbsolute: { x, y }, z: 0, userNode } };
}
const initialNodes = new Map([["near", node("near", 0)], ["far", node("far", 5000)], ["second", node("second", 900)]]);

function StoreBridge({ children }: { children: ReactNode }) {
  const api = useStoreApi();
  useLayoutEffect(() => {
    flowStore = api;
    api.setState({ width: 800, height: 600, transform: [0, 0, 1], nodeLookup: new Map(initialNodes) });
  }, [api]);
  return children;
}

type Item = { nodeId: string; src: string; alt: string; placement?: ImagePlacement; onLoad?: () => void; className?: string; style?: React.CSSProperties; aspect?: number };
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

async function flush() { await act(async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); }); }
async function loaded(image: BrowserImage) {
  await act(async () => { image.onload?.(); for (let i = 0; i < 12; i++) await Promise.resolve(); });
}

beforeEach(() => {
  BrowserImage.instances = [];
  objectSources.clear();
  vi.stubGlobal("Image", BrowserImage);
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
    const src = String(input);
    return Promise.resolve({ ok: true, blob: () => Promise.resolve(Object.assign(new Blob(["img"]), { source: src })) });
  }));
  let counter = 0;
  (URL as unknown as Record<string, unknown>).createObjectURL = vi.fn((blob: Blob & { source?: string }) => {
    const url = `blob:img-${++counter}`;
    objectSources.set(url, blob.source ?? "");
    return url;
  });
  (URL as unknown as Record<string, unknown>).revokeObjectURL = vi.fn((url: string) => { objectSources.delete(url); });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete (URL as unknown as Record<string, unknown>).createObjectURL;
  delete (URL as unknown as Record<string, unknown>).revokeObjectURL;
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
    expect(sourceOf(screen.getByRole("img", { name: "first" }).getAttribute("src"))).toBe("/shared.png");
    expect(sourceOf(screen.getByRole("img", { name: "second" }).getAttribute("src"))).toBe("/shared.png");
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
    expect(sourceOf(BrowserImage.instances[0].src)).toBe("/far.png");
    await loaded(BrowserImage.instances[0]);
    expect(sourceOf(screen.getByRole("img", { name: "far" }).getAttribute("src"))).toBe("/far.png");
    act(() => flowStore.setState({ transform: [0, 0, 1] }));
    await flush();
    expect(sourceOf(screen.getByRole("img", { name: "far" }).getAttribute("src"))).toBe("/far.png");
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
    expect(sourceOf(BrowserImage.instances[0].src)).toBe("/child.png");
  });

  it("loads an expanded card visible above a distant main node", async () => {
    render(<Scene items={[{ nodeId: "far", src: "/expanded.png", alt: "expanded", placement: { row: -6 } }]} />);
    act(() => flowStore.setState({ nodeLookup: new Map([["far", node("far", 100, 2000)]]) }));
    await flush();
    expect(sourceOf(BrowserImage.instances[0].src)).toBe("/expanded.png");
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
    expect(sourceOf(screen.getByRole("img", { name: "second" }).getAttribute("src"))).toBe("/shared.png");
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
    expect(sourceOf(screen.getByRole("img", { name: "near" }).getAttribute("src"))).toBe("/near.png");
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
    expect(sourceOf(screen.getByRole("img", { name: "near" }).getAttribute("src"))).not.toBe("/old.png");
    await loaded(BrowserImage.instances.at(-1)!);
    expect(sourceOf(screen.getByRole("img", { name: "near" }).getAttribute("src"))).toBe("/new.png");
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
    // 骨架（官方动画工具类延迟淡入 + animate-pulse 块）与内容类型图标在 pending 期存在
    const reveal = placeholder.querySelector(".animate-in")!;
    expect(reveal).toHaveClass("fade-in", "delay-150", "fill-mode-both");
    expect(reveal.querySelector(".animate-pulse")).not.toBeNull();
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
    const shaped = screen.getByRole("img", { name: "shaped" }).querySelector(".animate-pulse") as HTMLElement;
    expect(shaped).toHaveStyle({ aspectRatio: "1.6" });
    expect(shaped.style.width).toBe("min(100cqw, 160cqh)");
    expect(shaped).toHaveClass("rounded-md");
    // 未知宽高比：满铺
    const plain = screen.getByRole("img", { name: "plain" }).querySelector(".animate-pulse") as HTMLElement;
    expect(plain).toHaveClass("absolute", "inset-0");
  });
});
