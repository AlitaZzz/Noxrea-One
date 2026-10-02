// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Input } from "@/components/ui/input";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupClearButton,
  InputGroupInput,
  InputGroupText,
} from "@/components/ui/input-group";

afterEach(cleanup);

describe("Input", () => {
  it("uses the shadcn input contract and official state classes", () => {
    render(<Input aria-label="Name" aria-invalid defaultValue="value" />);
    const input = screen.getByRole("textbox");

    expect(input).toHaveAttribute("data-slot", "input");
    expect(input).toHaveClass("h-9", "rounded-md", "border-input", "aria-invalid:border-destructive");
  });

  it("updates an uncontrolled value and reports changes", () => {
    const onChange = vi.fn();
    render(<Input aria-label="Name" defaultValue="initial" onChange={onChange} />);
    const input = screen.getByRole("textbox") as HTMLInputElement;

    fireEvent.change(input, { target: { value: "updated" } });

    expect(input.value).toBe("updated");
    expect(onChange).toHaveBeenCalledOnce();
  });

  it("keeps a controlled value owned by the caller", () => {
    const onChange = vi.fn();
    render(<Input aria-label="Name" value="initial" onChange={onChange} />);
    const input = screen.getByRole("textbox") as HTMLInputElement;

    fireEvent.change(input, { target: { value: "updated" } });

    expect(input.value).toBe("initial");
    expect(onChange).toHaveBeenCalledOnce();
  });

  it("composes prefix, count, status, and clear behavior with InputGroup", () => {
    const onClear = vi.fn();
    render(
      <InputGroup>
        <InputGroupAddon><span>Prefix</span></InputGroupAddon>
        <InputGroupInput aria-label="Name" aria-invalid defaultValue="value" maxLength={12} />
        <InputGroupAddon align="inline-end"><InputGroupText>5 / 12</InputGroupText><InputGroupClearButton onClear={onClear} /></InputGroupAddon>
      </InputGroup>,
    );
    const input = screen.getByRole("textbox");

    expect(screen.getByText("Prefix")).toBeTruthy();
    expect(screen.getByText("5 / 12")).toBeTruthy();
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAttribute("data-slot", "input-group-control");
    fireEvent.click(screen.getByRole("button", { name: "Clear input" }));
    expect(onClear).toHaveBeenCalledOnce();
  });

  it("uses the native key handler for Enter", () => {
    const onKeyDown = vi.fn();
    render(<Input aria-label="Name" onKeyDown={onKeyDown} />);

    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });

    expect(onKeyDown).toHaveBeenCalledOnce();
  });

  it("forwards the native input ref", () => {
    const ref = createRef<HTMLInputElement>();
    render(<Input ref={ref} aria-label="Name" defaultValue="value" />);
    const input = screen.getByRole("textbox") as HTMLInputElement;

    ref.current?.focus();
    expect(document.activeElement).toBe(input);
    ref.current?.select();
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(input.value.length);
  });
});
