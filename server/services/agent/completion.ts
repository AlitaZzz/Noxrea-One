/**
 * Agent 上游调用层。
 * 封装从 chat 抽离的上游 LLM 调用逻辑：解析可用渠道、组装上游请求、
 * 执行非流式与流式补全，并累积 tool_call 结果。
 */

import type { ProtocolToolCall } from "@server/services/protocols/base";
import { getProtocol } from "@server/services/protocols/base";
import { getProvider, getProviders } from "@server/crud/model-config";
import "@server/services/agent/tools/definitions"; // 触发工具注册（副作用）
import { resolveSkillTools } from "@server/services/agent/tools/filter";
import { fetchWithTimeout, getWorkerApiTimeout } from "@server/core/http-client";
import { resolveRefImages } from "@server/services/resolvers/reference";
import { logEvent } from "@server/core/logger/utils";

import type { AgentMessage } from "@server/services/agent/context-builder";

/** 供应商解析：按 providerId 精确查找，否则按 model 名称匹配，最后回退第一个 */
export async function resolveProvider(userId: number, providerId?: number, model?: string) {
  if (providerId) {
    return getProvider(providerId, userId);
  }
  const providers = await getProviders(userId);
  if (model && providers.length) {
    const matched = providers.find((p) => p.models.some((m: { name: string }) => m.name === model));
    if (matched) return matched;
  }
  return providers[0] ?? null;
}

type BuildResult =
  | { ok: true; url: string; method: string; headers: Record<string, string>; body: unknown }
  | { ok: false; error: string };

/** 构造上游请求：解析参考图、注入 stream:true、按协议组装 body */
export async function buildUpstream(args: {
  messages: AgentMessage[];
  providerId?: number;
  model?: string;
  userId: number;
  /** 是否注入 Agent 工具（仅 openai 协议支持） */
  agent?: boolean;
  /** session 级激活的技能名，用于过滤注入给 LLM 的 tools */
  activeSkill?: string | null;
}): Promise<BuildResult> {
  const provider = await resolveProvider(args.userId, args.providerId, args.model);
  if (!provider) return { ok: false, error: "no available provider" };

  const protocol = getProtocol(provider.protocol);
  if (!protocol?.buildLlmRequest) return { ok: false, error: `protocol ${provider.protocol} not support llm` };

  const upstreamMessages: Array<Record<string, unknown>> = [];
  for (const m of args.messages) {
    // 工具执行结果消息
    if (m.role === "tool") {
      upstreamMessages.push({
        role: "tool",
        tool_call_id: m.toolCallId ?? "",
        content: m.content,
      });
      continue;
    }

    // assistant 发起的工具调用需原样回填，否则上游会拒绝后续 tool 消息
    if (m.role === "assistant" && m.toolCalls?.length) {
      upstreamMessages.push({
        role: "assistant",
        content: m.content || null,
        tool_calls: m.toolCalls.map((t) => ({
          id: t.id,
          type: "function",
          function: { name: t.name, arguments: JSON.stringify(t.args ?? {}) },
        })),
      });
      continue;
    }

    if (m.images && m.images.length > 0 && provider.protocol === "openai") {
      const resolved = await resolveRefImages(m.images, args.userId);
      const content: Array<Record<string, unknown>> = [{ type: "text", text: m.content }];
      for (const url of resolved) {
        content.push({ type: "image_url", image_url: { url } });
      }
      upstreamMessages.push({ role: m.role, content });
    } else {
      upstreamMessages.push({ role: m.role, content: m.content });
    }
  }

  const body: Record<string, unknown> = {
    model: args.model ?? provider.models?.[0]?.name ?? "",
    messages: upstreamMessages,
    stream: true,
  };

  if (args.agent && provider.protocol === "openai") {
    body.tools = resolveSkillTools(args.activeSkill ?? null);
    body.tool_choice = "auto";
    body.parallel_tool_calls = false;
  }

  const req = protocol.buildLlmRequest(provider.baseUrl, provider.apiKey, body);
  return { ok: true, url: req.url, method: req.method, headers: req.headers, body: req.body };
}

export type RunResult =
  | { ok: true; text: string; toolCalls?: ProtocolToolCall[] }
  | { ok: false; error: string };

