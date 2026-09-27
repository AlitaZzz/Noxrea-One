/**
 * Ark 图片生成协议。
 * 继承 Ark 协议基类，构建图片生成的上游请求与响应解析。
 * 产物解析与 openai 协议共用整树扫描（parseScanSyncResult）。
 */

import { ArkProtocol } from "./base";
import { parseScanSyncResult } from "@server/services/protocols/openai/shared";
import type { ProtocolRequestResult, ProtocolResponse } from "@server/services/protocols/base";

/** 裸 base64 产物补 PNG 前缀（对齐 openai/image 的兜底约定） */
const B64_MIME = "data:image/png;base64,";

export class ArkImageProtocol extends ArkProtocol {
  buildImageRequest(
    baseUrl: string,
    apiKey: string,
    body: Record<string, unknown>,
    channelConfig?: Record<string, unknown>
  ): ProtocolRequestResult {
    // 端点可被渠道配置覆盖（对齐 openai 行为）；ark 兼容接口无独立 edits
    // 路径（参考图由请求体携带），故不接 hasRef 形参
    const endpoints = (channelConfig?.protocol as Record<string, unknown>)?.endpoints as Record<string, string> | undefined;
    const endpoint = endpoints?.["image.generations"] ?? "/v1/images/generations";
    return this.buildPost(baseUrl, endpoint, apiKey, body);
  }

  parseImageResponse(response: unknown): ProtocolResponse {
    return parseScanSyncResult(response, B64_MIME);
  }
}
