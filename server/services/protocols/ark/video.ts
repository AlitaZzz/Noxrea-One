// ── Ark 视频生成协议 ──

import { ArkProtocol } from "./base";
import type { ProtocolRequestResult, ProtocolResponse } from "@server/services/protocols/base";

export class ArkVideoProtocol extends ArkProtocol {
  buildVideoRequest(
    baseUrl: string,
    apiKey: string,
    body: Record<string, unknown>
  ): ProtocolRequestResult {
    return this.buildPost(baseUrl, "/v1/video/generations", apiKey, body);
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
