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
import { logEvent } from "@server/core/logger/utils";
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

/**
 * 消息归一化：无 messages 时从 prompt 构造首条用户消息；将顶层 refImages 注入 messages。
 * 对齐 image/video 的任务级独立列形态：prompt（文本源）与 refImages（参考图）
 * 均由 service 消费进 messages，消费后删除，chat 请求体不含两者的顶层字段。
 *
 * 与 image/video 链路对齐：任务级 refImages 由 executor 统一解析为 base64 后注入 params。
 * 区别在于消费点——image/video 的参考图终点是上游顶层字段（build() 引擎 mapping 消费），
 * 而 LLM 的图片必须内嵌进 messages[].content 的多模态结构，此处为消费点。
 *
 * 注入的 data: URI 会被 resolveMessageImages 跳过；未解析的本地 URL 由其兜底转换。
 * 消费完毕显式移除 refImages（它不在 llm.allowedFields 中，build() 亦会丢弃，
 * 显式移除使"已消费"在代码层面可见）。
 */
function normalizeMessages(params: CapabilityParams): void {
  // 1. 无 messages：从 prompt 构造首条用户消息（prompt 为任务级文本源）
  let messages: unknown[] = Array.isArray(params.messages) ? params.messages : [];
  if (messages.length === 0) {
    const prompt = typeof params.prompt === "string" ? params.prompt : "";
    messages = [{ role: "user", content: prompt }];
    params.messages = messages;
  }

  // 2. 顶层 refImages 注入最后一条消息（生成式场景通常只有一条 user 消息）
  const refs = params.refImages;
  if (Array.isArray(refs) && refs.length > 0) {
    const imageParts = refs
      .filter((u): u is string => typeof u === "string" && u.length > 0)
      .map((url) => ({ type: "image_url", image_url: { url } }));
    if (imageParts.length > 0) {
      const last = messages[messages.length - 1] as Record<string, unknown>;
      if (typeof last.content === "string") {
        last.content = [{ type: "text", text: last.content }, ...imageParts];
      } else if (Array.isArray(last.content)) {
        last.content = [...last.content, ...imageParts];
      } else {
        last.content = imageParts;
      }
    }
  }

  // 3. 消费完毕：refImages 不在 llm.allowedFields 中（build 亦会丢弃）；
  //    prompt 已消费进 messages，置 undefined 后 build 透传检查会跳过，
  //    chat 请求体不含顶层 prompt（其合法形态仅 messages 内嵌）
  delete params.refImages;
  (params as { prompt?: string }).prompt = undefined;
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

    // 归一化：无 messages 时从 prompt 构造；顶层 refImages 注入 messages
    // （必须先于 base64 解析，保证注入的本地 URL 能被随后解析兜底转换）
    normalizeMessages(params);

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
      baseUrl: ctx.baseUrl,
      taskId: ctx.taskId,
    });

    const req = protocol.buildLlmRequest(ctx.baseUrl, ctx.apiKey, body);

    // 开始发送请求（对齐 taskmgr.request_preparing）
    logEvent("capability.llm", {
      banner: true,
      bannerTitle: "开始发送请求",
      stage: "request_preparing",
      taskId: ctx.taskId,
      url: req.url,
      method: req.method,
      body: req.body,
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

    // 已获取生成结果（对齐 taskmgr.sync_completed）
    logEvent("capability.llm", {
      banner: true,
      bannerTitle: "已获取生成结果",
      stage: "sync_completed",
      taskId: ctx.taskId,
      hasText: !!parsed.text,
    });

    return { urls: [], text: parsed.text };
  }
}

registerCapability("llm", new LlmCapabilityService());
