// ── OpenAI 协议基类 ──

import type { ProtocolRequestResult, ProtocolResponse, ProtocolService } from "@server/services/protocols/base";

export abstract class OpenAiProtocol implements ProtocolService {
  readonly name = "openai";

  protected buildHeaders(apiKey: string): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    };
  }

  protected buildPost(
    baseUrl: string,
    endpoint: string,
    apiKey: string,
    body: unknown
  ): ProtocolRequestResult {
    return {
      url: `${baseUrl}${endpoint}`,
      method: "POST",
      headers: this.buildHeaders(apiKey),
      body,
    };
  }
}
