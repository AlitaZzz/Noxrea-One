/**
 * SSE 流读取的公共能力。
 *
 * 服务端以 15s 心跳保活（server/http/sse.ts），这里提供事件帧解析与看门狗
 * 超时常量。画布编辑权流使用完整解析循环；生成任务流（use-sse-task-monitor）
 * 仅共用超时常量——其解析需「终态即停」等特殊语义，维持独立实现。
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

/** 每帧回调：event 为事件名（缺省 "message"），data 为解析后的载荷 */
export type SseEventHandler = (event: string, data: Record<string, unknown>) => void;

/**
 * 读取 SSE 流并按帧回调。
 *
 * @param onActivity 每收到字节时回调，供调用方刷新看门狗时间戳
 */
export async function readSseStream(
  body: ReadableStream<Uint8Array>,
  onEvent: SseEventHandler,
  options: { signal?: AbortSignal; onActivity?: () => void } = {}
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventName = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      options.onActivity?.();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

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
        onEvent(eventName || "message", data);
        eventName = "";
      }
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