/** 非流式调用（兜底接口使用） */
export async function runCompletion(args: {
  messages: AgentMessage[];
  providerId?: number;
  model?: string;
  userId: number;
}): Promise<RunResult> {
  const built = await buildUpstream(args);
  if (!built.ok) return { ok: false, error: built.error };

  try {
    const resp = await fetchWithTimeout(built.url, {
      method: built.method,
      headers: built.headers,
      body: JSON.stringify(built.body),
      scene: "async",
      timeoutMs: getWorkerApiTimeout(),
    });
    if (!resp.ok) {
      const txt = await resp.text().catch(() => "");
      return { ok: false, error: `upstream ${resp.status}: ${txt.slice(0, 200)}` };
    }
    const data = await resp.json();
    const provider = await resolveProvider(args.userId, args.providerId, args.model);
    const protocol = provider ? getProtocol(provider.protocol) : undefined;
    const text = protocol?.parseLlmResponse ? protocol.parseLlmResponse(data).text ?? "" : "";
    return { ok: true, text };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/**
 * 流式 body 空闲超时：fetchWithTimeout 的超时只覆盖「等响应头」阶段，
 * 响应头返回后 body 读取无任何保护--上游 200 但长时间不推数据时
 * reader.read() 会永久挂起，前端表现为一直「思考中」。
 */
const STREAM_IDLE_TIMEOUT_MS = 120_000;

function readWithIdleTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>
): Promise<{ done: boolean; value?: Uint8Array }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reader.cancel().catch(() => {});
      reject(new Error(`upstream stream idle: no data for ${STREAM_IDLE_TIMEOUT_MS / 1000}s`));
    }, STREAM_IDLE_TIMEOUT_MS);
    reader.read().then(
      (r) => { clearTimeout(timer); resolve(r); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}

/** 流式调用：逐 chunk 推 delta、累积 tool_calls */
export async function runCompletionStream(args: {
  messages: AgentMessage[];
  providerId?: number;
  model?: string;
  userId: number;
  agent?: boolean;
  /** session 级激活的技能名，用于过滤注入给 LLM 的 tools */
  activeSkill?: string | null;
  signal?: AbortSignal;
  onDelta: (delta: string) => void;
}): Promise<RunResult> {
  const startedAt = Date.now();
  const elapsed = () => Date.now() - startedAt;

  const built = await buildUpstream(args);
  if (!built.ok) {
    logEvent("chat.stream", { stage: "build_failed", model: args.model ?? null, error: built.error });
    return { ok: false, error: built.error };
  }

  const provider = await resolveProvider(args.userId, args.providerId, args.model);
  const protocolName = provider?.protocol;
  logEvent("chat.stream", {
    stage: "upstream_start",
    provider: provider?.name ?? null,
    protocol: protocolName ?? null,
    model: args.model ?? null,
    messages: args.messages.length,
    agent: args.agent ?? false,
  });

  try {
    const resp = await fetchWithTimeout(built.url, {
      method: built.method,
      headers: built.headers,
      body: JSON.stringify(built.body),
      scene: "async",
      timeoutMs: getWorkerApiTimeout(),
      ...(args.signal ? { signal: args.signal } : {}),
    });
    logEvent("chat.stream", { stage: "upstream_headers", status: resp.status, elapsedMs: elapsed() });
    if (!resp.ok) {
      const txt = await resp.text().catch(() => "");
      logEvent("chat.stream", { stage: "upstream_error", status: resp.status, body: txt.slice(0, 200), elapsedMs: elapsed() });
      return { ok: false, error: `upstream ${resp.status}: ${txt.slice(0, 200)}` };
    }

    const reader = resp.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let full = "";
    let firstDeltaLogged = false;
    const toolAcc = new ToolCallAccumulator();

    while (true) {
      const { done, value } = await readWithIdleTimeout(reader);
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") continue;

        const delta = extractDelta(data);
        if (delta) {
          if (!firstDeltaLogged) {
            firstDeltaLogged = true;
            logEvent("chat.stream", { stage: "first_delta", elapsedMs: elapsed() });
          }
          full += delta;
          args.onDelta(delta);
        }

        if (args.agent) toolAcc.feed(data);
      }
    }

    const toolCalls = toolAcc.finish();
    logEvent("chat.stream", {
      stage: "upstream_done",
      textLen: full.length,
      toolCalls: toolCalls.length,
      elapsedMs: elapsed(),
    });
    return { ok: true, text: full, ...(toolCalls.length ? { toolCalls } : {}) };
  } catch (e) {
    logEvent("chat.stream", { stage: "exception", error: String(e), elapsedMs: elapsed() });
    return { ok: false, error: String(e) };
  }
}

/**
 * 累积上游流式返回的 tool_calls 分片。
 *
 * OpenAI 流式协议里 tool_calls 是按 index 增量下发的：
 * 第一片带 id/function.name，后续片只带 function.arguments 的字符串增量。
 */
class ToolCallAccumulator {
  private slots = new Map<number, { id: string; name: string; argsText: string }>();

  feed(data: string): void {
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(data);
    } catch {
      return;
    }

    const choices = json?.choices as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(choices)) return;

    for (const choice of choices) {
      const delta = choice?.delta as Record<string, unknown> | undefined;
      const calls = delta?.tool_calls as Array<Record<string, unknown>> | undefined;
      if (!Array.isArray(calls)) continue;

      for (const call of calls) {
        const index = typeof call.index === "number" ? call.index : 0;
        const slot = this.slots.get(index) ?? { id: "", name: "", argsText: "" };

        if (typeof call.id === "string" && call.id) slot.id = call.id;
        const fn = call.function as Record<string, unknown> | undefined;
        if (typeof fn?.name === "string" && fn.name) slot.name = fn.name;
        if (typeof fn?.arguments === "string") slot.argsText += fn.arguments;

        this.slots.set(index, slot);
      }
    }
  }

  finish(): ProtocolToolCall[] {
    const result: ProtocolToolCall[] = [];
    for (const [index, slot] of [...this.slots.entries()].sort((a, b) => a[0] - b[0])) {
      if (!slot.name) continue;
      let parsedArgs: Record<string, unknown> = {};
      if (slot.argsText.trim()) {
        try {
          const parsed = JSON.parse(slot.argsText);
          if (parsed && typeof parsed === "object") parsedArgs = parsed as Record<string, unknown>;
        } catch {
          parsedArgs = {};
        }
      }
      result.push({
        id: slot.id || `call_${slot.name}_${index}_${Date.now()}`,
        name: slot.name,
        args: parsedArgs,
      });
    }
    return result;
  }
}

/** 从上游 SSE data 行提取增量文本，按协议分支 */
function extractDelta(data: string): string {
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(data);
  } catch {
    return "";
  }

  // OpenAI / Ark(兼容) 格式
  const choices = json?.choices as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(choices)) {
    const delta = (choices[0]?.delta as Record<string, unknown> | undefined)?.content;
    if (typeof delta === "string") return delta;
  }

  // Gemini 流式格式
  const candidates = json?.candidates as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(candidates)) {
    const parts = (candidates[0]?.content as Record<string, unknown> | undefined)?.parts as
      | Array<Record<string, unknown>>
      | undefined;
    const text = parts?.[0]?.text;
    if (typeof text === "string") return text;
  }

  return "";
}
