/**
 * 生成面板宿主：图片 / 视频 / 文本三类面板各常驻一个实例，选中目标变化时
 * 只切换 nodeId 与显隐，不重建面板内的 Tiptap 编辑器（以及编辑器持有的
 * 文档、撤销栈与 ProseMirror 插件状态）。
 *
 * 定位仍由 React Flow 的 NodeToolbar 承担（Bottom / center / 12px，与旧挂载一致）：
 * - 面板只在单选目标存在时可见；取消选中、框选、拖动时立即隐藏（display:none），
 *   不做延迟挂载，宿主本身不卸载；
 * - 隐藏期间锚定在最后一个目标节点上，NodeToolbar 只做定位，不产生可见内容；
 * - 目标节点被删除时，宿主在渲染期把该节点从记忆中剔除，槽位随之卸载——目标已
 *   不存在，编辑器状态不再保留；其余仍存在的槽位继续常驻，下一次目标重新挂载。
 *
 * 面板的显隐通过 `active` 传入：隐藏时面板停止上游投影 / 生成态订阅，并卸载
 * 参考区与操作区（Radix 浮层随之关闭、参考卡片停止媒体订阅），只保留编辑器。
 */
"use client";

import { NodeToolbar as RfNodeToolbar, Position } from "@xyflow/react";
import { type ComponentType, memo, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import { useCanvasStore } from "@/features/canvas/stores/canvas-store";
import type { ModelCapability } from "@/lib/types/models";

import ImageGenerationPanel from "./ImageGenerationPanel";
import TextGenerationPanel from "./TextGenerationPanel";
import VideoGenerationPanel from "./VideoGenerationPanel";

/** 面板类型全集（唯一来源）：必须是生成能力，顺序即槽位渲染与锚点回退顺序 */
const PANEL_KINDS = ["image", "video", "text"] as const satisfies readonly ModelCapability[];

type GenerationPanelKind = (typeof PANEL_KINDS)[number];

interface SlotProps {
  /** 该类型最后一次的目标节点；从未使用过则为 null（不挂载） */
  nodeId: string | null;
  active: boolean;
}

const PANELS: Record<GenerationPanelKind, ComponentType<{ nodeId: string; active: boolean }>> = {
  image: ImageGenerationPanel,
  video: VideoGenerationPanel,
  text: TextGenerationPanel,
};

export interface GenerationPanelTarget {
  kind: GenerationPanelKind;
  nodeId: string;
}

/**
 * 可见槽位用 display:contents 不产生额外盒模型，定位与旧挂载一致；
 * 隐藏槽位 display:none，面板实例与编辑器状态保留。
 */
function slotStyle(active: boolean) {
  return active ? ({ display: "contents" } as const) : ({ display: "none" } as const);
}

const Slot = memo(function Slot({ kind, nodeId, active }: SlotProps & { kind: GenerationPanelKind }) {
  if (!nodeId) return null;
  const Panel = PANELS[kind];
  return (
    <div style={slotStyle(active)}>
      <Panel nodeId={nodeId} active={active} />
    </div>
  );
});

interface PanelMemory {
  /** 最后一个目标节点：取消选中后 NodeToolbar 仍以它定位（面板全部隐藏） */
  anchor: string | null;
  /** 各类型最后一次的目标节点：同类型再次选中时复用同一面板实例 */
  ids: Record<GenerationPanelKind, string | null>;
}

function emptyIds(): Record<GenerationPanelKind, string | null> {
  return Object.fromEntries(PANEL_KINDS.map((kind) => [kind, null])) as Record<
    GenerationPanelKind,
    string | null
  >;
}

const EMPTY_MEMORY: PanelMemory = { anchor: null, ids: emptyIds() };

/**
 * 推进记忆：先剔除已删除节点（槽位随之卸载），再采用当前目标。
 * 返回原引用表示没有变化，调用方不触发渲染期 state 写入。
 */
function advanceMemory(
  memory: PanelMemory,
  target: GenerationPanelTarget | null,
  live: ReadonlySet<string>,
): PanelMemory {
  const keep = (id: string | null) => (id !== null && live.has(id) ? id : null);
  const ids = { ...memory.ids };
  let changed = false;
  for (const kind of PANEL_KINDS) {
    const id = keep(ids[kind]);
    if (id === ids[kind]) continue;
    ids[kind] = id;
    changed = true;
  }
  // 锚点被删除后改挂任一仍存在的槽位：隐藏槽位也要有节点可定位，实例才能保留。
  const anchor =
    memory.anchor !== null && live.has(memory.anchor)
      ? memory.anchor
      : (PANEL_KINDS.map((kind) => ids[kind]).find((id) => id !== null) ?? null);
  let next = changed || anchor !== memory.anchor ? { anchor, ids } : memory;
  if (target && (next.anchor !== target.nodeId || next.ids[target.kind] !== target.nodeId)) {
    next = { anchor: target.nodeId, ids: { ...next.ids, [target.kind]: target.nodeId } };
  }
  return next;
}

export default function GenerationPanelHost({ target }: { target: GenerationPanelTarget | null }) {
  const [memory, setMemory] = useState<PanelMemory>(EMPTY_MEMORY);

  const rememberedIds = useMemo(
    () =>
      Array.from(
        new Set(
          [memory.anchor, ...PANEL_KINDS.map((kind) => memory.ids[kind])].filter(
            (id): id is string => id !== null,
          ),
        ),
      ),
    [memory],
  );
  // 只订阅「记住的节点是否还存在」：useShallow 按元素比较存活 id 列表，
  // 节点位置/数据变化不触发宿主重渲染。
  const liveIds = useCanvasStore(
    useShallow((s) => rememberedIds.filter((id) => s.nodes.some((n) => n.id === id))),
  );
  // 目标可能先于父级重渲染一步失效（store 已删节点、target prop 仍是旧值）：
  // 目标也已删除时按「无目标」处理，否则会在剔除后立刻写回已删除的节点。
  const targetAlive = useCanvasStore((s) =>
    target ? s.nodes.some((n) => n.id === target.nodeId) : false,
  );
  const activeTarget = targetAlive ? target : null;
  const live = new Set(liveIds);

  // 目标变化 / 节点删除时在渲染期调整记忆（React 官方的「渲染期调整 state」模式）：
  // 本次渲染直接采用调整后的记忆，状态写入只影响后续渲染。取消选中 / 切换类型后，
  // 各槽位仍持有自己的最后目标，面板不卸载、编辑器不重建。
  const nextMemory = advanceMemory(memory, activeTarget, live);
  if (nextMemory !== memory) setMemory(nextMemory);

  const { anchor, ids } = nextMemory;
  if (!anchor) return null;

  return (
    <RfNodeToolbar nodeId={anchor} isVisible position={Position.Bottom} align="center" offset={12}>
      {PANEL_KINDS.map((kind) => (
        <Slot key={kind} kind={kind} nodeId={ids[kind]} active={activeTarget?.kind === kind} />
      ))}
    </RfNodeToolbar>
  );
}
