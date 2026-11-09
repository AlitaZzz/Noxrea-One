/**
 * 指针交互 hook：按下点补偿、写回菜单、节点点击 / 右键 / 拖动的入口，
 * 以及画布级右键菜单与新增节点动作。
 *
 * 拖动会话只在这里建立与提交；位置帧的提交由 use-canvas-node-changes 统一
 * 走会话，本 hook 的 drag stop 只处理最终归属与组几何。
 */
"use client";

import { useCallback, useRef } from "react";

import { dragInputFromEvent } from "@/features/canvas/drag/drag-input";
import type { DragPreviewSession } from "@/features/canvas/drag/drag-preview-session";
import { pointerClientPoint } from "@/features/canvas/drag/pointer-position";
import { type AddNodeType, useAddNode } from "@/features/canvas/hooks/use-add-node";
import { clearSelection } from "@/features/canvas/shared/canvas-edit-actions";
import {
  buildGroupHitIndex,
  buildNodeIndex,
  type GroupHitIndex,
  nodeAbsolutePosition,
  refitGroupRects,
  resolveDropGroupId,
} from "@/features/canvas/shared/group-bounds";
import { isGroupNode, memberParentId, pruneEmptyGroups } from "@/features/canvas/shared/group-membership";
import { prewarmPromptForNode } from "@/features/canvas/shared/prompt-shaping-prewarm";
import { applySelection } from "@/features/canvas/shared/selection";
import { markDirtyImmediate, takeCanvasSnapshot, useCanvasStore } from "@/features/canvas/stores/canvas-store";
import { useContextMenuStore } from "@/features/canvas/stores/context-menu-store";
import { useHistoryStore } from "@/features/canvas/stores/history-store";
import type { AnyNode } from "@/features/canvas/types";

export interface UseCanvasPointerOptions {
  dragSession: DragPreviewSession;
  onClick: () => void;
  onNodeDragStart: () => void;
  onNodeDragStop: () => void;
  screenToFlowPosition: (position: { x: number; y: number }) => { x: number; y: number };
  /** 点击画布 / 节点时收起网格菜单与工具条弹层。 */
  resetTransientPanels: () => void;
}

