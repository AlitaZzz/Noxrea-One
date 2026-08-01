import { NextRequest } from "next/server";
import { authenticateRequest } from "@server/core/auth/middleware";
import { updateMeSchema } from "@server/schemas/auth";
import { getUserById, updateUser } from "@server/crud/user";
import { hashPassword, verifyPassword } from "@server/core/auth";
import { ok, fail } from "@server/core/response";

export async function GET(request: NextRequest) {
  const auth = await authenticateRequest(request);
  if ("error" in auth) return auth.error;

  const user = await getUserById(auth.user.id);
  if (!user) return fail(404, "User not found");

  return Response.json(ok(user));
}

export async function PUT(request: NextRequest) {
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

  if (parsed.data.username !== undefined) {
    updates.username = parsed.data.username;
  }
  if (parsed.data.avatarUrl !== undefined) {
    updates.avatarUrl = parsed.data.avatarUrl;
  }
  if (parsed.data.theme !== undefined) {
    updates.theme = parsed.data.theme;
  }
  if (parsed.data.language !== undefined) {
    updates.language = parsed.data.language;
  }
  if (parsed.data.password !== undefined) {
    const user = await getUserById(auth.user.id);
    if (!user) return fail(404, "User not found");

    // oldPassword 用于验证当前密码，password 用于设置新密码
    const oldPassword = parsed.data.oldPassword ?? parsed.data.password;
    const valid = await verifyPassword(oldPassword, user.hashedPassword);
    if (!valid) {
      return fail(400, "Current password is incorrect");
    }
    // TODO: 完整改密逻辑：oldPassword 验证后设置 new_password
  }

  const updated = await updateUser(auth.user.id, updates);
  return Response.json(ok(updated));
}
