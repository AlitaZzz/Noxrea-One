// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { CircularProgress, Progress } from "@/components/ui/progress";

afterEach(cleanup);

describe("Progress", () => {
  it("uses the shadcn progress contract for a bounded line value", () => {
    render(<Progress value={35} max={100} />);
    const progress = screen.getByRole("progressbar");

    expect(progress).toHaveAttribute("data-slot", "progress");
    expect(progress).toHaveAttribute("aria-valuenow", "35");
    expect(progress.querySelector('[data-slot="progress-indicator"]')).toHaveStyle({ transform: "translateX(-65%)" });
  });

  it("renders a bounded circular value with the project UI contract", () => {
    render(<CircularProgress value={140} size={48} className="text-white" />);
    const progress = screen.getByRole("progressbar");

    expect(progress).toHaveAttribute("data-slot", "circular-progress");
    expect(progress).toHaveAttribute("aria-valuenow", "100");
    expect(screen.getByText("100%")).toBeTruthy();
    expect(progress).toHaveStyle({ width: "48px", height: "48px" });
    expect(progress).toHaveClass("text-white");
  });
});
