import { NextRequest } from "next/server";
import { authenticateRequest } from "@server/core/auth/middleware";
import { cancelTask, getTask } from "@server/crud/task";
import { ok, fail } from "@server/core/response";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await authenticateRequest(request);
  if ("error" in auth) return auth.error;

  const { id: taskId } = await params;

  const task = await getTask(taskId);
  if (!task) return fail(404, "Task not found");
  if (task.userId !== auth.user.id) return fail(403, "Access denied");

  // 终态检查（对齐 Python，包含 cancelled 防止重复取消）
  if (task.status === "completed" || task.status === "failed" || task.status === "cancelled") {
    return fail(400, "Task already finished");
  }

  await cancelTask(taskId);

  // 状态已写入 SQLite（cancelled 终态），由 TaskWatcher 轮询兜底推送至 SSE
  return Response.json(ok(null, "cancelled"));
}
