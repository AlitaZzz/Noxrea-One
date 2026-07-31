// ── Gemini 协议基类（对应 backend/app/services/protocols/gemini/base.py） ──

import type { ProtocolRequestResult, ProtocolService } from "@server/services/protocols/base";

export abstract class GeminiProtocol implements ProtocolService {
  readonly name = "gemini";

  protected buildHeaders(apiKey: string): Record<string, string> {
    return {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey,
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
