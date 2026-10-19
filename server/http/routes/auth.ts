/**
 * 认证路由。
 * 处理登录、注册、个人信息更新与登出等鉴权接口。
 */
import { Hono } from "hono";
import { authenticateRequest, setAuthCookie } from "@server/http/middleware/auth";
import { loginRequestSchema, registerRequestSchema, updateMeSchema } from "@server/schemas/auth";
import { getUserByUsername, getUserById, updateUser, createUser, isUsernameTakenError, setUserPassword, touchLastLogin, toPublicUser, UserAvatarKeyError } from "@server/crud/user";
import type { User } from "@server/core/database/generated/client";
import { createAccessToken, hashPassword, verifyPassword } from "@server/core/auth";
import { getStorageSummary } from "@server/services/storage/quota";
import { getLoginRateLimiter, getRegisterRateLimiter } from "@server/core/ratelimit";
import { getSetting } from "@server/core/settings";
import { logger } from "@server/core/logger";
import { getConnInfo } from "@hono/node-server/conninfo";
import { resolveRateLimitIp } from "@server/core/ratelimit/client-ip";
import { ok, failCode } from "@server/core/response";

const router = new Hono();

router.post("/api/auth/login", async (c) => {
  const request = c.req.raw;

  // 限流：X-Forwarded-For 可伪造，默认使用 socket peer；只有可信代理链才解析该头。
  const ip = resolveRateLimitIp({
    remoteAddress: getConnInfo(c).remote.address,
    forwardedFor: request.headers.get("x-forwarded-for"),
    trustedProxyCidrs: getSetting("network.trusted_proxy_cidrs"),
  });
  const loginCheck = getLoginRateLimiter().check(`login:${ip}`);
  if (!loginCheck.allowed) {
    return failCode(429, "auth.login_rate_limited", undefined, {
      "Retry-After": String(loginCheck.retryAfterSeconds),
      "Cache-Control": "no-store",
    });
  }

  // 解析
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return failCode(400, "common.invalid_json");
  }

  const parsed = loginRequestSchema.safeParse(body);
  if (!parsed.success) {
    return failCode(422, "common.invalid_request");
  }

  const { username, password } = parsed.data;

  // 查用户
  const user = await getUserByUsername(username);
  if (!user || !user.isActive) {
    return failCode(401, "auth.invalid_credentials");
  }

  // 验密码
  const valid = await verifyPassword(password, user.hashedPassword);
  if (!valid) {
    return failCode(401, "auth.invalid_credentials");
  }

  // lastLoginAt 是只写审计列：写失败只记日志，不得让凭据正确的登录整体失败
  try {
    await touchLastLogin(user.id);
  } catch (err) {
    logger.warn({ err, userId: user.id }, "Failed to record last login time");
  }

  // 签发 JWT 并下发 httpOnly cookie（浏览器端凭据载体；body 中的 access_token 供纯 API 客户端使用）
  const token = await createAccessToken(user.id, user.username, user.tokenVersion);
  setAuthCookie(c, token);

  return c.json(ok({ access_token: token, token_type: "bearer", user: toPublicUser(user) }, "Login successful"));
});

// POST /api/auth/register
router.post("/api/auth/register", async (c) => {
  const request = c.req.raw;

  // 注册开关
  if (!getSetting("auth.registration_enabled")) {
    return failCode(403, "auth.registration_disabled");
  }

  // 限流：与登录一致，不信任未配置为可信代理的 X-Forwarded-For。
  const ip = resolveRateLimitIp({
    remoteAddress: getConnInfo(c).remote.address,
    forwardedFor: request.headers.get("x-forwarded-for"),
    trustedProxyCidrs: getSetting("network.trusted_proxy_cidrs"),
  });
  const registerCheck = getRegisterRateLimiter().check(`register:${ip}`);
  if (!registerCheck.allowed) {
    return failCode(429, "auth.register_rate_limited", undefined, {
      "Retry-After": String(registerCheck.retryAfterSeconds),
      "Cache-Control": "no-store",
    });
  }

  // 解析
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return failCode(400, "common.invalid_json");
  }

  const parsed = registerRequestSchema.safeParse(body);
  if (!parsed.success) {
    return failCode(422, "common.invalid_request");
  }

  const { username, password } = parsed.data;

  // 查重
  const existing = await getUserByUsername(username);
  if (existing) {
    return failCode(409, "auth.username_taken");
  }

  // 哈希密码
  const hashed = await hashPassword(password);

  // 创建用户：上方查重与此处创建之间存在竞态，败方撞用户名唯一约束时与串行重名一致返回 409
  let user;
  try {
    user = await createUser({ username, hashedPassword: hashed });
  } catch (err) {
    if (isUsernameTakenError(err)) return failCode(409, "auth.username_taken");
    throw err;
  }

  // 签发 JWT 并下发 httpOnly cookie（同登录）
  const token = await createAccessToken(user.id, user.username, user.tokenVersion);
  setAuthCookie(c, token);

  return c.json(ok({ access_token: token, token_type: "bearer", user: toPublicUser(user) }, "Registration successful"));
});

