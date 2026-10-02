// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { Spinner } from "@/components/ui/spinner";

afterEach(cleanup);

describe("Spinner", () => {
  it("uses the shadcn spinner contract", () => {
    render(<Spinner className="size-6 text-primary" />);
    const spinner = screen.getByRole("status");

    expect(spinner).toHaveAttribute("data-slot", "spinner");
    expect(spinner).toHaveAttribute("aria-label", "Loading");
    expect(spinner).toHaveClass("size-6", "text-primary", "animate-spin");
  });
});
