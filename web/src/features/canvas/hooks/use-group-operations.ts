/**
 * 节点编组 / 取消编组 hook 与归属变换纯函数。
 *
 * 监听 canvas:group-nodes / canvas:ungroup-nodes / canvas:node-action(layout) 事件：
 * - 编组：计算包围盒建组节点，选中节点经 attachNodesToGroup 挂入（parentId +
 *   组内相对坐标），旧组因此变空的按「空组即删」清理；
 * - 解组：detachGroupMembers 把成员还原为顶层绝对坐标并剥离 parentId，清理组
 *   的连线（组不可连）；
 * - 组内布局（宫格/水平/垂直）：成员在组内相对空间重排，组框按内容收缩到
 *   最小包围（布局是唯一允许组框收缩的路径）。
 */
"use client";

import { useEffect } from "react";

import { createGroupNode } from "@/features/canvas/node-defaults";
import { buildNodeIndex, groupMembers, isGroupMember, nodeAbsolutePosition, pruneEmptyGroups } from "@/features/canvas/shared/group-bounds";
import { measureNode } from "@/features/canvas/shared/tidy-layout";
import { markDirtyImmediate, takeCanvasSnapshot, useCanvasStore } from "@/features/canvas/stores/canvas-store";
import { useHistoryStore } from "@/features/canvas/stores/history-store";
import type { AnyNode } from "@/features/canvas/types";
import {
  EventNames,
  GROUP_NODE_MIN_HEIGHT,
  GROUP_NODE_MIN_WIDTH,
  GROUP_NODE_PADDING,
  LAYOUT_GAP,
  NODE_TITLE_HEIGHT,
  NODE_TYPE,
} from "@/lib/constants";

// ============================================================
// 归属变换纯函数（导出供单测）
// ============================================================

/**
 * 给选中节点挂到新组：parentId 指向组节点，绝对坐标换算为组内相对坐标，
 * 成员取消选中（组整体接管选中态）。选中节点可能原属另一组（position 是
 * 旧组的相对坐标），绝对坐标经 nodeById 统一换算。
 */
export function attachNodesToGroup(
  nodes: AnyNode[],
  selectedIds: Set<string>,
  group: { id: string; position: { x: number; y: number } },
  nodeById: Map<string, AnyNode>,
): AnyNode[] {
  return nodes.map((n) => {
    if (!selectedIds.has(n.id)) return n;
    const abs = nodeAbsolutePosition(n, nodeById);
    return {
      ...n,
      parentId: group.id,
      position: {
        x: abs.x - group.position.x,
        y: abs.y - group.position.y,
      },
      selected: false,
    } as AnyNode;
  });
}

/**
 * 把组的成员解出到顶层：绝对坐标 = 组.position + 相对坐标，剥离 parentId，
 * 成员保持选中以便继续操作。归属关系只有 parentId 一处，无需清理 data。
 */
export function detachGroupMembers(
  nodes: AnyNode[],
  group: { id: string; position: { x: number; y: number } },
): AnyNode[] {
  return nodes.map((n) => {
    if (!isGroupMember(n, group.id)) return n;
    return {
      ...n,
      parentId: undefined,
      position: {
        x: n.position.x + group.position.x,
        y: n.position.y + group.position.y,
      },
      selected: true,
    } as AnyNode;
  });
}

// ============================================================
// Hook：事件监听与编排
// ============================================================

/** 布局结果：成员新位置（组内相对坐标）与组框收缩后的尺寸 */
interface GroupLayoutResult {
  positioned: Map<string, { x: number; y: number }>;
  width: number;
  height: number;
}

function measureMembers(members: AnyNode[]) {
  let maxW = 0;
  let maxH = 0;
  for (const m of members) {
    const { width, height } = measureNode(m);
    maxW = Math.max(maxW, width);
    maxH = Math.max(maxH, height);
  }
  return { maxW, maxH };
}

/** 布局原点在组内相对空间：padding + 标题栏（成员不可压住组标题） */
const LAYOUT_ORIGIN = { x: GROUP_NODE_PADDING, y: NODE_TITLE_HEIGHT + GROUP_NODE_PADDING };

