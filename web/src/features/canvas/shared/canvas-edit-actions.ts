/**
 * 画布编辑动作：复制 / 粘贴 / 全选 / 删除 / 撤销 / 重做（操作目标为节点与连线）。
 *
 * 剪贴板语义分两层：
 * - 内部剪贴板（useSelectionStore）：复制节点写入，右键菜单「粘贴」消费，免权限；
 * - 系统剪贴板：复制节点同步写入带标记的节点 JSON、复制图片写入 PNG 位图；
 *   键盘 Ctrl+V 走原生 paste 事件免权限读取，按「图片 → 节点 JSON → 文本」
 *   智能分流；右键菜单在内部剪贴板为空时主动 read()（需一次授权）。
 *
 * 抽成独立模块供键盘快捷键（use-canvas-keyboard）与画布菜单（CanvasContextMenu）共用，
 * 避免两处实现各自漂移；各动作返回是否实际执行，供调用方决定 preventDefault 等行为。
 */
"use client";

import { runSuppressed } from "@/features/canvas/agent/user-action-tracker";
import { cancelTidyAnimation } from "@/features/canvas/hooks/use-tidy-animation";
import { createTextNode, duplicateNode } from "@/features/canvas/node-defaults";
import { markDirtyImmediate, markDirtyUndo, takeCanvasSnapshot, useCanvasStore } from "@/features/canvas/stores/canvas-store";
import { useHistoryStore } from "@/features/canvas/stores/history-store";
import { useSelectionStore } from "@/features/canvas/stores/selection-store";
import type { AnyNode, MediaGenFields } from "@/features/canvas/types";
import { createNodesFromFiles } from "@/features/canvas/upload";
import type { HistorySnapshot } from "@/features/project/types";
import { isGenerating, LAYOUT_GAP, NODE_TYPE } from "@/lib/constants";
import i18n from "@/lib/i18n/config";

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

/**
 * 是否有媒体编辑面板打开中（标注 / 裁剪 / 选帧 / 片段截取 / 音频片段截取 / 打光 / 多视角）。
 * 键盘作用域所有权：面板打开时画布整体让出键盘——RF 的选中节点方向键移动
 * （disableKeyboardA11y）与画布全局快捷键（use-canvas-keyboard）都以此为准，
 * 各编辑面板自己的按键监听不经过此判断、始终生效。
 */
export function isMediaEditorOpen(): boolean {
  const s = useCanvasStore.getState();
  return !!(s.annotatingNodeId || s.croppingNodeId || s.frameCaptureNodeId || s.clipCaptureNodeId || s.audioClipNodeId || s.lightingNodeId || s.angleEditorNodeId);
}

/** 复制到系统剪贴板的节点 JSON 前缀标记：粘贴时据此识别「我们复制的节点」 */
export const CLIPBOARD_NODE_MARKER = "noxrea-nodes:";

/**
 * 方向键移动选中节点（画布键盘 hook 的方向键分支调用）。
 * 与 RF a11y 行为对齐：步长 5px，Shift ×4；开启网格吸附时按网格步长。
 * 不依赖焦点——RF 的 a11y 焦点路径（nodesFocusable/disableKeyboardA11y）已永久关闭。
 * @returns 是否有选中节点被移动
 */
export function nudgeSelectedNodes(direction: { x: number; y: number }, factor: number): boolean {
  const s = useCanvasStore.getState();
  const selected = s.nodes.filter((n) => n.selected);
  if (selected.length === 0) return false;
  const step = s.snapToGrid ? s.snapGridSize : 5;
  const dx = direction.x * step * factor;
  const dy = direction.y * step * factor;
  if (dx === 0 && dy === 0) return false;
  const ids = new Set(selected.map((n) => n.id));
  s.setNodes(
    s.nodes.map((n) =>
      ids.has(n.id) ? { ...n, position: { x: n.position.x + dx, y: n.position.y + dy } } : n
    )
  );
  markDirtyImmediate();
  return true;
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
  // 节点 JSON 同步写入系统剪贴板（带标记）：Ctrl+V 走原生 paste 事件可免权限读取，
  // 并支持跨标签页还原节点。clipboard-write 在安全上下文默认放行，失败静默忽略。
  void navigator.clipboard
    ?.writeText(CLIPBOARD_NODE_MARKER + JSON.stringify(expanded))
    .catch(() => {});
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
  return pasteNodes(clip.nodes, at);
}

/**
 * 从系统剪贴板文本还原节点并粘贴：识别 copySelection 写入的带标记 JSON。
 * 同时把解析结果同步进内部剪贴板，使右键菜单「粘贴」与后续行为保持一致。
 * @returns 是否识别并粘贴成功（非标记文本 / 解析失败返回 false）
 */
export function pasteNodesFromClipboardJson(text: string, at: { x: number; y: number }): boolean {
  if (!text.startsWith(CLIPBOARD_NODE_MARKER)) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(CLIPBOARD_NODE_MARKER.length));
  } catch {
    return false;
  }
  if (!Array.isArray(parsed)) return false;
  const nodes = parsed.filter(
    (n): n is AnyNode =>
      !!n &&
      typeof n === "object" &&
      typeof (n as { id?: unknown }).id === "string" &&
      !!(n as { position?: { x?: unknown; y?: unknown } }).position
  );
  if (nodes.length === 0) return false;
  useSelectionStore.getState().copySelected(nodes);
  return pasteNodes(nodes, at);
}

