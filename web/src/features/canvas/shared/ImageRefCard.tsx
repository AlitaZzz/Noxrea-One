/**
 * 参考区「图片」缩略卡片（图片 / 视频 / 文本生成面板共用）。
 *
 * 展示缩略图与角标编号（图片N），悬停浮层放大预览，
 * 支持图片之间的拖拽排序（仅同类）与 ✕ 断开连线。
 */
"use client";

import { Button } from "antd";
import { memo, useState } from "react";
import { useTranslation } from "react-i18next";

import { useCanvasStore } from "@/features/canvas/stores/canvas-store";
import { NODE_TYPE } from "@/lib/constants";

import { findReferenceNode, useRevealCanvasNode } from "./reveal-node";
import { useDelayedHover } from "./use-delayed-hover";

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
  // 放大预览用延迟悬停：鼠标扫过整排卡片时不闪大图
  const { active: hovered, onMouseEnter, onMouseLeave } = useDelayedHover();
  const [dragOver, setDragOver] = useState(false);
  const [dragging, setDragging] = useState(false);

  /** 存储服务上的图走缩略参数，外链原样使用（缩略按 56px 卡的 2 倍取 112） */
  const thumbnail = src.includes("/api/files/") ? `${src}?w=112` : src;
  /** 预览按显示上限 240 的 2 倍屏取图 */
  const preview = src.includes("/api/files/") ? `${src}?w=480` : src;

  return (
    <div
      className="relative group"
      draggable
      onDoubleClick={() => {
        const n = findReferenceNode(nodeId, NODE_TYPE.IMAGE, src);
        if (n) reveal(n);
      }}
      onDragStart={(e) => {
        e.dataTransfer.setData("application/x-ref-image", src);
        e.dataTransfer.setData("text/plain", src);
        e.dataTransfer.effectAllowed = "move";
        setDragging(true); // 自身拖拽期间不显示放大预览，避免与拖拽图像错位
        onDragStateChange?.(true);
        // 以缩略图为拖拽图像并锚定中心，避免快照携带悬停预览浮层导致错位
        const el = (e.currentTarget as HTMLElement).querySelector("img");
        if (el) e.dataTransfer.setDragImage(el, 28, 28);
      }}
      onDragEnd={() => {
        setDragging(false);
        onDragStateChange?.(false);
      }}
      onDragEnter={(e) => {
        // 部分浏览器要求 dragenter 也 preventDefault，否则后续 drop 不会触发
        e.preventDefault();
        e.stopPropagation();
      }}
      onDragOver={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!e.dataTransfer.types.includes("application/x-ref-image")) {
          e.dataTransfer.dropEffect = "none"; // 仅图片可放到图片位置
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
        onReorder(dragged, src); // 内部按 refOrder 校验，非图片自动忽略
      }}
    >
      <img
        src={thumbnail}
        draggable={false}
        alt={`Ref ${index + 1}`}
        className={`block h-14 w-14 rounded object-cover cursor-grab active:cursor-grabbing transition-shadow ${dragOver ? "ring-2 ring-white shadow-lg" : ""}`}
        onMouseEnter={onMouseEnter}
        onMouseLeave={onMouseLeave}
      />
      {/* 底部半透明编号条：与卡片下缘齐平，仿播放器字幕条 */}
      <span className="absolute inset-x-0 bottom-0 h-4 flex items-center justify-center rounded-b text-[10px] font-semibold pointer-events-none whitespace-nowrap" style={{ background: "rgba(0,0,0,0.5)", color: "#fff" }}>{t("common.refImageLabel", { index: index + 1 })}</span>
      {hovered && !dragging && !dragActive && !dragOver && (
        <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 z-50 pointer-events-none">
          <img
            src={preview}
            alt=""
            className="max-w-[240px] max-h-[240px] rounded-lg shadow-2xl"
            style={{ background: "var(--canvas-bg)", border: "1px solid var(--canvas-border)", objectFit: "contain" }}
          />
        </div>
      )}
      <Button type="text" size="small"
        className="!absolute -top-1.5 -right-1.5 !w-4 !h-4 !flex items-center justify-center !rounded-full !bg-black/70 !text-white/60 hover:!text-white hover:!bg-white/30 !text-[10px] opacity-0 group-hover:opacity-100 transition-opacity !p-0 !border-0"
        onClick={() => {
          // 删除参考 = 断开连线，显示顺序随后自动派生
          const store = useCanvasStore.getState();
          const edge = store.edges.find((e) => {
            if (e.target !== nodeId) return false;
            const srcNode = store.nodes.find((n) => n.id === e.source);
            return srcNode && srcNode.type === NODE_TYPE.IMAGE && (srcNode.data as { src?: string }).src === src;
          });
          if (edge) store.removeEdges([edge.id]);
        }}>✕</Button>
    </div>
  );
}

export default memo(ImageRefCard);
