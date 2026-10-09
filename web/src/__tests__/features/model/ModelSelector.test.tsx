// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { type ModelOption, ModelSelector } from "@/features/model/components/ModelSelector";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: "zh" } }),
}));

afterEach(cleanup);

const models: ModelOption[] = [
  { value: "openai/gpt-4o", name: "gpt-4o", providerName: "OpenAI" },
  { value: "anthropic/claude-3-7-sonnet", name: "claude-3-7-sonnet", providerName: "Anthropic" },
];

function renderSelector(options: readonly ModelOption[], value?: string) {
  const onValueChange = vi.fn();
  render(
    <ModelSelector models={options} value={value} onValueChange={onValueChange} placeholder="Select model" ariaLabel="Select model" />,
  );
  return { trigger: screen.getByRole("button", { name: "Select model" }), onValueChange };
}

describe("ModelSelector", () => {
  it("uses the shared menu contract and emits the selected model", () => {
    const { trigger, onValueChange } = renderSelector(models, "openai/gpt-4o");
    expect(trigger).toHaveTextContent("gpt-4o");
    fireEvent.keyDown(trigger, { key: "ArrowDown" });

    expect(screen.getByRole("menuitem", { name: /gpt-4o OpenAI/ })).toHaveClass("bg-accent", "text-accent-foreground");
    expect(screen.queryByRole("menuitem", { name: "modelConfig.emptyModels" })).toBeNull();

    fireEvent.click(screen.getByRole("menuitem", { name: /claude-3-7-sonnet Anthropic/ }));
    expect(onValueChange).toHaveBeenCalledExactlyOnceWith("anthropic/claude-3-7-sonnet");
  });

  it("shows a disabled empty state without emitting a selection", () => {
    const { trigger, onValueChange } = renderSelector([]);
    fireEvent.keyDown(trigger, { key: "Enter" });

    const item = screen.getByRole("menuitem", { name: "modelConfig.emptyModels" });
    expect(item).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(item);
    fireEvent.keyDown(item, { key: "Enter" });
    expect(onValueChange).not.toHaveBeenCalled();
    expect(screen.getByRole("menu")).toBeTruthy();
  });

  it("restores trigger focus when Escape closes an empty menu", async () => {
    const { trigger } = renderSelector([]);
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("updates an open empty menu when models become available", () => {
    const onValueChange = vi.fn();
    const { rerender } = render(
      <ModelSelector models={[]} onValueChange={onValueChange} placeholder="Select model" />,
    );
    fireEvent.keyDown(screen.getByRole("button", { name: "Select model" }), { key: "Enter" });
    expect(screen.getByRole("menuitem", { name: "modelConfig.emptyModels" })).toBeTruthy();
    rerender(<ModelSelector models={models} onValueChange={onValueChange} placeholder="Select model" />);
    expect(screen.queryByRole("menuitem", { name: "modelConfig.emptyModels" })).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: /gpt-4o OpenAI/ }));
    expect(onValueChange).toHaveBeenCalledExactlyOnceWith("openai/gpt-4o");
  });
});
