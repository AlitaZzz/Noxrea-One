/**
 * Ark 视频生成协议。
 * 继承 Ark 协议基类，构建视频生成的上游请求与响应解析。
 * 产物解析与 openai 协议共用整树扫描（parseScanSyncResult）。
 */

import { ArkProtocol } from "./base";
import { parseScanSyncResult } from "@server/services/protocols/openai/shared";
import type { ProtocolRequestResult, ProtocolResponse } from "@server/services/protocols/base";

/** 裸 base64 产物补通用前缀（MIME 省略，由播放器按内容识别） */
const B64_MIME = "data:;base64,";

export class ArkVideoProtocol extends ArkProtocol {
  buildVideoRequest(
    baseUrl: string,
    apiKey: string,
    body: Record<string, unknown>
  ): ProtocolRequestResult {
    return this.buildPost(baseUrl, "/v1/video/generations", apiKey, body);
  }

  parseVideoResponse(response: unknown): ProtocolResponse {
    return parseScanSyncResult(response, B64_MIME);
  }
}
