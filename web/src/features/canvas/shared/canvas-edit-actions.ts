/**
 * 画布编辑动作：复制 / 粘贴 / 全选 / 删除（操作目标为节点与连线）。
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
import { markDirtyImmediate, useCanvasStore } from "@/features/canvas/stores/canvas-store";
import { useSelectionStore } from "@/features/canvas/stores/selection-store";
import { PASTE_OFFSET } from "@/lib/constants";

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
 * @returns 是否实际执行了粘贴
 */
export function pasteClipboard(): boolean {
  const clip = useSelectionStore.getState().clipboard;
  if (!clip || clip.nodes.length === 0) return false;

  const newNodes = clip.nodes.map((n) => duplicateNode(n, PASTE_OFFSET));
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
