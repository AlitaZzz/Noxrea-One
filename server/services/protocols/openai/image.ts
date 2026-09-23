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
  getPollPath,
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
    const customPath = getPollPath(channelConfig, capability ?? "image");
    // 替换占位符：{model} 走请求模型名，其余（如 {task_id}）走任务 ID
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
