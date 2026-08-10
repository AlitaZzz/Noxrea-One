/**
 * 节点编组 / 取消编组 hook。
 * 监听编组事件，计算包围盒并为子节点打上 groupId 逻辑归属标记（坐标保持绝对，
 * 不再使用 React Flow 的 parentId / 相对坐标嵌套）。
 */
"use client";

import { useEffect } from "react";

import { createGroupNode } from "@/features/canvas/node-defaults";
import type { AnyNode } from "@/features/canvas/types";
import {
  EventNames,
  GROUP_NODE_MIN_HEIGHT,
  GROUP_NODE_MIN_WIDTH,
  GROUP_NODE_PADDING,
  NODE_TITLE_HEIGHT,
  NODE_TYPE,
} from "@/lib/constants";
import { markDirtyImmediate,takeCanvasSnapshot, useCanvasStore } from "@/features/canvas/stores/canvas-store";
import { useHistoryStore } from "@/features/canvas/stores/history-store";

/** 布局成员时的固定间距（px） */
const LAYOUT_GAP = 24;

/**
 * 编组/取消编组 hook。
 *
 * 监听 canvas:group-nodes / canvas:ungroup-nodes 事件，
 * 处理 bounding-box 计算、子节点坐标变换、边清理。
 */
export function useGroupOperations() {
  const pushHistory = useHistoryStore((s) => s.push);
  const addNodes = useCanvasStore((s) => s.addNodes);

  useEffect(() => {
    function onGroupNodes() {
      const allNodes = useCanvasStore.getState().nodes;
      const selected = allNodes.filter((n) => n.selected && n.type !== NODE_TYPE.GROUP);
      if (selected.length < 2) return;

      // Calculate bounding box of selected nodes
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const n of selected) {
        const w = Number(n.style?.width) || 200;
        const h = Number(n.style?.height) || 120;
        minX = Math.min(minX, n.position.x);
        minY = Math.min(minY, n.position.y);
        maxX = Math.max(maxX, n.position.x + w);
        maxY = Math.max(maxY, n.position.y + h);
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
      // 给选中的节点打上逻辑归属标记（groupId），坐标保持绝对不变
      const updatedNodes = store.nodes.map((n): AnyNode => {
        if (n.type === NODE_TYPE.GROUP) return n;
        if (selected.find((s) => s.id === n.id)) {
          return {
            ...n,
            data: { ...n.data, groupId: groupNode.id },
            selected: false,
          };
        }
        return n;
      });

      store.setNodes([{ ...groupNode, selected: true }, ...updatedNodes]);
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
        // 清除归属到该组的子节点标记（坐标保持绝对不变）
        newNodes = newNodes.map((n): AnyNode => {
          if (n.type === NODE_TYPE.GROUP) return n;
          if (n.data.groupId === group.id) {
            const { groupId: _omit, ...restData } = n.data;
            return { ...n, data: restData };
          }
          return n;
        });

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

    type CanvasNode = ReturnType<typeof useCanvasStore.getState>["nodes"][number];

    function measureMembers(members: CanvasNode[]) {
      let maxW = 0;
      let maxH = 0;
      for (const m of members) {
        maxW = Math.max(maxW, Number(m.style?.width) || 0);
        maxH = Math.max(maxH, Number(m.style?.height) || 0);
      }
      return { maxW, maxH };
    }

    function applyGridLayout(
      group: CanvasNode,
      members: CanvasNode[],
    ): { positioned: Map<string, { x: number; y: number }>; width: number; height: number } {
      const count = members.length;
      const cols = Math.ceil(Math.sqrt(count));
      const rows = Math.ceil(count / cols);
      const { maxW, maxH } = measureMembers(members);
      const cellW = maxW + LAYOUT_GAP;
      const cellH = maxH + LAYOUT_GAP;
      const originX = group.position.x + GROUP_NODE_PADDING;
      const originY = group.position.y + NODE_TITLE_HEIGHT + GROUP_NODE_PADDING;

      const positioned = new Map<string, { x: number; y: number }>();
      members.forEach((m, i) => {
        const r = Math.floor(i / cols);
        const c = i % cols;
        positioned.set(m.id, { x: originX + c * cellW, y: originY + r * cellH });
      });

      const contentW = cols * cellW - LAYOUT_GAP;
      const contentH = rows * cellH - LAYOUT_GAP;
      const width = Math.max(GROUP_NODE_MIN_WIDTH, contentW + GROUP_NODE_PADDING * 2);
      const height = Math.max(GROUP_NODE_MIN_HEIGHT, contentH + NODE_TITLE_HEIGHT + GROUP_NODE_PADDING * 2);
      return { positioned, width, height };
    }

    function applyHorizontalLayout(
      group: CanvasNode,
      members: CanvasNode[],
    ): { positioned: Map<string, { x: number; y: number }>; width: number; height: number } {
      const { maxW, maxH } = measureMembers(members);
      const stepX = maxW + LAYOUT_GAP;
      const originX = group.position.x + GROUP_NODE_PADDING;
      const originY = group.position.y + NODE_TITLE_HEIGHT + GROUP_NODE_PADDING;

      const positioned = new Map<string, { x: number; y: number }>();
      members.forEach((m, i) => {
        positioned.set(m.id, {
          x: originX + i * stepX,
          y: originY + Math.max(0, (maxH - (Number(m.style?.height) || 0)) / 2),
        });
      });

      const contentW = members.length * stepX - LAYOUT_GAP;
      const contentH = maxH;
      const width = Math.max(GROUP_NODE_MIN_WIDTH, contentW + GROUP_NODE_PADDING * 2);
      const height = Math.max(GROUP_NODE_MIN_HEIGHT, contentH + NODE_TITLE_HEIGHT + GROUP_NODE_PADDING * 2);
      return { positioned, width, height };
    }

    function applyVerticalLayout(
      group: CanvasNode,
      members: CanvasNode[],
    ): { positioned: Map<string, { x: number; y: number }>; width: number; height: number } {
      const { maxW, maxH } = measureMembers(members);
      const stepY = maxH + LAYOUT_GAP;
      const originX = group.position.x + GROUP_NODE_PADDING;
      const originY = group.position.y + NODE_TITLE_HEIGHT + GROUP_NODE_PADDING;

      const positioned = new Map<string, { x: number; y: number }>();
      members.forEach((m, i) => {
        positioned.set(m.id, {
          x: originX + Math.max(0, (maxW - (Number(m.style?.width) || 0)) / 2),
          y: originY + i * stepY,
        });
      });

      const contentW = maxW;
      const contentH = members.length * stepY - LAYOUT_GAP;
      const width = Math.max(GROUP_NODE_MIN_WIDTH, contentW + GROUP_NODE_PADDING * 2);
      const height = Math.max(GROUP_NODE_MIN_HEIGHT, contentH + NODE_TITLE_HEIGHT + GROUP_NODE_PADDING * 2);
      return { positioned, width, height };
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

      const members = store.nodes.filter(
        (n) => n.type !== NODE_TYPE.GROUP && n.data.groupId === group.id
      );
      if (members.length === 0) return;

      let result: { positioned: Map<string, { x: number; y: number }>; width: number; height: number };
      switch (detail.mode) {
        case "vertical":
          result = applyVerticalLayout(group, members);
          break;
        case "horizontal":
          result = applyHorizontalLayout(group, members);
          break;
        case "grid":
        default:
          result = applyGridLayout(group, members);
          break;
      }
      const { positioned, width, height } = result;

      pushHistory(takeCanvasSnapshot());

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
  }, [pushHistory, addNodes]);
}
