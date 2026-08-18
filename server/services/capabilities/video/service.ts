/**
 * 视频能力服务。
 * 实现视频生成能力，组装协议请求并提交异步任务，支持结果回传与日志脱敏。
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
import { logEvent } from "@server/core/logger/utils";
import type { GenerationResult } from "@server/schemas/result";

class VideoCapabilityService implements CapabilityService {
  readonly name = "video";

  async generate(
    ctx: CapabilityContext,
    params: CapabilityParams
  ): Promise<GenerationResult> {
    const protocol = getProtocol(ctx.protocol);
    if (!protocol?.buildVideoRequest) {
      throw new Error(`Protocol ${ctx.protocol} does not support video generation`);
    }

    const body = build({
      params,
      modelName: ctx.model,
      capability: "video",
      protocol: ctx.protocol,
      baseUrl: ctx.baseUrl,
      taskId: ctx.taskId,
    });

    // 从 model-ui.json 上游级解析 endpoints（替代旧的用户渠道 config）
    const endpoints = resolveProviderEndpoints(hostFromBaseUrl(ctx.baseUrl), ctx.model, "video");
    const endpointCfg = endpoints ? { protocol: { endpoints } } : undefined;

    const req = protocol.buildVideoRequest(ctx.baseUrl, ctx.apiKey, body, endpointCfg);

    // 转译完成阶段（对标外部服务的"转译完成, 返回 plan"）
    logEvent("capability.video", {
      banner: true,
      bannerTitle: "视频转译完成",
      stage: "translation_done",
      taskId: ctx.taskId,
      url: req.url,
      method: req.method,
      body: req.body,
    });

    const result = await submitAndWait({
      taskId: ctx.taskId,
      userId: ctx.userId,
      protocol,
      capability: "video",
      baseUrl: ctx.baseUrl,
      apiKey: ctx.apiKey,
      body,
      channelConfig: endpointCfg,
      buildRequest: () => req,
      parseResponse: (data) => {
        const parsed = protocol.parseVideoResponse
          ? protocol.parseVideoResponse(data)
          : { urls: [] };
        return parsed;
      },
    });

    if (result.status === "failed") {
      throw new Error(result.error ?? "Video generation failed");
    }

    return { urls: result.urls, text: result.text };
  }
}

registerCapability("video", new VideoCapabilityService());
