/**
 * SSE 流读取的公共能力（三路 SSE 消费的唯一解析器）。
 *
 * 服务端以 15s 心跳保活（server/http/sse.ts）。生成任务流（use-sse-task-monitor）、
 * Agent 流（use-canvas-agent-stream）与画布编辑权流（use-canvas-session）的
 * 线上格式完全一致（统一经 createSseResponse 的 emit 输出），此前三处各自
 * 维护解析实现，现全部收敛于此。
 *
 * 支持的帧格式子集（与本仓库服务端 emit 的输出一致）：LF / CRLF 分隔、
 * `event: <名称>` 事件行、单行 `data: <JSON 对象>` 载荷、`:` 前缀注释行。
 * 不支持多行 data 拼接与纯 CR 分隔——接入第三方 SSE 源前需先确认帧格式。
 */

/** 服务端 15s 心跳；30s 收不到任何字节即判定连接静默死亡，断开重连 */
export const SSE_WATCHDOG_TIMEOUT_MS = 30_000;
/** 连接建立阶段（fetch 至响应头）的预算：慢握手不等于连接死亡，放宽到 60s */
export const SSE_CONNECT_TIMEOUT_MS = 60_000;
/** 看门狗检查间隔 */
export const SSE_WATCHDOG_CHECK_MS = 5_000;

/**
 * 每帧回调：event 为事件名（缺省 "message"），data 为解析后的载荷。
 * 返回 false 提前结束读取（如任务终态即停、服务端推完即关流）；
 * 回调内抛错会中断读取并向上传播（error 事件 → 终止对话流）。
 */
export type SseEventHandler = (event: string, data: Record<string, unknown>) => void | false;

export interface ReadSseOptions {
  signal?: AbortSignal;
  /** 每收到字节时回调，供调用方刷新看门狗时间戳 */
  onActivity?: () => void;
  /** 单次 read 空闲超时（毫秒）：超时 cancel reader 并 reject（Agent 流的读空闲防护） */
  readTimeoutMs?: number;
}

/**
 * 读取 SSE 流并按帧回调。流结束、onEvent 返回 false 或回调抛错时返回；
 * finally 中释放 reader，异常或中断时避免连接悬挂。
 */
export async function readSseStream(
  body: ReadableStream<Uint8Array>,
  onEvent: SseEventHandler,
  options: ReadSseOptions = {}
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventName = "";

  // Agent 流的读空闲防护：单次 read 超时即 cancel 并 reject
  const readOnce = options.readTimeoutMs
    ? () =>
        new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
          const timer = setTimeout(() => {
            reader.cancel().catch(() => {});
            reject(new Error(`read timeout: no data for ${options.readTimeoutMs! / 1000}s`));
          }, options.readTimeoutMs);
          reader.read().then(
            (r) => {
              clearTimeout(timer);
              resolve(r);
            },
            (e) => {
              clearTimeout(timer);
              reject(e);
            },
          );
        })
    : () => reader.read();

  try {
    while (true) {
      const { done, value } = await readOnce();
      options.onActivity?.();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      let stopped = false;
      for (const line of lines) {
        // 心跳注释行
        if (line.startsWith(":")) continue;
        if (line.startsWith("event: ")) {
          eventName = line.slice(7).trim();
          continue;
        }
        if (!line.startsWith("data: ")) continue;

        let data: Record<string, unknown> = {};
        try {
          data = JSON.parse(line.slice(6)) as Record<string, unknown>;
        } catch {
          // 单行解析失败不影响后续帧；事件名随失败帧一并丢弃，
          // 避免陈旧 event 名误作用到下一帧的数据上
          eventName = "";
          continue;
        }
        if (onEvent(eventName || "message", data) === false) {
          stopped = true;
          break;
        }
        eventName = "";
      }
      if (stopped) break;
    }
  } finally {
    // 流异常或外部中断时释放 reader，避免连接悬挂
    try {
      await reader.cancel();
    } catch {
      // 已关闭时 cancel 可能抛错
    }
  }
}
