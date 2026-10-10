import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticateRequest: vi.fn(),
  setAuthCookie: vi.fn(),
  getUserByUsername: vi.fn(),
  getUserById: vi.fn(),
  updateUser: vi.fn(),
  createUser: vi.fn(),
  setUserPassword: vi.fn(),
  touchLastLogin: vi.fn(),
  toPublicUser: vi.fn(),
  isUsernameTakenError: vi.fn(),
  createAccessToken: vi.fn(),
  hashPassword: vi.fn(),
  verifyPassword: vi.fn(),
  getLoginRateLimiter: vi.fn(),
  getRegisterRateLimiter: vi.fn(),
  getConfig: vi.fn(),
  getConnInfo: vi.fn(),
  loginCheck: vi.fn(),
  loggerWarn: vi.fn(),
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
  touchLastLogin: mocks.touchLastLogin,
  toPublicUser: mocks.toPublicUser,
  isUsernameTakenError: mocks.isUsernameTakenError,
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
vi.mock("@server/core/logger", () => ({
  logger: { warn: mocks.loggerWarn },
}));

import { router } from "@server/http/routes/auth";
import { makeUser } from "../../helpers/user-fixture";

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

describe("注册并发重名", () => {
  const register = () => router.request("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ username: "alice", password: "secret123" }),
  });

  beforeEach(() => {
    mocks.getRegisterRateLimiter.mockReturnValue({ check: () => true });
    mocks.hashPassword.mockResolvedValue("hashed");
  });

  it("查重后创建时撞用户名唯一约束，与串行重名一致返回 409", async () => {
    const raceError = new Error("Unique constraint failed on the fields: (`username`)");
    mocks.createUser.mockRejectedValue(raceError);
    mocks.isUsernameTakenError.mockReturnValue(true);

    const response = await register();

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "auth.username_taken" });
    expect(mocks.isUsernameTakenError).toHaveBeenCalledWith(raceError);
    expect(mocks.setAuthCookie).not.toHaveBeenCalled();
  });

  it("其他创建错误不被吞成 409，继续向上抛出", async () => {
    mocks.createUser.mockRejectedValue(new Error("disk I/O error"));
    mocks.isUsernameTakenError.mockReturnValue(false);

    const response = await register();

    expect(response.status).toBe(500);
    expect(mocks.setAuthCookie).not.toHaveBeenCalled();
  });
});

describe("登录写入最后登录时间", () => {
  it("登录成功后调用 touchLastLogin", async () => {
    const user = makeUser();
    mocks.getUserByUsername.mockResolvedValue(user);
    mocks.verifyPassword.mockResolvedValue(true);
    mocks.createAccessToken.mockResolvedValue("token");
    mocks.touchLastLogin.mockResolvedValue({ ...user, lastLoginAt: new Date() });

    const response = await router.request("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username: "alice", password: "secret" }),
    });

    expect(response.status).toBe(200);
    expect(mocks.touchLastLogin).toHaveBeenCalledWith(7);
  });

  it("写最后登录时间失败只记日志，不阻断凭据正确的登录", async () => {
    mocks.getUserByUsername.mockResolvedValue(makeUser({ id: 9, username: "carol" }));
    mocks.verifyPassword.mockResolvedValue(true);
    mocks.createAccessToken.mockResolvedValue("token");
    mocks.touchLastLogin.mockRejectedValue(new Error("database is locked"));

    const response = await router.request("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username: "carol", password: "secret" }),
    });

    expect(response.status).toBe(200);
    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 9 }),
      "Failed to record last login time",
    );
  });

  it("账户被禁用（isActive=false）不写最后登录时间", async () => {
    mocks.getUserByUsername.mockResolvedValue(makeUser({ id: 10, username: "dave", isActive: false }));

    const response = await router.request("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username: "dave", password: "secret" }),
    });

    expect(response.status).toBe(401);
    expect(mocks.verifyPassword).not.toHaveBeenCalled();
    expect(mocks.touchLastLogin).not.toHaveBeenCalled();
  });

  it("登录失败（密码错误）不写最后登录时间", async () => {
    mocks.getUserByUsername.mockResolvedValue(makeUser({ id: 8, username: "bob" }));
    mocks.verifyPassword.mockResolvedValue(false);

    const response = await router.request("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username: "bob", password: "wrong" }),
    });

    expect(response.status).toBe(401);
    expect(mocks.touchLastLogin).not.toHaveBeenCalled();
  });
});
