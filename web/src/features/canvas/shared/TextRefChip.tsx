/**
 * 参考区「文本」缩略卡片（图片 / 视频 / 文本生成面板共用）。
 *
 * 文本参考不参与拖拽排序（不可拖动），按连线顺序展示：
 * 悬停用 Tooltip 显示全文，双击定位到源节点，✕ 断开连线。
 */
"use client";

import { memo } from "react";
import { useTranslation } from "react-i18next";

import { CloseOutlined, TextIcon } from "@/components/ui/AppIcon";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useCanvasStore } from "@/features/canvas/stores/canvas-store";

import { useRevealCanvasNode } from "./reveal-node";

export interface TextRefChipProps {
  /** 上游文本节点 id */
  id: string;
  /** 文本节点内容（悬停显示全文） */
  content: string;
  /** 生成面板所属节点 id（用于 ✕ 断开对应连线） */
  nodeId: string;
}

function TextRefChip({ id, content, nodeId }: TextRefChipProps) {
  const { t } = useTranslation();
  const reveal = useRevealCanvasNode();

  return (
    <Tooltip><TooltipTrigger asChild>
        <Card
          className="group relative flex size-14 flex-row items-center justify-center rounded-md border-border bg-accent p-0 shadow-none"
          onDoubleClick={() => {
            const n = useCanvasStore.getState().nodes.find((x) => x.id === id);
            if (n) reveal(n);
          }}
        >
          <TextIcon className="pointer-events-none" style={{ color: "var(--foreground)", width: 14, height: 15 }} />
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            aria-label={t("common.delete")}
            className="absolute -top-1.5 -right-1.5 rounded-full bg-black/50 p-0 text-white/70 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:bg-black/70 hover:text-white"
            onClick={() => {
              const store = useCanvasStore.getState();
              const edge = store.edges.find((e) => e.target === nodeId && e.source === id);
              if (edge) store.removeEdges([edge.id]);
            }}
          >
            <CloseOutlined className="size-3" />
          </Button>
        </Card>
      </TooltipTrigger><TooltipContent>{<div style={{ maxWidth: 280, maxHeight: 240, overflowY: "auto", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
          {content}
        </div>}</TooltipContent></Tooltip>
  );
}

export default memo(TextRefChip);
