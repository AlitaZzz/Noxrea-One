// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { Empty, EmptyDescription, EmptyMedia } from "@/components/ui/empty";

afterEach(cleanup);

describe("Empty", () => {
  it("uses the shadcn empty composition and UI-owned default media", () => {
    render(
      <Empty role="status">
        <EmptyMedia variant="icon" />
        <EmptyDescription>Nothing here</EmptyDescription>
      </Empty>,
    );

    expect(screen.getByRole("status")).toHaveAttribute("data-slot", "empty");
    expect(screen.getByText("Nothing here")).toHaveAttribute("data-slot", "empty-description");
    expect(document.querySelector('[data-slot="empty-icon"] svg')).toBeTruthy();
  });
});
