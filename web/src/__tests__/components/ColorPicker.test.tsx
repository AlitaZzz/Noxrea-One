// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ColorPicker } from "@/components/ui/color-picker";

afterEach(cleanup);

describe("ColorPicker", () => {
  it("renders the project color contract and reports hex values", () => {
    const onChange = vi.fn();
    const onChangeComplete = vi.fn();
    render(<ColorPicker value="#123456" onChange={onChange} onChangeComplete={onChangeComplete} />);
    const picker = screen.getByLabelText("Color") as HTMLInputElement;

    expect(picker).toHaveValue("#123456");
    fireEvent.change(picker, { target: { value: "#abcdef" } });

    expect(onChange).toHaveBeenCalledWith("#abcdef");
    expect(onChangeComplete).toHaveBeenCalledWith("#abcdef");
  });

  it("maps semantic size and protects invalid values", () => {
    render(<ColorPicker value="not-a-hex" size="sm" />);
    const picker = screen.getByLabelText("Color");

    expect(picker).toHaveClass("h-6", "w-8", "border-input");
    expect(picker).toHaveValue("#000000");
  });

  it("does not emit changes while disabled", () => {
    const onChange = vi.fn();
    render(<ColorPicker value="#123456" disabled onChange={onChange} />);

    const picker = screen.getByLabelText("Color");
    fireEvent.change(picker, { target: { value: "#abcdef" } });

    expect(onChange).not.toHaveBeenCalled();
  });
});
