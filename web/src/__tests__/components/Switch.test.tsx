// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Switch } from "@/components/ui/switch";

afterEach(cleanup);

describe("Switch", () => {
  it("uses the shadcn switch contract and state classes", () => {
    render(<Switch checked={false} />);
    const toggle = screen.getByRole("switch");

    expect(toggle).toHaveAttribute("data-slot", "switch");
    expect(toggle).toHaveClass("rounded-full", "data-checked:bg-primary", "data-unchecked:bg-input");
    expect(toggle.querySelector('[data-slot="switch-thumb"]')).toBeTruthy();
  });

  it("exposes checked state through switch semantics and toggles boolean values", () => {
    const onChange = vi.fn();
    render(<Switch checked={false} size="sm" onCheckedChange={onChange} />);
    const toggle = screen.getByRole("switch");

    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(toggle).toHaveAttribute("data-size", "sm");
    fireEvent.click(toggle);

    expect(onChange).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("does not toggle while disabled", () => {
    const onChange = vi.fn();
    render(<Switch checked disabled onCheckedChange={onChange} />);
    const toggle = screen.getByRole("switch");

    expect(toggle).toBeDisabled();
    fireEvent.click(toggle);

    expect(onChange).not.toHaveBeenCalled();
  });
});
