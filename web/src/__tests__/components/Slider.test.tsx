// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Slider } from "@/components/ui/slider";

afterEach(cleanup);

describe("Slider", () => {
  it("renders the shadcn structure and reports numeric keyboard changes", () => {
    const onValueChange = vi.fn();
    render(<Slider aria-label="Opacity" min={10} max={90} step={5} value={[30]} onValueChange={onValueChange} />);
    const slider = screen.getByRole("slider");

    expect(slider).toHaveAttribute("aria-valuemin", "10");
    expect(slider).toHaveAttribute("aria-valuemax", "90");
    expect(slider).toHaveAttribute("aria-valuenow", "30");
    expect(document.querySelector('[data-slot="slider"]')).toBeInTheDocument();
    expect(document.querySelector('[data-slot="slider-track"]')).toBeInTheDocument();
    expect(document.querySelector('[data-slot="slider-range"]')).toBeInTheDocument();
    expect(document.querySelector('[data-slot="slider-thumb"]')).toBeInTheDocument();

    fireEvent.keyDown(slider, { key: "ArrowRight" });

    expect(onValueChange).toHaveBeenCalledWith([35]);
  });

  it("supports uncontrolled keyboard interaction", () => {
    render(<Slider aria-label="Scale" min={0.2} max={3} step={0.1} defaultValue={[1.3]} />);
    const slider = screen.getByRole("slider");

    fireEvent.keyDown(slider, { key: "ArrowRight" });

    expect(slider).toHaveAttribute("aria-valuenow", "1.4");
  });

  it("does not report changes while disabled", () => {
    const onValueChange = vi.fn();
    render(<Slider aria-label="Disabled" value={[20]} disabled onValueChange={onValueChange} />);

    fireEvent.keyDown(screen.getByRole("slider"), { key: "ArrowRight" });

    expect(onValueChange).not.toHaveBeenCalled();
  });

  it("supports the official two-thumb range contract", () => {
    render(<Slider aria-label="Range" min={4} max={12} defaultValue={[4, 12]} />);

    expect(screen.getAllByRole("slider")).toHaveLength(2);
    expect(screen.getAllByRole("slider")[0]).toHaveAttribute("aria-valuenow", "4");
    expect(screen.getAllByRole("slider")[1]).toHaveAttribute("aria-valuenow", "12");
  });

  it("allows root class customization while keeping the official slots", () => {
    render(<Slider aria-label="Styled" value={[50]} className="custom-slider" />);

    expect(document.querySelector('[data-slot="slider"]')).toHaveClass("custom-slider");
    expect(document.querySelector('[data-slot="slider-track"]')).toHaveClass("bg-muted");
    expect(document.querySelector('[data-slot="slider-range"]')).toHaveClass("bg-primary");
    expect(document.querySelector('[data-slot="slider-thumb"]')).toHaveClass("bg-white");
  });
});
