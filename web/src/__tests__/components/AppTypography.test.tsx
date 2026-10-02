// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Paragraph } from "@/components/ui/typography";

afterEach(cleanup);

describe("Typography", () => {
  it("supports expandable paragraphs", () => {
    render(<Paragraph ellipsis={{ rows: 2, expandable: true, symbol: "Show more" }}>Long text</Paragraph>);
    const paragraph = screen.getByText("Long text").closest("p");

    expect(paragraph).toHaveAttribute("data-slot", "typography-paragraph");
    fireEvent.click(screen.getByRole("button", { name: "Show more" }));
    expect(paragraph).toHaveAttribute("data-expanded", "true");
  });

  it("copies the declared text", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(<Paragraph copyable={{ text: "copy me" }}>Shown</Paragraph>);

    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect(writeText).toHaveBeenCalledWith("copy me");
  });
});
