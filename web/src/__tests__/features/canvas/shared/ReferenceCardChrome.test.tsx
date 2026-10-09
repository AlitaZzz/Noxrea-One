// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ReferenceHoverPreview,
  ReferenceIndexBadge,
  ReferenceRemoveButton,
} from "@/features/canvas/shared/ReferenceCardChrome";

afterEach(cleanup);

describe("ReferenceCardChrome", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("uses HoverCard for delayed previews and shared card controls", async () => {
    const onRemove = vi.fn();

    render(
      <ReferenceHoverPreview preview={<span>Preview</span>}>
        <button type="button">Reference</button>
      </ReferenceHoverPreview>,
    );
    render(<ReferenceIndexBadge>Image 1</ReferenceIndexBadge>);
    render(<ReferenceRemoveButton ariaLabel="Remove" onRemove={onRemove} />);

    const trigger = screen.getByRole("button", { name: "Reference" });
    fireEvent.pointerEnter(trigger, { pointerType: "mouse" });
    await act(() => vi.advanceTimersByTimeAsync(160));

    expect(screen.getByText("Preview")).toBeInTheDocument();
    expect(screen.getByText("Image 1")).toHaveClass("bg-black/55", "text-white");
    const removeButton = screen.getByRole("button", { name: "Remove" });
    expect(removeButton).toHaveClass("size-4", "bg-popover", "text-popover-foreground", "border-border", "hover:bg-accent", "dark:hover:bg-accent", "focus-visible:opacity-100");
    fireEvent.click(removeButton);
    expect(onRemove).toHaveBeenCalledOnce();
  });

  it("does not open a preview while disabled", async () => {
    render(
      <ReferenceHoverPreview disabled preview={<span>Preview</span>}>
        <button type="button">Reference</button>
      </ReferenceHoverPreview>,
    );

    fireEvent.pointerEnter(screen.getByRole("button", { name: "Reference" }), { pointerType: "mouse" });
    await act(() => vi.advanceTimersByTimeAsync(200));
    expect(screen.queryByText("Preview")).toBeNull();
  });
});
