/**
 * Ark 协议基类。
 * 实现 Ark 上游协议的公共逻辑，提供认证头与请求结果封装。
 */

import type { ProtocolRequestResult, ProtocolService } from "@server/services/protocols/base";

export abstract class ArkProtocol implements ProtocolService {
  readonly name = "ark";

  protected buildHeaders(apiKey: string): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    };
  }

  protected buildPost(
    baseUrl: string,
    endpoint: string,
    apiKey: string,
    body: unknown
  ): ProtocolRequestResult {
    return {
      url: `${baseUrl}${endpoint}`,
      method: "POST",
      headers: this.buildHeaders(apiKey),
      body,
    };
  }
}
