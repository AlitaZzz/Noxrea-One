/**
 * 参考区排序的工具集（图 / 音 / 视频 / 文本面板共享）。
 *
 * 架构约定（单一数据源 + 派生合并）：
 * - 参考「存在性」完全派生自连线（edges + 上游节点），不落任何面板本地状态；
 * - genSettings 中的 refOrder / refAudioOrder / refVideoOrder 仅作为「排序偏好」持久化，
 *   写者是拖拽排序事件（writeOrderPref）与手动连线事件（bumpRefOrderToTail），
 *   断开连线不触碰偏好；
 * - 「重连 = 重新入列」：用户手动（重新）连线时对应参考一律置尾（bumpRefOrderToTail），
 *   断开再连排到最后；
 * - 撤销/重做整体恢复快照（含排序偏好），精确回到操作前状态——被断开的参考
 *   通过 undo 恢复时回到原来的位置，不做任何额外调整；
 * - 渲染顺序 = mergeOrder(偏好, 实时列表) 的纯 useMemo，任意时刻首帧即正确，
 *   彻底取代旧的「本地 state + render-phase 同步 + 300ms 防抖补救」模式。
 */
"use client";

import { markDirtyImmediate, useCanvasStore } from "@/features/canvas/stores/canvas-store";
import type { AnyNode, MediaGenFields, VideoGenSettings } from "@/features/canvas/types";
import { NODE_TYPE } from "@/lib/constants";

/** 空序哨兵：模块级常量保证 selector 返回引用稳定，避免误重渲染 */
export const EMPTY_ORDER: readonly string[] = [];

type OrderField = "refOrder" | "refAudioOrder" | "refVideoOrder";

/** 参考类上游节点类型 → genSettings 排序字段 */
const REF_FIELD_BY_TYPE: Record<string, OrderField> = {
  [NODE_TYPE.IMAGE]: "refOrder",
  [NODE_TYPE.AUDIO]: "refAudioOrder",
  [NODE_TYPE.VIDEO]: "refVideoOrder",
};

/** 生成面板节点类型 → genSettings.kind（genSettings 不存在时创建初始结构用） */
const KIND_BY_TYPE: Record<string, string> = {
  [NODE_TYPE.IMAGE]: "image",
  [NODE_TYPE.VIDEO]: "video",
  [NODE_TYPE.TEXT]: "text",
};

/**
 * 合并排序偏好与实时参考列表（纯函数）：
 * 1. 偏好序中仍存活的项按用户排序在前；
 * 2. 实时列表中未被偏好覆盖的新增项按连线顺序追加在后；
 * 3. 偏好中的失效引用（已断开连线 / 节点已删除）被自动过滤。
 */
export function mergeOrder(pref: readonly string[], live: readonly string[]): string[] {
  const liveSet = new Set(live);
  const prefSet = new Set(pref);
  const alive = pref.filter((u) => liveSet.has(u));
  const added = live.filter((u) => !prefSet.has(u));
  return [...alive, ...added];
}

/**
 * 写入参考排序偏好（事件驱动持久化：拖拽排序等离散操作时调用）。
 * 直接写节点 genSettings；排序不污染 undo 栈（skipHistory），保存由 saveManager 合并落盘。
 */
export function writeOrderPref(
  nodeId: string,
  patch: Partial<Pick<VideoGenSettings, OrderField>>,
): void {
  const store = useCanvasStore.getState();
  const node = store.nodes.find((n) => n.id === nodeId);
  const cur = ((node?.data as MediaGenFields | undefined)?.genSettings ?? {}) as Record<string, unknown>;
  store.updateNodeData(nodeId, { genSettings: { ...cur, ...patch } }, undefined, { skipHistory: true });
  markDirtyImmediate();
}

/** 响应式读取节点 genSettings（引用稳定：仅在 genSettings 整体被替换时变化） */
export function useGenSettings(nodeId: string) {
  return useCanvasStore((s) => {
    const node = s.nodes.find((n) => n.id === nodeId);
    return (node?.data as MediaGenFields | undefined)?.genSettings;
  });
}

