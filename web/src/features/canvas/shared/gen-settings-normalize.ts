/**
 * 生成设置（genSettings）的归一化规则。
 *
 * 设计约定：
 * - 选中 / 查看节点不得修改节点数据，归一化只在数据层执行：
 *   写入入口（writeGenSettings）与画布级目录 / 连线变化时统一处理；
 * - 只纠正「已持久化的非法值」，不为未持久化的字段物化默认值
 *   （空 modelKey / refMode 由展示与提交侧按同一回退链解析，写回会固化用户偏好）；
 * - 规则本身与旧面板挂载 effect 保持一致：
 *   悬空 modelKey → 回退链；字段值不属当前模型 options → 字段默认值；
 *   视频 refMode 不合法 → 上游参考 ∩ 模型能力的收敛值；
 *   空节点占位框跟随当前模型默认比例（仅在目录变化 / 生效模型变化时触发，
 *   且尺寸确有差异才返回，避免打开项目即产生无意义写入）。
 *
 * 本模块不读写 store；模型回退链经 last-model 读取设备级「上次使用模型」偏好
 * （localStorage），其余为纯计算。store 入口见 shared/gen-settings.ts。
 */

import type { AnyNode } from "@/features/canvas/types";
import type { ModelOption, ModelParamConfig } from "@/lib/types/models";

import { genKindOfNode, mediaNodeHasContent } from "./gen-settings-node";
import { resolveModelKey } from "./last-model";
import { ratioToNodeSize } from "./ratio-size";
import { allowedRefModesFor, resolveRefMode } from "./ref-modes";

export interface GenSettingsContext {
  /** 该能力的模型目录（modelsForCapability 构建，保持目录顺序） */
  models: readonly ModelOption[];
  findModelParams: (providerId: string, modelName: string, capability: string) => ModelParamConfig | null;
  /** 画布全量节点 / 连线（视频 refMode 的上游参考推导用） */
  nodes: readonly AnyNode[];
  edges: ReadonlyArray<{ source: string; target: string }>;
}

interface GenSettingsNormalization {
  /** 归一化后的完整 genSettings；仅在实际变化时存在 */
  genSettings?: Record<string, unknown>;
  /**
   * 需要跟随到空节点占位框的比例。
   * 已包含「节点有内容 / 尺寸未变化」守卫，调用方只需落尺寸。
   */
  applyRatio?: string;
}

interface NormalizeGenSettingsOptions {
  /**
   * 是否按当前模型默认比例校正空节点占位框：
   * - true：模型目录变化时的画布级归一化；
   * - false：仅连线变化（只纠偏设置值，不重排用户调整过的占位框）；
   * - 省略：写入入口按「生效模型是否变化」判断（需提供 previous）。
   */
  placeholder?: boolean;
  /** 写入前的 genSettings（写入入口判断生效模型是否变化） */
  previous?: Record<string, unknown>;
}

/**
 * 归一化单个生成节点的 genSettings。
 * 无任何变化返回 null；返回的 genSettings 是完整合并结果，调用方直接整体写回。
 */
export function normalizeGenSettings(
  node: AnyNode,
  genSettings: Record<string, unknown>,
  ctx: GenSettingsContext,
  options: NormalizeGenSettingsOptions = {},
): GenSettingsNormalization | null {
  const kind = genKindOfNode(node);
  if (!kind) return null;
  const { models } = ctx;
  // 模型目录未就绪：保持现状，等目录到达后由画布级归一化处理
  if (models.length === 0) return null;

  let next = genSettings;
  const assign = (key: string, value: unknown) => {
    if (Object.is(next[key], value)) return;
    if (next === genSettings) next = { ...genSettings };
    next[key] = value;
  };

  // 1. 悬空 modelKey：仅纠正已持久化且失效的值；空值不写（展示层回退，不固化偏好）
  const persistedKey = typeof next.modelKey === "string" ? next.modelKey : "";
  if (persistedKey && !models.some((m) => m.value === persistedKey)) {
    assign("modelKey", resolveModelKey(undefined, kind, models));
  }

  const effectiveModelKey = (value: Record<string, unknown>) =>
    resolveModelKey(
      typeof value.modelKey === "string" ? value.modelKey : undefined,
      kind,
      models,
    );
  const modelKey = effectiveModelKey(next);
  const entry = models.find((m) => m.value === modelKey);
  const params = entry ? ctx.findModelParams(entry.providerId, entry.name, kind) : null;
  const hasContent = mediaNodeHasContent(node);
  const isMedia = kind === "image" || kind === "video";
  const sizeDiffers = (ratio: string): boolean => {
    const size = ratioToNodeSize(ratio);
    return !!size && (node.style?.width !== size.width || node.style?.height !== size.height);
  };

  let applyRatio: string | undefined;

  // 2. 字段值不在当前模型 options：纠偏到字段默认值（只处理已持久化的值）
  for (const field of params?.fields ?? []) {
    if (!field.options?.length) continue;
    const current = next[field.name];
    if (current === undefined || (field.options as readonly unknown[]).includes(current)) continue;
    assign(field.name, field.default);
    // 比例被纠偏时，空节点占位框同步落位（与面板 setField("ratio") 的既有行为一致）
    if (field.name === "ratio" && isMedia && !hasContent && typeof field.default === "string" && sizeDiffers(field.default)) {
      applyRatio = field.default;
    }
  }

  // 3. 视频 refMode：仅纠正已持久化的非法值。
  //    未持久化时由面板展示 / 提交侧用同一 resolveRefMode 解析，不落默认值。
  if (kind === "video") {
    const persistedMode = next.refMode;
    if (typeof persistedMode === "string" && persistedMode !== "") {
      const refModeOptions = params?.capabilities?.refMode?.options ?? [];
      const allowed = allowedRefModesFor(node.id, ctx.nodes, ctx.edges);
      const { value } = resolveRefMode(persistedMode, refModeOptions, allowed);
      if (value !== persistedMode) assign("refMode", value);
    }
  }

  // 4. 空节点占位框：未设置 ratio 时跟随当前模型默认比例（与建节点工厂同一规则）。
  //    仅在目录变化或生效模型变化时触发；尺寸一致则不产生写入。
  if (isMedia && !hasContent && !next.ratio) {
    const ratioDefault = params?.fields?.find((f) => f.name === "ratio")?.default;
    if (typeof ratioDefault === "string") {
      const applyPlaceholder = options.placeholder
        ?? (options.previous !== undefined && effectiveModelKey(options.previous) !== modelKey);
      if (applyPlaceholder && !applyRatio && sizeDiffers(ratioDefault)) {
        applyRatio = ratioDefault;
      }
    }
  }

  if (next === genSettings && applyRatio === undefined) return null;
  return {
    genSettings: next === genSettings ? undefined : next,
    applyRatio,
  };
}
