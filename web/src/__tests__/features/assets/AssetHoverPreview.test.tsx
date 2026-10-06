// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AssetHoverPreview } from "@/features/assets/components/AssetHoverPreview";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("AssetHoverPreview", () => {
  it("uses HoverCard delay and keeps video autoplay behavior", () => {
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
    act(() => vi.advanceTimersByTime(599));
    expect(document.querySelector("video")).toBeNull();

    act(() => vi.advanceTimersByTime(1));
    const preview = document.querySelector("video");
    expect(preview).toBeTruthy();
    expect(preview).toHaveAttribute("src", "/clip.mp4");
    expect(preview).toHaveProperty("autoplay", true);
    expect(preview).toHaveProperty("muted", true);
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
