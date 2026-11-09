/**
 * 画布级浮层：选区聚合工具条、框选外框批量连线轨道、待创建连线预览、
 * 右键菜单、创建节点菜单与文件拖拽遮罩。
 *
 * 这些浮层不跟随单个节点挂载，位置由选区几何、指针落点或画布容器决定；
 * 面板显隐仍由交互状态机与选区投影门控。
 */
"use client";

import { Position } from "@xyflow/react";
import type { ComponentProps } from "react";
import { useTranslation } from "react-i18next";

import { DirUploadIcon } from "@/components/ui/AppIcon";
import type { BatchConnectHandlers } from "@/features/canvas/controls/BatchConnectContext";
import BatchConnectHandle from "@/features/canvas/controls/BatchConnectHandle";
import CanvasContextMenu from "@/features/canvas/controls/CanvasContextMenu";
import ConnectionCreateMenu, { type PendingConnectionCreate } from "@/features/canvas/controls/ConnectionCreateMenu";
import PendingConnectionPreview from "@/features/canvas/controls/PendingConnectionPreview";
import { SelectionToolbarLayer } from "@/features/canvas/controls/SelectionToolbar";
import type { CanvasToolbarMode, SelectionFrame } from "@/features/canvas/shared/canvas-derived";

export interface GlobalOverlaysProps {
  editingNodeId: string | null;
  editingTextNodeId: string | null;
  selectionKey: string;
  toolbarMode: CanvasToolbarMode;
  selectionFrame: SelectionFrame | null;
  batchConnectAnchor: { x: number; y: number } | null;
  batchConnectHandlers: BatchConnectHandlers;
  pendingConnectionCreate: PendingConnectionCreate | null;
  pendingPreviewAnchors: readonly { x: number; y: number }[];
  onSelectConnectionNode: (nodeType: string) => void;
  onCloseConnectionCreate: () => void;
  contextMenuProps: ComponentProps<typeof CanvasContextMenu>;
  isFileDragging: boolean;
}

export function GlobalOverlays({
  editingNodeId,
  editingTextNodeId,
  selectionKey,
  toolbarMode,
  selectionFrame,
  batchConnectAnchor,
  batchConnectHandlers,
  pendingConnectionCreate,
  pendingPreviewAnchors,
  onSelectConnectionNode,
  onCloseConnectionCreate,
  contextMenuProps,
  isFileDragging,
}: GlobalOverlaysProps) {
  const { t } = useTranslation();

  return (
    <>
      {/* 多选聚合工具条 — 屏幕固定尺寸，锚定全部选中节点（含组）的包围盒。
          框选手势与拖动期间让位，框选提交（box-selected）后立即出现 */}
      {toolbarMode.kind === "aggregate" &&
        !editingNodeId &&
        !editingTextNodeId && (
          <SelectionToolbarLayer
            bounds={toolbarMode.bounds}
            selectionKey={selectionKey}
          />
        )}

      {/* 批量连线轨道（框选外框专用，右缘 = 输出方向）：≥2 个非组节点选中时，
          条带锚在外框右缘正中、自此向右延伸，参与集 = 选中节点。外框不是节点，
          无显隐规则可依托，由 CSS 常显；拖动节点与框选手势中随节点轨道一起隐藏。
          条带高取常量 RAIL_WIDTH（外框恒高于 80px）。
          组节点的批量轨道由 GroupNode 内部的 GroupConnectRail 渲染 */}
      {selectionFrame && batchConnectAnchor && (
        <BatchConnectHandle
          anchor={batchConnectAnchor}
          participantIds={selectionFrame.ids}
          {...batchConnectHandlers}
        />
      )}

      {/* 拖拽连线落在空白、弹出创建菜单期间：持续渲染绿色流光预览线。
          多选扇出时每个选中节点一根（与拖拽中的束线预览一致），单节点即一根；
          锚点按 direction 取节点右/左边缘正中，无有效盒尺寸的节点跳过 */}
      {pendingConnectionCreate &&
        pendingPreviewAnchors.map((anchor, i) => (
          <PendingConnectionPreview
            key={i}
            from={anchor}
            to={pendingConnectionCreate.canvasPosition}
            fromPosition={pendingConnectionCreate.direction === "output" ? Position.Right : Position.Left}
          />
        ))}

      <CanvasContextMenu {...contextMenuProps} />

      {pendingConnectionCreate && (
        <ConnectionCreateMenu
          pending={pendingConnectionCreate}
          onSelect={onSelectConnectionNode}
          onClose={onCloseConnectionCreate}
        />
      )}

      {/* 拖入文件时的全屏模糊遮罩 + 释放提示 */}
      {isFileDragging && (
        <div
          className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center bg-card/55 backdrop-blur-md"
        >
          <div
            className="flex flex-col items-center gap-4 rounded-2xl border-2 border-dashed border-input bg-card/40 px-16 py-12"
          >
            <DirUploadIcon
              className="size-14 animate-bounce text-primary"
            />
            <div className="text-lg font-medium text-foreground">
              {t("file.dropToAdd")}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
