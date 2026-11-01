/**
 * 生成能力模型目录的唯一构建口。
 *
 * 生成面板、画布 Agent、模型默认值解析、画布级生成设置归一化都需要
 * 「某能力的可用模型列表」，且必须共享同一口径：
 * - 稳定键 value = providerId/modelName（模型行 ID 会在重拉时整表重建，不能持久化）；
 * - 按 value 去重（同名模型可能出现在多个渠道）；
 * - 顺序保持供应商 / 模型原始顺序（决定「第一个可用模型」的回退结果）。
 *
 * 任何新增消费方都必须复用本函数，禁止再写一份 flatMap + filter。
 */

import type { ModelCapability, ModelOption, ModelProvider } from "@/lib/types/models";

/** 提取某能力可用的模型选项（稳定键去重，保持目录顺序）。 */
export function modelsForCapability(
  providers: readonly ModelProvider[],
  capability: ModelCapability,
): ModelOption[] {
  const options: ModelOption[] = [];
  const seen = new Set<string>();
  for (const provider of providers) {
    for (const model of provider.models) {
      if (!model.capabilities?.includes(capability)) continue;
      const value = `${provider.id}/${model.name}`;
      if (seen.has(value)) continue;
      seen.add(value);
      options.push({
        value,
        providerId: provider.id,
        modelId: model.id,
        name: model.name,
        providerName: provider.name,
      });
    }
  }
  return options;
}
