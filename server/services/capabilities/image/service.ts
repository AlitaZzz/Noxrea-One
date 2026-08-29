/**
 * 图像能力服务。
 * 实现图像生成能力，组装协议请求并提交异步任务，支持结果回传与日志脱敏。
 */

import {
  registerCapability,
  type CapabilityService,
  type CapabilityContext,
  type CapabilityParams,
} from "@server/services/capabilities/base";
import { getProtocol } from "@server/services/protocols/base";
import { build } from "@server/services/request-builder/engine";
import { resolveProviderEndpoints, hostFromBaseUrl } from "@server/services/model-config";
import { submitAndWait } from "@server/services/tasks/manager";
import { GenerationFailureError } from "@server/core/errors/task-failure";
import type { GenerationResult } from "@server/schemas/result";

class ImageCapabilityService implements CapabilityService {
  readonly name = "image";

  async generate(
    ctx: CapabilityContext,
    params: CapabilityParams
  ): Promise<GenerationResult> {
    const protocol = getProtocol(ctx.protocol);
    if (!protocol?.buildImageRequest) {
      throw new Error(`Protocol ${ctx.protocol} does not support image generation`);
    }

    // 渠道识别阶段：记录上游 endpoints 来源（对标外部服务的"识别为 XXX 渠道"）
    const endpoints = resolveProviderEndpoints(hostFromBaseUrl(ctx.baseUrl), ctx.model, "image");

    // 管线构建请求体：transforms → auto-clean → mapping → patch
    const body = build({
      params,
      modelName: ctx.model,
      capability: "image",
      protocol: ctx.protocol,
      baseUrl: ctx.baseUrl,
      taskId: ctx.taskId,
    });

    // 从 model-ui.json 上游级解析 endpoints（替代旧的用户渠道 config）
    const endpointCfg = endpoints ? { protocol: { endpoints } } : undefined;

    // 依据前端原始 refImages 判断是否有参考图（决定 edits / generations 路由）
    const rawRefImages = params.refImages as string[] | undefined;
    const hasRef = Array.isArray(rawRefImages) && rawRefImages.length > 0;

    const req = protocol.buildImageRequest(ctx.baseUrl, ctx.apiKey, body, endpointCfg, hasRef);

    // 同步优先异步兜底（对齐 Python TaskManager.submit_and_wait）
    const result = await submitAndWait({
      taskId: ctx.taskId,
      userId: ctx.userId,
      protocol,
      capability: "image",
      baseUrl: ctx.baseUrl,
      apiKey: ctx.apiKey,
      body,
      channelConfig: endpointCfg,
      buildRequest: () => req,
      parseResponse: (data) => {
        const parsed = protocol.parseImageResponse
          ? protocol.parseImageResponse(data)
          : { urls: [] };
        return parsed;
      },
    });

    if (result.status === "failed") {
      throw new GenerationFailureError(
        result.error ?? "Image generation failed",
        result.errorCode
      );
    }

    return { urls: result.urls, text: result.text };
  }
}

registerCapability("image", new ImageCapabilityService());
