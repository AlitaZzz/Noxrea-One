/**
 * 图像能力服务。
 * 实现图像生成能力，组装协议请求并提交异步任务，支持结果回传与日志脱敏。
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

class ImageCapabilityService extends PollingCapabilityService {
  readonly name = "image";
  protected readonly capability = "image";
  protected readonly failFallback = "Image generation failed";

  protected buildRequest(
    protocol: ProtocolService,
    ctx: CapabilityContext,
    params: CapabilityParams,
    body: Record<string, unknown>,
    endpointCfg: CapabilityEndpointConfig
  ): ProtocolRequestResult {
    if (!protocol.buildImageRequest) {
      throw new Error(`Protocol ${protocol.name} does not support image generation`);
    }

    // 依据前端原始 refImages 判断是否有参考图（决定 edits / generations 路由），
    // hasRef 取自未被管线映射过的原始参数，而非 body 里已被映射的字段。
    const rawRefImages = params.refImages as string[] | undefined;
    const hasRef = Array.isArray(rawRefImages) && rawRefImages.length > 0;

    return protocol.buildImageRequest(ctx.baseUrl, ctx.apiKey, body, endpointCfg, hasRef);
  }

  protected parseResponse(protocol: ProtocolService, data: unknown): ProtocolResponse {
    return protocol.parseImageResponse ? protocol.parseImageResponse(data) : { urls: [] };
  }
}

registerCapability("image", new ImageCapabilityService());
