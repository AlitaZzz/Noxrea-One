// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import AssetBreadcrumb from "@/features/assets/components/AssetBreadcrumb";
import type { AssetFolder } from "@/features/assets/types";

afterEach(cleanup);

const folder = (id: string, name: string, parentId?: string): AssetFolder => ({
  id,
  name,
  parentId,
  scope: "personal",
  kind: "normal",
  createdAt: 0,
  count: 0,
});

describe("AssetBreadcrumb", () => {
  it("renders the root as the current page", () => {
    render(
      <AssetBreadcrumb
        rootLabel="Personal assets"
        folders={[]}
        activeFolderId={null}
        onNavigate={vi.fn()}
        collapsedLabel="Show parent folders"
      />,
    );

    expect(screen.getByText("Personal assets")).toHaveAttribute("aria-current", "page");
    expect(screen.queryByRole("button", { name: "Show parent folders" })).toBeNull();
  });

  it("navigates through visible ancestors and the current folder", () => {
    const onNavigate = vi.fn();
    render(
      <AssetBreadcrumb
        rootLabel="Personal assets"
        folders={[folder("one", "One"), folder("two", "Two", "one")]}
        activeFolderId="two"
        onNavigate={onNavigate}
        collapsedLabel="Show parent folders"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Personal assets" }));
    fireEvent.click(screen.getByRole("button", { name: "One" }));

    expect(onNavigate).toHaveBeenNthCalledWith(1, null);
    expect(onNavigate).toHaveBeenNthCalledWith(2, "one");
    expect(screen.getByText("Two")).toHaveAttribute("aria-current", "page");
  });

  it("exposes deeper folders through the official ellipsis menu", () => {
    const onNavigate = vi.fn();
    render(
      <AssetBreadcrumb
        rootLabel="Personal assets"
        folders={[
          folder("one", "One"),
          folder("two", "Two", "one"),
          folder("three", "Three", "two"),
          folder("four", "Four", "three"),
        ]}
        activeFolderId="four"
        onNavigate={onNavigate}
        collapsedLabel="Show parent folders"
      />,
    );

    const trigger = screen.getByRole("button", { name: "Show parent folders" });
    expect(trigger).toHaveAttribute("data-size", "icon");
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    expect(screen.getByRole("menuitem", { name: "Two" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Three" })).toBeTruthy();

    fireEvent.click(screen.getByRole("menuitem", { name: "Three" }));
    expect(onNavigate).toHaveBeenCalledWith("three");
  });
});
