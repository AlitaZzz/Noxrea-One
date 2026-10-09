/**
 * 参考区「文本」缩略卡片（图片 / 视频 / 文本生成面板共用）。
 *
 * 文本参考不参与拖拽排序（不可拖动），按连线顺序展示：
 * 悬停用 Hover Card 阅读全文，双击定位到源节点，✕ 断开连线。
 */
"use client";

import { memo } from "react";
import { useTranslation } from "react-i18next";

import { TextIcon } from "@/components/ui/AppIcon";
import { Card } from "@/components/ui/card";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { useCanvasStore } from "@/features/canvas/stores/canvas-store";

import { ReferenceIndexBadge, ReferenceRemoveButton } from "./ReferenceCardChrome";
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
    <Card className="group relative flex size-14 shrink-0 flex-row items-center justify-center gap-0 rounded-md border-border bg-accent p-0 shadow-none">
      <HoverCard>
        <HoverCardTrigger asChild>
          <div
            role="img"
            tabIndex={0}
            aria-label={t("node.text")}
            className="flex size-full items-center justify-center rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onDoubleClick={() => {
              const n = useCanvasStore.getState().nodes.find((x) => x.id === id);
              if (n) reveal(n);
            }}
          >
            <TextIcon className="size-4" />
          </div>
        </HoverCardTrigger>
        <HoverCardContent
          side="top"
          align="start"
          collisionPadding={16}
          className="nodrag nopan nowheel scrollbar-ui w-96 max-w-[calc(100vw-2rem)] max-h-[min(20rem,var(--radix-hover-card-content-available-height))] overflow-y-auto overscroll-contain whitespace-pre-wrap break-words text-sm"
        >
          {content}
        </HoverCardContent>
      </HoverCard>
      <ReferenceIndexBadge>{t("node.text")}</ReferenceIndexBadge>
      <ReferenceRemoveButton
        ariaLabel={t("common.delete")}
        onRemove={() => {
          const store = useCanvasStore.getState();
          const edge = store.edges.find((e) => e.target === nodeId && e.source === id);
          if (edge) store.removeEdges([edge.id]);
        }}
      />
    </Card>
  );
}

export default memo(TextRefChip);
