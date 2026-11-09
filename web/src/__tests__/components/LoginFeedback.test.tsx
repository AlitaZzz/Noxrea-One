// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ api: vi.fn(), login: vi.fn() }));

vi.mock("@/lib/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/client")>();
  return { ...actual, api: mocks.api };
});
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn() }) }));
vi.mock("@/lib/i18n/config", () => ({ default: { t: (key: string) => key }, setAppLanguage: vi.fn() }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ i18n: { language: "zh" } }) }));
vi.mock("@/lib/upload-formats", () => ({ loadUploadFormats: async () => undefined }));

import { useAppFeedback } from "@/components/ui/use-app-feedback";
import { login, logout } from "@/entities/user";
import { AppProviders } from "@/providers/AppProviders";

const USER = { id: 1, username: "a", avatarKey: null, theme: "dark", language: "zh" };

beforeEach(async () => {
  mocks.api.mockReset();
  mocks.api.mockImplementation((path: string) => {
    if (path === "/api/auth/login") return mocks.login();
    return Promise.resolve(null);
  });
  mocks.login.mockResolvedValue({ user: USER });
  await logout();
});

afterEach(async () => {
  cleanup();
  await logout();
  vi.restoreAllMocks();
});

describe("login feedback lifetime", () => {
  it("displays success from the login callback across an account boundary using the real UI backend", async () => {
    let complete!: (data: unknown) => void;
    mocks.login.mockReturnValue(new Promise((resolve) => { complete = resolve; }));
    let resumeFeedback!: () => void;
    const feedbackGate = new Promise<void>((resolve) => { resumeFeedback = resolve; });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const finished = vi.fn();
    function LoginAction() {
      const { message } = useAppFeedback();
      return <button onClick={async () => {
        await login("a", "password");
        await feedbackGate;
        message.success("Welcome");
        finished();
      }}>Login</button>;
    }
    render(<AppProviders><LoginAction /></AppProviders>);
    fireEvent.click(screen.getByRole("button", { name: "Login" }));
    await act(async () => {
      complete({ user: USER });
    });
    // Resume the old callback after React has committed the new account subtree.
    await act(async () => { resumeFeedback(); });
    await waitFor(() => expect(screen.getByText("Welcome")).toBeTruthy());
    expect(finished).toHaveBeenCalledTimes(1);
    expect(errors.mock.calls.flat().join(" ")).not.toContain("calling notice in render");
  });
});
