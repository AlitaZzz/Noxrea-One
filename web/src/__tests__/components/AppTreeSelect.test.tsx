// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import AppTreeSelect from "@/components/ui/AppTreeSelect";

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const nodes = [{ value: "folder", label: "Folder", title: "Folder" }];

describe("tree selection ownership", () => {
  it("keeps null empty until its owner accepts a selection", async () => {
    const onChange = vi.fn();
    const { container, rerender } = render(<AppTreeSelect value={null} onChange={onChange} nodes={nodes} placeholder="Empty" />);
    fireEvent.mouseDown(screen.getByRole("combobox"));
    fireEvent.click(await screen.findByText("Folder"));
    await waitFor(() => expect(onChange).toHaveBeenCalledExactlyOnceWith("folder"));
    expect(container.textContent).toContain("Empty");
    expect(container.textContent).not.toContain("Folder");
    rerender(<AppTreeSelect value="folder" onChange={onChange} nodes={nodes} placeholder="Empty" />);
    await waitFor(() => expect(container.textContent).toContain("Folder"));
    rerender(<AppTreeSelect value={null} onChange={onChange} nodes={nodes} placeholder="Empty" />);
    await waitFor(() => expect(container.textContent).toContain("Empty"));
  });
});
