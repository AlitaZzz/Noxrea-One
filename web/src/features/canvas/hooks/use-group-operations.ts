/**
 * 节点编组 / 取消编组 hook。
 * 监听编组事件，计算包围盒并为子节点打上 groupId 逻辑归属标记（坐标保持绝对，
 * 不再使用 React Flow 的 parentId / 相对坐标嵌套）。
 */
"use client";

import { useEffect } from "react";

import { createGroupNode } from "@/features/canvas/node-defaults";
import { EventNames, GROUP_NODE_PADDING, NODE_TYPE } from "@/lib/constants";
import { markDirtyImmediate,takeCanvasSnapshot, useCanvasStore } from "@/features/canvas/stores/canvas-store";
import { useHistoryStore } from "@/features/canvas/stores/history-store";

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
      const updatedNodes = store.nodes.map((n) => {
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
        newNodes = newNodes.map((n) => {
          if (n.data?.groupId === group.id) {
            const { groupId: _omit, ...restData } = n.data as Record<string, unknown> & { groupId?: string };
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

    window.addEventListener(EventNames.CANVAS_GROUP_NODES, onGroupNodes);
    window.addEventListener(EventNames.CANVAS_UNGROUP_NODES, onUngroupNodes);
    return () => {
      window.removeEventListener(EventNames.CANVAS_GROUP_NODES, onGroupNodes);
      window.removeEventListener(EventNames.CANVAS_UNGROUP_NODES, onUngroupNodes);
    };
  }, [pushHistory, addNodes]);
}
