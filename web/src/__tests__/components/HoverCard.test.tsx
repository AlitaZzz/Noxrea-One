// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";

afterEach(cleanup);

describe("HoverCard", () => {
  it("renders the shadcn content contract when controlled", () => {
    render(
      <HoverCard open>
        <HoverCardTrigger asChild>
          <button type="button">Open</button>
        </HoverCardTrigger>
        <HoverCardContent side="right" align="start">Panel</HoverCardContent>
      </HoverCard>,
    );

    expect(screen.getByText("Panel").closest("[data-slot='hover-card-content']")).toHaveAttribute("data-side", "right");
  });
});
