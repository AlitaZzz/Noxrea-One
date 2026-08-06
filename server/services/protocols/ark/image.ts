/**
 * Ark 图片生成协议。
 * 继承 Ark 协议基类，构建图片生成的上游请求与响应解析。
 */

import { ArkProtocol } from "./base";
import type { ProtocolRequestResult, ProtocolResponse } from "@server/services/protocols/base";

export class ArkImageProtocol extends ArkProtocol {
  buildImageRequest(
    baseUrl: string,
    apiKey: string,
    body: Record<string, unknown>
  ): ProtocolRequestResult {
    return this.buildPost(baseUrl, "/v1/images/generations", apiKey, body);
  }

  parseImageResponse(response: unknown): ProtocolResponse {
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
