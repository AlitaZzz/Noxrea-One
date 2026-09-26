/**
 * 视频能力服务。
 * 实现视频生成能力，组装协议请求并提交异步任务，支持结果回传与日志脱敏。
 * 公共骨架（管线、endpoints、submitAndWait、终态翻译）在 polling-base.ts。
 */

import {
  registerCapability,
  type CapabilityContext,
  type CapabilityParams,
} from "@server/services/capabilities/base";
import { PollingCapabilityService, type CapabilityEndpointConfig } from "@server/services/capabilities/polling-base";
import type {
  ProtocolRequestResult,
  ProtocolResponse,
  ProtocolService,
} from "@server/services/protocols/base";

class VideoCapabilityService extends PollingCapabilityService {
  readonly name = "video";
  protected readonly capability = "video";
  protected readonly failFallback = "Video generation failed";

  protected buildRequest(
    protocol: ProtocolService,
    ctx: CapabilityContext,
    _params: CapabilityParams,
    body: Record<string, unknown>,
    endpointCfg: CapabilityEndpointConfig
  ): ProtocolRequestResult {
    if (!protocol.buildVideoRequest) {
      throw new Error(`Protocol ${protocol.name} does not support video generation`);
    }

    return protocol.buildVideoRequest(ctx.baseUrl, ctx.apiKey, body, endpointCfg);
  }

  protected parseResponse(protocol: ProtocolService, data: unknown): ProtocolResponse {
    return protocol.parseVideoResponse ? protocol.parseVideoResponse(data) : { urls: [] };
  }
}

registerCapability("video", new VideoCapabilityService());
