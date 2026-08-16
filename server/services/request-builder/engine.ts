/**
 * 请求构建管线引擎。
 * 串联变换、字段映射与固定参数注入，将业务参数构建为上游请求体。
 */

import { applyTransforms } from "./transforms";
import { applyMapping } from "./mapping";
import { applyPatch } from "./patch";
import { getModelParams, type ModelParamConfig } from "@server/services/model-config";
import { logEvent, summarizeText } from "@server/core/logger/utils";

export interface BuildInput {
  /** 业务参数（前端传入的 params） */
  params: Record<string, unknown>;
  /** 模型名，用于从 model-params.json 加载 transforms */
  modelName: string;
  /** 能力名（image/video/llm/audio） */
  capability: string;
  /** 协议名（openai/gemini/ark） */
  protocol: string;
  /** 渠道配置（JSON 字符串解析后的对象，含 request.mapping / request.body_patch） */
  channelConfig?: Record<string, unknown>;
  /** 任务 ID（日志关联） */
  taskId?: string;
}

/** 引擎内置清理：这些内部字段不传给 Provider */
const INTERNAL_FIELDS = new Set(["capability"]);

/**
 * 四步管线：transforms → auto-clean → mapping → patch
 * 构建上游请求体
 *
 * channelConfig 结构（对齐 Python ChannelConfig）：
 * {
 *   request: {
 *     mapping: { "ref_images": "images[].image_url", ... },
 *     body_patch: { ... },
 *     model_overrides: [...],
 *     submit_style: "sync" | "async"
 *   },
 *   protocol: { endpoints: { ... } }
 * }
 */
export function build(input: BuildInput): Record<string, unknown> {
  let body = { ...input.params };
  const modelParams = getModelParams(input.modelName, input.capability);

  // 解析 channel config 中的 request 配置
  const requestCfg = input.channelConfig?.request as Record<string, unknown> | undefined;
  const mappingConfig = requestCfg?.mapping as Record<string, unknown> | undefined;
  const bodyPatch = requestCfg?.body_patch as Record<string, unknown> | undefined;

  // 1. Transforms：从 model-params.json 加载 transforms 配置执行值变换
  let consumed = new Set<string>();
  if (modelParams?.transforms && Object.keys(modelParams.transforms).length > 0) {
    const result = applyTransforms(body, modelParams.transforms);
    body = result.body;
    consumed = result.consumed;
  }

  // 2. Auto-clean：删内部字段、删 None 值、删 composite 已消费字段
  for (const key of Object.keys(body)) {
    if (INTERNAL_FIELDS.has(key)) {
      delete body[key];
    } else if (body[key] === null) {
      delete body[key];
    } else if (consumed.has(key)) {
      delete body[key];
    }
  }

  // 3.5 能力级白名单：LLM 能力只需 prompt/messages，不应把 image/video 的内部字段
  // （n、refImages、channelId、model 等）透传给语言模型上游，否则上游会报未知参数。
  if (input.capability === "llm") {
    const LLM_ALLOWED = new Set(["prompt", "messages", "temperature", "top_p", "max_tokens", "stop", "stream"]);
    for (const key of Object.keys(body)) {
      if (!LLM_ALLOWED.has(key)) delete body[key];
    }
  }

  // 3.6 注入模型名：LLM 请求必须带 model，否则上游报 MissingParameter。
  // 该字段不在白名单内，需在过滤之后、mapping 之前显式写入，确保不会被清掉。
  if (input.capability === "llm" && input.modelName) {
    body.model = input.modelName;
  }

  // 3. Mapping：字段映射/重命名（渠道级，从 request.mapping 读取）
  if (mappingConfig) {
    body = applyMapping(body, mappingConfig);
  }

  // 4. Patch：固定参数注入（渠道级，从 request.body_patch 读取）
  if (bodyPatch) {
    body = applyPatch(body, bodyPatch);
  }

  // 日志：回显请求构建结果
  logEvent("builder", {
    stage: "built",
    taskId: input.taskId,
    model: input.modelName,
    capability: input.capability,
    protocol: input.protocol,
    bodyKeys: Object.keys(body),
    ...(typeof body.prompt === "string" ? { promptLen: body.prompt.length } : {}),
  });

  return body;
}
