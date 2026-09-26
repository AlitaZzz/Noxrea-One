/**
 * 路由门（proxy.ts）行为测试：
 * - 本地 exp 校验：过期/损坏 token 按未登录处理，不触发后端实测
 * - 后端实测 revoked：清 cookie 并跳 /login
 * - 后端不可达：AUTH_GATE_MODE=fail-open（默认）放行 / fail-closed 按未登录处理
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();

function b64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj))
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** exp 未来 1 小时的伪造 JWT（路由门只本地解码 exp，不验签） */
function validToken(): string {
  return `${b64url({ alg: "HS256" })}.${b64url({ exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;
}

function expiredToken(): string {
  return `${b64url({ alg: "HS256" })}.${b64url({ exp: Math.floor(Date.now() / 1000) - 10 })}.sig`;
}

function req(pathname: string, token?: string): NextRequest {
  const headers = new Headers();
  if (token) headers.set("cookie", `noxrea-auth-token=${token}`);
  return new NextRequest(new URL(`http://localhost${pathname}`), { headers });
}

async function loadProxy(mode?: string) {
  vi.resetModules();
  if (mode) process.env.AUTH_GATE_MODE = mode;
  else delete process.env.AUTH_GATE_MODE;
  return import("@/proxy");
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", fetchMock);
});

describe("路由门两级校验", () => {
  it("本地过期 token 按未登录处理，且不触发后端实测", async () => {
    const { proxy } = await loadProxy("fail-open");
    const res = await proxy(req("/project", expiredToken()));
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get("location")!)).toMatchObject({ pathname: "/login" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("后端 revoked：清 httpOnly cookie 并跳 /login", async () => {
    fetchMock.mockResolvedValue({ status: 401 });
    const { proxy } = await loadProxy("fail-open");

    const res = await proxy(req("/project", validToken()));

    expect(res.status).toBe(307);
    expect(new URL(res.headers.get("location")!)).toMatchObject({ pathname: "/login" });
    const setCookie = res.headers.getSetCookie().join("; ");
    expect(setCookie).toContain("noxrea-auth-token=");
    expect(setCookie).toMatch(/Max-Age=0/i);
  });

  it("后端 revoked 且已在 /login：只清 cookie，不跳转", async () => {
    fetchMock.mockResolvedValue({ status: 401 });
    const { proxy } = await loadProxy("fail-open");

    const res = await proxy(req("/login", validToken()));

    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie().length).toBeGreaterThan(0);
  });
});

describe("AUTH_GATE_MODE 放行策略", () => {
  it("fail-open（默认）：后端不可达时放行，且 /login 跳 /project", async () => {
    fetchMock.mockRejectedValue(new Error("backend down"));
    const { proxy } = await loadProxy();

    expect((await proxy(req("/project", validToken()))).status).toBe(200);
    const res = await proxy(req("/login", validToken()));
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get("location")!)).toMatchObject({ pathname: "/project" });
  });

  it("fail-closed：后端不可达按未登录处理（不清 cookie）", async () => {
    fetchMock.mockRejectedValue(new Error("backend down"));
    const { proxy } = await loadProxy("fail-closed");

    const res = await proxy(req("/project", validToken()));

    expect(res.status).toBe(307);
    expect(new URL(res.headers.get("location")!)).toMatchObject({ pathname: "/login" });
    // cookie 原样保留：后端恢复后可继续会话，不属于吊销
    expect(res.headers.getSetCookie().length).toBe(0);
  });

  it("fail-closed：后端正常校验通过时照常放行", async () => {
    fetchMock.mockResolvedValue({ status: 200 });
    const { proxy } = await loadProxy("fail-closed");

    expect((await proxy(req("/project", validToken()))).status).toBe(200);
  });
});
