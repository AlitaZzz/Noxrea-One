// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import ImageRefCard from "@/features/canvas/shared/ImageRefCard";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/features/canvas/shared/reveal-node", () => ({
  findReferenceNode: vi.fn(),
  useRevealCanvasNode: () => vi.fn(),
}));
vi.mock("@/features/canvas/stores/canvas-store", () => ({
  useCanvasStore: { getState: () => ({ nodes: [], edges: [] }) },
}));

const props = { src: "/api/files/portrait.png", nodeId: "target", index: 0, onReorder: vi.fn() };

async function openPreview() {
  const trigger = document.querySelector('[data-slot="hover-card-trigger"]')!;
  fireEvent.pointerEnter(trigger, { pointerType: "mouse" });
  await act(() => vi.advanceTimersByTimeAsync(160));
  const content = document.querySelector('[data-slot="hover-card-content"]')!;
  const image = content.querySelector("img")!;
  Object.defineProperties(image, {
    naturalWidth: { value: 800 },
    naturalHeight: { value: 1200 },
  });
  return { trigger, content, image };
}

describe("ImageRefCard", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("waits for image decoding and layout before showing the natural-size preview", async () => {
    render(<ImageRefCard {...props} />);
    const { content, image } = await openPreview();
    let finishDecode!: () => void;
    const decode = vi.fn(() => new Promise<void>((resolve) => { finishDecode = resolve; }));
    Object.defineProperty(image, "decode", { value: decode });

    expect(image).toHaveAttribute("src", "/api/files/portrait.png?w=480");
    expect(content).not.toBeVisible();
    fireEvent.load(image);
    expect(decode).toHaveBeenCalledOnce();
    expect(content).not.toBeVisible();

    await act(async () => finishDecode());
    expect(content).not.toBeVisible();
    await act(() => vi.advanceTimersByTimeAsync(50));
    expect(content).toBeVisible();
    expect(content.querySelector("img")).toBe(image);
    expect(image).toHaveClass("max-h-[240px]", "max-w-[240px]", "object-contain");
  });

  it("shows a visible error for failed previews", async () => {
    render(<ImageRefCard {...props} />);
    const { content, image } = await openPreview();
    fireEvent.error(image);
    await act(() => vi.advanceTimersByTimeAsync(50));
    expect(content).toBeVisible();
    expect(content).toHaveAttribute("data-media-state", "error");
    expect(content).toHaveTextContent("media.previewLoadFailed");
    expect(content.querySelector("button")).toHaveTextContent("media.retry");
  });

  it("does not show a late decoded image after the pointer has left", async () => {
    render(<ImageRefCard {...props} />);
    const { trigger, image } = await openPreview();
    let finishDecode!: () => void;
    Object.defineProperty(image, "decode", {
      value: () => new Promise<void>((resolve) => { finishDecode = resolve; }),
    });
    fireEvent.load(image);
    fireEvent.pointerLeave(trigger, { pointerType: "mouse" });
    await act(() => vi.advanceTimersByTimeAsync(200));
    await act(async () => finishDecode());
    await act(() => vi.advanceTimersByTimeAsync(50));
    expect(document.querySelector('[data-slot="hover-card-content"]')).toBeNull();
  });
});
