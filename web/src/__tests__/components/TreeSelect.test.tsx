// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TreeSelect } from "@/components/ui/tree-select";

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("TreeSelect", () => {
  it("keeps the controlled value until its owner accepts a selection", async () => {
    const onChange = vi.fn();
    const nodes = [{ value: "folder", label: "Folder", title: "Folder" }];
    const { container, rerender } = render(<TreeSelect value={null} onChange={onChange} nodes={nodes} placeholder="Empty" />);
    fireEvent.click(screen.getByRole("combobox"));
    fireEvent.click(await screen.findByText("Folder"));
    await waitFor(() => expect(onChange).toHaveBeenCalledExactlyOnceWith("folder"));
    expect(container.textContent).toContain("Empty");
    rerender(<TreeSelect value="folder" onChange={onChange} nodes={nodes} placeholder="Empty" />);
    await waitFor(() => expect(container.textContent).toContain("Folder"));
  });

  it("uses the caller-provided search placeholder", () => {
    render(
      <TreeSelect
        nodes={[{ value: "folder", label: "Folder", title: "Folder" }]}
        searchable
        searchPlaceholder="Search folders..."
      />,
    );

    fireEvent.click(screen.getByRole("combobox"));
    expect(screen.getByRole("tree").parentElement).toHaveClass("p-1");
    expect(screen.getByPlaceholderText("Search folders...")).toBeTruthy();
  });

  it("uses the shared button semantics for its trigger", () => {
    render(<TreeSelect nodes={[{ value: "folder", label: "Folder", title: "Folder" }]} placeholder="Empty" />);

    const trigger = screen.getByRole("combobox");
    expect(trigger.tagName).toBe("BUTTON");
    expect(trigger).toHaveAttribute("data-slot", "popover-trigger");
    expect(trigger).toHaveClass("cursor-pointer");
  });

  it("clears the value without opening the menu", () => {
    const onChange = vi.fn();
    render(
      <TreeSelect
        value="folder"
        onChange={onChange}
        nodes={[{ value: "folder", label: "Folder", title: "Folder" }]}
        allowClear
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(onChange).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(screen.queryByRole("tree")).toBeNull();
  });
});
