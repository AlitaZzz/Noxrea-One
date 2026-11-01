/**
 * 生成设置的语义读写入口与画布级归一化。
 *
 * - 读取：useGenSettings 响应式订阅节点 genSettings；
 * - 写入：writeGenSettings 合并 patch 后在**同一次写入**内完成归一化
 *   （悬空 modelKey / 字段越界 / refMode 非法），面板挂载不再产生任何写回；
 * - 排序偏好：ref-order 的拖拽 / 重连事件直接写同一字段（skipHistory）。
 *   该模块位于归一化依赖链下游（gen-settings → gen-settings-normalize →
 *   ref-modes → ref-order），不能反向依赖本模块；排序字段不参与归一化。
 * - 画布级：normalizeCanvasGenSettings 在模型目录或连线连通关系变化时一次性处理
 *   全画布，纠偏不再依赖「节点恰好被选中」。
 *
 * 归一化规则见 shared/gen-settings-normalize.ts。
 */

"use client";

import { useModelStore } from "@/lib/model-store";
import type { ModelCapability } from "@/lib/types/models";

import { markDirtyImmediate, useCanvasStore } from "../stores/canvas-store";
import type { AnyNode } from "../types";
import { genKindOfNode, genSettingsOf } from "./gen-settings-node";
import {
  type GenSettingsContext,
  normalizeGenSettings,
} from "./gen-settings-normalize";
import { modelsForCapability } from "./model-catalog";
import { applyRatioToNode, ratioToNodeSize } from "./ratio-size";

/**
 * 响应式读取节点 genSettings（引用稳定：仅在 genSettings 整体被替换时变化）。
 *
 * `active=false`（面板隐藏）时选择器退化为常量，不再随全画布 store 变更扫描
 * 节点，也不触发所在面板重渲染。隐藏面板不显示、不接受输入，值无需保真；
 * 重新可见时选择器恢复实时读取。
 */
export function useGenSettings(nodeId: string, active: boolean) {
  return useCanvasStore((s) => {
    if (!active) return undefined;
    return genSettingsOf(s.nodes.find((n) => n.id === nodeId));
  });
}

function contextFor(
  kind: ModelCapability,
  nodes: readonly AnyNode[],
  edges: ReadonlyArray<{ source: string; target: string }>,
): GenSettingsContext {
  const { providers, findModelParams } = useModelStore.getState();
  return { models: modelsForCapability(providers, kind), findModelParams, nodes, edges };
}

/**
 * 受控写入口：合并 patch 后整体写回 genSettings（skipHistory，连续编辑不压栈）。
 * 生成面板的提示词 / 模型 / 参数编辑统一走此函数——store 是唯一数据源，
 * 外部通道（如画布 Agent update_node）的写入经由 useGenSettings 反应式透出。
 *
 * 归一化与 patch 在同一次写回内完成：模型切换时字段纠偏不会产生第二次提交。
 */
export function writeGenSettings(nodeId: string, patch: Record<string, unknown>): void {
  const store = useCanvasStore.getState();
  const node = store.nodes.find((n) => n.id === nodeId);
  const current = (genSettingsOf(node) ?? {}) as Record<string, unknown>;
  const merged = { ...current, ...patch };

  let genSettings = merged;
  let applyRatio: string | undefined;
  const kind = node ? genKindOfNode(node) : null;
  if (node && kind) {
    const result = normalizeGenSettings(node, merged, contextFor(kind, store.nodes, store.edges), {
      previous: current,
    });
    if (result?.genSettings) genSettings = result.genSettings;
    applyRatio = result?.applyRatio;
  }

  store.updateNodeData(nodeId, { genSettings }, undefined, { skipHistory: true });
  markDirtyImmediate();
  // 生效模型变化 / 比例被纠偏时，空节点占位框跟随（有内容节点由 applyRatioToNode 内部跳过）
  if (applyRatio) applyRatioToNode(nodeId, applyRatio);
}

/**
 * 画布级归一化：一次扫描处理全部生成节点，有变化才批量写回并标脏。
 *
 * @param placeholder 是否按当前模型默认比例校正空节点占位框：
 *   模型目录变化为 true；仅连线变化为 false（连线不改变模型默认比例，
 *   不应把用户手动调整过的空节点尺寸拉回）。
 */
export function normalizeCanvasGenSettings(options: { placeholder: boolean }): void {
  const store = useCanvasStore.getState();
  const modelState = useModelStore.getState();
  // 模型目录未就绪：保持现状，等 initialize 写入目录后再归一化
  if (modelState.providers.length === 0) return;

  const contexts = new Map<ModelCapability, GenSettingsContext>();
  const patches = new Map<string, NonNullable<ReturnType<typeof normalizeGenSettings>>>();

  for (const node of store.nodes) {
    const kind = genKindOfNode(node);
    if (!kind) continue;
    const genSettings = genSettingsOf(node) as Record<string, unknown> | undefined;
    // 无 genSettings 的节点不凭空创建：归一化只纠偏已有设置
    if (!genSettings) continue;

    let ctx = contexts.get(kind);
    if (!ctx) {
      ctx = contextFor(kind, store.nodes, store.edges);
      contexts.set(kind, ctx);
    }
    const result = normalizeGenSettings(node, genSettings, ctx, { placeholder: options.placeholder });
    if (result) patches.set(node.id, result);
  }

  if (patches.size === 0) return;

  // 批量替换为单次 store 提交；占位框尺寸直接落 style（不在后台归一化里播动画）
  store.setNodes(store.nodes.map((node) => {
    const result = patches.get(node.id);
    if (!result) return node;
    let style = node.style;
    if (result.applyRatio) {
      const size = ratioToNodeSize(result.applyRatio);
      if (size) style = { ...node.style, width: size.width, height: size.height };
    }
    return {
      ...node,
      data: result.genSettings ? { ...node.data, genSettings: result.genSettings } : node.data,
      style,
    } as AnyNode;
  }));
  markDirtyImmediate();
}
