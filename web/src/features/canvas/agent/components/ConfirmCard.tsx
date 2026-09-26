/**
 * 提议-确认卡片：结构化展示待确认操作（真实标题 / 类型 / 图片缩略图），
 * 删除类操作支持逐条勾选要执行的目标；批准/取消经 onResolve 上报 ConfirmDecision。
 * arrange_canvas 无目标清单，仅展示说明文字。
 */
"use client";

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import type { ConfirmDecision, PendingConfirmation } from "@/features/canvas/agent/types";
import { useCanvasStore } from "@/features/canvas/stores/canvas-store";
import { NODE_TYPE } from "@/lib/constants";

/** 节点类型 → i18n key（类型名与画布元素面板共用 node.* 文案） */
const NODE_TYPE_KEYS: Record<string, string> = {
  [NODE_TYPE.TEXT]: "node.text",
  [NODE_TYPE.IMAGE]: "node.image",
  [NODE_TYPE.VIDEO]: "node.video",
  [NODE_TYPE.AUDIO]: "node.audio",
  [NODE_TYPE.DIRECTOR]: "node.director",
  [NODE_TYPE.GROUP]: "node.group",
};

interface ParsedCall {
  id: string;
  name: string;
  nodeIds: string[];
  edges: Array<{ source: string; target: string }>;
}

function parseCalls(pending: PendingConfirmation): ParsedCall[] {
  return pending.calls.map((t) => {
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(t.args || "{}") as Record<string, unknown>;
    } catch { /* 参数不合法按空处理 */ }
    return {
      id: t.id,
      name: t.name,
      nodeIds: Array.isArray(args.nodeIds) ? args.nodeIds.filter((x): x is string => typeof x === "string") : [],
      edges: Array.isArray(args.edges)
        ? args.edges
          .map((e) => e as Record<string, unknown>)
          .filter((e) => typeof e.source === "string" && typeof e.target === "string")
          .map((e) => ({ source: e.source as string, target: e.target as string }))
        : [],
    };
  });
}

interface Props {
  pending: PendingConfirmation;
  onResolve: (decision: ConfirmDecision) => void;
}

export function ConfirmCard({ pending, onResolve }: Props) {
  const { t } = useTranslation();
  const nodes = useCanvasStore((s) => s.nodes);
  const calls = useMemo(() => parseCalls(pending), [pending]);
  // callId → 勾选保留项（nodeId 或原 edges 下标）；初始全选
  const [checked, setChecked] = useState<Record<string, Set<string | number>>>(() => {
    const init: Record<string, Set<string | number>> = {};
    for (const c of calls) {
      if (c.nodeIds.length > 0) init[c.id] = new Set(c.nodeIds);
      else if (c.edges.length > 0) init[c.id] = new Set(c.edges.map((_, i) => i));
    }
    return init;
  });

  const nodesById = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const nodeLabel = (id: string) => {
    const n = nodesById.get(id);
    const label = n?.data?.label;
    return typeof label === "string" && label ? label : id.slice(0, 6);
  };
  const nodeThumb = (id: string): string | null => {
    const n = nodesById.get(id);
    if (n?.type !== NODE_TYPE.IMAGE) return null;
    const src = (n.data as { src?: unknown }).src;
    return typeof src === "string" && src ? src : null;
  };

  const toggle = (callId: string, key: string | number) => {
    setChecked((prev) => {
      const set = new Set(prev[callId]);
      if (set.has(key)) set.delete(key);
      else set.add(key);
      return { ...prev, [callId]: set };
    });
  };

  const buildDecision = (approved: boolean): ConfirmDecision => {
    if (!approved) return { approved: false };
    const selections: ConfirmDecision["selections"] = {};
    for (const c of calls) {
      const set = checked[c.id];
      if (!set) continue;
      if (c.nodeIds.length > 0) selections[c.id] = { nodeIds: c.nodeIds.filter((id) => set.has(id)) };
      else if (c.edges.length > 0) selections[c.id] = { edgeIndexes: c.edges.map((_, i) => i).filter((i) => set.has(i)) };
    }
    return { approved: true, selections };
  };

  return (
    <div className="chat-confirm">
      <div className="chat-confirm-title">{t("agent.confirmTitle")}</div>
      {calls.map((c) => {
        if (c.name === "arrange_canvas") {
          return (
            <div key={c.id} className="chat-confirm-item">
              <span className="chat-confirm-detail">{t("agent.arrangeCanvasDetail")}</span>
            </div>
          );
        }
        if (c.nodeIds.length > 0) {
          return (
            <div key={c.id} className="chat-confirm-group">
              <div className="chat-confirm-subtitle">{t("agent.confirmDeleteNodes", { count: c.nodeIds.length })}</div>
              <div className="chat-confirm-list">
                {c.nodeIds.map((id) => {
                  const n = nodesById.get(id);
                  const thumb = nodeThumb(id);
                  return (
                    <label key={id} className="chat-confirm-item chat-confirm-item-check">
                      <input
                        type="checkbox"
                        checked={checked[c.id]?.has(id) ?? true}
                        onChange={() => toggle(c.id, id)}
                      />
                      {thumb && <img className="chat-confirm-thumb" src={thumb} alt="" />}
                      <span className="chat-confirm-item-label">{nodeLabel(id)}</span>
                      <span className="chat-confirm-item-type">{n?.type && NODE_TYPE_KEYS[n.type] ? t(NODE_TYPE_KEYS[n.type]) : t("agent.nodeTypeFallback")}</span>
                    </label>
                  );
                })}
              </div>
            </div>
          );
        }
        if (c.edges.length > 0) {
          return (
            <div key={c.id} className="chat-confirm-group">
              <div className="chat-confirm-subtitle">{t("agent.confirmDeleteEdges", { count: c.edges.length })}</div>
              <div className="chat-confirm-list">
                {c.edges.map((e, i) => (
                  <label key={`${e.source}-${e.target}-${i}`} className="chat-confirm-item chat-confirm-item-check">
                    <input
                      type="checkbox"
                      checked={checked[c.id]?.has(i) ?? true}
                      onChange={() => toggle(c.id, i)}
                    />
                    <span className="chat-confirm-item-label">{nodeLabel(e.source)} → {nodeLabel(e.target)}</span>
                  </label>
                ))}
              </div>
            </div>
          );
        }
        return (
          <div key={c.id} className="chat-confirm-item">
            <span className="chat-confirm-detail">{t("agent.confirmGeneric")}</span>
          </div>
        );
      })}
      <div className="chat-confirm-actions">
        <button type="button" className="chat-confirm-btn chat-confirm-approve" onClick={() => onResolve(buildDecision(true))}>
          {t("agent.confirmExecute")}
        </button>
        <button type="button" className="chat-confirm-btn chat-confirm-deny" onClick={() => onResolve({ approved: false })}>
          {t("common.cancel")}
        </button>
      </div>
    </div>
  );
}

export default ConfirmCard;
