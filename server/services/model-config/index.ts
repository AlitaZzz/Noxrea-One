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
  /** 默认值 */
  default?: boolean | string | number;
}

/** 值换算规则（声明式，写 JSON） */
export interface TransformSpec {
  type: "lookup" | "map" | "ratio";
  /** lookup 专用：参与组合的字段列表，如 ["ratio", "resolution"] */
  composite?: string[];
  /** lookup / map 专用：查表 */
  table?: Record<string, string | string[]>;
}

/** 单个语义字段的映射规格 */
export interface FieldMapSpec {
  /** 上游字段名（含嵌套路径，如 extra_body.image） */
  field: string;
  /** 结构枚举：single / array / array[].k / role:xxx / role:first-last / slot:first / slot:last */
  kind: string;
  /** 可选：值换算规则 */
  transform?: TransformSpec;
  /** 可选：按参考模式（refMode）分派映射规格，命中则覆盖 field/kind/transform */
  byRefMode?: Record<string, FieldMapSpec>;
}

/** 渠道级覆盖：_endpoints 为特殊键（路由），其余为字段映射覆盖 */
export interface ChannelOverride {
  /** 渠道级 endpoint 路由（如 image.edits / video.poll） */
  _endpoints?: Record<string, string>;
  /** 字段映射覆盖（渠道优先于模型级 mapping） */
  [field: string]: FieldMapSpec | Record<string, string> | undefined;
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
  /**
   * 模型级默认字段映射（语义字段 → 上游字段），后端 build() 用。
   * 不返回给前端。
   */
  mapping?: Record<string, FieldMapSpec>;
  /**
   * 渠道级覆盖：{ host → { _endpoints, 字段覆盖 } }，后端 build() 与轮询用。
   * 不返回给前端。
   */
  channels?: Record<string, ChannelOverride>;
}

function loadRaw(): Record<string, Record<string, unknown>> {
  return loadJson<Record<string, Record<string, unknown>>>("server/resources/model-ui.json");
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
    // mapping / channels 不继承（渠道级覆盖只对本模型生效，不跨模型传递）
    mapping: specific.mapping ?? defaultCfg.mapping,
    channels: specific.channels ?? defaultCfg.channels,
  };
}

function parseConfig(raw: unknown): ModelParamConfig {
  const obj = raw as Record<string, unknown> ?? {};
  return {
    fields: (obj.fields as ParamField[]) ?? [],
    capabilities: (obj.capabilities as Record<string, Capability>) ?? undefined,
    allowedFields: (obj.allowedFields as string[]) ?? undefined,
    mapping: (obj.mapping as Record<string, FieldMapSpec>) ?? undefined,
    channels: (obj.channels as Record<string, ChannelOverride>) ?? undefined,
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

/** 从 baseUrl 解析 host（供渠道级覆盖匹配用） */
export function hostFromBaseUrl(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return baseUrl;
  }
}

/**
 * 取某语义字段的映射规格（渠道级覆盖 → 模型级默认 → undefined）。
 * 优先级：channels[host][key] → mapping[key] → undefined。
 * 命中不到返回 undefined，由 build() 按白名单原样透传。
 */
export function resolveFieldMapSpec(
  modelName: string,
  capability: string,
  key: string,
  host?: string
): FieldMapSpec | undefined {
  const config = getModelParams(modelName, capability);
  if (!config) return undefined;

  // 1. 渠道级覆盖优先
  if (host) {
    const ch = config.channels?.[host];
    const override = ch?.[key];
    if (override && typeof override === "object" && "field" in override) {
      return override as FieldMapSpec;
    }
  }

  // 2. 模型级默认映射
  return config.mapping?.[key];
}

/**
 * 取渠道级 endpoints（channels[host]._endpoints）。
 * 返回 { image.edits, video.poll, ... }，未命中返回 undefined。
 */
export function resolveChannelEndpoints(
  modelName: string,
  capability: string,
  host: string
): Record<string, string> | undefined {
  const config = getModelParams(modelName, capability);
  if (!config) return undefined;
  return config.channels?.[host]?._endpoints;
}
