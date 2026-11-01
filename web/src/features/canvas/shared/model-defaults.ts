/**
 * 模型默认参数的统一解析口。
 *
 * 模型参数（含默认比例等 defaults）的唯一配置源是后端 model-ui.json，
 * 经 model store 下发后，前端所有「未设置时的默认值」场景——
 * 新建节点占位框尺寸、生成面板参数回退——统一从这里解析，
 * 禁止在前端另行硬编码默认值造成前后端两处漂移。
 *
 * 模型解析与面板展示层同一条回退链：该能力上次使用的模型 → 第一个可用模型
 * （resolveModelKey(undefined, …)），保证"新节点默认值"与面板打开时展示的
 * 模型及其默认参数一致。
 */

import { resolveModelKey } from "@/features/canvas/shared/last-model";
import { modelsForCapability } from "@/features/canvas/shared/model-catalog";
import { useModelStore } from "@/lib/model-store";
import type { ModelCapability } from "@/lib/types/models";

/** 有占位框 / 比例默认值的生成能力：仅图像与视频（文本生成没有） */
type MediaGenKind = Extract<ModelCapability, "image" | "video">;

/** 解析当前默认模型的某项参数默认值；模型或参数配置未就绪返回 undefined */
export function resolveModelDefaultField(kind: MediaGenKind, field: string): unknown {
  const { providers, findModelParams } = useModelStore.getState();
  const models = modelsForCapability(providers, kind);
  const modelKey = resolveModelKey(undefined, kind, models);
  const entry = models.find((m) => m.value === modelKey);
  if (!entry) return undefined;
  const params = findModelParams(entry.providerId, entry.name, kind);
  return params?.fields?.find((f) => f.name === field)?.default;
}
