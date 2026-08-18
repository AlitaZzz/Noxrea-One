/**
 * Settings 模块的共享类型。
 * 模型渠道配置相关的类型从 lib/types/models 重新导出，
 * 供 ApiSettingsDrawer 等组件统一从 feature 内部引用。
 */
export type { ModelCapability, ModelProvider, ModelInfo } from "@/lib/types/models";
