// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AssetHoverPreview } from "@/features/assets/components/AssetHoverPreview";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("AssetHoverPreview", () => {
  it("uses HoverCard delay and keeps video autoplay behavior", async () => {
    vi.useFakeTimers();

    render(
      <AssetHoverPreview
        asset={{ name: "clip", mediaType: "video", sourceUrl: "/clip.mp4" }}
      >
        <button type="button">Asset</button>
      </AssetHoverPreview>,
    );

    const trigger = screen.getByRole("button", { name: "Asset" });
    fireEvent.focus(trigger);
    await act(() => vi.advanceTimersByTimeAsync(599));
    expect(document.querySelector("video")).toBeNull();

    await act(() => vi.advanceTimersByTimeAsync(1));
    const preview = document.querySelector("video");
    expect(preview).toBeTruthy();
    expect(preview).toHaveAttribute("src", "/clip.mp4");
    expect(preview).toHaveProperty("autoplay", true);
    expect(preview).toHaveProperty("muted", true);
    const content = document.querySelector('[data-slot="hover-card-content"]');
    expect(content).not.toBeVisible();
    Object.defineProperties(preview, {
      readyState: { value: 2 },
      videoWidth: { value: 1280 },
      videoHeight: { value: 720 },
    });
    fireEvent.loadedMetadata(preview!);
    expect(content).not.toBeVisible();
    fireEvent.loadedData(preview!);
    await act(() => vi.advanceTimersByTimeAsync(50));
    expect(content).toBeVisible();
  });

  it("keeps image previews hidden until decoding has completed", async () => {
    vi.useFakeTimers();
    render(
      <AssetHoverPreview asset={{ name: "portrait", mediaType: "image", sourceUrl: "/portrait.png" }}>
        <button type="button">Image</button>
      </AssetHoverPreview>,
    );
    fireEvent.focus(screen.getByRole("button", { name: "Image" }));
    await act(() => vi.advanceTimersByTimeAsync(600));
    const image = document.querySelector("img")!;
    const content = document.querySelector('[data-slot="hover-card-content"]');
    Object.defineProperties(image, {
      naturalWidth: { value: 800 },
      naturalHeight: { value: 1200 },
      decode: { value: vi.fn().mockResolvedValue(undefined) },
    });
    expect(content).not.toBeVisible();
    await act(async () => fireEvent.load(image));
    await act(() => vi.advanceTimersByTimeAsync(50));
    expect(content).toBeVisible();
  });

  it("does not create a hover card for audio assets", () => {
    render(
      <AssetHoverPreview
        asset={{ name: "song", mediaType: "audio", sourceUrl: "/song.mp3" }}
      >
        <button type="button">Asset</button>
      </AssetHoverPreview>,
    );

    expect(screen.getByRole("button", { name: "Asset" })).toBeTruthy();
    expect(document.querySelector('[data-slot="hover-card"]')).toBeNull();
  });

  it("does not treat an unsupported media type as an image", () => {
    render(
      <AssetHoverPreview
        asset={{ name: "document", mediaType: "", sourceUrl: "/document.pdf" }}
      >
        <button type="button">Document</button>
      </AssetHoverPreview>,
    );

    expect(screen.getByRole("button", { name: "Document" })).toBeTruthy();
    expect(document.querySelector('[data-slot="hover-card"]')).toBeNull();
  });

  it("previews text content without requiring a source URL", () => {
    vi.useFakeTimers();

    render(
      <AssetHoverPreview
        asset={{ name: "note", mediaType: "text", plainText: "第一行\n第二行" }}
      >
        <button type="button">Note</button>
      </AssetHoverPreview>,
    );

    fireEvent.focus(screen.getByRole("button", { name: "Note" }));
    act(() => vi.advanceTimersByTime(600));

    expect(document.querySelector('[data-slot="hover-card-content"]')?.textContent).toBe("第一行\n第二行");
    expect(document.querySelector("img")).toBeNull();
    expect(document.querySelector("video")).toBeNull();
  });
});
