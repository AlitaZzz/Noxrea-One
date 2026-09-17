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
import { isGenerating, LAYOUT_GAP, NODE_TYPE } from "@/lib/constants";

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
  // 选中组时自动带上其全部成员：复制组 = 复制整组内容（成员经粘贴重映射归新组）
  const selSet = new Set(selIds);
  const selectedGroupIds = new Set(
    nodes.filter((n) => n.type === NODE_TYPE.GROUP && selSet.has(n.id)).map((n) => n.id)
  );
  const expanded = selectedGroupIds.size
    ? nodes.filter((n) => {
        if (selSet.has(n.id)) return true;
        const gid = (n.data as { groupId?: string } | undefined)?.groupId;
        return n.type !== NODE_TYPE.GROUP && gid !== undefined && selectedGroupIds.has(gid);
      })
    : nodes.filter((n) => selSet.has(n.id));
  useSelectionStore.getState().copySelected(expanded);
  return true;
}

/**
 * 创建副本：等价于「复制 + 在原位置旁粘贴」，副本落在原选中内容右下方并保持选中。
 * 与 Ctrl+V 的区别：落点固定跟随原内容，不依赖光标位置。
 * 偏移量取 LAYOUT_GAP（与整理/网格间距同约定）：节点尺寸普遍 200px+，
 * 偏移过小副本与原件几乎完全重叠；连续 Ctrl+D 时以副本为基准继续偏移，
 * 自然形成 LAYOUT_GAP 步进的斜向级联（Figma 同款行为）。
 * @returns 是否实际执行
 */
export function duplicateSelection(): boolean {
  const selIds = getSelectedNodeIds();
  if (selIds.length === 0) return false;
  const selSet = new Set(selIds);
  const sel = useCanvasStore.getState().nodes.filter((n) => selSet.has(n.id));
  const minX = Math.min(...sel.map((n) => n.position.x));
  const minY = Math.min(...sel.map((n) => n.position.y));
  if (!copySelection()) return false;
  return pasteClipboard({ x: minX + LAYOUT_GAP, y: minY + LAYOUT_GAP });
}

/**
 * 把图片节点的内容写入系统剪贴板（PNG），供粘贴到画布外应用（微信 / 文档等）。
 * 统一经 canvas 转码为 PNG——ClipboardItem 对 png 支持最广，jpeg/webp 兼容性参差。
 * @returns 是否成功（权限拒绝 / 加载失败返回 false，调用方负责提示）
 */
export async function copyImageSrcToClipboard(src: string): Promise<boolean> {
  try {
    const img = new Image();
    img.crossOrigin = "anonymous";
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("image load failed"));
      img.src = src;
    });
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    canvas.getContext("2d")?.drawImage(img, 0, 0);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) return false;
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    return true;
  } catch {
    return false;
  }
}

/**
 * 粘贴画布剪贴板：派生新节点 → 落位 → 选中新节点。
 *
 * @param at 目标画布坐标（粘贴内容的包围盒左上角）。保持剪贴板内各节点的
 *           相对布局、整体平移到该点——键盘 Ctrl+V 传光标处（不在画布上时
 *           传视口中心），右键菜单传右键落点。
 * @returns 是否实际执行了粘贴
 */
export function pasteClipboard(at: { x: number; y: number }): boolean {
  const clip = useSelectionStore.getState().clipboard;
  if (!clip || clip.nodes.length === 0) return false;

  // 以 at 为基准整体平移，保持内部相对布局不被打乱
  const minX = Math.min(...clip.nodes.map((n) => n.position.x));
  const minY = Math.min(...clip.nodes.map((n) => n.position.y));
  let newNodes: AnyNode[] = clip.nodes.map((n) => {
    const cloned = duplicateNode(n, { x: 0, y: 0 });
    cloned.position = {
      x: at.x + (n.position.x - minX),
      y: at.y + (n.position.y - minY),
    };
    return cloned;
  });

  // 重映射组归属：剪贴板内含组节点时，成员副本指向粘贴出的新组；
  // 原组不在本次剪贴板内则解除归属，避免副本「串」到画布上的原组
  // （否则拖原组会带着粘贴副本跑、原组成员计数虚增）。
  const groupIdMap = new Map<string, string>();
  clip.nodes.forEach((orig, i) => {
    if (orig.type === NODE_TYPE.GROUP) groupIdMap.set(orig.id, newNodes[i].id);
  });
  newNodes = newNodes.map((n) => {
    if (n.type === NODE_TYPE.GROUP) return n;
    const gid = (n.data as { groupId?: string } | undefined)?.groupId;
    if (!gid) return n;
    const mapped = groupIdMap.get(gid);
    if (mapped) {
      return { ...n, data: { ...n.data, groupId: mapped } } as AnyNode;
    }
    const { groupId: _omit, ...rest } = n.data as Record<string, unknown>;
    return { ...n, data: rest } as AnyNode;
  });

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

/** 是否存在生成/处理中的节点（用于禁止撤销/重做，避免波及生成中节点）。
    导出给键盘层：拦截发生时给出提示，而不是静默吞掉快捷键。 */
export function hasGeneratingNode(): boolean {
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
