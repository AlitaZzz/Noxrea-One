// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Node } from "@xyflow/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import NodeInspector from "@/features/canvas/debug/NodeInspector";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("NodeInspector", () => {
  it("renders raw JSON as valid block content", () => {
    const node: Node = {
      id: "node-1",
      type: "text",
      position: { x: 12, y: 34 },
      data: { label: "Text node" },
    };

    render(<NodeInspector open node={node} onClose={vi.fn()} />);

    const paragraph = document.querySelector('[data-slot="typography-paragraph"]');
    expect(paragraph).toHaveClass("whitespace-pre-wrap");
    expect(paragraph).toHaveTextContent('"id": "node-1"');
    expect(paragraph?.querySelector("pre")).toBeNull();
  });

  it("preserves and copies the complete JSON with long titles and resource paths", () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const label = "LongTitle".repeat(20);
    const node: Node = {
      id: "video-node-1",
      type: "video-node",
      position: { x: 12115, y: -3725 },
      data: { label, src: `/api/files/${"a".repeat(256)}.mp4` },
      style: { width: 600, height: 366 },
    };
    const json = JSON.stringify({ id: node.id, type: node.type, position: node.position, data: node.data, style: node.style }, null, 2);
    const onClose = vi.fn();

    render(<NodeInspector open node={node} onClose={onClose} />);

    expect(screen.getByRole("dialog", { name: label })).toBeTruthy();
    const content = document.querySelector('[data-slot="typography-paragraph"] > span');
    expect(content?.textContent).toBe(json);
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect(writeText).toHaveBeenCalledExactlyOnceWith(json);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
