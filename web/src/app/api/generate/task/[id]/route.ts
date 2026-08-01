import { NextRequest } from "next/server";
import { authenticateRequest } from "@server/core/auth/middleware";
import { getTask } from "@server/crud/task";
import { ok, fail } from "@server/core/response";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await authenticateRequest(request);
  if ("error" in auth) return auth.error;

  const { id } = await params;
  const task = await getTask(id);
  if (!task) return fail(404, "Task not found");

  // 归属校验
  if (task.userId !== auth.user.id) return fail(403, "Access denied");

  return Response.json(ok(task));
}
