// ── OpenAI LLM 协议 ──

import type {
  ProtocolRequestResult,
  ProtocolResponse,
  ProtocolService,
  ProtocolToolCall,
} from "@server/services/protocols/base";

export class OpenAiLlmProtocol implements ProtocolService {
  readonly name = "openai_llm";

  buildLlmRequest(
    baseUrl: string,
    apiKey: string,
    body: Record<string, unknown>
  ): ProtocolRequestResult {
    return {
      url: `${baseUrl}/chat/completions`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body,
    };
  }

  parseLlmResponse(response: unknown): ProtocolResponse {
    const data = response as Record<string, unknown>;
    const choices = data?.choices as Array<Record<string, unknown>> | undefined;

    // 合并所有 choice 的 content（对应 Python merge_choices 逻辑）
    const parts: string[] = [];
    const toolCalls: ProtocolToolCall[] = [];

    if (Array.isArray(choices)) {
      for (const choice of choices) {
        const msg = choice?.message as Record<string, unknown> | undefined;
        const content = msg?.content as string | undefined;
        if (content) parts.push(content);

        const rawCalls = msg?.tool_calls as Array<Record<string, unknown>> | undefined;
        if (Array.isArray(rawCalls)) {
          for (const call of rawCalls) {
            const parsed = parseToolCall(call);
            if (parsed) toolCalls.push(parsed);
          }
        }
      }
    }

    return {
      urls: [],
      text: parts.join("\n"),
      ...(toolCalls.length ? { toolCalls } : {}),
    };
  }
}

/** 把单个 OpenAI tool_call 结构规范化为 ProtocolToolCall */
export function parseToolCall(call: Record<string, unknown>): ProtocolToolCall | null {
  const fn = call?.function as Record<string, unknown> | undefined;
  const name = fn?.name;
  if (typeof name !== "string" || !name) return null;

  const rawArgs = fn?.arguments;
  let args: Record<string, unknown> = {};
  if (typeof rawArgs === "string" && rawArgs.trim()) {
    try {
      const parsed = JSON.parse(rawArgs);
      if (parsed && typeof parsed === "object") args = parsed as Record<string, unknown>;
    } catch {
      args = {};
    }
  } else if (rawArgs && typeof rawArgs === "object") {
    args = rawArgs as Record<string, unknown>;
  }

  const id = typeof call?.id === "string" && call.id ? call.id : `call_${name}_${Date.now()}`;
  return { id, name, args };
}
