// @vitest-environment jsdom
import { QueryClient, useQuery, useQueryClient } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { type ReactNode, StrictMode, useEffect, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ api: vi.fn(), login: vi.fn(), updateMe: vi.fn() }));

vi.mock("@/lib/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/client")>();
  return { ...actual, api: mocks.api };
});
vi.mock("@/components/ui/AppUiProvider", () => ({ default: ({ children }: { children: ReactNode }) => children }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn() }) }));
vi.mock("@/lib/i18n/config", () => ({ default: { t: (key: string) => key }, setAppLanguage: vi.fn() }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ i18n: { language: "zh" } }) }));
vi.mock("@/lib/upload-formats", () => ({ loadUploadFormats: async () => undefined }));

import { login, logout, savePreference } from "@/entities/user";
import { AppProviders } from "@/providers/AppProviders";

const userA = { id: 1, username: "a", avatarKey: null, theme: "dark", language: "zh" };
const userB = { ...userA, id: 2, username: "b" };

beforeEach(async () => {
  mocks.api.mockReset();
  mocks.api.mockImplementation((path: string, options?: { method?: string }) => {
    if (path === "/api/auth/login") return mocks.login();
    if (path === "/api/auth/me" && options?.method === "PUT") return mocks.updateMe();
    return Promise.resolve(null);
  });
  mocks.login.mockResolvedValue({ user: userA });
  mocks.updateMe.mockResolvedValue(null);
  await logout();
});

afterEach(async () => {
  cleanup();
  await logout();
  document.documentElement.classList.remove("light", "dark");
});

describe("page session boundary", () => {
  it("finishes queries during StrictMode's mount cleanup and remount", async () => {
    function Page() {
      const query = useQuery({ queryKey: ["strict"], queryFn: async () => "Ready" });
      return <span>{query.data ?? "Loading"}</span>;
    }
    render(<StrictMode><AppProviders><Page /></AppProviders></StrictMode>);
    await waitFor(() => expect(screen.getByText("Ready")).toBeTruthy());
  });

  it("syncs the persisted user theme to the document root", async () => {
    mocks.login.mockResolvedValue({ user: { ...userA, theme: "light" } });
    await login("a", "password");

    render(
      <AppProviders><span>Content</span></AppProviders>,
    );

    await waitFor(() => {
      expect(document.documentElement).toHaveClass("light");
      expect(document.documentElement).not.toHaveClass("dark");
    });
  });

  it("preserves local state for profile changes and recreates it and query cache for another account", async () => {
    await login("a", "password");
    const clients: QueryClient[] = [];
    function Page() {
      const client = useQueryClient();
      const [count, setCount] = useState(0);
      useEffect(() => { clients.push(client); }, [client]);
      return <button onClick={() => {
        client.setQueryData(["private"], "A-secret");
        setCount((value) => value + 1);
      }}>{count}</button>;
    }
    render(<AppProviders><Page /></AppProviders>);
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByRole("button").textContent).toBe("1");
    await act(async () => { await savePreference("language", "en"); });
    expect(screen.getByRole("button").textContent).toBe("1");
    expect(clients).toHaveLength(1);
    mocks.login.mockResolvedValue({ user: userB });
    await act(async () => { await login("b", "password"); });
    expect(screen.getByRole("button").textContent).toBe("0");
    expect(clients).toHaveLength(2);
    expect(clients[0].getQueryData(["private"])).toBeUndefined();
    expect(clients[1].getQueryData(["private"])).toBeUndefined();
  });
});
