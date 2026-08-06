/**
 * LLM 能力服务。
 * 实现 LLM 文本生成能力，组装协议请求、解析参考图并调用上游补全。
 */

import {
  registerCapability,
  type CapabilityService,
  type CapabilityContext,
  type CapabilityParams,
} from "@server/services/capabilities/base";
import { getProtocol } from "@server/services/protocols/base";
import { build } from "@server/services/request-builder/engine";
import { fetchWithTimeout, getWorkerApiTimeout } from "@server/core/http-client";
import { resolveRefImages } from "@server/services/resolvers/reference";
import { logEvent, summarizeText, summarizeBody } from "@server/core/logger/utils";
import type { GenerationResult } from "@server/schemas/result";

/**
 * 遍历 messages，将 image_url 中的本地 URL 转为 base64 data URI。
 * 解析参考图引用后组装消息上下文。
 */
async function resolveMessageImages(
  messages: unknown,
  userId: number
): Promise<void> {
  if (!Array.isArray(messages)) return;

  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    const content = (msg as Record<string, unknown>).content;
    if (!Array.isArray(content)) continue;

    // 收集所有需要解析的 URL
    const urls: string[] = [];
    const urlMap = new Map<string, { part: Record<string, unknown>; imageUrl: Record<string, unknown> }>();

    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const p = part as Record<string, unknown>;
      if (p.type !== "image_url") continue;
      const imageUrl = p.image_url as Record<string, unknown> | undefined;
      if (!imageUrl) continue;
      const url = imageUrl.url as string | undefined;
      if (!url || url.startsWith("data:")) continue;
      urls.push(url);
      urlMap.set(url, { part: p, imageUrl });
    }

    if (urls.length === 0) continue;

    // 批量解析
    const resolved = await resolveRefImages(urls, userId);

    for (let i = 0; i < urls.length; i++) {
      urlMap.get(urls[i])!.imageUrl.url = resolved[i];
    }
  }
}

class LlmCapabilityService implements CapabilityService {
  readonly name = "llm";

  async generate(
    ctx: CapabilityContext,
    params: CapabilityParams
  ): Promise<GenerationResult> {
    const protocol = getProtocol(ctx.protocol);
    if (!protocol?.buildLlmRequest) {
      throw new Error(`Protocol ${ctx.protocol} does not support LLM`);
    }

    // messages 中的 image_url 转为 base64（对齐 Python 逻辑）
    if (params.messages) {
      await resolveMessageImages(params.messages, ctx.userId);
    }

    // 管线构建请求体
    const body = build({
      params,
      modelName: ctx.model,
      capability: "llm",
      protocol: ctx.protocol,
      channelConfig: ctx.config,
      taskId: ctx.taskId,
    });

    logEvent("capability.llm", {
      stage: "params_raw",
      taskId: ctx.taskId,
      params: { ...params, prompt: summarizeText(params.prompt) },
      model: ctx.model,
      protocol: ctx.protocol,
    });

    const req = protocol.buildLlmRequest(ctx.baseUrl, ctx.apiKey, body);

    logEvent("capability.llm", {
      stage: "dispatch",
      taskId: ctx.taskId,
      upstream: {
        url: req.url,
        method: req.method,
        headers: { ...req.headers, Authorization: "Bearer ***" },
        body: summarizeBody(req.body),
      },
    });

    const response = await fetchWithTimeout(req.url, {
      method: req.method,
      headers: req.headers,
      body: JSON.stringify(req.body),
      timeoutMs: getWorkerApiTimeout(),
    });

    if (!response.ok) {
      const errBody = await response.text().catch(() => "");
      throw new Error(`LLM generation failed: ${response.status} ${errBody}`);
    }

    const data = await response.json();
    const parsed = protocol.parseLlmResponse
      ? protocol.parseLlmResponse(data)
      : { urls: [], text: "" };

    return { urls: [], text: parsed.text };
  }
}

registerCapability("llm", new LlmCapabilityService());
