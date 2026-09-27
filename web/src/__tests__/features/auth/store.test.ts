/**
 * auth store initialize 并发去重回归测试。
 *
 * 背景：(app)/layout 的会话恢复 effect 在 React StrictMode 下双挂载，
 * 同步标志位守卫拦不住在途窗口，/me 会真的发两次——
 * 在途 promise 去重后，并发调用必须共享同一次拉取。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  me: vi.fn(),
}));

vi.mock("@/features/auth/api", () => ({
  authApi: {
    me: (...args: unknown[]) => mocks.me(...args),
    login: vi.fn(),
    register: vi.fn(),
    logout: vi.fn(async () => undefined),
    updateMe: vi.fn(async () => undefined),
  },
}));

vi.mock("@/lib/global-notification", () => ({
  showGlobalNotification: () => ({ error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() }),
}));

vi.mock("@/lib/i18n/config", () => ({
  default: { t: (k: string) => k, exists: () => false },
}));

import { useAuthStore } from "@/features/auth/store";

const USER = { id: "1", username: "u", avatarUrl: "", theme: "dark", language: "zh" };

describe("auth store initialize 并发去重", () => {
  beforeEach(() => {
    mocks.me.mockReset();
    useAuthStore.setState({ user: null, loading: false, initialized: false });
  });

  it("并发 initialize 共享同一次 /me（StrictMode 双挂载不双发请求）", async () => {
    let resolveMe!: (v: unknown) => void;
    mocks.me.mockImplementation(
      () => new Promise((resolve) => { resolveMe = resolve; }),
    );

    const a = useAuthStore.getState().initialize();
    const b = useAuthStore.getState().initialize();
    expect(mocks.me).toHaveBeenCalledTimes(1);

    resolveMe(USER);
    await Promise.all([a, b]);

    expect(mocks.me).toHaveBeenCalledTimes(1);
    expect(useAuthStore.getState().initialized).toBe(true);
    expect(useAuthStore.getState().user).toMatchObject({ username: "u" });
  });

  it("访客判定（/me 401）期间并发调用也只发一次", async () => {
    mocks.me.mockRejectedValue(new Error("401"));

    await Promise.all([
      useAuthStore.getState().initialize(),
      useAuthStore.getState().initialize(),
    ]);

    expect(mocks.me).toHaveBeenCalledTimes(1);
    expect(useAuthStore.getState().initialized).toBe(true);
    expect(useAuthStore.getState().loading).toBe(false);
  });

  it("已初始化后再次 initialize 不再发请求", async () => {
    mocks.me.mockResolvedValue(USER);

    await useAuthStore.getState().initialize();
    await useAuthStore.getState().initialize();

    expect(mocks.me).toHaveBeenCalledTimes(1);
  });
});
