import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticateRequest: vi.fn(),
  setAuthCookie: vi.fn(),
  getUserByUsername: vi.fn(),
  getUserById: vi.fn(),
  updateUser: vi.fn(),
  createUser: vi.fn(),
  setUserPassword: vi.fn(),
  toPublicUser: vi.fn(),
  createAccessToken: vi.fn(),
  hashPassword: vi.fn(),
  verifyPassword: vi.fn(),
  getLoginRateLimiter: vi.fn(),
  getRegisterRateLimiter: vi.fn(),
  getConfig: vi.fn(),
  getConnInfo: vi.fn(),
  loginCheck: vi.fn(),
}));

vi.mock("@server/http/middleware/auth", () => ({
  authenticateRequest: mocks.authenticateRequest,
  setAuthCookie: mocks.setAuthCookie,
}));
vi.mock("@server/crud/user", () => ({
  getUserByUsername: mocks.getUserByUsername,
  getUserById: mocks.getUserById,
  updateUser: mocks.updateUser,
  createUser: mocks.createUser,
  setUserPassword: mocks.setUserPassword,
  toPublicUser: mocks.toPublicUser,
}));
vi.mock("@server/core/auth", () => ({
  createAccessToken: mocks.createAccessToken,
  hashPassword: mocks.hashPassword,
  verifyPassword: mocks.verifyPassword,
}));
vi.mock("@server/core/ratelimit", () => ({
  getLoginRateLimiter: mocks.getLoginRateLimiter,
  getRegisterRateLimiter: mocks.getRegisterRateLimiter,
}));
vi.mock("@server/core/config", () => ({
  getConfig: mocks.getConfig,
}));
vi.mock("@hono/node-server/conninfo", () => ({
  getConnInfo: mocks.getConnInfo,
}));

import { router } from "./auth";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getLoginRateLimiter.mockReturnValue({ check: mocks.loginCheck });
  mocks.loginCheck.mockReturnValue(true);
  mocks.getConnInfo.mockReturnValue({ remote: { address: "203.0.113.10" } });
  mocks.getConfig.mockReturnValue({
    ALLOW_REGISTRATION: true,
    TRUSTED_PROXY_CIDRS: "",
  });
  mocks.getUserByUsername.mockResolvedValue(null);
});

describe("认证限流 IP 解析", () => {
  it("默认不信任直连客户端伪造的 X-Forwarded-For", async () => {
    const response = await router.request("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username: "alice", password: "secret" }),
      headers: {
        "Content-Type": "application/json",
        "X-Forwarded-For": "198.51.100.1,198.51.100.2",
      },
    });

    expect(response.status).toBe(401);
    expect(mocks.loginCheck).toHaveBeenCalledWith("login:203.0.113.10");
  });

  it("可信代理存在时解析 XFF 中最右侧的非可信客户端", async () => {
    mocks.getConfig.mockReturnValue({
      ALLOW_REGISTRATION: true,
      TRUSTED_PROXY_CIDRS: "10.0.0.0/8",
    });
    mocks.getConnInfo.mockReturnValue({ remote: { address: "10.0.0.1" } });

    await router.request("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username: "alice", password: "secret" }),
      headers: {
        "Content-Type": "application/json",
        "X-Forwarded-For": "198.51.100.10,10.0.0.2",
      },
    });

    expect(mocks.loginCheck).toHaveBeenCalledWith("login:198.51.100.10");
  });
});
