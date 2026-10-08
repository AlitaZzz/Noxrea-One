// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const login = vi.hoisted(() => vi.fn());
vi.mock("@/features/auth/api", () => ({ authApi: { login } }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn() }) }));
vi.mock("@/lib/i18n/config", () => ({ default: { t: (key: string) => key }, setAppLanguage: vi.fn() }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ i18n: { language: "zh" } }) }));
vi.mock("@/lib/upload-formats", () => ({ loadUploadFormats: async () => undefined }));

import { useAppFeedback } from "@/components/ui/use-app-feedback";
import { useAuthStore } from "@/features/auth/store";
import { AppProviders } from "@/providers/AppProviders";

afterEach(() => { cleanup(); useAuthStore.setState({ user: null }); vi.restoreAllMocks(); });

describe("login feedback lifetime", () => {
  it("displays success from the login callback across an account boundary using the real UI backend", async () => {
    useAuthStore.setState({ user: null, initialized: true });
    let complete!: (data: unknown) => void;
    login.mockReturnValue(new Promise((resolve) => { complete = resolve; }));
    let resumeFeedback!: () => void;
    const feedbackGate = new Promise<void>((resolve) => { resumeFeedback = resolve; });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const finished = vi.fn();
    function LoginAction() {
      const { message } = useAppFeedback();
      return <button onClick={async () => {
        await useAuthStore.getState().login("a", "password");
        await feedbackGate;
        message.success("Welcome");
        finished();
      }}>Login</button>;
    }
    render(<AppProviders><LoginAction /></AppProviders>);
    fireEvent.click(screen.getByRole("button", { name: "Login" }));
    await act(async () => {
      complete({ user: { id: 1, username: "a", avatarUrl: null, theme: "dark", language: "zh" } });
    });
    // Resume the old callback after React has committed the new account subtree.
    await act(async () => { resumeFeedback(); });
    await waitFor(() => expect(screen.getByText("Welcome")).toBeTruthy());
    expect(finished).toHaveBeenCalledTimes(1);
    expect(errors.mock.calls.flat().join(" ")).not.toContain("calling notice in render");
  });
});
