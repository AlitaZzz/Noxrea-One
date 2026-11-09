import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ api: vi.fn(), me: vi.fn(), login: vi.fn() }));
vi.mock("@/lib/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/client")>();
  return { ...actual, api: mocks.api };
});
vi.mock("@/lib/i18n/config", () => ({
  default: { t: (key: string) => key, exists: () => false }, setAppLanguage: vi.fn(),
}));

import { initializeSession, login } from "@/entities/user";

const userA = { id: 1, username: "a", avatarKey: null, theme: "dark", language: "zh" };
const userB = { ...userA, id: 2, username: "b" };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("session startup", () => {
  it("does not restore A from a delayed /me after B has logged in", async () => {
    const me = deferred<typeof userA>();
    mocks.api.mockImplementation((path: string) => {
      if (path === "/api/auth/me") return me.promise;
      if (path === "/api/auth/login") return mocks.login();
      return Promise.resolve(null);
    });
    mocks.login.mockResolvedValue({ user: userB });

    const pending = initializeSession();
    await login("b", "password");
    me.resolve(userA);

    expect(await pending).toMatchObject({ id: 2, username: "b" });
  });
});
