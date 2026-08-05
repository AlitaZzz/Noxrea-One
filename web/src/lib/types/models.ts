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

export interface ModelParamConfig {
  params: string[];
  defaults: Record<string, unknown>;
  constraints: Record<string, string[]>;
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
