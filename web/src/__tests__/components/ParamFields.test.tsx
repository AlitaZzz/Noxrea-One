// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import ParamFields, { type ParamFieldView, ParamSummary } from "@/components/ui/ParamFields";

afterEach(cleanup);

const fields: ParamFieldView[] = [{
  name: "mode", type: "segmented", label: "Mode",
  options: [{ value: "first", label: "First" }, { value: "second", label: "Second" }],
  formatValue: (value) => `Selected ${value}`,
}];

const clarityField: ParamFieldView = {
  name: "clarity", type: "select", label: "Clarity",
  options: [{ value: "standard", label: "Standard" }, { value: "high", label: "High" }],
  formatValue: (value) => String(value),
};

describe("generic parameter rendering", () => {
  it("renders caller-provided labels and emits the original option value", () => {
    const onChange = vi.fn();
    render(<ParamFields fields={fields} values={{ mode: "first" }} onChange={onChange} />);
    const group = screen.getByRole("radiogroup");
    expect(group).toHaveAttribute("data-spacing", "2");
    expect(group).toHaveStyle({ "--gap": "2" });
    expect(group).toHaveStyle({ "grid-template-columns": "repeat(2, minmax(0, 1fr))" });
    expect(screen.getByRole("radio", { name: "First" })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByRole("radio", { name: "Second" }));
    expect(onChange).toHaveBeenCalledWith("mode", "second");
  });

  it("uses the caller's summary formatter and preserves false and zero values", () => {
    const view = (name: string): ParamFieldView => ({ ...fields[0], name, formatValue: (value) => `${name}=${value}` });
    const { container } = render(<ParamSummary fields={[view("zero"), view("off"), view("missing")]} values={{ zero: 0, off: false }} />);
    expect(container.textContent).toBe("zero=0 · off=false");
  });

  it("does not create invalid grid tracks for a field without options", () => {
    const { container } = render(<ParamFields fields={[{ ...fields[0], options: [] }]} values={{}} onChange={vi.fn()} />);
    expect(container.querySelector("button")).toBeNull();
    expect(container.innerHTML).not.toContain("repeat(0");
  });

  it("renders a short clarity select as a spaced ToggleGroup", () => {
    render(<ParamFields fields={[clarityField]} values={{ clarity: "standard" }} onChange={vi.fn()} />);
    const group = screen.getByRole("radiogroup");
    expect(group).toHaveAttribute("data-spacing", "2");
    expect(group).toHaveStyle({ "--gap": "2" });
    expect(group).toHaveStyle({ "grid-template-columns": "repeat(2, minmax(0, 1fr))" });
    expect(screen.getByRole("radio", { name: "Standard" })).toBeInTheDocument();
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("keeps longer select lists as a Select", () => {
    const field: ParamFieldView = {
      ...clarityField,
      options: ["One", "Two", "Three", "Four", "Five"].map((label) => ({ value: label, label })),
    };
    render(<ParamFields fields={[field]} values={{ clarity: "One" }} onChange={vi.fn()} />);
    expect(screen.getByRole("combobox")).toBeInTheDocument();
    expect(screen.queryByRole("group")).toBeNull();
  });
});
