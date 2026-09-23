/**
 * 画布状态序列化：把当前画布压缩成喂给 LLM 的紧凑 JSON。
 * 只保留 agent 决策需要的字段（id/类型/位置/尺寸/内容摘要），
 * 文本内容与提示词截断，节点数超限时给出剩余计数标记。
 */
"use client";

import { getLiveViewport, useCanvasStore } from "@/features/canvas/stores/canvas-store";
import { NODE_TYPE } from "@/lib/constants";

/** 注入 prompt 的节点数上限 */
const MAX_NODES = 30;
/** 内容摘要最大长度 */
const SUMMARY_MAX = 120;
/** 标题摘要最大长度 */
const LABEL_MAX = 60;

function truncate(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max) + "…" : t;
}

export interface SerializedCanvasState {
  viewport: { x: number; y: number; zoom: number };
  nodes: Array<{
    id: string;
    type: string;
    x: number;
    y: number;
    w: number;
    h: number;
    label?: string;
    content?: string;
    prompt?: string;
    hasSrc?: boolean;
    selected?: boolean;
  }>;
  truncated?: string;
  edges: Array<{ source: string; target: string }>;
  selection: string[];
}

/** 序列化当前画布状态（随用户消息发送，续流轮不重发） */
export function serializeCanvasState(): SerializedCanvasState {
  const store = useCanvasStore.getState();
  const vp = getLiveViewport();

  const all = store.nodes;
  const nodes = all.slice(0, MAX_NODES).map((n) => {
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

    if (n.type === NODE_TYPE.TEXT) {
      const plain = typeof data.plainText === "string" ? data.plainText : "";
      if (plain) out.content = truncate(plain, SUMMARY_MAX);
    }
    const gs = data.genSettings as { prompt?: string; kind?: string } | undefined;
    if (gs?.prompt) out.prompt = truncate(gs.prompt, SUMMARY_MAX);
    if (typeof data.src === "string" && data.src) out.hasSrc = true;
    if (n.selected) out.selected = true;
    return out;
  });

  return {
    viewport: { x: Math.round(vp.x), y: Math.round(vp.y), zoom: Math.round(vp.zoom * 100) / 100 },
    nodes,
    ...(all.length > MAX_NODES ? { truncated: `还有 ${all.length - MAX_NODES} 个节点未列出` } : {}),
    edges: store.edges.map((e) => ({ source: e.source, target: e.target })),
    selection: store.nodes.filter((n) => n.selected).map((n) => n.id),
  };
}
