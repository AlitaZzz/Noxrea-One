/**
 * 参考区「视频」缩略卡片（视频 / 文本生成面板共用）。
 *
 * 以首帧作为缩略图、悬停浮层自动播放预览，支持视频之间的拖拽排序（仅同类）与 ✕ 断开连线。
 */
"use client";

import { memo, useState } from "react";
import { useTranslation } from "react-i18next";

import { useCanvasStore } from "@/features/canvas/stores/canvas-store";
import { NODE_TYPE } from "@/lib/constants";

import { findReferenceNode, useRevealCanvasNode } from "./reveal-node";
import { useDelayedHover } from "./use-delayed-hover";

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
  // 悬浮预览用延迟悬停：鼠标扫过整排卡片时不闪浮层
  const { active: hovered, onMouseEnter, onMouseLeave } = useDelayedHover();
  const [dragOver, setDragOver] = useState(false);
  const [dragging, setDragging] = useState(false);

  return (
    <div
      className={`relative group h-14 w-14 rounded transition-shadow cursor-grab active:cursor-grabbing ${dragOver ? "ring-2 ring-white shadow-lg" : ""}`}
      style={{ background: "var(--canvas-bg-hover)", border: "1px solid var(--canvas-border)" }}
      draggable
      onDoubleClick={() => {
        const n = findReferenceNode(nodeId, NODE_TYPE.VIDEO, src);
        if (n) reveal(n);
      }}
      onDragStart={(e) => {
        e.dataTransfer.setData("application/x-ref-video", src);
        e.dataTransfer.setData("text/plain", src);
        e.dataTransfer.effectAllowed = "move";
        setDragging(true); // 自身拖拽期间不显示预览，避免与拖拽图像错位
        onDragStateChange?.(true);
        // 以首帧缩略视频为拖拽图像并锚定中心，避免快照携带悬停预览浮层导致错位
        const el = (e.currentTarget as HTMLElement).querySelector("video");
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
        if (!e.dataTransfer.types.includes("application/x-ref-video")) {
          e.dataTransfer.dropEffect = "none"; // 仅视频可放到视频位置
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
        onReorder(dragged, src); // 面板侧按 refVideoOrder 校验，非视频自动忽略
      }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      {/* 静态缩略：用视频元素渲染首帧（#t=0.1 避开开头黑场，preload=metadata 不预载全片） */}
      <video src={`${src}#t=0.1`} className="w-full h-full object-cover rounded pointer-events-none" muted preload="metadata" playsInline draggable={false} />
      {hovered && !dragging && !dragActive && !dragOver && (
        <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 z-50 pointer-events-none">
          <video src={src} className="max-w-[240px] max-h-[240px] rounded-lg shadow-2xl" style={{ background: "var(--canvas-bg)", border: "1px solid var(--canvas-border)" }} autoPlay muted loop playsInline />
        </div>
      )}
      {/* 底部半透明编号条：与卡片下缘齐平，仿播放器字幕条 */}
      <span className="absolute inset-x-0 bottom-0 h-4 flex items-center justify-center rounded-b text-[10px] font-semibold pointer-events-none whitespace-nowrap" style={{ background: "rgba(0,0,0,0.5)", color: "#fff" }}>{t("common.refVideoLabel", { index: index + 1 })}</span>
      <button
        type="button"
        className="app-overlay-btn app-overlay-btn--xxs absolute -top-1.5 -right-1.5 opacity-0 group-hover:opacity-100"
        onClick={() => {
          // 删除参考 = 断开连线（与图片 / 音频参考一致），显示顺序随后自动派生
          const store = useCanvasStore.getState();
          const edge = store.edges.find((e) => {
            if (e.target !== nodeId) return false;
            const srcNode = store.nodes.find((n) => n.id === e.source);
            return srcNode && srcNode.type === NODE_TYPE.VIDEO && (srcNode.data as { src?: string }).src === src;
          });
          if (edge) store.removeEdges([edge.id]);
        }}>✕</button>
    </div>
  );
}

export default memo(VideoRefCard);
