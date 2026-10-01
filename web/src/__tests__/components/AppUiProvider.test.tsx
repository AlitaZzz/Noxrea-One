// @vitest-environment jsdom
import { act, cleanup, render, renderHook } from "@testing-library/react";
import { type ReactNode, StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import AppUiProvider from "@/components/ui/AppUiProvider";
import { useAppFeedback } from "@/components/ui/use-app-feedback";
import { globalFeedback } from "@/lib/feedback";

const backend = vi.hoisted(() => ({
  message: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
  notification: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));
vi.mock("antd", () => ({
  App: Object.assign(({ children }: { children: ReactNode }) => children, { useApp: () => backend }),
  ConfigProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/components/ui/theme", () => ({ directorTheme: () => ({}) }));

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("project feedback adapter", () => {
  it("preserves rich descriptions, deduplication keys and explicit duration", () => {
    const { result } = renderHook(useAppFeedback, { wrapper: AppUiProvider });
    const description = <b>Detailed failure</b>;
    act(() => result.current.notification.error({ title: "Failure", description, key: "task", duration: 15 }));
    expect(backend.notification.error).toHaveBeenCalledExactlyOnceWith({ title: "Failure", description, key: "task", duration: 15, placement: "bottomRight" });
    act(() => result.current.notification.success({ title: "Done" }));
    expect(backend.notification.success).toHaveBeenCalledWith({ title: "Done", duration: 5, placement: "bottomRight" });
  });
  it("flushes pre-mount and unmounted feedback once under StrictMode", () => {
    globalFeedback.message.info("before mount");
    const tree = <StrictMode><AppUiProvider><span>App</span></AppUiProvider></StrictMode>;
    const mounted = render(tree);
    expect(backend.message.info).toHaveBeenCalledExactlyOnceWith("before mount");
    mounted.unmount();
    globalFeedback.notification.error({ title: "during unmount" });
    expect(backend.notification.error).not.toHaveBeenCalled();
    render(tree);
    expect(backend.notification.error).toHaveBeenCalledExactlyOnceWith({ title: "during unmount", duration: 6, placement: "bottomRight" });
  });
  it("requires a project provider", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try { expect(() => renderHook(useAppFeedback)).toThrow("useAppFeedback requires AppUiProvider"); }
    finally { consoleError.mockRestore(); }
  });
});
