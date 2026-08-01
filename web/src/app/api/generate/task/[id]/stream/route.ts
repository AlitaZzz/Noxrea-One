export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextRequest } from "next/server";
import { authenticateRequest } from "@server/core/auth/middleware";
import { getTask } from "@server/crud/task";
import { taskWatcher } from "@server/core/events/task-watcher";
import { logger } from "@server/core/logger";
import { fail } from "@server/core/response";
import { buildFileUrl } from "@server/services/storage/service";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await authenticateRequest(request);
  if ("error" in auth) return auth.error;

  const { id: taskId } = await params;

  // 校验任务存在且归属
  const task = await getTask(taskId);
  if (!task) return fail(404, "Task not found");
  if (task.userId !== auth.user.id) return fail(403, "Access denied");

  // 如果已经是终态，直接返回
  // CRUD 层已反序列化 JSON 字段，resultUrls/config 已是数组/对象，直接使用
  if (task.status === "completed" || task.status === "failed" || task.status === "cancelled") {
    const resultUrls = (task.resultUrls as string[] | null) ?? undefined;

    const body = JSON.stringify({
      type: "status",
      taskId: task.id,
      status: task.status,
      resultUrls: resultUrls?.map(buildFileUrl),
      resultText: task.resultText,
      error: task.error,
      prompt: task.prompt,
      config: task.config || undefined,
    });
    return new Response(`data: ${body}\n\n`, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      let aborted = false;

      request.signal.addEventListener("abort", () => {
        aborted = true;
      });

      // 心跳定时器
      const heartbeat = setInterval(() => {
        if (aborted) return;
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch { /* closed */ }
      }, 15_000);

      try {
        // 双进程架构：Worker 与 Next 进程分离，状态通过 SQLite 同步，
        // 由 TaskWatcher 轮询兜底（EventBus 仅单进程内有效，跨进程无效）。
        while (!aborted) {
          const state = await taskWatcher.watch(taskId, request.signal);
          if (aborted) break;
          if (!state) continue;

          const result = { data: state };

          if (result) {
            const rawUrls: string[] | undefined = result.data.resultUrls as string[] | undefined;
            const payload = {
              type: "status",
              taskId: taskId,
              status: result.data.status,
              resultUrls: rawUrls?.map(buildFileUrl),
              resultText: result.data.resultText,
              error: result.data.error,
              prompt: result.data.prompt,
              config: result.data.config,
            };

            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify(payload)}\n\n`)
            );

            // 终态 → 关闭
            if (
              payload.status === "completed" ||
              payload.status === "failed" ||
              payload.status === "cancelled"
            ) {
              break;
            }
          }
        }
      } catch (err) {
        logger.debug({ err, taskId }, "SSE stream error");
      } finally {
        clearInterval(heartbeat);
        try {
          controller.close();
        } catch { /* already closed */ }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
