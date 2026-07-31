// ── OpenAI LLM 协议 ──

import type { ProtocolRequestResult, ProtocolResponse, ProtocolService } from "@server/services/protocols/base";

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
    if (Array.isArray(choices)) {
      for (const choice of choices) {
        const msg = choice?.message as Record<string, unknown> | undefined;
        const content = msg?.content as string | undefined;
        if (content) parts.push(content);
      }
    }

    return { urls: [], text: parts.join("\n") };
  }
}
