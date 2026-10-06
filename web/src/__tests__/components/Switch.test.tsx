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
    expect(toggle).toHaveClass("rounded-full", "data-[state=checked]:bg-primary", "data-[state=unchecked]:bg-input");
    const thumb = toggle.querySelector('[data-slot="switch-thumb"]');
    expect(thumb).toHaveAttribute("data-state", "unchecked");
    expect(thumb).toHaveClass("data-[state=checked]:translate-x-[calc(100%-2px)]", "data-[state=unchecked]:translate-x-0");
  });

  it("uses Radix data-state for checked track and thumb", () => {
    render(<Switch checked />);
    const toggle = screen.getByRole("switch");
    const thumb = toggle.querySelector('[data-slot="switch-thumb"]');

    expect(toggle).toHaveAttribute("data-state", "checked");
    expect(thumb).toHaveAttribute("data-state", "checked");
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