// POST /api/auth/logout
// 登出：过期鉴权 cookie（httpOnly，只能由服务端清除）。幂等，无需鉴权。
router.post("/api/auth/logout", (c) => {
  setAuthCookie(c, "", 0);
  return c.json(ok(null, "Logged out"));
});

/** me 资源表示单点：GET/PUT 同组合（specs/storage-user-quota.md 规则 5）——同资源表示一致由结构保证，而非两处理器各自书写 */
async function meRepresentation(user: User) {
  return { ...toPublicUser(user), storage: await getStorageSummary(user.id) };
}

// GET /api/auth/me
router.get("/api/auth/me", async (c) => {
  const request = c.req.raw;
  const auth = await authenticateRequest(request);
  if ("error" in auth) return auth.error;

  const user = await getUserById(auth.user.id);
  if (!user) return failCode(404, "auth.user_not_found");

  return c.json(ok(await meRepresentation(user)));
});

// PUT /api/auth/me
router.put("/api/auth/me", async (c) => {
  const request = c.req.raw;
  const auth = await authenticateRequest(request);
  if ("error" in auth) return auth.error;

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return failCode(400, "common.invalid_json");
  }

  const parsed = updateMeSchema.safeParse(body);
  if (!parsed.success) {
    return failCode(422, "common.invalid_request");
  }

  // password/oldPassword 由下方分支单独处理；画像字段在 updateUser 白名单过滤后落库
  let passwordChanged = false;
  if (parsed.data.password !== undefined) {
    const user = await getUserById(auth.user.id);
    if (!user) return failCode(404, "auth.user_not_found");

    const oldPassword = parsed.data.oldPassword ?? parsed.data.password;
    const valid = await verifyPassword(oldPassword, user.hashedPassword);
    if (!valid) {
      return failCode(400, "auth.current_password_incorrect");
    }

    // 写入新哈希并递增凭据版本号（旧 JWT 全部失效）。此前只校验不落库，
    // 改密码实际是空操作却提示成功。随后轮换当前会话：用新版本号重签，
    // 否则本次修改会把自己的 token 也作废、被 401 拦截器踢回登录页
    const hashed = await hashPassword(parsed.data.password);
    await setUserPassword(auth.user.id, hashed);
    passwordChanged = true;
  }

  // 画像字段显式透传（password/oldPassword 不入此通道）；crud 层 fail-closed 兜底
  // 与资产/封面错误映射同风格（schema refine 已拦，此处为纵深防线）
  try {
    await updateUser(auth.user.id, {
      avatarKey: parsed.data.avatarKey,
      theme: parsed.data.theme,
      language: parsed.data.language,
    });
  } catch (err) {
    if (err instanceof UserAvatarKeyError) return failCode(422, "common.invalid_request");
    throw err;
  }
  // 密码分支已改库，重新取一遍保证返回值与 cookie 中版本号一致
  const fresh = await getUserById(auth.user.id);
  if (!fresh) return failCode(404, "auth.user_not_found");

  if (passwordChanged) {
    const token = await createAccessToken(fresh.id, fresh.username, fresh.tokenVersion);
    setAuthCookie(c, token);
  }
  return c.json(ok(await meRepresentation(fresh)));
});

export { router };
