/**
 * 画布编辑动作：复制 / 粘贴 / 全选 / 删除 / 撤销 / 重做（操作目标为节点与连线）。
 *
 * 与输入框内的「文本剪贴板操作」是两回事：
 * 这里的复制写入 useSelectionStore 的内存剪贴板，粘贴由剪贴板中的节点派生出新节点落位，
 * 全程不触碰浏览器剪贴板 API，因此不受 clipboard-read 权限等限制。
 *
 * 抽成独立模块供键盘快捷键（use-canvas-keyboard）与画布菜单（CanvasContextMenu）共用，
 * 避免两处实现各自漂移；各动作返回是否实际执行，供调用方决定 preventDefault 等行为。
 */
"use client";

import { duplicateNode } from "@/features/canvas/node-defaults";
import { markDirtyImmediate, markDirtyUndo, takeCanvasSnapshot, useCanvasStore } from "@/features/canvas/stores/canvas-store";
import { useHistoryStore } from "@/features/canvas/stores/history-store";
import { useSelectionStore } from "@/features/canvas/stores/selection-store";
import type { AnyNode, MediaGenFields } from "@/features/canvas/types";
import type { HistorySnapshot } from "@/features/project/types";
import { isGenerating, PASTE_OFFSET } from "@/lib/constants";

/** 当前选中的节点 id */
export function getSelectedNodeIds(): string[] {
  return useCanvasStore
    .getState()
    .nodes.filter((n) => n.selected)
    .map((n) => n.id);
}

/** 当前选中的边 id */
export function getSelectedEdgeIds(): string[] {
  return useCanvasStore
    .getState()
    .edges.filter((e) => e.selected)
    .map((e) => e.id);
}

/** 复制当前选中节点到画布剪贴板。@returns 是否实际执行了复制 */
export function copySelection(): boolean {
  const selIds = getSelectedNodeIds();
  if (selIds.length === 0) return false;
  const nodes = useCanvasStore.getState().nodes;
  useSelectionStore.getState().copySelected(nodes.filter((n) => selIds.includes(n.id)));
  return true;
}

/**
 * 粘贴画布剪贴板：派生新节点 → 落位 → 选中新节点。
 *
 * @param at 目标画布坐标（粘贴内容的包围盒左上角）。
 *           传入时保持剪贴板内各节点的相对布局、整体平移到该点，
 *           用于右键菜单的「粘贴到此处」；
 *           省略时沿用 PASTE_OFFSET 相对偏移，用于键盘 Ctrl+V。
 * @returns 是否实际执行了粘贴
 */
export function pasteClipboard(at?: { x: number; y: number }): boolean {
  const clip = useSelectionStore.getState().clipboard;
  if (!clip || clip.nodes.length === 0) return false;

  let newNodes: AnyNode[];
  if (at) {
    // 以剪贴板内容的包围盒左上角为基准整体平移，保持内部相对布局不被打乱
    const minX = Math.min(...clip.nodes.map((n) => n.position.x));
    const minY = Math.min(...clip.nodes.map((n) => n.position.y));
    newNodes = clip.nodes.map((n) => {
      const cloned = duplicateNode(n, { x: 0, y: 0 });
      cloned.position = {
        x: at.x + (n.position.x - minX),
        y: at.y + (n.position.y - minY),
      };
      return cloned;
    });
  } else {
    newNodes = clip.nodes.map((n) => duplicateNode(n, PASTE_OFFSET));
  }

  useCanvasStore.getState().addNodes(newNodes);
  // 粘贴后选中新节点，与键盘 Ctrl+V 行为保持一致
  const latest = useCanvasStore.getState();
  latest.setNodes(
    latest.nodes.map((n) => ({ ...n, selected: newNodes.some((nn) => nn.id === n.id) })),
  );
  markDirtyImmediate();
  return true;
}

/** 全选画布节点 */
export function selectAllNodes(): void {
  const store = useCanvasStore.getState();
  if (store.nodes.length === 0) return;
  store.setNodes(store.nodes.map((n) => ({ ...n, selected: true })));
}

/** 删除当前选中的节点与连线 */
export function deleteSelection(): void {
  const nodeIds = getSelectedNodeIds();
  const edgeIds = getSelectedEdgeIds();
  if (nodeIds.length === 0 && edgeIds.length === 0) return;

  const store = useCanvasStore.getState();
  if (nodeIds.length > 0) store.removeNodes(nodeIds);
  if (edgeIds.length > 0) store.removeEdges(edgeIds);
}

/** 是否存在生成/处理中的节点（用于禁止撤销/重做，避免波及生成中节点） */
function hasGeneratingNode(): boolean {
  return useCanvasStore
    .getState()
    .nodes.some((n) => isGenerating((n.data as MediaGenFields).taskBinding));
}

/** 把历史快照恢复为画布当前状态（节点/边去选中，避免遗留悬空选区） */
function restoreSnapshot(snapshot: HistorySnapshot): void {
  const s = useCanvasStore.getState();
  s.setNodes(snapshot.nodes.map((n) => ({ ...n, selected: false })));
  s.setEdges(snapshot.edges.map((e) => ({ ...e, selected: false })), { skipHistory: true });
  s.setViewport(snapshot.viewport);
  s.setBackground(snapshot.background);
  s.setTheme(snapshot.theme);
  if (snapshot.minimapVisible !== undefined) useCanvasStore.setState({ minimapVisible: snapshot.minimapVisible });
  if (snapshot.snapToGrid !== undefined) useCanvasStore.setState({ snapToGrid: snapshot.snapToGrid });
  markDirtyUndo();
}

/** 撤销：恢复到最近一次改动前的状态。@returns 是否实际执行了撤销 */
export function undoAction(): boolean {
  // 生成期间禁止撤销：undo 全局快照会波及生成中节点的 taskBinding，
  // 导致 SSE 结果落在过期节点上或白等后 scanAndConnect 复活僵尸任务
  if (hasGeneratingNode()) return false;
  // 先捕获现场快照（进 redoStack，供 redo 回到撤销前），再弹出恢复目标
  const prev = useHistoryStore.getState().undo(takeCanvasSnapshot());
  if (!prev) return false;
  restoreSnapshot(prev);
  return true;
}

/** 重做：回到撤销前的现场状态。@returns 是否实际执行了重做 */
export function redoAction(): boolean {
  if (hasGeneratingNode()) return false;
  // 先捕获现场快照（存回 undoStack，保证 redo 后还能再 undo），再弹出恢复目标
  const next = useHistoryStore.getState().redo(takeCanvasSnapshot());
  if (!next) return false;
  restoreSnapshot(next);
  return true;
}
