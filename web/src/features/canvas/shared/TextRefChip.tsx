/**
 * 参考区「文本」缩略卡片（图片 / 视频 / 文本生成面板共用）。
 *
 * 文本参考不参与拖拽排序（不可拖动），按连线顺序展示：
 * 悬停用 Tooltip 显示全文，双击定位到源节点，✕ 断开连线。
 */
"use client";

import { Button, Tooltip } from "antd";
import { memo } from "react";

import { TextIcon } from "@/components/ui/icons/media/TextIcon";
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
  const reveal = useRevealCanvasNode();

  return (
    <Tooltip
      title={
        <div style={{ maxWidth: 280, maxHeight: 240, overflowY: "auto", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
          {content}
        </div>
      }
    >
      <div
        className="relative group h-14 w-14 rounded flex items-center justify-center"
        style={{ background: "var(--canvas-bg-hover)", border: "1px solid var(--canvas-border)" }}
        onDoubleClick={() => {
          const n = useCanvasStore.getState().nodes.find((x) => x.id === id);
          if (n) reveal(n);
        }}
      >
        <TextIcon className="pointer-events-none" style={{ color: "var(--canvas-text)", width: 14, height: 15 }} />
        <Button type="text" size="small"
          className="!absolute -top-1.5 -right-1.5 !w-4 !h-4 !flex items-center justify-center !rounded-full !bg-black/70 !text-white/60 hover:!text-white hover:!bg-white/30 !text-[10px] opacity-0 group-hover:opacity-100 transition-opacity !p-0 !border-0"
          onClick={() => {
            const store = useCanvasStore.getState();
            const edge = store.edges.find((e) => e.target === nodeId && e.source === id);
            if (edge) store.removeEdges([edge.id]);
          }}>✕</Button>
      </div>
    </Tooltip>
  );
}

export default memo(TextRefChip);
