// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PasswordInput } from "@/components/ui/password-input";

afterEach(cleanup);

describe("password visibility interaction", () => {
  it("notifies an uncontrolled caller on mouse and keyboard toggles while retaining input focus", async () => {
    const onVisibleChange = vi.fn();
    render(
      <PasswordInput
        aria-label="Secret"
        defaultValue="value"
        onVisibleChange={onVisibleChange}
        showLabel="Show secret"
        hideLabel="Hide secret"
      />,
    );
    const input = screen.getByLabelText("Secret");
    const toggle = screen.getByRole("button", { name: "Show secret" });
    act(() => input.focus());
    fireEvent.mouseDown(toggle);
    fireEvent.click(toggle);
    await waitFor(() => expect(input.getAttribute("type")).toBe("text"));
    expect(screen.getByRole("button", { name: "Hide secret" })).toBeTruthy();
    expect(onVisibleChange).toHaveBeenCalledExactlyOnceWith(true);
    expect(document.activeElement).toBe(input);
    fireEvent.keyDown(toggle, { key: "Enter" });
    fireEvent.click(toggle);
    await waitFor(() => expect(input.getAttribute("type")).toBe("password"));
    expect(onVisibleChange).toHaveBeenLastCalledWith(false);
  });

  it("waits for the owner to update controlled visibility and ignores disabled interaction", async () => {
    const onVisibleChange = vi.fn();
    const { rerender } = render(
      <PasswordInput
        aria-label="Secret"
        visible={false}
        onVisibleChange={onVisibleChange}
        showLabel="Show secret"
        hideLabel="Hide secret"
      />,
    );
    fireEvent.click(screen.getByRole("button"));
    expect(onVisibleChange).toHaveBeenCalledExactlyOnceWith(true);
    expect(screen.getByLabelText("Secret").getAttribute("type")).toBe("password");
    rerender(
      <PasswordInput
        aria-label="Secret"
        visible
        disabled
        onVisibleChange={onVisibleChange}
        showLabel="Show secret"
        hideLabel="Hide secret"
      />,
    );
    await waitFor(() => expect(screen.getByLabelText("Secret").getAttribute("type")).toBe("text"));
    fireEvent.click(screen.getByRole("button"));
    expect(onVisibleChange).toHaveBeenCalledTimes(1);
  });
});
