// ── Image Capability Service（对应 backend/app/services/capabilities/image/service.py） ──

import {
  registerCapability,
  type CapabilityService,
  type CapabilityContext,
  type CapabilityParams,
} from "@server/services/capabilities/base";
import { getProtocol } from "@server/services/protocols/base";
import { build } from "@server/services/request-builder/engine";
import { submitAndWait } from "@server/services/tasks/manager";
import { logEvent, summarizeText, summarizeBody } from "@server/core/logger/utils";
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

    logEvent("capability.image", {
      stage: "params_raw",
      taskId: ctx.taskId,
      params: { ...params, prompt: summarizeText(params.prompt) },
      model: ctx.model,
      protocol: ctx.protocol,
    });

    // 管线构建请求体：transforms → auto-clean → mapping → patch
    const body = build({
      params,
      modelName: ctx.model,
      capability: "image",
      protocol: ctx.protocol,
      channelConfig: ctx.config,
      taskId: ctx.taskId,
    });

    logEvent("capability.image", {
      stage: "body_built",
      taskId: ctx.taskId,
      bodyKeys: Object.keys(body),
      body: { ...body, prompt: summarizeText(body.prompt as string) },
    });

    const req = protocol.buildImageRequest(ctx.baseUrl, ctx.apiKey, body);

    logEvent("capability.image", {
      stage: "dispatch",
      taskId: ctx.taskId,
      upstream: {
        url: req.url,
        method: req.method,
        headers: { ...req.headers, Authorization: "Bearer ***" },
        body: summarizeBody(req.body),
      },
    });

    // 同步优先异步兜底（对齐 Python TaskManager.submit_and_wait）
    const result = await submitAndWait({
      taskId: ctx.taskId,
      userId: ctx.userId,
      protocol,
      capability: "image",
      baseUrl: ctx.baseUrl,
      apiKey: ctx.apiKey,
      body,
      buildRequest: () => req,
      parseResponse: (data) => {
        const parsed = protocol.parseImageResponse
          ? protocol.parseImageResponse(data)
          : { urls: [] };
        return parsed;
      },
    });

    if (result.status === "failed") {
      throw new Error(result.error ?? "Image generation failed");
    }

    return { urls: result.urls, text: result.text };
  }
}

registerCapability("image", new ImageCapabilityService());
