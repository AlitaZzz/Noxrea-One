/**
 * OpenAI 音频协议。
 * 实现 OpenAI 音频生成的上游请求构建与响应解析。
 */

import type { ProtocolRequestResult, ProtocolResponse, ProtocolService } from "@server/services/protocols/base";

export class OpenAiAudioProtocol implements ProtocolService {
  readonly name = "openai_audio";

  buildAudioRequest(
    baseUrl: string,
    apiKey: string,
    body: Record<string, unknown>
  ): ProtocolRequestResult {
    return {
      url: `${baseUrl}/audio/speech`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body,
    };
  }

  parseAudioResponse(response: unknown): ProtocolResponse {
    void response;
    return { urls: [] };
  }
}
