/**
 * 参考区「图片」缩略卡片（图片 / 视频 / 文本生成面板共用）。
 *
 * 展示缩略图与角标编号（图片N），悬停浮层放大预览，
 * 支持图片之间的拖拽排序（仅同类）与 ✕ 断开连线。
 */
"use client";

import { memo, useState } from "react";
import { useTranslation } from "react-i18next";

import { Card } from "@/components/ui/card";
import { useCanvasStore } from "@/features/canvas/stores/canvas-store";
import { NODE_TYPE } from "@/lib/constants";

import { ReferenceHoverPreview, ReferenceIndexBadge, ReferenceRemoveButton } from "./ReferenceCardChrome";
import { findReferenceNode, useRevealCanvasNode } from "./reveal-node";

export interface ImageRefCardProps {
  /** 参考图地址 */
  src: string;
  /** 生成面板所属节点 id（用于定位来源节点与断开连线） */
  nodeId: string;
  /** 在同类型参考中的序号（0-based），用于角标与 @ 引用编号 */
  index: number;
  /** 拖放排序回调（dragged / target 均为图片 src） */
  onReorder: (dragged: string, target: string) => void;
  /** 上报自身拖拽状态（父级聚合后经 dragActive 回传，用于抑制其它卡片预览） */
  onDragStateChange?: (dragging: boolean) => void;
  /** 参考区内是否正有任意参考被拖拽：为 true 时不显示放大预览 */
  dragActive?: boolean;
}

function ImageRefCard({
  src,
  nodeId,
  index,
  onReorder,
  onDragStateChange,
  dragActive,
}: ImageRefCardProps) {
  const { t } = useTranslation();
  const reveal = useRevealCanvasNode();
  const [dragOver, setDragOver] = useState(false);
  const [dragging, setDragging] = useState(false);

  /** 存储服务上的图走缩略参数，外链原样使用（缩略按 56px 卡的 2 倍取 112） */
  const thumbnail = src.includes("/api/files/") ? `${src}?w=112` : src;
  /** 预览按显示上限 240 的 2 倍屏取图 */
  const preview = src.includes("/api/files/") ? `${src}?w=480` : src;

  return (
    <ReferenceHoverPreview
      disabled={dragging || Boolean(dragActive) || dragOver}
      src={preview}
      mediaType="image"
    >
      <Card
        className={`group relative h-14 w-14 rounded-md border-border bg-accent p-0 shadow-none ${dragOver ? "ring-2 ring-white shadow-lg" : ""}`}
        draggable
        onDoubleClick={() => {
          const n = findReferenceNode(nodeId, NODE_TYPE.IMAGE, src);
          if (n) reveal(n);
        }}
        onDragStart={(e) => {
          e.dataTransfer.setData("application/x-ref-image", src);
          e.dataTransfer.setData("text/plain", src);
          e.dataTransfer.effectAllowed = "move";
          setDragging(true);
          onDragStateChange?.(true);
          const el = (e.currentTarget as HTMLElement).querySelector("img");
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
          if (!e.dataTransfer.types.includes("application/x-ref-image")) {
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
        <img
          src={thumbnail}
          draggable={false}
          alt={`Ref ${index + 1}`}
          className="block size-full cursor-grab rounded-md object-cover transition-shadow active:cursor-grabbing"
        />
        <ReferenceIndexBadge>{t("common.refImageLabel", { index: index + 1 })}</ReferenceIndexBadge>
        <ReferenceRemoveButton
          ariaLabel={t("common.delete")}
          onRemove={() => {
            const store = useCanvasStore.getState();
            const edge = store.edges.find((e) => {
              if (e.target !== nodeId) return false;
              const srcNode = store.nodes.find((n) => n.id === e.source);
              return srcNode && srcNode.type === NODE_TYPE.IMAGE && (srcNode.data as { src?: string }).src === src;
            });
            if (edge) store.removeEdges([edge.id]);
          }}
        />
      </Card>
    </ReferenceHoverPreview>
  );
}

export default memo(ImageRefCard);
