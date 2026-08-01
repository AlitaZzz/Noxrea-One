import { NextRequest } from "next/server";
import { registerRequestSchema } from "@server/schemas/auth";
import { getUserByUsername, createUser } from "@server/crud/user";
import { hashPassword, createAccessToken } from "@server/core/auth";
import { getRegisterRateLimiter } from "@server/core/ratelimit";
import { getConfig } from "@server/core/config";
import { ok, fail } from "@server/core/response";

export async function POST(request: NextRequest) {
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
  const user = await createUser({
    username,
    hashedPassword: hashed,
    email,
  });

  // 签发 JWT
  const token = await createAccessToken(user.id, user.username);

  return Response.json(
    ok({ access_token: token, token_type: "bearer", user }, "Registration successful")
  );
}
