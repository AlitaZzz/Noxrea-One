/**
 * 供应商（provider）解析。
 * 通过 baseUrl 的 host 匹配供应商，读取该供应商的字段映射配置。
 *
 * provider-map.json 结构：
 * {
 *   "_default": { "protocol": "...", "models": { ... } },
 *   "<host>":   { "protocol": "...", "models": { ... } }
 * }
 *
 * models 下按「模型名（精确 / * 通配）→ 能力 → 语义字段 → {field, kind, transform?}」组织。
 */

import { loadJson } from "@server/services/json-loader";

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

/** 某个能力下所有语义字段的映射表 */
export type CapabilityMap = Record<string, FieldMapSpec>;

/** 某个模型下各能力的映射表 */
export type ModelMap = Record<string, CapabilityMap>;

export interface ProviderConfig {
  protocol: string;
  /** 供应商级 endpoint 路由（如 image.edits / poll / video.generations） */
  endpoints?: Record<string, string>;
  models: Record<string, ModelMap>;
}

export type ProviderMap = Record<string, ProviderConfig>;

/** 从 baseUrl 解析 host，并匹配供应商（命中不到则 _default 兜底） */
export function resolveProvider(baseUrl: string): ProviderConfig {
  const map = loadJson<ProviderMap>("server/resources/provider-map.json");
  let host: string;
  try {
    host = new URL(baseUrl).hostname;
  } catch {
    return map["_default"];
  }
  return map[host] ?? map["_default"];
}

/**
 * 取某个语义字段的映射规格。
 * 匹配优先级：模型精确名 → fnmatch 通配符（如 *seedance-2*）→ 模型通配 "*" → undefined。
 */
export function resolveKindSpec(
  cfg: ProviderConfig,
  model: string,
  capability: string,
  semanticKey: string
): FieldMapSpec | undefined {
  const exact = cfg.models[model]?.[capability]?.[semanticKey];
  if (exact) return exact;

  // fnmatch 通配符匹配（按配置顺序遍历，命中即返回）
  for (const [pattern, caps] of Object.entries(cfg.models)) {
    if (pattern === "*" || pattern === model) continue;
    if (pattern.includes("*") || pattern.includes("?")) {
      const regex = new RegExp(
        "^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$"
      );
      if (regex.test(model)) {
        const spec = caps[capability]?.[semanticKey];
        if (spec) return spec;
      }
    }
  }

  const wildcard = cfg.models["*"]?.[capability]?.[semanticKey];
  if (wildcard) return wildcard;

  return undefined;
}

/** 取供应商 endpoint（如 image.edits / poll） */
export function resolveEndpoint(cfg: ProviderConfig, key: string): string | undefined {
  return cfg.endpoints?.[key];
}
