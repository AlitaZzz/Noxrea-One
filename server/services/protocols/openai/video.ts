/**
 * OpenAI 视频生成协议。
 * 构建视频生成的上游请求；响应/轮询解析逻辑在 shared.ts（与 image 共用）。
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

/** 裸 base64 产物补通用前缀（MIME 省略，由播放器按内容识别） */
const B64_MIME = "data:;base64,";

export class OpenAiVideoProtocol implements ProtocolService {
  readonly name = "openai_video";

  buildVideoRequest(
    baseUrl: string,
    apiKey: string,
    body: Record<string, unknown>,
    channelConfig?: Record<string, unknown>
  ): ProtocolRequestResult {
    const endpoints = (channelConfig?.protocol as Record<string, unknown>)?.endpoints as Record<string, string> | undefined;
    const endpoint = endpoints?.["video.generations"] ?? "/videos";

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

  parseVideoResponse(response: unknown): ProtocolResponse {
    return parseScanSyncResult(response, B64_MIME);
  }

  // 异步任务支持

  extractTaskId(data: unknown, channelConfig?: Record<string, unknown>, capability?: string): string | null {
    return extractOpenAiTaskId(data, channelConfig, capability ?? "video");
  }

  buildPollUrl(baseUrl: string, upstreamTaskId: string, channelConfig?: Record<string, unknown>, capability?: string, model?: string): string {
    return buildOpenAiPollUrl(baseUrl, upstreamTaskId, channelConfig, capability ?? "video", model);
  }

  parsePollResponse(data: unknown): PollResult {
    return parseScanPollResult(data, B64_MIME);
  }
}
