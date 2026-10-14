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

  // 回归：`type="number"` 在 "1." 部分小数状态下 .value 读数为空（badInput），
  // 受控回写会在下一次键入时把可见文本抹掉（变速面板数字被"吃掉"的根因）。
  // 修复后组件以 text + 聚焦期草稿工作：键入原文全程可见，失焦才归一化。
  it("keeps the typed draft visible through partial decimals and normalizes on blur", () => {
    const onChange = vi.fn();
    function Harness() {
      const [value, setValue] = useState<number | null>(1.66);
      return (
        <NumberInput
          aria-label="Amount"
          value={value}
          min={0.1}
          max={4}
          step={0.05}
          onChange={(next) => { onChange(next); setValue(next); }}
        />
      );
    }
    render(<Harness />);
    const input = screen.getByRole("spinbutton") as HTMLInputElement;
    expect(input.value).toBe("1.66");

    fireEvent.change(input, { target: { value: "1" } });
    expect(onChange).toHaveBeenLastCalledWith(1);
    expect(input.value).toBe("1");

    fireEvent.change(input, { target: { value: "1." } });
    expect(onChange).toHaveBeenLastCalledWith(1);
    expect(input.value).toBe("1.");

    fireEvent.change(input, { target: { value: "1.0" } });
    expect(onChange).toHaveBeenLastCalledWith(1);
    expect(input.value).toBe("1.0");

    fireEvent.change(input, { target: { value: "1.05" } });
    expect(onChange).toHaveBeenLastCalledWith(1.05);
    expect(input.value).toBe("1.05");

    fireEvent.blur(input);
    expect(input.value).toBe("1.05");
  });

  it("does not erase non-numeric text while typing; normalizes on blur", () => {
    const onChange = vi.fn();
    function Harness() {
      const [value, setValue] = useState<number | null>(2);
      return (
        <NumberInput
          aria-label="Amount"
          value={value}
          controls={false}
          onChange={(next) => { onChange(next); setValue(next); }}
        />
      );
    }
    render(<Harness />);
    const input = screen.getByRole("spinbutton") as HTMLInputElement;

    fireEvent.change(input, { target: { value: "abc" } });
    expect(onChange).toHaveBeenLastCalledWith(null);
    expect(input.value).toBe("abc");

    fireEvent.blur(input);
    expect(input.value).toBe("");
  });

  it("follows external value changes while focused", () => {
    function Harness() {
      const [value, setValue] = useState<number | null>(1);
      return (
        <>
          <NumberInput aria-label="Amount" value={value} onChange={setValue} />
          <button type="button" onClick={() => setValue(2.5)}>external</button>
        </>
      );
    }
    render(<Harness />);
    const input = screen.getByRole("spinbutton") as HTMLInputElement;

    fireEvent.change(input, { target: { value: "1." } });
    expect(input.value).toBe("1.");

    // 聚焦期间外部改值（联动滑杆等）→ 草稿放弃，跟随外部值
    fireEvent.click(screen.getByRole("button", { name: "external" }));
    expect(input.value).toBe("2.5");
  });

  it("steps with ArrowUp / ArrowDown, clamped to the configured range", () => {
    const onChange = vi.fn();
    function Harness() {
      const [value, setValue] = useState<number | null>(1);
      return (
        <NumberInput
          aria-label="Amount"
          value={value}
          min={0.1}
          max={1.2}
          step={0.05}
          onChange={(next) => { onChange(next); setValue(next); }}
        />
      );
    }
    render(<Harness />);
    const input = screen.getByRole("spinbutton") as HTMLInputElement;

    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(onChange).toHaveBeenLastCalledWith(1.05);
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(onChange).toHaveBeenLastCalledWith(1.1);
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(onChange).toHaveBeenLastCalledWith(1.05);
    expect(input.value).toBe("1.05");
  });

  // precision：键入小数位超限直接截断（与 step / 属主 clamp 精度对齐，避免失焦跳变）
  it("truncates typed decimals beyond the configured precision", () => {
    const onChange = vi.fn();
    function Harness() {
      const [value, setValue] = useState<number | null>(1);
      return (
        <NumberInput
          aria-label="Amount"
          value={value}
          min={0.1}
          max={4}
          step={0.05}
          precision={2}
          onChange={(next) => { onChange(next); setValue(next); }}
        />
      );
    }
    render(<Harness />);
    const input = screen.getByRole("spinbutton") as HTMLInputElement;

    fireEvent.change(input, { target: { value: "1.055" } });
    expect(input.value).toBe("1.05");
    expect(onChange).toHaveBeenLastCalledWith(1.05);

    fireEvent.change(input, { target: { value: "1." } });
    expect(input.value).toBe("1.");
    expect(onChange).toHaveBeenLastCalledWith(1);

    fireEvent.change(input, { target: { value: "1.05" } });
    expect(input.value).toBe("1.05");
    expect(onChange).toHaveBeenLastCalledWith(1.05);

    fireEvent.blur(input);
    expect(input.value).toBe("1.05");
  });

  it("truncates to integer when precision is 0", () => {
    const onChange = vi.fn();
    function Harness() {
      const [value, setValue] = useState<number | null>(12);
      return (
        <NumberInput
          aria-label="Amount"
          value={value}
          precision={0}
          onChange={(next) => { onChange(next); setValue(next); }}
        />
      );
    }
    render(<Harness />);
    const input = screen.getByRole("spinbutton") as HTMLInputElement;

    fireEvent.change(input, { target: { value: "12.9" } });
    expect(input.value).toBe("12");
    expect(onChange).toHaveBeenLastCalledWith(12);

    fireEvent.change(input, { target: { value: "13." } });
    expect(input.value).toBe("13.");
    expect(onChange).toHaveBeenLastCalledWith(13);
  });
});
