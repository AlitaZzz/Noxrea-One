// @vitest-environment jsdom
import { act, cleanup, render, renderHook, screen } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import AppUiProvider from "@/components/ui/AppUiProvider";
import { useAppFeedback } from "@/components/ui/use-app-feedback";
import { globalFeedback } from "@/lib/feedback";
import { changeSession } from "@/lib/session-lifecycle";

afterEach(cleanup);

describe("project feedback adapter", () => {
  it("clears old notices on account changes while retaining the feedback instance", () => {
    const { result } = renderHook(useAppFeedback, { wrapper: AppUiProvider });
    const feedback = result.current;
    act(() => feedback.message.success("Welcome"));
    expect(screen.getByRole("status")).toHaveTextContent("Welcome");
    act(() => changeSession());
    expect(screen.queryByRole("status")).toBeNull();
    expect(result.current).toBe(feedback);
  });

  it("preserves rich descriptions, deduplication keys and explicit duration", () => {
    const { result } = renderHook(useAppFeedback, { wrapper: AppUiProvider });
    const description = <b>Detailed failure</b>;
    act(() => result.current.notification.error({ title: "Failure", description, key: "task", duration: 15 }));
    expect(screen.getByRole("alert")).toHaveTextContent("Failure");
    expect(screen.getByText("Detailed failure")).toBeTruthy();
    act(() => result.current.notification.error({ title: "Updated", key: "task", duration: 0 }));
    expect(screen.queryByText("Failure")).toBeNull();
    expect(screen.getByRole("alert")).toHaveTextContent("Updated");
  });

  it("flushes pre-mount and unmounted feedback once under StrictMode", () => {
    globalFeedback.message.info("before mount");
    const tree = <StrictMode><AppUiProvider><span>App</span></AppUiProvider></StrictMode>;
    const mounted = render(tree);
    expect(screen.getByRole("status")).toHaveTextContent("before mount");
    mounted.unmount();
    globalFeedback.notification.error({ title: "during unmount", duration: 0 });
    expect(screen.queryByRole("alert")).toBeNull();
    render(tree);
    expect(screen.getByRole("alert")).toHaveTextContent("during unmount");
  });

  it("requires a project provider", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try { expect(() => renderHook(useAppFeedback)).toThrow("useAppFeedback requires AppUiProvider"); }
    finally { consoleError.mockRestore(); }
  });
});
