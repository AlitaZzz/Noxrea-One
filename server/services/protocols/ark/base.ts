/**
 * Ark 协议基类。
 * 实现 Ark 上游协议的公共逻辑，提供认证头与请求结果封装。
 *
 * 纯同步对接：不实现 extractTaskId / buildPollUrl / parsePollResponse——
 * 当前 ark 渠道按「提交即同步返回产物」对接（submitAndWait 同步解析；
 * model-ui.json 亦无 ark 轮询端点配置）。若未来接入火山方舟原生异步
 * 任务 API，需在此补齐轮询三件套（可复用 openai/shared 的实现）。
 * 上游暂不支持取消任务，不实现 buildCancelRequest（骨架与接入说明见 protocols/base）。
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
