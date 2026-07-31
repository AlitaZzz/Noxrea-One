export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextRequest } from "next/server";
import { authenticateRequest } from "@server/core/auth/middleware";
import { getTask } from "@server/crud/task";
import { bus } from "@server/core/events/bus";
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
  if (task.status === "completed" || task.status === "failed") {
    let resultUrls: string[] | undefined;
    try {
      resultUrls = task.resultUrls ? JSON.parse(task.resultUrls) : undefined;
    } catch { /* ignore */ }

    const body = JSON.stringify({
      type: "status",
      task_id: task.id,
      status: task.status,
      result_urls: resultUrls?.map(buildFileUrl),
      result_text: task.resultText,
      error: task.error,
      prompt: task.prompt,
      config: task.config ? JSON.parse(task.config) : undefined,
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
        bus.unsubscribe(taskId);
      });

      // 心跳定时器
      const heartbeat = setInterval(() => {
        if (aborted) return;
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch { /* closed */ }
      }, 15_000);

      try {
        // Promise.race: EventBus（进程内，0 延迟） vs TaskWatcher（跨进程兜底）
        while (!aborted) {
          const result = await Promise.race([
            bus.waitEvent(taskId, 1000).then((evt) => {
              if (evt) return { source: "bus", data: evt };
              return null;
            }),
            taskWatcher.watch(taskId, request.signal).then((state) => {
              if (state) return { source: "watcher", data: state };
              return null;
            }),
          ]);

          if (aborted) break;

          if (result) {
            const rawUrls: string[] | undefined = result.data.resultUrls as string[] | undefined;
            const payload = {
              type: "status",
              task_id: taskId,
              status: result.data.status,
              result_urls: rawUrls?.map(buildFileUrl),
              result_text: result.data.resultText,
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
              payload.status === "failed"
            ) {
              break;
            }
          }
        }
      } catch (err) {
        logger.debug({ err, taskId }, "SSE stream error");
      } finally {
        clearInterval(heartbeat);
        bus.unsubscribe(taskId);
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
