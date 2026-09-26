import { type NextRequest,NextResponse } from "next/server";

/**
 * 路由级鉴权门（Next 16 起由 middleware.ts 改名 proxy.ts，职责不变）。
 * 方案 2：proxy 向后端实测校验 token。
 *
 * 两级校验：
 * 1. 本地无签名 exp 解码——过期/损坏 token 直接按未登录处理，不发后端请求；
 *    这是「跳 /login 又被弹回 /project」死循环的唯一出口（JS 清不掉 httpOnly cookie）。
 * 2. 向后端 /api/auth/me 转发 cookie 实测——吊销（改密码递增 tokenVersion、封禁）
 *    立即生效，而非等到 JWT 自然过期。请求经同源 /api 走 next.config rewrites
 *    代理到 SERVER_URL，后端异地部署时无需任何额外配置。
 *
 * 后端不可达/超时的放行策略由 AUTH_GATE_MODE 决定（默认 fail-open 放行，
 * 本地签名校验真实性仍由 API 401 拦截器兜底）：自托管 NAS 场景可用性优先于即时吊销。
 * 设为 fail-closed 则后端不可达按未登录处理（安全优先，后端故障期间页面不可用）。
 * 签名校验本身仍在后端逐请求进行。
 */
const TOKEN_COOKIE = "noxrea-auth-token";

/** 后端实测校验超时：超过按后端故障处理，不阻塞整页加载 */
const BACKEND_CHECK_TIMEOUT_MS = 2000;

/** 后端不可达时的放行策略：fail-open（可用性优先）/ fail-closed（安全优先） */
const FAIL_CLOSED = process.env.AUTH_GATE_MODE === "fail-closed";

/** 无验证解码 JWT payload 的 exp（秒）。结构损坏或已过期返回 true */
function tokenExpired(token: string): boolean {
  const payloadPart = token.split(".")[1];
  if (!payloadPart) return true;
  try {
    const payload = JSON.parse(atob(payloadPart.replace(/-/g, "+").replace(/_/g, "/"))) as { exp?: number };
    return typeof payload.exp !== "number" || payload.exp * 1000 <= Date.now();
  } catch {
    return true;
  }
}

/** 向后端实测 token。返回 null 表示后端不可达（放行策略见 AUTH_GATE_MODE） */
async function backendVerdict(token: string, origin: string): Promise<"valid" | "revoked" | null> {
  try {
    const res = await fetch(new URL("/api/auth/me", origin), {
      headers: { cookie: `${TOKEN_COOKIE}=${token}` },
      cache: "no-store",
      signal: AbortSignal.timeout(BACKEND_CHECK_TIMEOUT_MS),
    });
    if (res.status === 200) return "valid";
    if (res.status === 401) return "revoked";
    return null;
  } catch {
    return null;
  }
}

export async function proxy(req: NextRequest) {
  const rawToken = req.cookies.get(TOKEN_COOKIE)?.value;
  const token = rawToken && !tokenExpired(rawToken) ? rawToken : null;
  const { pathname } = req.nextUrl;

  if (token) {
    const verdict = await backendVerdict(token, req.nextUrl.origin);

    if (verdict === "revoked") {
      // 已吊销：清掉 httpOnly cookie（服务端下发 Set-Cookie 可以做到），
      // 按「未登录」处理，避免 valid 页面与 401 拦截器互相弹跳
      if (pathname === "/login") {
        const res = NextResponse.next();
        res.cookies.set(TOKEN_COOKIE, "", { path: "/", maxAge: 0 });
        return res;
      }
      const res = NextResponse.redirect(new URL("/login", req.url));
      res.cookies.set(TOKEN_COOKIE, "", { path: "/", maxAge: 0 });
      return res;
    }

    // valid：按已登录处理（或 fail-open 且后端不可达）
    if (verdict === "valid" || (verdict === null && !FAIL_CLOSED)) {
      if (pathname === "/login" || pathname === "/") {
        return NextResponse.redirect(new URL("/project", req.url));
      }
      return NextResponse.next();
    }

    // 后端不可达且 fail-closed：按未登录处理（不清 cookie，后端恢复后可继续会话）
  }

  if (pathname !== "/login") {
    return NextResponse.redirect(new URL("/login", req.url));
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/", "/login", "/project/:path*", "/canvas/:path*"],
};