function applyGridLayout(members: AnyNode[]): GroupLayoutResult {
  const count = members.length;
  const cols = Math.ceil(Math.sqrt(count));

  // 分行流式：行内游标累加（每个节点用自身宽度），行高取该行最高节点
  const positioned = new Map<string, { x: number; y: number }>();
  let cursorY = LAYOUT_ORIGIN.y;
  let maxRowWidth = 0;

  for (let i = 0; i < count; i += cols) {
    const rowMembers = members.slice(i, i + cols);
    let cursorX = LAYOUT_ORIGIN.x;
    let rowMaxH = 0;
    for (const m of rowMembers) {
      const { width: w, height: h } = measureNode(m);
      positioned.set(m.id, { x: cursorX, y: cursorY });
      cursorX += w + LAYOUT_GAP;
      rowMaxH = Math.max(rowMaxH, h);
    }
    maxRowWidth = Math.max(maxRowWidth, cursorX - LAYOUT_ORIGIN.x - LAYOUT_GAP);
    cursorY += rowMaxH + LAYOUT_GAP;
  }

  const contentW = maxRowWidth;
  const contentH = cursorY - LAYOUT_ORIGIN.y - LAYOUT_GAP;
  const width = Math.max(GROUP_NODE_MIN_WIDTH, contentW + GROUP_NODE_PADDING * 2);
  const height = Math.max(GROUP_NODE_MIN_HEIGHT, contentH + NODE_TITLE_HEIGHT + GROUP_NODE_PADDING * 2);
  return { positioned, width, height };
}

function applyHorizontalLayout(members: AnyNode[]): GroupLayoutResult {
  const { maxH } = measureMembers(members);

  // 紧凑排列：游标按每个节点自身宽度累加，净间距恒定为 LAYOUT_GAP
  const positioned = new Map<string, { x: number; y: number }>();
  let cursorX = LAYOUT_ORIGIN.x;
  for (const m of members) {
    const { width: w, height: h } = measureNode(m);
    positioned.set(m.id, {
      x: cursorX,
      y: LAYOUT_ORIGIN.y + Math.max(0, (maxH - h) / 2),
    });
    cursorX += w + LAYOUT_GAP;
  }

  const contentW = cursorX - LAYOUT_ORIGIN.x - LAYOUT_GAP;
  const contentH = maxH;
  const width = Math.max(GROUP_NODE_MIN_WIDTH, contentW + GROUP_NODE_PADDING * 2);
  const height = Math.max(GROUP_NODE_MIN_HEIGHT, contentH + NODE_TITLE_HEIGHT + GROUP_NODE_PADDING * 2);
  return { positioned, width, height };
}

function applyVerticalLayout(members: AnyNode[]): GroupLayoutResult {
  const { maxW } = measureMembers(members);

  // 紧凑排列：游标按每个节点自身高度累加，净间距恒定为 LAYOUT_GAP
  const positioned = new Map<string, { x: number; y: number }>();
  let cursorY = LAYOUT_ORIGIN.y;
  for (const m of members) {
    const { width: w, height: h } = measureNode(m);
    positioned.set(m.id, {
      x: LAYOUT_ORIGIN.x + Math.max(0, (maxW - w) / 2),
      y: cursorY,
    });
    cursorY += h + LAYOUT_GAP;
  }

  const contentW = maxW;
  const contentH = cursorY - LAYOUT_ORIGIN.y - LAYOUT_GAP;
  const width = Math.max(GROUP_NODE_MIN_WIDTH, contentW + GROUP_NODE_PADDING * 2);
  const height = Math.max(GROUP_NODE_MIN_HEIGHT, contentH + NODE_TITLE_HEIGHT + GROUP_NODE_PADDING * 2);
  return { positioned, width, height };
}

// ============================================================
// Hook：监听编组 / 解组 / 组内布局事件
// ============================================================

/**
 * 编组/取消编组 hook。
 *
 * 监听 canvas:group-nodes / canvas:ungroup-nodes / canvas:node-action 事件，
 * 处理包围盒计算、成员归属与坐标变换、边清理与历史压栈。
 */
