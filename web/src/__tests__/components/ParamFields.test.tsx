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

describe("generic parameter rendering", () => {
  it("renders caller-provided labels and emits the original option value", () => {
    const onChange = vi.fn();
    render(<ParamFields fields={fields} values={{ mode: "first" }} onChange={onChange} />);
    expect(screen.getByRole("button", { name: "First" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Second" }));
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
});
