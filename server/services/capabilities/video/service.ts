// ── Video Capability Service（对应 backend/app/services/capabilities/video/service.py） ──

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
      channelConfig: ctx.config,
      taskId: ctx.taskId,
    });

    const req = protocol.buildVideoRequest(ctx.baseUrl, ctx.apiKey, body);

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

    const result = await submitAndWait({
      taskId: ctx.taskId,
      userId: ctx.userId,
      protocol,
      capability: "video",
      baseUrl: ctx.baseUrl,
      apiKey: ctx.apiKey,
      body,
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
