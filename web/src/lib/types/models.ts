// ============================================================
// 模型配置类型
// ============================================================

export type ModelCapability = "text" | "image" | "video" | "audio";

export interface ProviderPreset {
  name: string;
  baseUrl: string;
  protocol?: string;
  config?: Record<string, unknown>;
}

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

export interface ModelParamConfig {
  fields: ParamField[];
  transforms?: Record<string, unknown>;
}

/** 模型信息（与 API 契约一致，camelCase） */
export interface ModelInfo {
  id: string;
  name: string;
  channelId?: string;
  capabilities: ModelCapability[];
}

/** 渠道信息（与 API 契约一致，camelCase） */
export interface ModelChannel {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  protocol?: string;
  config?: Record<string, unknown>;
  models: ModelInfo[];
}

/** 生成面板中的模型选项 */
export interface ModelOption {
  /** 基于 id 的稳定键：channelId/modelId，改名不影响已有节点 */
  value: string;
  channelId: string;
  modelId: string;
  /** 模型名，发送后端与显示都用它 */
  name: string;
  /** 渠道名，仅显示拼接用 */
  channelName: string;
}
