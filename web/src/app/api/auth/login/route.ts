import { NextRequest } from "next/server";
import { loginRequestSchema } from "@server/schemas/auth";
import { toUserOut } from "@server/schemas/user";
import { getUserByUsername } from "@server/crud/user";
import { createAccessToken, verifyPassword } from "@server/core/auth";
import { getLoginRateLimiter } from "@server/core/ratelimit";
import { ok, fail } from "@server/core/response";

export async function POST(request: NextRequest) {
  // 限流
  const ip = request.headers.get("x-forwarded-for") ?? "unknown";
  if (!getLoginRateLimiter().check(`login:${ip}`)) {
    return fail(429, "Too many login attempts. Please try again later.");
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
  if (!user || !user.is_active) {
    return fail(401, "Invalid username or password");
  }

  // 验密码
  const valid = await verifyPassword(password, user.hashedPassword);
  if (!valid) {
    return fail(401, "Invalid username or password");
  }

  // 签发 JWT
  const token = await createAccessToken(user.id, user.username);

  return Response.json(
    ok({ access_token: token, token_type: "bearer", user: toUserOut(user) }, "Login successful")
  );
}
