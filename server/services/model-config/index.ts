/**
 * 模型配置服务。
 * 加载模型参数与能力预设，提供渠道、模型配置与预设的读取入口。
 *
 * model-ui.json 结构（v2）：
 *   {
 *     "_default": { <capability>: { fields, allowedFields, mapping } },   // 纯透传兜底
 *     "<host通配>": {                       // 如 "*apimart*" / "*fhl.mom*" / "*agnes*"
 *       "<模型名通配或精确>": {               // 精确优先，其次 * 通配
 *         "<capability>": { fields, mapping }   // 该上游下该模型的参数与字段映射
 *       }
 *     }
 *   }
 *
 * 匹配规则：
 *   - host 通配第一个命中即返回（配置保证互斥，不出现多命中）。
 *   - 模型名精确匹配优先于通配匹配。
 *   - 未命中任何 host 时回退 _default（纯透传，不做任何字段改名/换算）。
 */

import { loadJson } from "@server/services/json-loader";

// 预设

/** 加载预设配置（供前端 API 使用），支持热更新 */
export function loadPresets(): Record<string, unknown> {
  return loadJson<Record<string, unknown>>("provider-presets.json");
}

// 模型参数
export type ParamFieldType = "segmented" | "select" | "slider" | "switch" | "number";

export interface ParamField {
  name: string;
  type: ParamFieldType;
  /** 标签 i18n key；省略时前端渲染器按 param.<name> 推导 */
  label?: string;
  order: number;
  options?: (string | number)[];
  default?: string | number | boolean;
  min?: number;
  max?: number;
  step?: number;
  /** 渲染辅助：选项 i18n 前缀（如 param.options.quality） */
  optionI18nPrefix?: string;
  /** 渲染辅助：值后缀 i18n key（如 param.unit.n） */
  unit?: string;
  /** 渲染辅助：是否按比例格子渲染（ratio 专用） */
  ratio?: boolean;
  /** switch 专用：true/false 及简称 i18n key */
  trueLabel?: string;
  falseLabel?: string;
  trueShort?: string;
  falseShort?: string;
}

/** 能力声明：模型支持的参考方式约束（当前仅 refMode 被消费） */
export interface Capability {
  /** refMode 专用：可选参考方式（text/image/first-last/full），未声明则该模型不支持参考 */
  options?: string[];
}

/** 值换算规则（声明式，写 JSON） */
export interface TransformSpec {
  type: "lookup" | "map" | "ratio" | "stringify" | "wrap";
  /** lookup 专用：参与组合的字段列表，如 ["ratio", "resolution"] */
  composite?: string[];
  /** lookup / map 专用：查表 */
  table?: Record<string, string | string[]>;
  /** wrap 专用：包装键名，默认 "url" */
  key?: string;
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
  /** 可选：首尾帧成对输出 slots.firstFrame → pair[0]、slots.lastFrame → pair[1] */
  pair?: [string, string];
}

/** 派生字段：由另一个参数（如 refMode）查表派生上游字段 */
export interface DerivedFieldSpec {
  /** 派生来源参数名（如 refMode） */
  source: string;
  /** 来源值 → 上游值 查表 */
  table: Record<string, string>;
  /** 未命中时默认值 */
  default?: string;
}

/** 某上游下某模型某能力的参数配置 */
export interface ModelParamConfig {
  fields: ParamField[];
  /**
   * 能力声明：当前仅 refMode.options 被前端消费，用于渲染参考方式下拉；
   * 未声明 refMode 的模型，前端不显示参考方式（视为不支持参考）。
   * 参考素材（refImages/refVideos/refAudios）是否支持由 allowedFields + mapping 决定。
   */
  capabilities?: Record<string, Capability>;
  /**
   * 该能力允许接收的业务字段白名单（含无 UI 控件的字段，如 refImages / messages / stream）。
   * 后端入参校验与 build() 兜底过滤的权威来源。
   */
  allowedFields?: string[];
  /**
   * 默认字段映射（语义字段 → 上游字段），后端 build() 用。
   * 不返回给前端。
   */
  mapping?: Record<string, FieldMapSpec>;
  /**
   * 派生字段：由另一参数（如 refMode）查表派生出的上游字段，
   * 后端 build() 在字段循环前优先应用（如 Agnes 的 mode 由 refMode 派生）。
   */
  derivedFields?: Record<string, DerivedFieldSpec>;
}

/** model-ui.json 顶层：host通配 → 模型名 → capability → 配置 */
type HostMap = Record<string, Record<string, Record<string, unknown>>>;

function loadRaw(): HostMap {
  return loadJson<HostMap>("model-ui.json");
}

/** 返回完整 JSON（供前端 API 使用） */
export function loadModelParams(): Record<string, Record<string, unknown>> {
  return loadRaw();
}

/**
 * 通配符 → 正则，`*` 匹配任意字符（含域名主体子串），`?` 匹配单字符。
 */
function wildcardToRegex(pattern: string): RegExp {
  return new RegExp(
    "^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$"
  );
}

/**
 * 在 host 层级匹配：遍历顶层 key（含通配），第一个命中即返回。
 * 返回 [命中的 hostKey, 其下的模型映射表]。
 */
function matchHost(data: HostMap, host: string): [string, Record<string, Record<string, unknown>>] | null {
  for (const [key, models] of Object.entries(data)) {
    if (key === "_default") continue;
    if (key === host) return [key, models];
    if (key.includes("*") || key.includes("?")) {
      if (wildcardToRegex(key).test(host)) return [key, models];
    }
  }
  return null;
}

