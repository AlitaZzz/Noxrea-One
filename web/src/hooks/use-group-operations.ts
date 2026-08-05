/**
 * 节点编组 / 取消编组 hook。
 * 监听编组事件，计算包围盒、转换子节点相对坐标并维护父子关系与历史快照。
 */
"use client";

import { useEffect } from "react";

import { createGroupNode } from "@/features/canvas/node-defaults";
import { EventNames, GROUP_NODE_PADDING, NODE_TYPE } from "@/lib/constants";
import { markDirtyImmediate,takeCanvasSnapshot, useCanvasStore } from "@/stores/canvas-store";
import { useHistoryStore } from "@/stores/history-store";

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
      // Move selected nodes to be children of the group
      const updatedNodes = store.nodes.map((n) => {
        if (selected.find((s) => s.id === n.id)) {
          return {
            ...n,
            parentId: groupNode.id,
            position: {
              x: n.position.x - groupX,
              y: n.position.y - groupY,
            },
            extent: "parent" as const,
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
        const groupX = group.position.x;
        const groupY = group.position.y;

        // Move children back to absolute positions
        newNodes = newNodes.map((n) => {
          if (n.parentId === group.id) {
            return {
              ...n,
              parentId: undefined,
              extent: undefined,
              position: {
                x: n.position.x + groupX,
                y: n.position.y + groupY,
              },
            };
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
