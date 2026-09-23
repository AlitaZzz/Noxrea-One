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
  getPollPath,
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
    const customPath = getPollPath(channelConfig, capability ?? "video");
    // 替换占位符：{model} 走请求模型名，其余（如 {video_id}）走任务 ID
    const fill = (path: string) =>
      path.replace(/\{([^}]+)\}/g, (_, name: string) => (name === "model" ? (model ?? "") : upstreamTaskId));
    if (customPath) {
      // 如果已是完整 URL（含协议头），直接替换占位符返回
      if (/^https?:\/\//.test(customPath)) {
        return fill(customPath);
      }
      // 如果包含 {xxx} 占位符，拼接 baseUrl 后替换
      if (/\{[^}]+\}/.test(customPath)) {
        return `${baseUrl}${fill(customPath)}`;
      }
      // 无占位符：追加到路径末尾
      return `${baseUrl}${customPath}/${upstreamTaskId}`;
    }
    return `${baseUrl}/tasks/${upstreamTaskId}`;
  }

  parsePollResponse(data: unknown): PollResult {
    return parseScanPollResult(data, B64_MIME);
  }
}
