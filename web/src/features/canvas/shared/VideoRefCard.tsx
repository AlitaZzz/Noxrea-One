/**
 * 参考区「视频」缩略卡片（视频 / 文本生成面板共用）。
 *
 * 以首帧作为缩略图、悬停浮层自动播放预览，支持视频之间的拖拽排序（仅同类）与 ✕ 断开连线。
 */
"use client";

import { memo, useState } from "react";
import { useTranslation } from "react-i18next";

import { Card } from "@/components/ui/card";
import { useCanvasStore } from "@/features/canvas/stores/canvas-store";
import { NODE_TYPE } from "@/lib/constants";

import { ReferenceHoverPreview, ReferenceIndexBadge, ReferenceRemoveButton } from "./ReferenceCardChrome";
import { findReferenceNode, useRevealCanvasNode } from "./reveal-node";

export interface VideoRefCardProps {
  /** 参考视频地址 */
  src: string;
  /** 生成面板所属节点 id（用于定位来源节点与断开连线） */
  nodeId: string;
  /** 在同类型参考中的序号（0-based），用于角标与 @ 引用编号 */
  index: number;
  /** 拖放排序回调（dragged / target 均为视频 src） */
  onReorder: (dragged: string, target: string) => void;
  /** 上报自身拖拽状态（父级聚合后经 dragActive 回传，用于抑制其它卡片预览） */
  onDragStateChange?: (dragging: boolean) => void;
  /** 参考区内是否正有任意参考被拖拽：为 true 时不显示悬浮预览 */
  dragActive?: boolean;
}

function VideoRefCard({
  src,
  nodeId,
  index,
  onReorder,
  onDragStateChange,
  dragActive,
}: VideoRefCardProps) {
  const { t } = useTranslation();
  const reveal = useRevealCanvasNode();
  const [dragOver, setDragOver] = useState(false);
  const [dragging, setDragging] = useState(false);

  return (
    <ReferenceHoverPreview
      disabled={dragging || Boolean(dragActive) || dragOver}
      src={src}
      mediaType="video"
    >
      <Card
        className={`group relative flex h-14 w-14 flex-row cursor-grab rounded-md border-border bg-accent p-0 shadow-none transition-shadow active:cursor-grabbing ${dragOver ? "ring-2 ring-white shadow-lg" : ""}`}
        draggable
        onDoubleClick={() => {
          const n = findReferenceNode(nodeId, NODE_TYPE.VIDEO, src);
          if (n) reveal(n);
        }}
        onDragStart={(e) => {
          e.dataTransfer.setData("application/x-ref-video", src);
          e.dataTransfer.setData("text/plain", src);
          e.dataTransfer.effectAllowed = "move";
          setDragging(true);
          onDragStateChange?.(true);
          const el = (e.currentTarget as HTMLElement).querySelector("video");
          if (el) e.dataTransfer.setDragImage(el, 28, 28);
        }}
        onDragEnd={() => {
          setDragging(false);
          onDragStateChange?.(false);
        }}
        onDragEnter={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
        onDragOver={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (!e.dataTransfer.types.includes("application/x-ref-video")) {
            e.dataTransfer.dropEffect = "none";
            return;
          }
          e.dataTransfer.dropEffect = "move";
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setDragOver(false);
          const dragged = e.dataTransfer.getData("text/plain");
          if (!dragged || dragged === src) return;
          onReorder(dragged, src);
        }}
      >
        <video src={`${src}#t=0.1`} className="pointer-events-none size-full rounded-md object-cover" muted preload="metadata" playsInline draggable={false} />
        <ReferenceIndexBadge>{t("common.refVideoLabel", { index: index + 1 })}</ReferenceIndexBadge>
        <ReferenceRemoveButton
          ariaLabel={t("common.delete")}
          onRemove={() => {
            const store = useCanvasStore.getState();
            const edge = store.edges.find((e) => {
              if (e.target !== nodeId) return false;
              const srcNode = store.nodes.find((n) => n.id === e.source);
              return srcNode && srcNode.type === NODE_TYPE.VIDEO && (srcNode.data as { src?: string }).src === src;
            });
            if (edge) store.removeEdges([edge.id]);
          }}
        />
      </Card>
    </ReferenceHoverPreview>
  );
}

export default memo(VideoRefCard);
