/**
 * 认证路由。
 * 处理登录、注册、个人信息更新与登出等鉴权接口。
 */
import { Hono } from "hono";
import { authenticateRequest, setAuthCookie } from "@server/http/middleware/auth";
import { loginRequestSchema, registerRequestSchema, updateMeSchema } from "@server/schemas/auth";
import { getUserByUsername, getUserById, updateUser, createUser, setUserPassword, toPublicUser } from "@server/crud/user";
import { createAccessToken, hashPassword, verifyPassword } from "@server/core/auth";
import { getLoginRateLimiter, getRegisterRateLimiter } from "@server/core/ratelimit";
import { getConfig } from "@server/core/config";
import { ok, failCode } from "@server/core/response";

const router = new Hono();

router.post("/api/auth/login", async (c) => {
  const request = c.req.raw;

  // 限流
  const ip = request.headers.get("x-forwarded-for") ?? "unknown";
  if (!getLoginRateLimiter().check(`login:${ip}`)) {
    return failCode(429, "auth.login_rate_limited");
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

  // 签发 JWT 并下发 httpOnly cookie（浏览器端凭据载体；body 中的 access_token 供纯 API 客户端使用）
  const token = await createAccessToken(user.id, user.username, user.tokenVersion);
  setAuthCookie(c, token);

  return c.json(ok({ access_token: token, token_type: "bearer", user: toPublicUser(user) }, "Login successful"));
});

// POST /api/auth/register
router.post("/api/auth/register", async (c) => {
  const request = c.req.raw;

  // 注册开关
  const cfg = getConfig();
  if (!cfg.ALLOW_REGISTRATION) {
    return failCode(403, "auth.registration_disabled");
  }

  // 限流
  const ip = request.headers.get("x-forwarded-for") ?? "unknown";
  if (!getRegisterRateLimiter().check(`register:${ip}`)) {
    return failCode(429, "auth.register_rate_limited");
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

  const { username, password, email } = parsed.data;

  // 查重
  const existing = await getUserByUsername(username);
  if (existing) {
    return failCode(409, "auth.username_taken");
  }

  // 哈希密码
  const hashed = await hashPassword(password);

  // 创建用户
  const user = await createUser({ username, hashedPassword: hashed, email });

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

// GET /api/auth/me
router.get("/api/auth/me", async (c) => {
  const request = c.req.raw;
  const auth = await authenticateRequest(request);
  if ("error" in auth) return auth.error;

  const user = await getUserById(auth.user.id);
  if (!user) return failCode(404, "auth.user_not_found");

  return c.json(ok(toPublicUser(user)));
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

  const updates: Record<string, unknown> = {};

  if (parsed.data.username !== undefined) updates.username = parsed.data.username;
  if (parsed.data.avatarUrl !== undefined) updates.avatarUrl = parsed.data.avatarUrl;
  if (parsed.data.theme !== undefined) updates.theme = parsed.data.theme;
  if (parsed.data.language !== undefined) updates.language = parsed.data.language;

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

  await updateUser(auth.user.id, updates);
  // 密码分支已改库，重新取一遍保证返回值与 cookie 中版本号一致
  const fresh = await getUserById(auth.user.id);
  if (!fresh) return failCode(404, "auth.user_not_found");

  if (passwordChanged) {
    const token = await createAccessToken(fresh.id, fresh.username, fresh.tokenVersion);
    setAuthCookie(c, token);
  }
  return c.json(ok(toPublicUser(fresh)));
});

export { router };
