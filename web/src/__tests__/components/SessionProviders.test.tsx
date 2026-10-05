// @vitest-environment jsdom
import { QueryClient, useQuery, useQueryClient } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { type ReactNode, StrictMode, useEffect, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/ui/AppUiProvider", () => ({ default: ({ children }: { children: ReactNode }) => children }));
vi.mock("@/lib/i18n/config", () => ({ default: { t: (key: string) => key } }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ i18n: { language: "zh" } }) }));
vi.mock("@/lib/upload-formats", () => ({ loadUploadFormats: async () => undefined }));

import { useAuthStore } from "@/features/auth/store";
import { CachedUserProvider, useCurrentUser } from "@/features/auth/UserContext";
import { AppProviders } from "@/providers/AppProviders";

afterEach(() => {
  cleanup();
  useAuthStore.setState({ user: null });
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

  it("does not resurrect the SSR user cache after logout", () => {
    const cachedUser = { id: 1, username: "a", avatarUrl: null, theme: "dark", language: "zh" };
    useAuthStore.setState({ user: null, initialized: false });
    function UserLabel() {
      const user = useCurrentUser();
      return <span>{user?.username ?? "Guest"}</span>;
    }
    render(<CachedUserProvider user={cachedUser}><UserLabel /></CachedUserProvider>);
    expect(screen.getByText("a")).toBeTruthy();
    act(() => useAuthStore.setState({ initialized: true }));
    expect(screen.getByText("Guest")).toBeTruthy();
  });

  it("syncs the persisted user theme to the document root", async () => {
    const user = { id: 1, username: "a", avatarUrl: null, theme: "light", language: "zh" };
    useAuthStore.setState({ user, initialized: true });

    render(
      <CachedUserProvider user={null}>
        <AppProviders><span>Content</span></AppProviders>
      </CachedUserProvider>,
    );

    await waitFor(() => {
      expect(document.documentElement).toHaveClass("light");
      expect(document.documentElement).not.toHaveClass("dark");
    });
  });

  it("preserves local state for profile changes and recreates it and query cache for another account", () => {
    const userA = { id: 1, username: "a", avatarUrl: null, theme: "dark", language: "zh" };
    useAuthStore.setState({ user: userA });
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
    act(() => useAuthStore.setState({ user: { ...userA, language: "en" } }));
    expect(screen.getByRole("button").textContent).toBe("1");
    expect(clients).toHaveLength(1);
    act(() => useAuthStore.setState({ user: { ...userA, id: 2, username: "b" } }));
    expect(screen.getByRole("button").textContent).toBe("0");
    expect(clients).toHaveLength(2);
    expect(clients[0].getQueryData(["private"])).toBeUndefined();
    expect(clients[1].getQueryData(["private"])).toBeUndefined();
  });
});