/** 从当前 nodes/edges 派生某节点的三类实时参考 src 列表（与面板派生逻辑一致，含 src 去重） */
function collectLiveRefs(nodes: AnyNode[], edges: { source: string; target: string }[], targetId: string): Record<OrderField, string[]> {
  const live: Record<OrderField, string[]> = { refOrder: [], refAudioOrder: [], refVideoOrder: [] };
  const upstreamIds = new Set(edges.filter((e) => e.target === targetId).map((e) => e.source));
  for (const n of nodes) {
    if (!upstreamIds.has(n.id)) continue;
    const field = REF_FIELD_BY_TYPE[n.type ?? ""];
    const src = (n.data as { src?: string } | undefined)?.src;
    if (field && src && !live[field].includes(src)) live[field].push(src);
  }
  return live;
}

/**
 * 「重连 = 重新入列」：用户手动（重新）连线后由 handleConnect 调用，
 * 把对应 src 一律移到排序偏好末尾。
 *
 * - 语义覆盖手动重建路径：画布拖线重连、✕ 删除后重连、拖断后重连——断开再连排到最后；
 * - 撤销/重做不经过本函数：快照整体恢复（含排序偏好），参考回到操作前的精确位置；
 * - 写入值 = mergeOrder(当前偏好, 当前实时列表) 后将本次新增 src 依次置尾，
 *   因此既有参考的相对顺序不受影响，新（重连）参考稳定排到最后；
 * - src 不在偏好中（首次连线）时同样固化到末尾，保证与 added 追加语义一致；
 * - skipHistory 写入，不污染 undo 栈；顺带清洗偏好中已失效的旧引用。
 */
export function bumpRefOrderToTail(newEdges: ReadonlyArray<{ source: string; target: string }>): void {
  const store = useCanvasStore.getState();

  // 按目标节点收集本次（重新）建立的参考 src（按类型分桶、按事件顺序）
  const byTarget = new Map<string, Record<OrderField, string[]>>();
  for (const e of newEdges) {
    const srcNode = store.nodes.find((n) => n.id === e.source);
    const field = srcNode ? REF_FIELD_BY_TYPE[srcNode.type ?? ""] : undefined;
    const src = srcNode ? (srcNode.data as { src?: string } | undefined)?.src : undefined;
    if (!field || !src) continue;
    const bucket = byTarget.get(e.target) ?? { refOrder: [], refAudioOrder: [], refVideoOrder: [] };
    if (!bucket[field].includes(src)) bucket[field].push(src);
    byTarget.set(e.target, bucket);
  }
  if (byTarget.size === 0) return;

  let dirty = false;
  for (const [targetId, added] of byTarget) {
    const targetNode = store.nodes.find((n) => n.id === targetId);
    const kind = targetNode ? KIND_BY_TYPE[targetNode.type ?? ""] : undefined;
    if (!targetNode || !kind) continue; // 非生成面板节点（agent/group 等）无参考概念

    const cur = (((targetNode.data as MediaGenFields | undefined)?.genSettings ?? { kind }) as Record<string, unknown>);
    const live = collectLiveRefs(store.nodes, store.edges, targetId);
    const patch: Partial<Record<OrderField, string[]>> = {};
    for (const field of ["refOrder", "refAudioOrder", "refVideoOrder"] as const) {
      const addedSrcs = added[field];
      if (addedSrcs.length === 0) continue;
      const pref = (cur[field] as string[] | undefined) ?? [];
      const ordered = mergeOrder(pref, live[field]);
      // 本次新增 src 依次置尾（保持事件顺序），已在末尾则幂等无变化
      for (const src of addedSrcs) {
        const idx = ordered.indexOf(src);
        if (idx !== -1) ordered.splice(idx, 1);
        ordered.push(src);
      }
      patch[field] = ordered;
    }
    if (Object.keys(patch).length === 0) continue;
    store.updateNodeData(targetId, { genSettings: { ...cur, ...patch } }, undefined, { skipHistory: true });
    dirty = true;
  }
  if (dirty) markDirtyImmediate();
}

