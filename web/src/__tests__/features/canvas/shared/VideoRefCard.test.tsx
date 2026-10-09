// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import VideoRefCard from "@/features/canvas/shared/VideoRefCard";

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

const props = { src: "/portrait.mp4", nodeId: "target", index: 0, onReorder: vi.fn() };
const previewSelector = '[data-slot="hover-card-content"] video';

async function hover(trigger: Element) {
  fireEvent.pointerEnter(trigger, { pointerType: "mouse" });
  await act(() => vi.advanceTimersByTimeAsync(160));
}

describe("VideoRefCard", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("hides the preview until the first frame is ready, then uses the video aspect ratio", async () => {
    render(<VideoRefCard {...props} />);
    await hover(document.querySelector('[data-slot="hover-card-trigger"]')!);
    const video = document.querySelector<HTMLVideoElement>(previewSelector)!;

    const content = video.closest('[data-slot="hover-card-content"]');
    expect(content).not.toBeVisible();
    expect(video).toHaveProperty("autoplay", true);
    expect(video).toHaveProperty("muted", true);
    expect(video).toHaveProperty("loop", true);

    Object.defineProperties(video, {
      videoWidth: { value: 704 },
      videoHeight: { value: 1280 },
      readyState: { value: 2 },
    });
    fireEvent.loadedMetadata(video);
    expect(content).not.toBeVisible();
    fireEvent.loadedData(video);
    await act(() => vi.advanceTimersByTimeAsync(50));
    fireEvent.playing(video);

    expect(document.querySelector(previewSelector)).toBe(video);
    expect(content).toBeVisible();
    expect(video).not.toHaveAttribute("width");
    expect(video).not.toHaveAttribute("height");
    expect(video).toHaveClass("max-h-[240px]", "max-w-[240px]", "object-contain");
  });

  it("unmounts playback on leave and opens a stable preview on the next hover", async () => {
    render(<VideoRefCard {...props} />);
    const trigger = document.querySelector('[data-slot="hover-card-trigger"]')!;
    await hover(trigger);
    const first = document.querySelector(previewSelector);
    fireEvent.pointerLeave(trigger, { pointerType: "mouse" });
    await act(() => vi.advanceTimersByTimeAsync(200));
    expect(document.querySelector(previewSelector)).toBeNull();

    await hover(trigger);
    const next = document.querySelector(previewSelector);
    expect(next).not.toBe(first);
    expect(next?.closest('[data-slot="hover-card-content"]')).not.toBeVisible();
  });

  it("closes playback during a drag without replacing the thumbnail trigger", async () => {
    const { rerender } = render(<VideoRefCard {...props} />);
    const trigger = document.querySelector('[data-slot="hover-card-trigger"]')!;
    const thumbnail = trigger.querySelector("video");
    await hover(trigger);
    rerender(<VideoRefCard {...props} dragActive />);
    await act(() => vi.advanceTimersByTimeAsync(200));

    expect(document.querySelector(previewSelector)).toBeNull();
    expect(document.querySelector('[data-slot="hover-card-trigger"]')).toBe(trigger);
    expect(trigger.querySelector("video")).toBe(thumbnail);
    await hover(trigger);
    expect(document.querySelector(previewSelector)).toBeNull();
  });
});
