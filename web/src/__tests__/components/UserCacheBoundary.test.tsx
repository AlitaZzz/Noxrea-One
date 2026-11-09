// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ api: vi.fn() }));

vi.mock("@/lib/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/client")>();
  return { ...actual, api: mocks.api };
});
vi.mock("@/lib/i18n/config", () => ({ default: { t: (key: string) => key }, setAppLanguage: vi.fn() }));

import { CachedUserProvider, initializeSession, useCurrentUser } from "@/entities/user";

afterEach(cleanup);

describe("SSR 用户缓存边界", () => {
  it("会话确认未登录后不再回退到 SSR 缓存", async () => {
    const cachedUser = { id: 1, username: "a", avatarKey: null, theme: "dark", language: "zh" };
    mocks.api.mockResolvedValue(null);
    function UserLabel() {
      const user = useCurrentUser();
      return <span>{user?.username ?? "Guest"}</span>;
    }
    render(<CachedUserProvider user={cachedUser}><UserLabel /></CachedUserProvider>);
    expect(screen.getByText("a")).toBeTruthy();
    await act(async () => { await initializeSession(); });
    expect(screen.getByText("Guest")).toBeTruthy();
  });
});
