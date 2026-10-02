// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import type { Node } from "@xyflow/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import NodeInspector from "@/features/canvas/debug/NodeInspector";

afterEach(cleanup);

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
});