/**
 * 在模型层级匹配：精确优先，其次通配。
 * 返回 [命中的模型 key, 其下的能力表]。
 */
function matchModel(models: Record<string, Record<string, unknown>>, modelName: string): [string, Record<string, unknown>] | null {
  // 1. 精确名优先
  const exact = models[modelName];
  if (exact) return [modelName, exact];

  // 2. 通配匹配
  for (const [key, caps] of Object.entries(models)) {
    if (key === modelName) continue;
    if (key.includes("*") || key.includes("?")) {
      if (wildcardToRegex(key).test(modelName)) return [key, caps];
    }
  }

  return null;
}

/**
 * 解析某能力配置为 ModelParamConfig。
 */
function parseConfig(raw: unknown): ModelParamConfig {
  const obj = (raw as Record<string, unknown>) ?? {};
  return {
    fields: (obj.fields as ParamField[]) ?? [],
    capabilities: (obj.capabilities as Record<string, Capability>) ?? undefined,
    allowedFields: (obj.allowedFields as string[]) ?? undefined,
    mapping: (obj.mapping as Record<string, FieldMapSpec>) ?? undefined,
    derivedFields: (obj.derivedFields as Record<string, DerivedFieldSpec>) ?? undefined,
  };
}

/**
 * 按 host + 模型名 + capability 查找参数配置。
 * 匹配优先级：
 *   1. host 通配第一个命中（配置互斥）→ 该 host 下模型名精确 > 通配
 *   2. 未命中 host → _default 对应 capability（纯透传兜底）
 * 字段缺失时继承 _default 同名 capability 的 fields/allowedFields（mapping 不继承）。
 */
export function getModelParams(host: string, modelName: string, capability: string): ModelParamConfig | null {
  const data = loadRaw();

  const defaultCfg = data["_default"]?.[capability];
  const defaultConfig = defaultCfg ? parseConfig(defaultCfg) : null;

  const hostHit = matchHost(data, host);
  if (hostHit) {
    const [, models] = hostHit;
    const modelHit = matchModel(models, modelName);
    if (modelHit) {
      const [, caps] = modelHit;
      const capRaw = caps[capability];
      if (capRaw) {
        return mergeConfig(parseConfig(capRaw), defaultConfig);
      }
    }
  }

  // 兜底：_default 纯透传
  return defaultConfig;
}

/**
 * 合并配置：模型级配置优先，缺失的 fields/allowedFields 从 _default 补充。
 * mapping 不跨模型继承（字段映射只对本模型/本上游生效）。
 */
function mergeConfig(specific: ModelParamConfig, defaultCfg: ModelParamConfig | null): ModelParamConfig {
  if (!defaultCfg) return specific;

  return {
    fields: specific.fields.length > 0 ? specific.fields : defaultCfg.fields,
    capabilities: specific.capabilities ?? defaultCfg.capabilities,
    allowedFields: specific.allowedFields ?? defaultCfg.allowedFields,
    mapping: specific.mapping ?? defaultCfg.mapping,
    derivedFields: specific.derivedFields ?? defaultCfg.derivedFields,
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
 * 白名单是能力级声明，不依赖 host；但字段白名单通常写在模型级或 _default，
 * 这里按「host 下模型级 → _default」解析。
 */
export function getAllowedFields(host: string, modelName: string, capability: string): string[] {
  const normalized = normalizeCapability(capability);
  const config = getModelParams(host, modelName, normalized);
  return config?.allowedFields ?? [];
}

/** 从 baseUrl 解析 host（供渠道级匹配用） */
export function hostFromBaseUrl(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return baseUrl;
  }
}

/**
 * 解析某 baseUrl 在 model-ui.json 中命中的供应商条目 key。
 * 命中 vendor 通配条目返回其 key（如 "*apimart*"）；未命中返回 "_default"。
 * 用途：让供应商识别结果在日志中可见，避免静默回退导致的问题难以排查。
 */
export function resolveMatchedHost(baseUrl: string): string {
  const host = hostFromBaseUrl(baseUrl);
  const hit = matchHost(loadRaw(), host);
  return hit ? hit[0] : "_default";
}

/**
 * 取某语义字段的映射规格（本上游本模型 mapping → undefined）。
 * 命中不到返回 undefined，由 build() 按白名单原样透传。
 */
export function resolveFieldMapSpec(
  host: string,
  modelName: string,
  capability: string,
  key: string
): FieldMapSpec | undefined {
  const config = getModelParams(host, modelName, capability);
  if (!config) return undefined;
  return config.mapping?.[key];
}

/**
 * 取某上游某模型某能力的派生字段表（如 Agnes 的 mode 由 refMode 派生）。
 * 未命中返回 undefined。
 */
export function resolveDerivedFields(
  host: string,
  modelName: string,
  capability: string
): Record<string, DerivedFieldSpec> | undefined {
  const config = getModelParams(host, modelName, capability);
  if (!config) return undefined;
  return config.derivedFields;
}

/**
 * 取某上游（host）的 endpoint 路由。
 * 存放于 host 条目顶层的 `_endpoints` 键，如 { "image.edits": "/images/generations", "video.poll": "..." }。
 * 未命中返回 undefined。
 */
export function resolveProviderEndpoints(
  host: string,
  modelName: string,
  capability: string
): Record<string, string> | undefined {
  void modelName;
  void capability;
  const data = loadRaw();
  const hostHit = matchHost(data, host);
  if (!hostHit) return undefined;
  const [, models] = hostHit;
  const endpoints = models["_endpoints"];
  if (endpoints && typeof endpoints === "object") {
    return endpoints as Record<string, string>;
  }
  return undefined;
}
