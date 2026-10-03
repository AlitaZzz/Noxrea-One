// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";

afterEach(cleanup);

describe("Card", () => {
  it("exposes the official card slots and composes children", () => {
    render(
      <Card>
        <CardHeader>
          <CardTitle>Title</CardTitle>
          <CardDescription>Description</CardDescription>
          <CardAction><button type="button">Action</button></CardAction>
        </CardHeader>
        <CardContent>Content</CardContent>
        <CardFooter>Footer</CardFooter>
      </Card>,
    );

    expect(document.querySelector('[data-slot="card"]')).toHaveClass("bg-card", "rounded-xl");
    expect(document.querySelector('[data-slot="card-header"]')).toHaveClass("grid");
    expect(document.querySelector('[data-slot="card-title"]')).toHaveTextContent("Title");
    expect(document.querySelector('[data-slot="card-description"]')).toHaveTextContent("Description");
    expect(document.querySelector('[data-slot="card-action"]')).toHaveTextContent("Action");
    expect(document.querySelector('[data-slot="card-content"]')).toHaveTextContent("Content");
    expect(document.querySelector('[data-slot="card-footer"]')).toHaveTextContent("Footer");
  });
});