export function useCanvasPointer({
  dragSession,
  onClick,
  onNodeDragStart,
  onNodeDragStop,
  screenToFlowPosition,
  resetTransientPanels,
}: UseCanvasPointerOptions) {
  const pushHistory = useHistoryStore((s) => s.push);
  const { addNode } = useAddNode();

  // 拖动参考点的按下点：React Flow 在越过拖动阈值的首个指针事件才建立拖动
  // 参考点，按下到该事件之间的指针位移会永久丢失（节点整段拖动落后指针）。
  // 参考点必须取自 d3-drag 使用的同一事件（mousedown/touchstart）：PointerEvent
  // 的 clientX 保留小数，而 React Flow 读到的 MouseEvent 坐标是整数，混用会在
  // 补偿里留下亚像素误差。捕获阶段记录，拖拽开始时按差值补偿（规则 2.7）。
  const pressPointRef = useRef<{ x: number; y: number } | null>(null);
  const dragGroupIndexRef = useRef<GroupHitIndex | null>(null);

  const handleCanvasPressCapture = useCallback(
    (event: React.MouseEvent<HTMLDivElement> | React.TouchEvent<HTMLDivElement>) => {
      pressPointRef.current = pointerClientPoint(event.nativeEvent);
    },
    [],
  );

  const handleNodeDragStart = useCallback(
    (event: unknown, _node: AnyNode, dragItems: AnyNode[]) => {
      // 激活后的第一件事是建立会话并补出首帧（规则 2.8）：会话基准只取当前 store
      // 与 DOM，不依赖下面的簿记工作；历史压栈、组命中索引与交互状态后置，
      // 起手落位不被它们推后（历史快照取的是 store，会话不写 store，语义不变）
      // 吸附开关与网格设置在拖动开始时捕获一次：拖动期不再订阅 store；对齐阈值
      // 由会话按开始时的 zoom 换算，修饰键初值取本事件（规则 4.5、8.3、10.4）
      const { snapEnabled, snapGridSize } = useCanvasStore.getState();
      // 阈值事件发生在按下点之后：这段指针位移由会话补回（规则 2.7）
      const pointerDown = pressPointRef.current;
      const pointerAtStart = pointerClientPoint(event);
      dragSession.begin(dragItems.map((node) => node.id), { snapEnabled, snapGridSize }, {
        preThresholdOffset:
          pointerDown && pointerAtStart
            ? { x: pointerAtStart.x - pointerDown.x, y: pointerAtStart.y - pointerDown.y }
            : undefined,
        ...dragInputFromEvent(event),
      });
      pushHistory(takeCanvasSnapshot());
      dragGroupIndexRef.current = buildGroupHitIndex(useCanvasStore.getState().nodes);
      onNodeDragStart();
      // 拖入高亮随每次拖拽重新开始计算（上一轮残留即刻清空）
      useCanvasStore.getState().setDragOverGroup(null);
    },
    [pushHistory, onNodeDragStart, dragSession],
  );

  // 拖入组高亮：拖拽中实时以「落点归属」同口径（resolveDropGroupId）计算
  // 松手将加入的组，组边框高亮反馈归属结果；组节点拖拽不参与。
  // 只在归属「将变化」时高亮：悬停在自己当前组内归属不变，高亮即噪音
  const handleNodeDrag = useCallback((_: unknown, rawNode: AnyNode) => {
    if (isGroupNode(rawNode)) return;
    const { setDragOverGroup } = useCanvasStore.getState();
    const index = dragGroupIndexRef.current;
    if (!index) return;
    const next = resolveDropGroupId(rawNode, index);
    setDragOverGroup(next && next !== memberParentId(rawNode) ? next : null);
  }, []);

  const handleNodeDragStop = useCallback(
    (_: unknown, rawNode: AnyNode) => {
      onNodeDragStop();
      // 终态帧已在 handleNodesChange 提交；未到达时以最后预览几何兜底提交
      dragSession.stop();
      useCanvasStore.getState().setDragOverGroup(null);

      const allNodes = useCanvasStore.getState().nodes;
      // 拖动位置已由预览会话在终态帧一次提交到 store，拖拽停止只负责处理
      // 最终归属和组几何，不再从 React Flow 内部复制第二份节点数组。
      const draggedNode = allNodes.find((n) => n.id === rawNode.id);
      if (!draggedNode) {
        dragGroupIndexRef.current = null;
        return;
      }
      if (isGroupNode(draggedNode)) {
        // 位置提交（含落库）已由会话完成
        dragGroupIndexRef.current = null;
        return;
      }

      // 统一判定归属（resolveDropGroupId，与拖入高亮共用同一口径；
      // 成员中心以绝对坐标判定）
      const oldParentId = memberParentId(draggedNode);
      const dragIndex = dragGroupIndexRef.current ?? buildGroupHitIndex(allNodes);
      const nextParentId = resolveDropGroupId(draggedNode, dragIndex);
      dragGroupIndexRef.current = null;

      if (nextParentId === oldParentId) {
        // 位置提交（含落库）已由会话完成，归属未变时无额外写入
        return;
      }

      // 不在此处 pushHistory：拖拽开始（handleNodeDragStart）已压入拖拽前快照，
      // 否则会把"拖动前"状态重复压栈，导致撤销/重做丢失真正的组外状态。
      // 归属变化伴随坐标换算：加入新组 → 绝对位置换算为组内相对；脱离 → 换算回绝对
      const nodeById = buildNodeIndex(allNodes);
      const absPos = nodeAbsolutePosition(draggedNode, nodeById);
      const withMembership = allNodes.map((n) => {
        if (n.id !== draggedNode.id) return n;
        let position = absPos;
        const newParent = nextParentId ? nodeById.get(nextParentId) : undefined;
        if (newParent) {
          position = {
            x: absPos.x - newParent.position.x,
            y: absPos.y - newParent.position.y,
          };
        }
        return { ...n, parentId: nextParentId, position } as AnyNode;
      });

      // 成员全部脱离的旧组：空组即删（唯一口径见 pruneEmptyGroups），
      // 组框重算对已删除的组自然跳过
      const touchedGroupIds = new Set<string>();
      if (oldParentId) touchedGroupIds.add(oldParentId);
      if (nextParentId) touchedGroupIds.add(nextParentId);
      const finalNodes = refitGroupRects(pruneEmptyGroups(withMembership), touchedGroupIds);

      useCanvasStore.getState().setNodes(finalNodes);
      markDirtyImmediate();
    },
    [onNodeDragStop, dragSession],
  );

  const handlePaneClick = useCallback(() => {
    // React Flow 的 pane 本身不可聚焦；点击画布时主动结束控件焦点，
    // 让 shadcn 控件的 focus-visible ring 不会残留在控制条上。
    const activeElement = document.activeElement;
    if (activeElement instanceof HTMLElement && activeElement !== document.body) {
      activeElement.blur();
    }
    // 点击空白：视为「点击选中」语义，恢复选中态 UI
    onClick();
    resetTransientPanels();
    // Exit all node editor modes when clicking the canvas pane
    useCanvasStore.getState().closeForeignNodeEditors(null);
    // Deselect all nodes and edges：与 Esc 共用 clearSelection（无选中项时不重建数组）。
    clearSelection();
  }, [onClick, resetTransientPanels]);

  // 右键空白处 → 画布级操作菜单（粘贴 / 全选 / 整理 / 重置视图）。
  // 原生菜单由 use-canvas-events 的 preventCtx 统一屏蔽，这里只负责唤起自定义菜单。
  const handlePaneContextMenu = useCallback((e: React.MouseEvent | MouseEvent) => {
    e.preventDefault();
    useContextMenuStore.getState().show(e.clientX, e.clientY, "canvas");
  }, []);

  // 右键节点 → 节点级操作菜单（复制 / 删除）。
  // 标准行为：若该节点尚未选中，先单选它，让菜单明确作用在它身上。
  const handleNodeContextMenu = useCallback((e: React.MouseEvent, node: AnyNode) => {
    const target = e.target as HTMLElement;
    // 文本节点编辑态（Tiptap contenteditable）与输入框：放行浏览器原生右键菜单，
    // 供复制 / 粘贴 / 拼写检查。与 use-canvas-events 的 preventCtx 同一套豁免选择器。
    if (target.closest("input, textarea, [contenteditable='true'], [contenteditable='']")) return;
    e.preventDefault();
    const store = useCanvasStore.getState();
    if (!node.selected) {
      applySelection(store.nodes, (n) => n.id === node.id, store.setNodes);
    }
    useContextMenuStore.getState().show(e.clientX, e.clientY, "node", node.id);
  }, []);

  // Explicitly handle node selection — React Flow's internal click detection
  // may miss clicks that land on interactive child elements (inputs, selects, etc.)
  const handleNodeClick = useCallback(
    (_event: React.MouseEvent, node: Record<string, unknown>) => {
      const nodeId = node.id as string;
      // 单击节点（含修饰键点击）属于点击选择，恢复选中态 UI
      onClick();
      resetTransientPanels();
      // Exit editor modes opened on other nodes
      useCanvasStore.getState().closeForeignNodeEditors(nodeId);
      // 当按下修饰键时，由 React Flow 通过 onNodesChange 处理多选
      if (_event.ctrlKey || _event.metaKey || _event.shiftKey) {
        return;
      }

      // 只写选中态真正变化的节点：整表克隆会让 React Flow 重建全部内部实例，
      // 工具条要等整画布提交才能出现（节点越多越明显）
      applySelection(useCanvasStore.getState().nodes, (n) => n.id === nodeId, useCanvasStore.getState().setNodes);
    },
    [onClick, resetTransientPanels],
  );

  // 悬停生成节点时预热提示词字形：面板首次显示的 18–20ms layout 来自
  // 中文首次 shaping，提前到悬停阶段把成本移出点击路径（见 shared/prompt-shaping-prewarm）。
  const handleNodeMouseEnter = useCallback((_event: React.MouseEvent, node: AnyNode) => {
    prewarmPromptForNode(node);
  }, []);

  // 从右键/双击菜单新增节点时，锚定到触发菜单的点击点（世界坐标）
  const addNodeAtMenu = useCallback(
    (type: AddNodeType) => {
      const { x, y } = useContextMenuStore.getState();
      addNode(type, screenToFlowPosition({ x, y }));
    },
    [addNode, screenToFlowPosition],
  );
  const handleAddText = useCallback(() => addNodeAtMenu("text"), [addNodeAtMenu]);
  const handleAddImage = useCallback(() => addNodeAtMenu("image"), [addNodeAtMenu]);
  const handleAddVideo = useCallback(() => addNodeAtMenu("video"), [addNodeAtMenu]);
  const handleAddAudio = useCallback(() => addNodeAtMenu("audio"), [addNodeAtMenu]);
  const handleAddDirector = useCallback(() => addNodeAtMenu("director"), [addNodeAtMenu]);

  return {
    handleCanvasPressCapture,
    handleNodeDragStart,
    handleNodeDrag,
    handleNodeDragStop,
    handlePaneClick,
    handlePaneContextMenu,
    handleNodeContextMenu,
    handleNodeClick,
    handleNodeMouseEnter,
    handleAddText,
    handleAddImage,
    handleAddVideo,
    handleAddAudio,
    handleAddDirector,
  };
}
