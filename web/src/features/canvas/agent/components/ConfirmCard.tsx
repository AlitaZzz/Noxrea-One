/**
 * 提议-确认卡片：结构化展示待确认操作（真实标题 / 类型 / 图片缩略图），
 * 删除类操作支持逐条勾选要执行的目标；批准/取消经 onResolve 上报 ConfirmDecision。
 * arrange_canvas 无目标清单，仅展示说明文字。
 */
"use client";

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
    <div className="mb-3 max-w-[88%] rounded-xl border border-destructive/50 bg-destructive/10 px-3 py-2.5">
      <div className="mb-2 text-sm font-semibold text-destructive">{t("agent.confirmTitle")}</div>
      {calls.map((c) => {
        if (c.name === "arrange_canvas") {
          return (
            <div key={c.id} className="mb-1.5 flex flex-col gap-0.5 text-xs text-muted-foreground">
              <span>{t("agent.arrangeCanvasDetail")}</span>
            </div>
          );
        }
        if (c.nodeIds.length > 0) {
          return (
            <div key={c.id} className="mb-2">
              <div className="mb-1.5 text-xs font-medium text-foreground">{t("agent.confirmDeleteNodes", { count: c.nodeIds.length })}</div>
              <div className="flex max-h-[180px] flex-col gap-0.5 overflow-y-auto">
                {c.nodeIds.map((id) => {
                  const n = nodesById.get(id);
                  const thumb = nodeThumb(id);
                  return (
                    <div
                      key={id}
                      className="flex min-w-0 flex-row items-center gap-1.5 rounded-md px-1 py-0.5 text-xs text-muted-foreground"
                    >
                      <Checkbox
                        checked={checked[c.id]?.has(id) ?? true}
                        onCheckedChange={() => toggle(c.id, id)}
                        aria-label={nodeLabel(id)}
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-auto min-w-0 flex-1 justify-start gap-1.5 rounded-md px-1 py-1 text-left text-xs font-normal hover:bg-destructive/10"
                        onClick={() => toggle(c.id, id)}
                      >
                        {thumb && <img className="size-7 shrink-0 rounded-md border border-border object-cover" src={thumb} alt="" />}
                        <span className="min-w-0 truncate font-medium text-foreground">{nodeLabel(id)}</span>
                        <span className="shrink-0 text-[11px] text-muted-foreground">{n?.type && NODE_TYPE_KEYS[n.type] ? t(NODE_TYPE_KEYS[n.type]) : t("agent.nodeTypeFallback")}</span>
                      </Button>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        }
        if (c.edges.length > 0) {
          return (
            <div key={c.id} className="mb-2">
              <div className="mb-1.5 text-xs font-medium text-foreground">{t("agent.confirmDeleteEdges", { count: c.edges.length })}</div>
              <div className="flex max-h-[180px] flex-col gap-0.5 overflow-y-auto">
                {c.edges.map((e, i) => (
                  <div
                    key={`${e.source}-${e.target}-${i}`}
                    className="flex min-w-0 flex-row items-center gap-1.5 rounded-md px-1 py-0.5 text-xs text-muted-foreground"
                  >
                    <Checkbox
                      checked={checked[c.id]?.has(i) ?? true}
                      onCheckedChange={() => toggle(c.id, i)}
                      aria-label={`${nodeLabel(e.source)} → ${nodeLabel(e.target)}`}
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-auto min-w-0 flex-1 justify-start rounded-md px-1 py-1 text-left text-xs font-normal hover:bg-destructive/10"
                      onClick={() => toggle(c.id, i)}
                    >
                      <span className="min-w-0 truncate font-medium text-foreground">{nodeLabel(e.source)} → {nodeLabel(e.target)}</span>
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          );
        }
        return (
          <div key={c.id} className="mb-1.5 flex flex-col gap-0.5 text-xs text-muted-foreground">
            <span>{t("agent.confirmGeneric")}</span>
          </div>
        );
      })}
      <div className="flex gap-2 mt-2.5">
        <Button type="button" variant="outline" size="sm" className="flex-1" onClick={() => onResolve({ approved: false })}>
          {t("common.cancel")}
        </Button>
        <Button type="button" variant="destructive" size="sm" className="flex-1" onClick={() => onResolve(buildDecision(true))}>
          {t("agent.confirmExecute")}
        </Button>
      </div>
    </div>
  );
}

export default ConfirmCard;
