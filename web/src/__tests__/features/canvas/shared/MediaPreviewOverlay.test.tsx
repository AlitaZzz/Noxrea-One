// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import MediaPreviewOverlay from "@/features/canvas/shared/MediaPreviewOverlay";

afterEach(cleanup);

describe("MediaPreviewOverlay", () => {
  const items = [
    { url: "/one.png", mediaType: "image" as const },
    { url: "/two.png", mediaType: "image" as const },
  ];

  it("uses the controlled Dialog and navigates with arrow keys", () => {
    const onClose = vi.fn();
    const onIndexChange = vi.fn();

    render(
      <MediaPreviewOverlay
        open
        items={items}
        index={0}
        onIndexChange={onIndexChange}
        onClose={onClose}
      />,
    );

    expect(screen.getByRole("dialog")).toBeTruthy();
    const nextButton = screen.getByRole("button", { name: "Next media" });
    expect(nextButton.className).not.toContain("active:!");
    expect(nextButton.parentElement?.className).toContain("top-1/2");
    expect(nextButton.parentElement?.className).toContain("-translate-y-1/2");
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(onIndexChange).toHaveBeenCalledWith(1);
  });

  it("closes through the Dialog escape behavior", () => {
    const onClose = vi.fn();

    render(
      <MediaPreviewOverlay
        open
        items={[items[0]]}
        index={0}
        onClose={onClose}
      />,
    );

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });
});
