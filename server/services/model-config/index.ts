/**
 * 模型配置服务。
 * 加载模型参数与能力预设，提供渠道、模型配置与预设的读取入口。
 */

import { loadJson } from "@server/services/json-loader";

// 预设

/** 加载预设配置（供前端 API 使用），支持热更新 */
export function loadPresets(): Record<string, unknown> {
  return loadJson<Record<string, unknown>>("server/resources/provider-presets.json");
}

// 模型参数
export type ParamFieldType = "segmented" | "select" | "slider" | "switch" | "number";

export interface ParamField {
  name: string;
  type: ParamFieldType;
  label: string;
  order: number;
  options?: (string | number)[];
  default?: string | number | boolean;
  min?: number;
  max?: number;
  step?: number;
  /** 渲染辅助：选项 i18n 前缀（如 generation.quality） */
  optionI18nPrefix?: string;
  /** 渲染辅助：值后缀 i18n key（如 generation.countUnit） */
  unit?: string;
  /** 渲染辅助：是否按比例格子渲染（ratio 专用） */
  ratio?: boolean;
  /** switch 专用：true/false 及简称 i18n key */
  trueLabel?: string;
  falseLabel?: string;
  trueShort?: string;
  falseShort?: string;
}

/** 能力开关声明：模型支持哪些参考/附加能力 + 约束 */
export interface Capability {
  /** refMode 专用：可选参考方式（first/first-last/full），未声明则该模型不支持参考 */
  options?: string[];
  /** 数量上限（refVideos/refAudios/refImages） */
  max?: number;
  /** 默认值 */
  default?: boolean | string | number;
}

export interface ModelParamConfig {
  fields: ParamField[];
  /**
   * 能力开关声明：前端据此动态渲染开关（refMode / generateAudio / refVideos / refAudios）。
   * 模型未声明的能力，前端不显示对应开关。
   */
  capabilities?: Record<string, Capability>;
  /**
   * 该能力允许接收的业务字段白名单（含无 UI 控件的字段，如 refImages / messages / stream）。
   * 后端入参校验与 build() 兜底过滤的权威来源。
   */
  allowedFields?: string[];
}

function loadRaw(): Record<string, Record<string, unknown>> {
  return loadJson<Record<string, Record<string, unknown>>>("server/resources/model-params.json");
}

/** 返回完整 JSON（供前端 API 使用） */
export function loadModelParams(): Record<string, Record<string, unknown>> {
  return loadRaw();
}

/**
 * 按模型名 + capability 查找参数配置。
 * 匹配优先级：精确名 > fnmatch 通配符 > _default
 * fields/capabilities 优先用模型级配置，缺失继承 _default。
 * 读取模型参数预设
 */
export function getModelParams(modelName: string, capability: string): ModelParamConfig | null {
  const data = loadRaw();

  // _default 配置（fields/capabilities 的兜底来源）
  const defaultCap = data["_default"]?.[capability];
  const defaultConfig = defaultCap ? parseConfig(defaultCap) : null;

  // 1. 精确名匹配
  const exact = data[modelName]?.[capability];
  if (exact) {
    return mergeConfig(parseConfig(exact), defaultConfig);
  }

  // 2. fnmatch 通配符匹配
  for (const [pattern, caps] of Object.entries(data)) {
    if (pattern === "_default" || pattern === modelName) continue;
    if (pattern.includes("*") || pattern.includes("?")) {
      const regex = new RegExp(
        "^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$"
      );
      if (regex.test(modelName)) {
        const capConfig = caps[capability];
        if (capConfig) return mergeConfig(parseConfig(capConfig), defaultConfig);
      }
    }
  }

  // 3. _default 兜底
  return defaultConfig;
}

/**
 * 合并配置：模型级配置优先，缺失的字段从 default 配置补充。
 * fields 为唯一数据源：模型级声明了 fields 则以模型级为准，否则继承 _default。
 */
function mergeConfig(specific: ModelParamConfig, defaultCfg: ModelParamConfig | null): ModelParamConfig {
  if (!defaultCfg) return specific;

  return {
    fields: specific.fields.length > 0 ? specific.fields : defaultCfg.fields,
    // capabilities 模型级优先，缺失则继承 _default
    capabilities: specific.capabilities ?? defaultCfg.capabilities,
    // allowedFields 模型级优先，缺失则继承 _default
    allowedFields: specific.allowedFields ?? defaultCfg.allowedFields,
  };
}

function parseConfig(raw: unknown): ModelParamConfig {
  const obj = raw as Record<string, unknown> ?? {};
  return {
    fields: (obj.fields as ParamField[]) ?? [],
    capabilities: (obj.capabilities as Record<string, Capability>) ?? undefined,
    allowedFields: (obj.allowedFields as string[]) ?? undefined,
  };
}

/**
 * 从 fields 提取默认值映射（name -> default）。
 * 供生成执行时使用，替代旧的 defaults 字段。
 */
export function modelFieldDefaults(modelParams: ModelParamConfig | null): Record<string, unknown> {
  if (!modelParams) return {};
  const out: Record<string, unknown> = {};
  for (const f of modelParams.fields) {
    if (f.default !== undefined) out[f.name] = f.default;
  }
  return out;
}

/**
 * 能力名归一化：前端/DB 层可能用 "text"，后端生成能力统一为 "llm"。
 */
export function normalizeCapability(capability: string): string {
  return capability === "text" ? "llm" : capability;
}

/**
 * 取某模型某能力允许接收的业务字段白名单。
 * 匹配优先级复用 getModelParams（精确名 > 通配 > _default），并对能力名做 text/llm 归一化。
 */
export function getAllowedFields(modelName: string, capability: string): string[] {
  const normalized = normalizeCapability(capability);
  const config = getModelParams(modelName, normalized);
  return config?.allowedFields ?? [];
}
