/**
 * 画布状态序列化：把当前画布压缩成喂给 LLM 的名册式紧凑 JSON。
 * 只含节点的结构性信息（id/类型/位置/尺寸/标题/选中态），不含 content/prompt——
 * 节点完整内容一律由模型按需调用 get_node_detail 读取，快照成本与内容长度无关。
 * 选中节点排最前：服务端对超长快照做结构性截断时优先保留。
 */
"use client";

import { getLiveViewport, useCanvasStore } from "@/features/canvas/stores/canvas-store";

/** 标题兜底截断（标题一般很短，仅防异常超长） */
const LABEL_MAX = 80;

function truncate(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max) + "…" : t;
}

export interface SerializedCanvasState {
  viewport: { x: number; y: number; zoom: number };
  selection: string[];
  nodes: Array<{
    id: string;
    type: string;
    x: number;
    y: number;
    w: number;
    h: number;
    label?: string;
    hasSrc?: boolean;
    selected?: boolean;
  }>;
  edges: Array<{ source: string; target: string }>;
}

/** 序列化当前画布名册（随用户消息与工具续轮发送） */
export function serializeCanvasState(): SerializedCanvasState {
  const store = useCanvasStore.getState();
  const vp = getLiveViewport();

  // 选中节点排最前：结构性截断时选中节点详情永不丢失，其余保持原顺序
  const ordered = [...store.nodes].sort((a, b) => Number(b.selected ?? false) - Number(a.selected ?? false));
  const nodes = ordered.map((n) => {
    const data = n.data as Record<string, unknown>;
    const out: SerializedCanvasState["nodes"][number] = {
      id: n.id,
      type: n.type ?? "unknown",
      x: Math.round(n.position.x),
      y: Math.round(n.position.y),
      w: Math.round((n.style?.width as number) ?? 200),
      h: Math.round((n.style?.height as number) ?? 120),
    };
    const label = typeof data.label === "string" ? data.label : "";
    if (label) out.label = truncate(label, LABEL_MAX);
    if (typeof data.src === "string" && data.src) out.hasSrc = true;
    if (n.selected) out.selected = true;
    return out;
  });

  return {
    viewport: { x: Math.round(vp.x), y: Math.round(vp.y), zoom: Math.round(vp.zoom * 100) / 100 },
    selection: store.nodes.filter((n) => n.selected).map((n) => n.id),
    nodes,
    edges: store.edges.map((e) => ({ source: e.source, target: e.target })),
  };
}
