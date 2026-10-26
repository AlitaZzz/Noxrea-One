// @vitest-environment jsdom
/**
 * auth store 初始账号作用域回归测试。
 *
 * 背景：cookie 预置的已登录用户不产生 user id 变化，订阅式注入不会触发；
 * 若此时不建立账号作用域，刷新后 file-access 的持久化载入/写入会因
 * currentAccountKey() 为 null 整条链路跳过（IndexedDB 既不读也不写）。
 * 模块加载行为必须用全新模块注册表验证，因此在每个用例内动态导入。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/features/auth/api", () => ({
  authApi: {
    me: vi.fn(),
    login: vi.fn(),
    register: vi.fn(),
    logout: vi.fn(async () => undefined),
    updateMe: vi.fn(async () => undefined),
  },
}));

vi.mock("@/lib/global-notification", () => ({
  showGlobalNotification: () => ({ error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() }),
  notifyFailure: () => undefined,
}));

vi.mock("@/lib/i18n/config", () => ({
  default: { t: (key: string) => key, exists: () => false },
  setAppLanguage: vi.fn(),
}));

const USER_COOKIE = "noxrea-user";
const CACHED_USER = { id: 7, username: "cached", avatarKey: null, theme: "dark", language: "zh" };

function writeUserCookie(user: typeof CACHED_USER | null): void {
  document.cookie = user
    ? `${USER_COOKIE}=${encodeURIComponent(JSON.stringify(user))}; path=/`
    : `${USER_COOKIE}=; path=/; max-age=0`;
}

describe("auth store 初始账号作用域", () => {
  beforeEach(() => {
    vi.resetModules();
    writeUserCookie(null);
  });

  afterEach(() => {
    writeUserCookie(null);
  });

  it("cookie 预置已登录用户时，加载 store 即建立账号作用域", async () => {
    writeUserCookie(CACHED_USER);
    const { currentAccountKey } = await import("@/lib/session-lifecycle");
    await import("@/features/auth/store");

    expect(currentAccountKey()).toBe(String(CACHED_USER.id));
  });

  it("无 cookie 时账号作用域保持为空", async () => {
    const { currentAccountKey } = await import("@/lib/session-lifecycle");
    await import("@/features/auth/store");

    expect(currentAccountKey()).toBeNull();
  });
});
