// ── OpenAI 视频生成协议 ──

import type { ProtocolRequestResult, ProtocolResponse, ProtocolService } from "@server/services/protocols/base";

export class OpenAiVideoProtocol implements ProtocolService {
  readonly name = "openai_video";

  buildVideoRequest(
    baseUrl: string,
    apiKey: string,
    body: Record<string, unknown>
  ): ProtocolRequestResult {
    return {
      url: `${baseUrl}/videos`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body,
    };
  }

  parseVideoResponse(response: unknown): ProtocolResponse {
    const data = response as Record<string, unknown>;
    const resultData = data?.data as Array<Record<string, unknown>> | undefined;
    const urls: string[] = [];

    if (Array.isArray(resultData)) {
      for (const item of resultData) {
        const url = item?.url as string | undefined;
        if (url) urls.push(url);
      }
    }

    return { urls };
  }
}