/**
 * 粘贴核心：以剪贴板节点为源派生新节点（新 id、剥离瞬时状态、组归属重映射）、
 * 整体平移到 at 落位并选中。
 */
function pasteNodes(clipNodes: AnyNode[], at: { x: number; y: number }): boolean {
  if (clipNodes.length === 0) return false;

  // 以 at 为基准整体平移，保持内部相对布局不被打乱
  const minX = Math.min(...clipNodes.map((n) => n.position.x));
  const minY = Math.min(...clipNodes.map((n) => n.position.y));
  let newNodes: AnyNode[] = clipNodes.map((n) => {
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
  clipNodes.forEach((orig, i) => {
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

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * 用纯文本创建文本节点（系统剪贴板粘贴的文本分支）。
 * content 存段落化的富文本 HTML（供 Tiptap 编辑），plainText 存原文（供下游消费）。
 */
export function createTextNodeWithContent(text: string, at: { x: number; y: number }): AnyNode {
  const node = createTextNode(at);
  const html = text
    .split(/\n{2,}/)
    .map((para) => `<p>${para.split("\n").map(escapeHtml).join("<br>")}</p>`)
    .join("");
  (node.data as { content: string; plainText: string }).content = html;
  (node.data as { content: string; plainText: string }).plainText = text;
  useCanvasStore.getState().addNodes([node]);
  const latest = useCanvasStore.getState();
  latest.setNodes(latest.nodes.map((n) => ({ ...n, selected: n.id === node.id })));
  markDirtyImmediate();
  return node;
}

/**
 * 智能粘贴核心：按「图片 → 节点 JSON → 文本 → 内部剪贴板兜底」顺序消费剪贴板内容。
 * 键盘原生 paste 事件与右键菜单（主动读取系统剪贴板）共用此入口。
 * @returns 是否实际执行了粘贴
 */
export function pasteFromClipboardContent(
  content: { imageFiles: File[]; text: string },
  at: { x: number; y: number }
): boolean {
  if (content.imageFiles.length > 0) {
    void createNodesFromFiles(content.imageFiles, at);
    return true;
  }
  const text = content.text ?? "";
  // 节点 JSON：解析失败时返回 false 且不降级为文本节点（内部 JSON 串贴成文本没有意义）
  if (text.startsWith(CLIPBOARD_NODE_MARKER)) {
    return pasteNodesFromClipboardJson(text, at);
  }
  const trimmed = text.trim();
  if (trimmed) {
    createTextNodeWithContent(trimmed, at);
    return true;
  }
  // 系统剪贴板无内容（如复制节点时写入系统剪贴板失败）：回退内部剪贴板
  return pasteClipboard(at);
}

/**
 * 读取系统剪贴板内容（右键菜单粘贴用；键盘 paste 事件路径无需此函数、免权限）。
 * read() 需要剪贴板读取权限（浏览器弹一次授权），Firefox 不支持 read() 时
 * 降级 readText() 只取文本。全部失败返回 null，由调用方提示改用 Ctrl+V。
 */
export async function readSystemClipboard(): Promise<{ imageFiles: File[]; text: string } | null> {
  try {
    if (navigator.clipboard?.read) {
      const imageFiles: File[] = [];
      let text = "";
      for (const item of await navigator.clipboard.read()) {
        const imageType = item.types.find((t) => t.startsWith("image/"));
        if (imageType) {
          const blob = await item.getType(imageType);
          // 文件名会成为节点标题，走 i18n；扩展名按 MIME 推断供下游识别
          const ext = imageType.split("/")[1]?.replace("jpeg", "jpg") ?? "png";
          const name = `${i18n.t("node.clipboardImage")}.${ext}`;
          imageFiles.push(new File([blob], name, { type: imageType }));
          continue;
        }
        if (item.types.includes("text/plain")) {
          text = await (await item.getType("text/plain")).text();
        }
      }
      return { imageFiles, text };
    }
    if (navigator.clipboard?.readText) {
      return { imageFiles: [], text: await navigator.clipboard.readText() };
    }
  } catch {
    // 权限被拒 / 浏览器不支持
  }
  return null;
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
  // 整理动画每帧都在写节点位置，先停掉，否则下一帧会覆盖恢复出的布局
  cancelTidyAnimation();
  // 撤销/重做是程序化恢复，不算用户对画布内容做的增量修改，不进动作历史
  runSuppressed(() => {
    const s = useCanvasStore.getState();
    s.setNodes(snapshot.nodes.map((n) => ({ ...n, selected: false })));
    s.setEdges(snapshot.edges.map((e) => ({ ...e, selected: false })), { skipHistory: true });
    s.setViewport(snapshot.viewport);
    s.setBackground(snapshot.background);
    if (snapshot.minimapVisible !== undefined) useCanvasStore.setState({ minimapVisible: snapshot.minimapVisible });
    if (snapshot.snapToGrid !== undefined) useCanvasStore.setState({ snapToGrid: snapshot.snapToGrid });
  });
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
