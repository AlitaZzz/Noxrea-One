// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Checkbox } from "@/components/ui/checkbox";

afterEach(cleanup);

describe("Checkbox", () => {
  it("exposes Radix state changes through the standard callback", () => {
    const onChange = vi.fn();
    render(<label><Checkbox checked={false} onCheckedChange={onChange} />Images</label>);
    const checkbox = screen.getByRole("checkbox", { name: "Images" });

    fireEvent.click(checkbox);

    expect(onChange).toHaveBeenCalledExactlyOnceWith(true);
    expect(checkbox).toHaveAttribute("aria-checked", "false");
  });

  it("does not emit changes while disabled", () => {
    const onChange = vi.fn();
    render(<label><Checkbox checked disabled onCheckedChange={onChange} />Images</label>);

    expect(screen.getByRole("checkbox", { name: "Images" })).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: "Images" }));

    expect(onChange).not.toHaveBeenCalled();
  });
});
