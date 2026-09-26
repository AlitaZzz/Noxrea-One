/**
 * OpenAI 图片生成协议。
 * 构建图片生成的上游请求；响应/轮询解析逻辑在 shared.ts（与 video 共用）。
 */

import type {
  ProtocolRequestResult,
  ProtocolResponse,
  ProtocolService,
  PollResult,
} from "@server/services/protocols/base";
import {
  parseScanPollResult,
  parseScanSyncResult,
  extractOpenAiTaskId,
  buildOpenAiPollUrl,
} from "./shared";

/** 裸 base64 产物补 PNG 前缀（OpenAI 标准 b64_json 不带 data: 锚点） */
const B64_MIME = "data:image/png;base64,";

export class OpenAiImageProtocol implements ProtocolService {
  readonly name = "openai_image";

  buildImageRequest(
    baseUrl: string,
    apiKey: string,
    body: Record<string, unknown>,
    channelConfig?: Record<string, unknown>,
    hasRef?: boolean
  ): ProtocolRequestResult {
    // 解析 channel config 中的 endpoints
    const endpoints = (channelConfig?.protocol as Record<string, unknown>)?.endpoints as Record<string, string> | undefined;

    // 有参考图（图生图/编辑）→ /images/edits，否则 → /images/generations
    // hasRef 由调用方依据前端原始 refImages 判定，而非 body 里已被映射的字段。
    let endpoint: string;
    if (hasRef) {
      endpoint = endpoints?.["image.edits"] ?? "/images/edits";
    } else {
      endpoint = endpoints?.["image.generations"] ?? "/images/generations";
    }

    return {
      url: `${baseUrl}${endpoint}`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body,
    };
  }

  parseImageResponse(response: unknown): ProtocolResponse {
    return parseScanSyncResult(response, B64_MIME);
  }

  // 异步任务支持

  extractTaskId(data: unknown, channelConfig?: Record<string, unknown>, capability?: string): string | null {
    return extractOpenAiTaskId(data, channelConfig, capability ?? "image");
  }

  buildPollUrl(baseUrl: string, upstreamTaskId: string, channelConfig?: Record<string, unknown>, capability?: string, model?: string): string {
    return buildOpenAiPollUrl(baseUrl, upstreamTaskId, channelConfig, capability ?? "image", model);
  }

  parsePollResponse(data: unknown): PollResult {
    return parseScanPollResult(data, B64_MIME);
  }
}
