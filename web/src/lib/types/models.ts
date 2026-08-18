// ============================================================
// 模型配置类型
// ============================================================

export type ModelCapability = "text" | "image" | "video" | "audio";

export interface ProviderPreset {
  name: string;
  baseUrl: string;
  protocol?: string;
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

/** 能力开关声明：模型支持哪些参考/附加能力 + 约束 */
export interface Capability {
  /** refMode 专用：可选参考方式（first/first-last/full），未声明则该模型不支持参考 */
  options?: string[];
  /** 默认值 */
  default?: boolean | string | number;
}

export interface ModelParamConfig {
  fields: ParamField[];
  /** 能力开关声明：前端据此动态渲染开关（refMode/generateAudio/refVideos/refAudios） */
  capabilities?: Record<string, Capability>;
  /**
   * 该能力允许接收的业务字段白名单（后端入参校验与 build() 兜底过滤的权威来源）。
   */
  allowedFields?: string[];
}

/** 模型信息（与 API 契约一致，camelCase） */
export interface ModelInfo {
  id: string;
  name: string;
  providerId?: string;
  capabilities: ModelCapability[];
}

/** 供应商信息（与 API 契约一致，camelCase） */
export interface ModelProvider {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  protocol?: string;
  models: ModelInfo[];
}

/** 生成面板中的模型选项 */
export interface ModelOption {
  /** 基于 id 的稳定键：providerId/modelId，改名不影响已有节点 */
  value: string;
  providerId: string;
  modelId: string;
  /** 模型名，发送后端与显示都用它 */
  name: string;
  /** 供应商名，仅显示拼接用 */
  providerName: string;
}
