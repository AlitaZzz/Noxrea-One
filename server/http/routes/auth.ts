/**
 * 认证路由。
 * 处理登录、注册、个人信息更新与登出等鉴权接口。
 */
import { Hono } from "hono";
import { authenticateRequest } from "@server/core/auth/middleware";
import { loginRequestSchema, registerRequestSchema, updateMeSchema } from "@server/schemas/auth";
import { getUserByUsername, getUserById, updateUser, createUser } from "@server/crud/user";
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

  // 签发 JWT
  const token = await createAccessToken(user.id, user.username);

  return c.json(ok({ access_token: token, token_type: "bearer", user }, "Login successful"));
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

  // 签发 JWT
  const token = await createAccessToken(user.id, user.username);

  return c.json(ok({ access_token: token, token_type: "bearer", user }, "Registration successful"));
});

// GET /api/auth/me
router.get("/api/auth/me", async (c) => {
  const request = c.req.raw;
  const auth = await authenticateRequest(request);
  if ("error" in auth) return auth.error;

  const user = await getUserById(auth.user.id);
  if (!user) return failCode(404, "auth.user_not_found");

  return c.json(ok(user));
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

  if (parsed.data.password !== undefined) {
    const user = await getUserById(auth.user.id);
    if (!user) return failCode(404, "auth.user_not_found");

    const oldPassword = parsed.data.oldPassword ?? parsed.data.password;
    const valid = await verifyPassword(oldPassword, user.hashedPassword);
    if (!valid) {
      return failCode(400, "auth.current_password_incorrect");
    }
  }

  const updated = await updateUser(auth.user.id, updates);
  return c.json(ok(updated));
});

export { router };
