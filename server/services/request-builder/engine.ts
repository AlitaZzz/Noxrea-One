/**
 * 请求构建管线引擎。
 * 将前端固定语义字段，按模型 + 渠道（baseUrl host）+ 能力，
 * 转换为上游真实字段（字段名 + 结构 + 值换算）。
 *
 * 数据来源：model-ui.json（经 resolveFieldMapSpec 读取，支持热更新）。
 * 前端永远传固定语义字段名（ratio/seconds/refImages/refMode...），
 * 后端据模型 + 渠道自动转换，前端不感知上游字段。
 */

import { getAllowedFields, resolveFieldMapSpec, hostFromBaseUrl } from "@server/services/model-config";
import { resolveRefSlots, resolveByKind, applyTransform, setNested } from "./resolve";


export interface BuildInput {
  /** 业务参数（前端传入的 params） */
  params: Record<string, unknown>;
  /** 模型名 */
  modelName: string;
  /** 能力名（image/video/llm/audio） */
  capability: string;
  /** 协议名（openai/gemini/ark） */
  protocol: string;
  /** 上游 baseUrl，用于匹配渠道 */
  baseUrl: string;
  /** 任务 ID（日志关联） */
  taskId?: string;
}

/** 引擎内置清理：这些内部字段不传给 Provider */
const INTERNAL_FIELDS = new Set(["capability", "refMode", "channelId"]);

/** 通用字段：所有能力都放行（不属于能力业务字段，但需透传上游） */
const UNIVERSAL_FIELDS = new Set(["prompt", "model"]);

/** 参考类语义字段：需要从 refImages/refMode 派生槽位后按 kind 组装 */
const REF_KEYS = new Set(["refImages"]);

/**
 * 构建上游请求体：
 *   1. 解析参考槽位（refMode + refImages → firstFrame/lastFrame/refImages）
 *   2. 逐个语义字段查 {field, kind, transform}，改名 + 组结构 + 换算值
 *   3. 未映射字段原样透传；内部字段清除
 */
export function build(input: BuildInput): Record<string, unknown> {
  // 0. 能力字段白名单兜底：只放行该能力允许的业务字段 + 通用字段，其余丢弃
  const host = hostFromBaseUrl(input.baseUrl);
  const allowedSet = new Set(getAllowedFields(host, input.modelName, input.capability));

  // 1. 解析参考槽位
  const refMode = input.params.refMode as string | undefined;
  const refImages = (input.params.refImages as string[]) ?? [];
  // refMode 是视频专属参数；图像能力不涉及首尾帧，参考图直接全量参考（由 resolveRefSlots 按能力区分）
  const slots = resolveRefSlots(refMode, refImages, input.capability);

  // 2. 逐个字段转换
  const result: Record<string, unknown> = {};

  for (const [key, rawValue] of Object.entries(input.params)) {
    // 内部字段清除
    if (INTERNAL_FIELDS.has(key)) continue;

    // 兜底过滤：既非通用字段、也不在能力白名单内的字段，静默丢弃
    if (!UNIVERSAL_FIELDS.has(key) && !allowedSet.has(key)) continue;

    const spec = resolveFieldMapSpec(host, input.modelName, input.capability, key);

    // 有映射规格：参考类走 kind 组结构；普通类走改名 + transform
    if (spec) {
      // 按参考模式分派映射规格（如 seedance 首帧用 image_urls，首尾帧用 image_with_roles）
      const effectiveSpec = (refMode && spec.byRefMode?.[refMode]) ?? spec;
      if (REF_KEYS.has(key)) {
        const [field, value] = resolveByKind(effectiveSpec, slots);
        if (value !== undefined) setNested(result, field, value);
      } else {
        const value = applyTransform(effectiveSpec.transform, rawValue, input.params);
        if (value !== undefined && value !== null) setNested(result, effectiveSpec.field, value);
      }
      continue;
    }

    // 无映射：原样透传（去除 null）
    if (rawValue !== undefined && rawValue !== null) {
      result[key] = rawValue;
    }
  }

  return result;
}
