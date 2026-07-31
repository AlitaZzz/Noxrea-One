import { NextRequest } from "next/server";
import { authenticateRequest } from "@server/core/auth/middleware";
import { cancelTask, getTask } from "@server/crud/task";
import { bus } from "@server/core/events/bus";
import { EventType } from "@server/core/events/types";
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

  // 终态检查（对齐 Python）
  if (task.status === "completed" || task.status === "failed") {
    return fail(400, "Task already finished");
  }

  await cancelTask(taskId);

  // 发布进程内事件通知 SSE
  bus.publish(taskId, {
    type: EventType.TASK_FAILED,
    taskId,
    status: "failed",
    error: "Cancelled",
    timestamp: new Date().toISOString(),
  });

  return Response.json(ok(null, "cancelled"));
}
