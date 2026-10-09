// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HoverCard, HoverCardContent, HoverCardMediaContent, HoverCardTrigger } from "@/components/ui/hover-card";

afterEach(cleanup);

describe("HoverCard", () => {
  it("renders the shadcn content contract when controlled", () => {
    render(
      <HoverCard open>
        <HoverCardTrigger asChild>
          <button type="button">Open</button>
        </HoverCardTrigger>
        <HoverCardContent side="right" align="start">Panel</HoverCardContent>
      </HoverCard>,
    );

    expect(screen.getByText("Panel").closest("[data-slot='hover-card-content']")).toHaveAttribute("data-side", "right");
  });
});

describe("HoverCardMediaContent", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  function preview(src: string, mediaType: "image" | "video" = "image", open = true) {
    return (
      <HoverCard open={open}>
        <HoverCardTrigger asChild><button type="button">Media</button></HoverCardTrigger>
        <HoverCardMediaContent src={src} mediaType={mediaType} />
      </HoverCard>
    );
  }

  function imageDimensions(image: HTMLImageElement) {
    Object.defineProperties(image, {
      naturalWidth: { value: 800 },
      naturalHeight: { value: 1200 },
    });
  }

  it("decodes an already cached image without relying on another load event", async () => {
    render(preview("/cached.png"));
    const image = document.querySelector("img")!;
    imageDimensions(image);
    Object.defineProperty(image, "complete", { value: true });
    const decode = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(image, "decode", { value: decode });
    await act(() => vi.advanceTimersByTimeAsync(50));

    expect(decode).toHaveBeenCalledOnce();
    expect(document.querySelector('[data-slot="hover-card-content"]')).toBeVisible();
  });

  it("does not hide a playing preview on another loadeddata event", async () => {
    render(preview("/clip.mp4", "video"));
    const video = document.querySelector("video")!;
    Object.defineProperties(video, {
      videoWidth: { value: 1280 },
      videoHeight: { value: 720 },
      readyState: { value: 2 },
    });
    fireEvent.loadedData(video);
    await act(() => vi.advanceTimersByTimeAsync(50));
    const content = document.querySelector('[data-slot="hover-card-content"]');
    expect(content).toBeVisible();
    fireEvent.loadedData(video);
    expect(content).toBeVisible();
  });

  it("ignores an older decode completion after switching sources", async () => {
    const { rerender } = render(preview("/old.png"));
    const oldImage = document.querySelector("img")!;
    imageDimensions(oldImage);
    let finishOld!: () => void;
    Object.defineProperty(oldImage, "decode", {
      value: () => new Promise<void>((resolve) => { finishOld = resolve; }),
    });
    fireEvent.load(oldImage);
    rerender(preview("/new.png"));
    const newImage = document.querySelector("img")!;
    expect(newImage).not.toBe(oldImage);
    await act(async () => finishOld());
    await act(() => vi.advanceTimersByTimeAsync(50));
    expect(document.querySelector('[data-slot="hover-card-content"]')).not.toBeVisible();

    imageDimensions(newImage);
    Object.defineProperty(newImage, "decode", { value: vi.fn().mockResolvedValue(undefined) });
    await act(async () => fireEvent.load(newImage));
    await act(() => vi.advanceTimersByTimeAsync(50));
    expect(document.querySelector('[data-slot="hover-card-content"]')).toBeVisible();
  });

  it("shows a visible error and retries after a rejected decode", async () => {
    render(preview("/broken.png"));
    const image = document.querySelector("img")!;
    imageDimensions(image);
    Object.defineProperty(image, "decode", { value: vi.fn().mockRejectedValue(new Error("decode failed")) });
    fireEvent.load(image);
    await act(() => vi.advanceTimersByTimeAsync(50));
    const content = document.querySelector('[data-slot="hover-card-content"]');
    expect(content).toBeVisible();
    expect(content).toHaveAttribute("data-media-state", "error");
    expect(screen.getByRole("alert")).toHaveTextContent("media.previewLoadFailed");

    fireEvent.click(screen.getByRole("button", { name: "media.retry" }));
    const retryImage = document.querySelector("img")!;
    expect(retryImage).not.toBe(image);
    expect(content).not.toBeVisible();
    imageDimensions(retryImage);
    Object.defineProperty(retryImage, "decode", { value: vi.fn().mockResolvedValue(undefined) });
    fireEvent.load(retryImage);
    await act(() => vi.advanceTimersByTimeAsync(500));
    expect(content).toHaveAttribute("data-media-state", "prepared");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("reveals a decoded SVG even when it has no intrinsic dimensions", async () => {
    render(preview("/vector.svg"));
    const image = document.querySelector("img")!;
    Object.defineProperty(image, "decode", { value: vi.fn().mockResolvedValue(undefined) });
    fireEvent.load(image);
    await act(() => vi.advanceTimersByTimeAsync(50));
    expect(document.querySelector('[data-slot="hover-card-content"]')).toBeVisible();
  });

  it("shows a visible error and remounts a failed video on retry", () => {
    render(preview("/broken.mp4", "video"));
    const video = document.querySelector("video")!;
    fireEvent.error(video);
    const content = document.querySelector('[data-slot="hover-card-content"]')!;
    expect(content).toBeVisible();
    expect(content).toHaveAttribute("data-media-state", "error");
    expect(screen.getByRole("alert")).toHaveTextContent("media.previewLoadFailed");

    fireEvent.click(screen.getByRole("button", { name: "media.retry" }));
    const retryVideo = document.querySelector("video")!;
    expect(retryVideo).not.toBe(video);
    expect(content).not.toBeVisible();
  });

  it("invalidates a pending decode when the media emits an error", async () => {
    render(preview("/failed.png"));
    const image = document.querySelector("img")!;
    imageDimensions(image);
    let finishDecode!: () => void;
    Object.defineProperty(image, "decode", {
      value: () => new Promise<void>((resolve) => { finishDecode = resolve; }),
    });
    fireEvent.load(image);
    fireEvent.error(image);
    await act(async () => finishDecode());
    await act(() => vi.advanceTimersByTimeAsync(50));
    expect(document.querySelector('[data-slot="hover-card-content"]')).toHaveAttribute("data-media-state", "error");
  });

  it("resets readiness when a decoded preview closes and reopens", async () => {
    const { rerender } = render(preview("/clip.mp4", "video"));
    const video = document.querySelector("video")!;
    Object.defineProperties(video, {
      videoWidth: { value: 1280 },
      videoHeight: { value: 720 },
      readyState: { value: 2 },
    });
    fireEvent.loadedData(video);
    await act(() => vi.advanceTimersByTimeAsync(50));
    expect(document.querySelector('[data-slot="hover-card-content"]')).toBeVisible();
    rerender(preview("/clip.mp4", "video", false));
    await act(() => vi.advanceTimersByTimeAsync(200));
    expect(document.querySelector("video")).toBeNull();
    rerender(preview("/clip.mp4", "video"));
    expect(document.querySelector("video")).not.toBe(video);
    expect(document.querySelector('[data-slot="hover-card-content"]')).not.toBeVisible();
  });

  it("lets pointer hit testing pass through the positioning wrapper", () => {
    const styles = document.createElement("style");
    const stylesheet = resolve(dirname(fileURLToPath(import.meta.url)), "../../components/ui/hover-card.css");
    styles.textContent = readFileSync(stylesheet, "utf8");
    document.head.appendChild(styles);
    try {
      render(
        <HoverCard open>
          <HoverCardTrigger asChild><button type="button">Reference</button></HoverCardTrigger>
          <HoverCardMediaContent src="/portrait.mp4" mediaType="video" />
        </HoverCard>,
      );
      const content = document.querySelector('[data-slot="hover-card-content"]')!;
      const wrapper = content.parentElement!;
      expect(wrapper).toHaveAttribute("data-radix-popper-content-wrapper");
      expect(content).not.toBeVisible();
      expect(getComputedStyle(wrapper).pointerEvents).toBe("none");
      expect(content).toHaveClass("pointer-events-auto");
      render(<HoverCard open><HoverCardTrigger asChild><button>Plain</button></HoverCardTrigger><HoverCardContent>Plain content</HoverCardContent></HoverCard>);
      const plainContent = screen.getByText("Plain content");
      expect(getComputedStyle(plainContent.parentElement!).pointerEvents).not.toBe("none");
    } finally {
      styles.remove();
    }
  });
});
