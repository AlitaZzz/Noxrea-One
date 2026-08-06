/**
 * Gemini 图片生成协议。
 * 继承 Gemini 协议基类，构建图片生成的上游请求与响应解析。
 */

import { GeminiProtocol } from "./base";
import type { ProtocolRequestResult, ProtocolResponse } from "@server/services/protocols/base";

export class GeminiImageProtocol extends GeminiProtocol {
  buildImageRequest(
    baseUrl: string,
    apiKey: string,
    body: Record<string, unknown>
  ): ProtocolRequestResult {
    const model = (body.model as string) ?? "imagen-3.0-generate-002";
    const prompt = (body.prompt as string) ?? "";

    return this.buildPost(
      baseUrl,
      `/v1beta/models/${model}:predict`,
      apiKey,
      {
        instances: [{ prompt }],
        parameters: {
          sampleCount: body.n ?? 1,
        },
      }
    );
  }

  parseImageResponse(response: unknown): ProtocolResponse {
    const data = response as Record<string, unknown>;
    const predictions = data?.predictions as Array<Record<string, unknown>> | undefined;
    const urls: string[] = [];

    if (Array.isArray(predictions)) {
      for (const p of predictions) {
        const url = p?.bytesBase64Encoded as string | undefined;
        if (url) urls.push(url);
      }
    }

    return { urls };
  }
}