export function useGroupOperations() {
  const pushHistory = useHistoryStore((s) => s.push);

  useEffect(() => {
    function onGroupNodes() {
      const allNodes = useCanvasStore.getState().nodes;
      const selected = allNodes.filter((n) => n.selected && n.type !== NODE_TYPE.GROUP);
      if (selected.length < 2) return;

      // Calculate bounding box of selected nodes（绝对坐标：选中节点可能原属
      // 另一组，position 是旧组的相对坐标，必须先换算）
      const nodeById = buildNodeIndex(allNodes);
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const n of selected) {
        const { width: w, height: h } = measureNode(n);
        const abs = nodeAbsolutePosition(n, nodeById);
        minX = Math.min(minX, abs.x);
        minY = Math.min(minY, abs.y);
        maxX = Math.max(maxX, abs.x + w);
        maxY = Math.max(maxY, abs.y + h);
      }

      const groupX = minX - GROUP_NODE_PADDING;
      const groupY = minY - GROUP_NODE_PADDING;
      const groupW = maxX - minX + GROUP_NODE_PADDING * 2;
      const groupH = maxY - minY + GROUP_NODE_PADDING * 2;

      pushHistory(takeCanvasSnapshot());

      const groupNode = createGroupNode(
        { x: groupX, y: groupY },
        { width: groupW, height: groupH }
      );

      const store = useCanvasStore.getState();
      // 成员挂入新组：parentId 结构关系 + 相对坐标（attachNodesToGroup）；
      // 编组把选中节点从原组带走后，变空的旧组按「空组即删」清理
      const updatedNodes = attachNodesToGroup(
        store.nodes,
        new Set(selected.map((n) => n.id)),
        groupNode,
        nodeById,
      );

      store.setNodes(pruneEmptyGroups([{ ...groupNode, selected: true }, ...updatedNodes]));
      markDirtyImmediate();
    }

    function onUngroupNodes() {
      const allNodes = useCanvasStore.getState().nodes;
      const selectedGroup = allNodes.filter((n) => n.selected && n.type === NODE_TYPE.GROUP);
      if (selectedGroup.length === 0) return;

      pushHistory(takeCanvasSnapshot());

      const store = useCanvasStore.getState();
      let newNodes = [...store.nodes];

      for (const group of selectedGroup) {
        // 成员解出到顶层（绝对坐标还原），保持选中以便继续操作
        newNodes = detachGroupMembers(newNodes, group);
        // Remove the group node
        newNodes = newNodes.filter((n) => n.id !== group.id);
      }

      // Clear all edges connected to removed group nodes
      const removedIds = new Set(selectedGroup.map((g) => g.id));
      const newEdges = store.edges.filter(
        (e) => !removedIds.has(e.source) && !removedIds.has(e.target)
      );

      store.setNodes(newNodes);
      store.setEdges(newEdges, { skipHistory: true });
      markDirtyImmediate();
    }

    function onNodeAction(e: Event) {
      const detail = (e as CustomEvent).detail as {
        nodeId?: string;
        action?: string;
        mode?: "grid" | "vertical" | "horizontal";
      };
      if (detail.action !== "layout" || !detail.nodeId) return;

      const store = useCanvasStore.getState();
      const group = store.nodes.find((n) => n.id === detail.nodeId);
      if (!group || group.type !== NODE_TYPE.GROUP) return;

      const members = groupMembers(store.nodes, group.id);
      if (members.length === 0) return;

      let result: GroupLayoutResult;
      switch (detail.mode) {
        case "vertical":
          result = applyVerticalLayout(members);
          break;
        case "horizontal":
          result = applyHorizontalLayout(members);
          break;
        case "grid":
        default:
          result = applyGridLayout(members);
          break;
      }
      const { positioned, width, height } = result;

      pushHistory(takeCanvasSnapshot());

      // 成员位置是组内相对坐标；组框按内容收缩到最小包围（布局是唯一允许收缩的路径）
      const newNodes = store.nodes.map((n) => {
        if (n.id === group.id) {
          return { ...n, style: { ...n.style, width, height } };
        }
        const pos = positioned.get(n.id);
        if (pos) return { ...n, position: pos };
        return n;
      });

      store.setNodes(newNodes);
      markDirtyImmediate();
    }

    window.addEventListener(EventNames.CANVAS_GROUP_NODES, onGroupNodes);
    window.addEventListener(EventNames.CANVAS_UNGROUP_NODES, onUngroupNodes);
    window.addEventListener(EventNames.CANVAS_NODE_ACTION, onNodeAction);
    return () => {
      window.removeEventListener(EventNames.CANVAS_GROUP_NODES, onGroupNodes);
      window.removeEventListener(EventNames.CANVAS_UNGROUP_NODES, onUngroupNodes);
      window.removeEventListener(EventNames.CANVAS_NODE_ACTION, onNodeAction);
    };
  }, [pushHistory]);
}
