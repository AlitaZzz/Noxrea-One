/**
 * SSE 响应辅助。
 * 把 ReadableStream 样板（事件帧编码、心跳保活、客户端断连联动上游取消、
 * 任务异常转 error 事件）收拢为 createSseResponse 一个入口，供 SSE 路由复用。
 */

interface SseContext {
  emit: (event: string, data: unknown) => void;
  signal: AbortSignal;
}

interface SseOptions {
  onDisconnect?: () => void;
}

const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
};

const activeConnections = new Set<() => void>();

/** 优雅停机时主动关闭所有 SSE 流，避免 server.close() 被长连接无限阻塞。 */
export function closeAllSseConnections(): void {
  for (const disconnect of [...activeConnections]) {
    disconnect();
  }
}

export function createSseResponse(
  request: Request,
  task: (context: SseContext) => Promise<void>,
  options: SseOptions = {},
): Response {
  const encoder = new TextEncoder();
  const upstreamAbort = new AbortController();
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let terminated = false;

  const disconnect = () => {
    if (terminated) return;
    terminated = true;
    cleanup();
    upstreamAbort.abort();
    options.onDisconnect?.();
    // close() 会因 terminated 已置位提前返回，必须直接关流：不关的话这个
    // 响应体永不终结，只能靠 GC 回收
    try {
      controller?.close();
    } catch {
      // The consumer may have cancelled between the state check and close.
    }
  };

  const cleanup = () => {
    activeConnections.delete(disconnect);
    if (heartbeat) {
      clearInterval(heartbeat);
      heartbeat = undefined;
    }
    request.signal.removeEventListener("abort", disconnect);
  };

  const write = (content: string) => {
    if (terminated || !controller) return;
    try {
      controller.enqueue(encoder.encode(content));
    } catch {
      disconnect();
    }
  };

  const emit = (event: string, data: unknown) => {
    write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const close = () => {
    if (terminated) return;
    terminated = true;
    cleanup();
    try {
      controller?.close();
    } catch {
      // The consumer may have cancelled between the state check and close.
    }
  };

  const stream = new ReadableStream<Uint8Array>({
    async start(streamController) {
      controller = streamController;
      activeConnections.add(disconnect);
      request.signal.addEventListener("abort", disconnect, { once: true });
      if (request.signal.aborted) {
        disconnect();
        return;
      }

      heartbeat = setInterval(() => write(": ping\n\n"), 15_000);
      try {
        await task({ emit, signal: upstreamAbort.signal });
      } catch (error) {
        if (!terminated) {
          const message = error instanceof Error ? error.message : "Stream failed";
          emit("error", { error: message });
        }
      } finally {
        close();
      }
    },
    cancel() {
      disconnect();
    },
  });

  return new Response(stream, { status: 200, headers: SSE_HEADERS });
}
