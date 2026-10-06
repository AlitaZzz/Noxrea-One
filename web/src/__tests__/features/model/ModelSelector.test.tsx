// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { type ModelOption, ModelSelector } from "@/features/model/components/ModelSelector";

afterEach(cleanup);

const models: ModelOption[] = [
  {
    value: "openai/gpt-4o",
    name: "gpt-4o",
    providerName: "OpenAI",
  },
  {
    value: "anthropic/claude-3-7-sonnet",
    name: "claude-3-7-sonnet",
    providerName: "Anthropic",
  },
];

describe("ModelSelector", () => {
  it("uses the shared shadcn menu contract and emits the selected model", () => {
    const onValueChange = vi.fn();

    render(
      <ModelSelector
        models={models}
        value="openai/gpt-4o"
        onValueChange={onValueChange}
        placeholder="Select model"
        ariaLabel="Select model"
      />,
    );

    const trigger = screen.getByRole("button", { name: "Select model" });
    expect(trigger).toHaveTextContent("gpt-4o");

    fireEvent.keyDown(trigger, { key: "ArrowDown" });

    const selected = screen.getByRole("menuitem", { name: /gpt-4o OpenAI/ });
    expect(selected).toHaveClass("bg-accent", "text-accent-foreground");
    expect(screen.getByRole("menuitem", { name: /claude-3-7-sonnet Anthropic/ })).toBeTruthy();

    fireEvent.click(screen.getByRole("menuitem", { name: /claude-3-7-sonnet Anthropic/ }));
    expect(onValueChange).toHaveBeenCalledExactlyOnceWith("anthropic/claude-3-7-sonnet");
  });
});
