/**
 * 画布级生成设置归一化调度。
 *
 * 选中只是查看，不能在面板挂载时写回节点数据；纠偏统一由本 hook 在数据源变化时触发：
 * - 模型目录（供应商 / 模型 / 参数缓存）变化：全画布归一化，含空节点占位比例；
 * - 连线连通关系变化：只归一化设置值（refMode 可用范围随上游参考变化），不重排占位框。
 *
 * 归一化幂等：无变化的节点不会被写回，也不会标脏项目。
 */

"use client";

import { useEffect } from "react";

import { useModelStore } from "@/lib/model-store";

import { normalizeCanvasGenSettings } from "../shared/gen-settings";
import { useCanvasStore } from "../stores/canvas-store";

/**
 * 连线连通关系签名：源 → 目标按数组顺序拼接。
 * 选中态等非连通改动同样会换新 edges 数组，不能作为全画布归一化的触发条件。
 * 签名按数组引用缓存：输入、节点选中等其他 store 变更不重复拼接。
 */
const topologyKeys = new WeakMap<readonly { source: string; target: string }[], string>();

function edgeTopologyKey(edges: ReadonlyArray<{ source: string; target: string }>): string {
  let key = topologyKeys.get(edges);
  if (key === undefined) {
    key = edges.map((e) => `${e.source}\u0000${e.target}`).join("\n");
    topologyKeys.set(edges, key);
  }
  return key;
}

export function useGenSettingsNormalization(): void {
  const providers = useModelStore((s) => s.providers);
  const modelParamsCache = useModelStore((s) => s.modelParamsCache);
  const edgeTopology = useCanvasStore((s) => edgeTopologyKey(s.edges));

  useEffect(() => {
    normalizeCanvasGenSettings({ placeholder: true });
  }, [providers, modelParamsCache]);

  useEffect(() => {
    normalizeCanvasGenSettings({ placeholder: false });
  }, [edgeTopology]);
}
