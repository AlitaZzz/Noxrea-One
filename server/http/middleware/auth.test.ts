import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

vi.mock("@server/core/config", () => ({
  getConfig: () => ({
    JWT_EXPIRE_MINUTES: 30,
    LOG_LEVEL: "silent",
    ALLOW_INSECURE_SECRETS: true,
  }),
}));

vi.mock("@server/core/database/client", () => ({
  prisma: {},
}));

import { setAuthCookie } from "./auth";

function buildApp() {
  const app = new Hono();
  app.get("/set", (c) => {
    setAuthCookie(c, "token-xyz");
    return c.text("ok");
  });
  return app;
}

const cookieOf = (res: Response): string | null => res.headers.get("set-cookie")?.toLowerCase() ?? null;

describe("setAuthCookie secure 属性", () => {
  beforeEach(() => vi.clearAllMocks());

  it("HTTPS 请求（X-Forwarded-Proto）下发 Secure cookie，maxAge 与 JWT 过期一致", async () => {
    const res = await buildApp().request("/set", {
      headers: { "x-forwarded-proto": "https" },
    });
    const cookie = cookieOf(res);
    expect(cookie).toContain("secure");
    expect(cookie).toContain("httponly");
    // JWT_EXPIRE_MINUTES=30 → 1800s
    expect(cookie).toContain("max-age=1800");
  });

  it("X-Forwarded-Proto 多值取第一个（https, http → Secure）", async () => {
    const res = await buildApp().request("/set", {
      headers: { "x-forwarded-proto": "https, http" },
    });
    expect(cookieOf(res)).toContain("secure");
  });

  it("本地 http 请求不带 Secure（否则浏览器丢弃 cookie 无法登录）", async () => {
    const res = await buildApp().request("/set");
    const cookie = cookieOf(res);
    expect(cookie).not.toContain("secure");
    expect(cookie).toContain("httponly");
  });

  it("X-Forwarded-Proto 为 http 时以转发头为准，不带 Secure", async () => {
    const res = await buildApp().request("/set", {
      headers: { "x-forwarded-proto": "http" },
    });
    expect(cookieOf(res)).not.toContain("secure");
  });
});
