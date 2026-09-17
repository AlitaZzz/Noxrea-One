/**
 * 多选外框上的批量连线 Handle（仅右缘 = 输出方向）。
 * 框选 ≥2 个非组节点时，外框右缘出现 Handle，可直接从框上拖线，
 * 不必捏某个具体节点的 Handle：
 * - 拖到已有节点 → 批量建边（逐个 canConnect 校验 + 去重，由父级完成）；
 * - 拖到空白 → 与单节点连线一致，弹出「创建连接节点」菜单，批量接驳；
 * - 拖回选区内或移动过小 → 取消。
 * 样式复用节点 Handle 的 .react-flow__handle 类（尺寸/加号图标/hover 放大），
 * 通过 .selection-frame-handle 强制常显（节点 Handle 由 hover/选中规则控制显隐）。
 * 通过 ViewportPortal 渲染，坐标为画布坐标，自动跟随视口平移缩放。
 */
"use client";

import { Position, ViewportPortal } from "@xyflow/react";
import { useRef, useState } from "react";

import { GROUP_NODE_PADDING } from "@/lib/constants";

import PendingConnectionPreview from "./PendingConnectionPreview";

interface Props {
  /** 选中节点的内容包围盒（画布坐标，未含外框 padding） */
  bbox: { x: number; y: number; width: number; height: number };
  selectedIds: string[];
  onConnectToNode: (selectedIds: string[], targetId: string) => void;
  onConnectToBlank: (
    selectedIds: string[],
    canvasPosition: { x: number; y: number },
    screenPosition: { x: number; y: number },
    sourceAnchor: { x: number; y: number }
  ) => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  screenToFlowPosition: (pos: { x: number; y: number }) => { x: number; y: number };
}

export default function SelectionFrameHandles({
  bbox,
  selectedIds,
  onConnectToNode,
  onConnectToBlank,
  onDragStart,
  onDragEnd,
  screenToFlowPosition,
}: Props) {
  const [preview, setPreview] = useState<null | {
    from: { x: number; y: number };
    to: { x: number; y: number };
    fromPosition: Position;
  }>(null);
  const dragRef = useRef<{ anchor: { x: number; y: number }; startX: number; startY: number } | null>(null);

  /** 外框可视矩形右缘（与 .react-flow__nodesselection-rect 的 40px 外扩一致），
      Handle 悬浮于框缘外侧，与节点 Handle 的露出方式一致 */
  const anchor = {
    x: bbox.x + bbox.width + GROUP_NODE_PADDING,
    y: bbox.y + bbox.height / 2,
  };

  function startDrag(e: React.PointerEvent) {
    e.stopPropagation();
    e.preventDefault();
    dragRef.current = { anchor, startX: e.clientX, startY: e.clientY };
    onDragStart();
    setPreview({ from: anchor, to: anchor, fromPosition: Position.Right });

    const onMove = (ev: PointerEvent) => {
      const to = screenToFlowPosition({ x: ev.clientX, y: ev.clientY });
      setPreview((p) => (p ? { ...p, to } : p));
    };
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setPreview(null);
      const drag = dragRef.current;
      dragRef.current = null;
      onDragEnd();
      if (!drag) return;

      // 移动过小视为误触，取消（避免单击 Handle 就弹菜单）
      const moved = Math.hypot(ev.clientX - drag.startX, ev.clientY - drag.startY);
      if (moved < 4) return;

      const to = screenToFlowPosition({ x: ev.clientX, y: ev.clientY });
      const nodeEl = (document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null)?.closest(
        ".react-flow__node"
      ) as HTMLElement | null;
      const targetId = nodeEl?.getAttribute("data-id") ?? null;

      if (targetId && !selectedIds.includes(targetId)) {
        onConnectToNode(selectedIds, targetId);
      } else if (!targetId) {
        // 拖回选区内（落点命中选中的节点）视为取消；空白处弹创建菜单
        onConnectToBlank(selectedIds, to, { x: ev.clientX, y: ev.clientY }, drag.anchor);
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  return (
    <ViewportPortal>
      <div
        className="nopan nodrag react-flow__handle react-flow__handle-right source selection-frame-handle"
        style={{
          left: anchor.x,
          top: anchor.y,
          cursor: "crosshair",
          zIndex: 30,
        }}
        onPointerDown={startDrag}
      />
      {preview && (
        <PendingConnectionPreview from={preview.from} to={preview.to} fromPosition={Position.Right} />
      )}
    </ViewportPortal>
  );
}
