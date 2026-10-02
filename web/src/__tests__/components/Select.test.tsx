// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

afterEach(cleanup);

describe("Select", () => {
  it("uses the shadcn trigger contract and emits the selected value", () => {
    const onValueChange = vi.fn();
    render(
      <Select defaultValue="openai" onValueChange={onValueChange}>
        <SelectTrigger aria-label="Protocol"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="openai">OpenAI</SelectItem>
          <SelectItem value="ark">Ark</SelectItem>
        </SelectContent>
      </Select>,
    );

    const trigger = screen.getByRole("combobox");
    expect(trigger).toHaveAttribute("data-slot", "select-trigger");
    expect(trigger).toHaveClass("h-9", "rounded-md", "border-input");

    fireEvent.pointerDown(trigger, { button: 0, pointerType: "mouse" });
    fireEvent.click(trigger);
    expect(document.querySelector('[data-position]')).toHaveClass("space-y-px");
    fireEvent.click(screen.getByRole("option", { name: "Ark" }));
    expect(onValueChange).toHaveBeenCalledExactlyOnceWith("ark");
  });

  it("supports disabled options and a placeholder", () => {
    render(
      <Select>
        <SelectTrigger aria-label="Type"><SelectValue placeholder="Choose type" /></SelectTrigger>
        <SelectContent>
          <SelectItem value="clear">Choose type</SelectItem>
          <SelectItem value="image" disabled>Image</SelectItem>
        </SelectContent>
      </Select>,
    );

    expect(screen.getByRole("combobox")).toHaveTextContent("Choose type");
    fireEvent.pointerDown(screen.getByRole("combobox"), { button: 0, pointerType: "mouse" });
    fireEvent.click(screen.getByRole("combobox"));
    expect(screen.getByRole("option", { name: "Image" })).toHaveAttribute("aria-disabled", "true");
  });

  it("does not open when the trigger is disabled", () => {
    render(
      <Select disabled>
        <SelectTrigger aria-label="Protocol"><SelectValue /></SelectTrigger>
        <SelectContent><SelectItem value="openai">OpenAI</SelectItem></SelectContent>
      </Select>,
    );

    const trigger = screen.getByRole("combobox");
    expect(trigger).toBeDisabled();
    fireEvent.click(trigger);
    expect(screen.queryByRole("option", { name: "OpenAI" })).toBeNull();
  });
});
