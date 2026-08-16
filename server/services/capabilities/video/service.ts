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
import { resolveChannelEndpoints, hostFromBaseUrl } from "@server/services/model-config";
import { submitAndWait } from "@server/services/tasks/manager";
import { logEvent, summarizeText, summarizeBody } from "@server/core/logger/utils";
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

    logEvent("capability.video", {
      stage: "params_raw",
      taskId: ctx.taskId,
      params: { ...params, prompt: summarizeText(params.prompt) },
      model: ctx.model,
      protocol: ctx.protocol,
    });

    const body = build({
      params,
      modelName: ctx.model,
      capability: "video",
      protocol: ctx.protocol,
      baseUrl: ctx.baseUrl,
      taskId: ctx.taskId,
    });

    // 从 model-ui.json 上游级解析 endpoints（替代旧的用户渠道 config）
    const endpoints = resolveChannelEndpoints(hostFromBaseUrl(ctx.baseUrl), ctx.model, "video");
    const endpointCfg = endpoints ? { protocol: { endpoints } } : undefined;

    const req = protocol.buildVideoRequest(ctx.baseUrl, ctx.apiKey, body, endpointCfg);

    logEvent("capability.video", {
      stage: "dispatch",
      taskId: ctx.taskId,
      upstream: {
        url: req.url,
        method: req.method,
        headers: { ...req.headers, Authorization: "Bearer ***" },
        body: summarizeBody(req.body),
      },
    });

    // 完整最终 body（base64 原样保留，仅脱敏 Authorization），用于核对真实发送内容
    logEvent("capability.video", {
      stage: "dispatch_full",
      taskId: ctx.taskId,
      url: req.url,
      method: req.method,
      headers: { ...req.headers, Authorization: "Bearer ***" },
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
