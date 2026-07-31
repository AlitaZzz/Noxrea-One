// ── Gemini LLM 协议 ──

import { GeminiProtocol } from "./base";
import type { ProtocolRequestResult, ProtocolResponse } from "@server/services/protocols/base";

export class GeminiLlmProtocol extends GeminiProtocol {
  buildLlmRequest(
    baseUrl: string,
    apiKey: string,
    body: Record<string, unknown>
  ): ProtocolRequestResult {
    const model = (body.model as string) ?? "gemini-pro";
    const prompt = (body.prompt as string) ?? "";

    return this.buildPost(
      baseUrl,
      `/v1beta/models/${model}:generateContent`,
      apiKey,
      {
        contents: [
          {
            parts: [{ text: prompt }],
          },
        ],
      }
    );
  }

  parseLlmResponse(response: unknown): ProtocolResponse {
    const data = response as Record<string, unknown>;
    const candidates = data?.candidates as Array<Record<string, unknown>> | undefined;
    const parts = candidates?.[0]?.content as Record<string, unknown> | undefined;
    const text = (parts?.parts as Array<Record<string, unknown>> | undefined)?.[0]?.text as string | undefined;

    return { urls: [], text: text ?? "" };
  }
}
