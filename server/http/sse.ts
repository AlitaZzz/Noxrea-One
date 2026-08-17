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

  const cleanup = () => {
    if (heartbeat) {
      clearInterval(heartbeat);
      heartbeat = undefined;
    }
    request.signal.removeEventListener("abort", disconnect);
  };

  const disconnect = () => {
    if (terminated) return;
    terminated = true;
    cleanup();
    upstreamAbort.abort();
    options.onDisconnect?.();
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
