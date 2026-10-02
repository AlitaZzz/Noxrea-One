// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import Descriptions from "@/components/ui/descriptions";

afterEach(cleanup);

describe("Descriptions", () => {
  it("renders declared items with semantic description markup", () => {
    render(<Descriptions column={1} size="sm" bordered items={[{ key: "id", label: "ID", children: "node-1" }]} />);

    expect(screen.getByText("ID").tagName).toBe("DT");
    expect(screen.getByText("node-1").tagName).toBe("DD");
    const descriptions = document.querySelector('[data-slot="descriptions"]');
    expect(descriptions).toHaveAttribute("data-size", "sm");
    expect(descriptions).toHaveAttribute("data-bordered", "true");
    expect(descriptions).toHaveClass("rounded-md", "border-border");
  });
});
