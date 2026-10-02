// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { NumberInput } from "@/components/ui/number-input";

afterEach(cleanup);

describe("NumberInput", () => {
  it("emits numbers while preserving an empty editing state", () => {
    const onChange = vi.fn();
    function Harness() {
      const [value, setValue] = useState<number | null>(12);
      return <NumberInput aria-label="Amount" value={value} onChange={(next) => { onChange(next); setValue(next); }} controls={false} />;
    }
    render(<Harness />);
    const input = screen.getByRole("spinbutton") as HTMLInputElement;

    fireEvent.change(input, { target: { value: "13.5" } });
    expect(onChange).toHaveBeenLastCalledWith(13.5);
    expect(input.value).toBe("13.5");

    fireEvent.change(input, { target: { value: "" } });
    expect(onChange).toHaveBeenLastCalledWith(null);
    expect(input.value).toBe("");
  });

  it("steps values and clamps them to the configured range", () => {
    const onChange = vi.fn();
    function Harness() {
      const [value, setValue] = useState<number | null>(1);
      return <NumberInput aria-label="Amount" value={value} min={0} max={1.2} step={0.1} onChange={(next) => { onChange(next); setValue(next); }} />;
    }
    render(<Harness />);

    fireEvent.click(screen.getByRole("button", { name: "Increase value" }));
    expect(onChange).toHaveBeenLastCalledWith(1.1);
    fireEvent.click(screen.getByRole("button", { name: "Increase value" }));
    expect(onChange).toHaveBeenLastCalledWith(1.2);
    fireEvent.click(screen.getByRole("button", { name: "Increase value" }));
    expect(onChange).toHaveBeenLastCalledWith(1.2);
  });

  it("supports suffix, semantic variants, and Enter handling", () => {
    const onPressEnter = vi.fn();
    render(
      <NumberInput
        aria-label="Amount"
        value={2}
        suffix="x"
        controls={false}
        onPressEnter={onPressEnter}
      />,
    );
    const input = screen.getByRole("spinbutton");

    fireEvent.keyDown(input, { key: "Enter" });

    expect(screen.getByText("x")).toBeInTheDocument();
    expect(input).toHaveAttribute("data-slot", "input-group-control");
    expect(input).toHaveClass("h-9", "rounded-none", "border-0");
    expect(onPressEnter).toHaveBeenCalledOnce();
  });
});
