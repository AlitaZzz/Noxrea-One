import { Hono } from "hono";
import { authenticateRequest } from "@server/core/auth/middleware";
import { loginRequestSchema, registerRequestSchema, updateMeSchema } from "@server/schemas/auth";
import { getUserByUsername, getUserById, updateUser, createUser } from "@server/crud/user";
import { createAccessToken, hashPassword, verifyPassword } from "@server/core/auth";
import { getLoginRateLimiter, getRegisterRateLimiter } from "@server/core/ratelimit";
import { getConfig } from "@server/core/config";
import { ok, fail } from "@server/core/response";

const router = new Hono();

// ── POST /api/auth/login ──
router.post("/api/auth/login", async (c) => {
  const request = c.req.raw;

  // 限流
  const ip = request.headers.get("x-forwarded-for") ?? "unknown";
  if (!getLoginRateLimiter().check(`login:${ip}`)) {
    return fail(429, "登录尝试过于频繁，请稍后再试。");
  }

  // 解析
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, "Invalid JSON body");
  }

  const parsed = loginRequestSchema.safeParse(body);
  if (!parsed.success) {
    return fail(422, parsed.error.issues.map((i) => i.message).join("; "));
  }

  const { username, password } = parsed.data;

  // 查用户
  const user = await getUserByUsername(username);
  if (!user || !user.isActive) {
    return fail(401, "用户名或密码错误");
  }

  // 验密码
  const valid = await verifyPassword(password, user.hashedPassword);
  if (!valid) {
    return fail(401, "用户名或密码错误");
  }

  // 签发 JWT
  const token = await createAccessToken(user.id, user.username);

  return c.json(ok({ access_token: token, token_type: "bearer", user }, "Login successful"));
});

// ── POST /api/auth/register ──
router.post("/api/auth/register", async (c) => {
  const request = c.req.raw;

  // 注册开关
  const cfg = getConfig();
  if (!cfg.ALLOW_REGISTRATION) {
    return fail(403, "Registration is disabled");
  }

  // 限流
  const ip = request.headers.get("x-forwarded-for") ?? "unknown";
  if (!getRegisterRateLimiter().check(`register:${ip}`)) {
    return fail(429, "注册尝试过于频繁，请稍后再试。");
  }

  // 解析
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, "Invalid JSON body");
  }

  const parsed = registerRequestSchema.safeParse(body);
  if (!parsed.success) {
    return fail(422, parsed.error.issues.map((i) => i.message).join("; "));
  }

  const { username, password, email } = parsed.data;

  // 查重
  const existing = await getUserByUsername(username);
  if (existing) {
    return fail(409, "用户名已存在");
  }

  // 哈希密码
  const hashed = await hashPassword(password);

  // 创建用户
  const user = await createUser({ username, hashedPassword: hashed, email });

  // 签发 JWT
  const token = await createAccessToken(user.id, user.username);

  return c.json(ok({ access_token: token, token_type: "bearer", user }, "Registration successful"));
});

// ── GET /api/auth/me ──
router.get("/api/auth/me", async (c) => {
  const request = c.req.raw;
  const auth = await authenticateRequest(request);
  if ("error" in auth) return auth.error;

  const user = await getUserById(auth.user.id);
  if (!user) return fail(404, "User not found");

  return c.json(ok(user));
});

// ── PUT /api/auth/me ──
router.put("/api/auth/me", async (c) => {
  const request = c.req.raw;
  const auth = await authenticateRequest(request);
  if ("error" in auth) return auth.error;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, "Invalid JSON body");
  }

  const parsed = updateMeSchema.safeParse(body);
  if (!parsed.success) {
    return fail(422, parsed.error.issues.map((i) => i.message).join("; "));
  }

  const updates: Record<string, unknown> = {};

  if (parsed.data.username !== undefined) updates.username = parsed.data.username;
  if (parsed.data.avatarUrl !== undefined) updates.avatarUrl = parsed.data.avatarUrl;
  if (parsed.data.theme !== undefined) updates.theme = parsed.data.theme;
  if (parsed.data.language !== undefined) updates.language = parsed.data.language;

  if (parsed.data.password !== undefined) {
    const user = await getUserById(auth.user.id);
    if (!user) return fail(404, "User not found");

    const oldPassword = parsed.data.oldPassword ?? parsed.data.password;
    const valid = await verifyPassword(oldPassword, user.hashedPassword);
    if (!valid) {
      return fail(400, "Current password is incorrect");
    }
  }

  const updated = await updateUser(auth.user.id, updates);
  return c.json(ok(updated));
});

export { router };
