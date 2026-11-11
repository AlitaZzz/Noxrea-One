/**
 * 画布编辑动作：复制 / 粘贴 / 全选 / 清空选中 / 删除 / 撤销 / 重做（操作目标为节点与连线）。
 *
 * 剪贴板语义分两层：
 * - 内部剪贴板（useSelectionStore）：复制节点写入规范快照（含外部上游边），
 *   创建副本与系统读取失败时消费，免权限；
 * - 系统剪贴板：复制节点写入 Noxrea 自定义格式 + HTML 镜像（纯文本选择另写
 *   text/plain），复制图片写入 PNG 位图。键盘 Ctrl+V 优先同步解析 paste
 *   事件，事件看不到自定义格式时回退 read()；右键菜单主动 read()（需一次授权）。
 *
 * 节点 JSON 永不进入 text/plain：任何输入框、富文本与 Agent 输入区都只会
 * 收到可读文本或空内容（见 specs/canvas-clipboard.md）。
 *
 * 抽成独立模块供键盘快捷键（use-canvas-keyboard）与画布菜单（CanvasContextMenu）共用，
 * 避免两处实现各自漂移；各动作返回是否实际执行，供调用方决定 preventDefault 等行为。
 */
"use client";

import { runSuppressed } from "@/features/canvas/agent/user-action-tracker";
import { cancelTidyAnimation } from "@/features/canvas/hooks/use-tidy-animation";
import { createEdge, createTextNode, duplicateNode } from "@/features/canvas/node-defaults";
import {
  type CanvasClipboardEdge,
  type CanvasClipboardNode,
  createCanvasClipboardPayload,
  parseCanvasClipboard,
  sanitizeEdgeForClipboard,
  sanitizeNodeForClipboard,
  textOnlyPlainText,
} from "@/features/canvas/shared/canvas-clipboard-format";
import {
  type CanvasClipboardWriteResult,
  type ClipboardPasteContent,
  writeCanvasClipboard,
} from "@/features/canvas/shared/canvas-system-clipboard";
import { nodeAcceptsInput } from "@/features/canvas/shared/connection-rules";
import { toAbsoluteNodes } from "@/features/canvas/shared/group-bounds";
import { isGroupNode, memberParentId } from "@/features/canvas/shared/group-membership";
import { applySelection, updateSelection } from "@/features/canvas/shared/selection";
import { textToTiptapHtml } from "@/features/canvas/shared/text-to-html";
import type { CanvasState } from "@/features/canvas/stores/canvas-store";
import { markDirtyImmediate, markDirtyUndo, pushHistoryThrottled, takeCanvasSnapshot, useCanvasStore, withHistoryBatch } from "@/features/canvas/stores/canvas-store";
import { MEDIA_EDITOR_NODE_ID_KEYS, NODE_UI_STATE_KEYS } from "@/features/canvas/stores/canvas-store";
import { useHistoryStore } from "@/features/canvas/stores/history-store";
import { useSelectionStore } from "@/features/canvas/stores/selection-store";
import type { AnyEdge, AnyNode, MediaGenFields } from "@/features/canvas/types";
import type { HistorySnapshot } from "@/features/canvas/types";
import { createNodesFromFiles } from "@/features/canvas/upload";
import { canConnect, isGenerating, LAYOUT_GAP } from "@/lib/constants";
import { loadMediaImage } from "@/lib/load-media-image";

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
 * 媒体编辑面板当前节点 id（无面板打开时为 null）：标注 / 裁剪 / 选帧 /
 * 片段截取 / 音频片段截取 / 打光 / 多视角 / 全景。
 * 键盘作用域所有权：面板打开时画布整体让出键盘——RF 的选中节点方向键移动
 * （disableKeyboardA11y）与画布全局快捷键（use-canvas-keyboard）都以此为准，
 * 各编辑面板自己的按键监听不经过此判断、始终生效。
 * 响应式订阅（画布让权、右键菜单 disabled 派生）与命令式判断共用此清单。
 * 键集由 MEDIA_EDITOR_NODE_ID_KEYS 维护（NODE_UI_STATE_KEYS 去掉文本编辑与
 * 多选展开：文本编辑态 Ctrl+Z 必须路由到画布级撤销，多选展开不是编辑浮层）。
 */
export function selectMediaEditorNodeId(s: CanvasState): string | null {
  for (const key of MEDIA_EDITOR_NODE_ID_KEYS) {
    const nodeId = s[key];
    if (nodeId) return nodeId;
  }
  return null;
}

export function isMediaEditorOpenState(s: CanvasState): boolean {
  return selectMediaEditorNodeId(s) !== null;
}

export function isMediaEditorOpen(): boolean {
  return isMediaEditorOpenState(useCanvasStore.getState());
}

/** 规范化快照与 React Flow 节点模型的边界：载荷已按类型契约校验，运行时字段均可选 */
function toCanvasNodes(nodes: CanvasClipboardNode[]): AnyNode[] {
  return nodes as unknown as AnyNode[];
}

function toCanvasEdges(edges: CanvasClipboardEdge[]): AnyEdge[] {
  return edges as unknown as AnyEdge[];
}

/**
 * 方向键移动选中节点（画布键盘 hook 的方向键分支调用）。
 * 与 RF a11y 行为对齐：步长 5px，Shift ×4；吸附总开关开启时按网格步长。
 * 不依赖焦点——RF 的 a11y 焦点路径（nodesFocusable/disableKeyboardA11y）已永久关闭。
 * @returns 是否有选中节点被移动
 */
export function nudgeSelectedNodes(direction: { x: number; y: number }, factor: number): boolean {
  const s = useCanvasStore.getState();
  const selected = s.nodes.filter((n) => n.selected);
  if (selected.length === 0) return false;
  const step = s.snapEnabled ? s.snapGridSize : 5;
  const dx = direction.x * step * factor;
  const dy = direction.y * step * factor;
  if (dx === 0 && dy === 0) return false;
  const ids = new Set(selected.map((n) => n.id));
  // 整段连续微调合并为一条撤销：首次微调压「微调前」快照，窗口内的后续微调并入
  pushHistoryThrottled();
  s.setNodes(
    s.nodes.map((n) =>
      ids.has(n.id) ? { ...n, position: { x: n.position.x + dx, y: n.position.y + dy } } : n
    )
  );
  markDirtyImmediate();
  return true;
}

/**
 * 选择快照：复制与创建副本的唯一选择口径。
 *
 * 1. 选中组自动展开全部直接成员；
 * 2. 父组不在快照内的成员换算为世界坐标并删除 parentId（单独复制成员不会
 *    按组内相对坐标错位）；
 * 3. 生成规范节点/连线（只保留可迁移字段，剥离运行时与瞬时状态）；
 * 4. 连线取任一端在选中集内的全部相关边：内部剪贴板据此还原上游关系，
 *    系统载荷只取两端都在集内的边。
 */
function collectSelectionSnapshot(): {
  nodes: CanvasClipboardNode[];
  edges: CanvasClipboardEdge[];
} | null {
  const selIds = getSelectedNodeIds();
  if (selIds.length === 0) return null;
  const state = useCanvasStore.getState();
  const canvasNodes = state.nodes;
  const selSet = new Set(selIds);
  const selectedGroupIds = new Set(
    canvasNodes.filter((n) => isGroupNode(n) && selSet.has(n.id)).map((n) => n.id),
  );
  const expanded = selectedGroupIds.size
    ? canvasNodes.filter((n) => {
        const parentId = memberParentId(n);
        return selSet.has(n.id) || (parentId !== undefined && selectedGroupIds.has(parentId));
      })
    : canvasNodes.filter((n) => selSet.has(n.id));
  const expandedIds = new Set(expanded.map((n) => n.id));

  // 防御损坏数据：空组不能进入载荷（导入侧会整包拒绝）。正常 store 不变量
  // 下组必有成员，这里只影响已被破坏的现场
  const memberCounts = new Map<string, number>();
  for (const node of expanded) {
    const parentId = memberParentId(node);
    if (parentId !== undefined && expandedIds.has(parentId)) {
      memberCounts.set(parentId, (memberCounts.get(parentId) ?? 0) + 1);
    }
  }
  const exportable = expanded.filter(
    (node) => !isGroupNode(node) || (memberCounts.get(node.id) ?? 0) > 0,
  );
  if (exportable.length === 0) return null;
  const exportableIds = new Set(exportable.map((n) => n.id));
  const canvasById = new Map(canvasNodes.map((n) => [n.id, n] as const));
  const absoluteById = new Map(
    toAbsoluteNodes(canvasNodes).map((n) => [n.id, n.position] as const),
  );

  const nodes = exportable.map((node) => {
    const sanitized = sanitizeNodeForClipboard(node);
    const parentId = memberParentId(node);
    if (parentId !== undefined) {
      const parent = canvasById.get(parentId);
      if (!exportableIds.has(parentId) || !parent || !isGroupNode(parent)) {
        // 父组不在复制范围（或归属数据已损坏）：展平为世界坐标
        const absolute = absoluteById.get(node.id);
        if (absolute) sanitized.position = { x: absolute.x, y: absolute.y };
        delete sanitized.parentId;
      }
    }
    return sanitized;
  });

  // 任一端在选中集内的连线都保留在内部快照；系统载荷由
  // createCanvasClipboardPayload 过滤为两端都在载荷内的边
  const edges = state.edges
    .filter((edge) => expandedIds.has(edge.source) || expandedIds.has(edge.target))
    .map(sanitizeEdgeForClipboard);

  return { nodes, edges };
}

/**
 * 复制当前选中节点到画布剪贴板。
 * @param onSystemWriteResult 系统剪贴板写入结果回调（React 调用方经
 *        useCanvasClipboardFeedback 提供统一提示）；内部剪贴板始终已更新。
 * @returns 是否实际执行了复制
 */
export function copySelection(
  onSystemWriteResult?: (result: CanvasClipboardWriteResult) => void,
): boolean {
  const snapshot = collectSelectionSnapshot();
  if (!snapshot) return false;

  // 内部剪贴板只保存规范快照（data 已深拷贝，不再共享 store 引用）
  useSelectionStore
    .getState()
    .copySelected(toCanvasNodes(snapshot.nodes), toCanvasEdges(snapshot.edges));

  // 系统载荷只含内部连线；纯文本选择才附带可读 text/plain。
  // writeCanvasClipboard 在首次 await 前同步调用 clipboard.write，保持用户手势。
  const payload = createCanvasClipboardPayload(snapshot.nodes, snapshot.edges);
  const plainText = textOnlyPlainText(snapshot.nodes);
  void writeCanvasClipboard(payload, plainText).then(
    (result) => onSystemWriteResult?.(result),
    () => onSystemWriteResult?.({ ok: false, reason: "rejected" }),
  );
  return true;
}

/**
 * 创建副本：等价于「复制 + 在原位置旁粘贴」，副本落在原选中内容右下方并保持选中。
 * 与 Ctrl+V 的区别：落点固定跟随原内容，不依赖光标位置。
 * 偏移量取 LAYOUT_GAP（与整理/网格间距同约定）：节点尺寸普遍 200px+，
 * 偏移过小副本与原件几乎完全重叠；连续 Ctrl+D 时以副本为基准继续偏移，
 * 自然形成 LAYOUT_GAP 步进的斜向级联（Figma 同款行为）。
 *
 * 直接使用选择快照，不写系统剪贴板，也不修改已存在的内部剪贴板。
 * @returns 是否实际执行
 */
export function duplicateSelection(): boolean {
  const snapshot = collectSelectionSnapshot();
  if (!snapshot) return false;
  // 落点基准取选中内容的绝对包围盒左上角（成员 position 是组内相对坐标）
  const absSel = toAbsoluteNodes(toCanvasNodes(snapshot.nodes));
  const minX = Math.min(...absSel.map((n) => n.position.x));
  const minY = Math.min(...absSel.map((n) => n.position.y));
  // 副本只保留上游连线（含集内边），下游外部连线不还原——副本是开新分支
  return pasteNodes(
    toCanvasNodes(snapshot.nodes),
    toCanvasEdges(snapshot.edges),
    { x: minX + LAYOUT_GAP, y: minY + LAYOUT_GAP },
    { includeExternalEdges: true },
  );
}

/**
 * 把图片节点的内容写入系统剪贴板（PNG），供粘贴到画布外应用（微信 / 文档等）。
 * 统一经 canvas 转码为 PNG——ClipboardItem 对 png 支持最广，jpeg/webp 兼容性参差。
 * @returns 是否成功（权限拒绝 / 加载失败返回 false，调用方负责提示）
 */
export async function copyImageSrcToClipboard(src: string): Promise<boolean> {
  try {
    // 画布数据里是存储 key；位图经访问解析直连（S3 签名 URL / local 应用流式）。
    // 动作时现取地址，元素失败按规则 3.6 刷新一次
    const img = await loadMediaImage(src);
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
 * @param options.includeExternalEdges 副本（创建副本/Ctrl+D）传 true：
 *           额外还原上游外部边（集外节点 → 副本）。普通粘贴默认 false：
 *           只还原两端都在剪贴板内的边，不继承外部关系。
 * @returns 是否实际执行了粘贴
 */
export function pasteClipboard(
  at: { x: number; y: number },
  options?: { includeExternalEdges?: boolean },
): boolean {
  const clip = useSelectionStore.getState().clipboard;
  if (!clip || clip.nodes.length === 0) return false;
  return pasteNodes(clip.nodes, clip.edges, at, options);
}

/**
 * 从系统载荷 JSON 还原节点并粘贴：整包校验通过后才写入内部剪贴板与画布。
 * 解析失败不产生任何副作用（画布、历史、内部剪贴板均不变）。
 * @returns 是否识别并粘贴成功
 */
function pasteCanvasClipboardJson(json: string, at: { x: number; y: number }): boolean {
  const parsed = parseCanvasClipboard(json);
  if (!parsed.ok) return false;
  const nodes = toCanvasNodes(parsed.payload.nodes);
  const edges = toCanvasEdges(parsed.payload.edges);
  useSelectionStore.getState().copySelected(nodes, edges);
  return pasteNodes(nodes, edges, at);
}

/**
 * 粘贴核心：以剪贴板节点为源派生新节点（新 id、剥离瞬时状态、parentId 重映射）、
 * 整体平移到 at 落位并选中；相关连线还原——集内端点指向副本，副本模式额外
 * 还原上游外部边（集外 source 指向原节点），跨画布不存在的端点丢弃该边。
 *
 * 落位语义（Sub Flow 模型）：剪贴板内成员的 position 是组内相对坐标，包围盒与
 * 平移在绝对坐标空间计算；父组在剪贴板内时成员保持相对坐标（视觉随新父落位），
 * 原父不在剪贴板内则成员展平为顶层（按绝对坐标落位）。
 */
function pasteNodes(
  clipNodes: AnyNode[],
  clipEdges: AnyEdge[],
  at: { x: number; y: number },
  options?: { includeExternalEdges?: boolean },
): boolean {
  if (clipNodes.length === 0) return false;

  // 原 id → 副本 id 的映射：连线重映射要用，先于落位建立
  const idMap = new Map<string, string>();

  // 第一遍：克隆并建立 id 映射（duplicateNode 已剥离 parentId 等瞬时/归属状态）
  const clones = clipNodes.map((n) => {
    const cloned = duplicateNode(n, { x: 0, y: 0 });
    idMap.set(n.id, cloned.id);
    return cloned;
  });

  // 剪贴板内的组节点 → 副本组：随迁成员的 parentId 重映射到新组
  const parentIdMap = new Map<string, string>();
  clipNodes.forEach((orig) => {
    if (isGroupNode(orig)) parentIdMap.set(orig.id, idMap.get(orig.id)!);
  });

  // 第二遍：落位。整体平移基准 = 剪贴板内容的绝对包围盒左上角
  const absNodes = toAbsoluteNodes(clipNodes);
  const minX = Math.min(...absNodes.map((n) => n.position.x));
  const minY = Math.min(...absNodes.map((n) => n.position.y));
  const newNodes: AnyNode[] = clones.map((cloned, i) => {
    const orig = clipNodes[i];
    const mappedParentId = orig.parentId ? parentIdMap.get(orig.parentId) : undefined;
    if (mappedParentId) {
      // 父随迁：相对坐标原样保留，视觉随副本组整体落位
      cloned.parentId = mappedParentId;
      return cloned;
    }
    const abs = absNodes[i].position;
    cloned.position = {
      x: at.x + (abs.x - minX),
      y: at.y + (abs.y - minY),
    };
    return cloned;
  });

  // 建节点 + 还原连线是同一原子操作：批量守卫合并为一条撤销，离散操作必定入栈
  // （先落节点再还原连线：节点表必须包含刚创建的副本（边的集内端点已重映射
  // 为副本 id，在旧快照里查不到会被误丢））
  withHistoryBatch(() => {
    const store = useCanvasStore.getState();
    store.addNodes(newNodes);

    // 连线还原：集内端点重映射到副本；普通粘贴只还原两端都在剪贴板内的边
    // （不继承与原节点的外部关系）；副本模式（includeExternalEdges）额外还原
    // 上游外部边（集外 source → 集内副本），下游外部边不还原——副本是开新
    // 分支，不抢占下游消费者的输入；跨画布粘贴时集外 id 不存在则丢弃该边
    const includeExternal = options?.includeExternalEdges === true;
    const latestNodes = useCanvasStore.getState().nodes;
    const existingPairs = new Set(
      useCanvasStore.getState().edges.map((e) => `${e.source}→${e.target}`),
    );
    const nodeById = new Map(latestNodes.map((n) => [n.id, n]));
    const newEdges = clipEdges
      // 集内判定必须用重映射前的原 id：idMap 的键是原节点 id，重映射后已是
      // 副本 id（idMap 里查不到），错位判定会把所有内部边误判成外部边丢掉
      .filter((e) => idMap.has(e.target) && (includeExternal || idMap.has(e.source)))
      .map((e) => {
        const source = idMap.get(e.source) ?? e.source;
        const target = idMap.get(e.target) ?? e.target;
        return { source, target };
      })
      .filter(({ source, target }) => {
        if (!nodeById.has(source) || !nodeById.has(target)) return false;
        // 跨画布粘贴时集外节点的类型可能与原边不匹配，按连接规则再校验一次
        // （含节点能力：上传素材不能作为连线目标，与画布交互同一口径）
        const srcNode = nodeById.get(source)!, tgtNode = nodeById.get(target)!;
        if (!canConnect(srcNode.type, tgtNode.type) || !nodeAcceptsInput(tgtNode)) return false;
        const key = `${source}→${target}`;
        if (existingPairs.has(key)) return false;
        existingPairs.add(key);
        return true;
      })
      .map(({ source, target }) => createEdge(source, target));

    if (newEdges.length > 0) store.setEdges([...useCanvasStore.getState().edges, ...newEdges]);
  });
  // 粘贴后选中新节点，与键盘 Ctrl+V 行为保持一致
  const latest = useCanvasStore.getState();
  const pastedIds = new Set(newNodes.map((n) => n.id));
  applySelection(latest.nodes, (n) => pastedIds.has(n.id), latest.setNodes);
  markDirtyImmediate();
  return true;
}

/**
 * 用纯文本创建文本节点（系统剪贴板粘贴的文本分支）。
 * content 存段落化的富文本 HTML（供 Tiptap 编辑），plainText 存原文（供下游消费）。
 */
export function createTextNodeWithContent(text: string, at: { x: number; y: number }): AnyNode {
  const node = createTextNode(at);
  const html = textToTiptapHtml(text);
  (node.data as { content: string; plainText: string }).content = html;
  (node.data as { content: string; plainText: string }).plainText = text;
  useCanvasStore.getState().addNodes([node], { forceHistory: true });
  const latest = useCanvasStore.getState();
  applySelection(latest.nodes, (n) => n.id === node.id, latest.setNodes);
  markDirtyImmediate();
  return node;
}

/**
 * 智能粘贴核心：按「Noxrea 载荷 → 图片 → 非空文本 → 内部剪贴板兜底」顺序消费。
 * 键盘原生 paste 事件与右键菜单（主动读取系统剪贴板）共用此入口。
 *
 * 载荷存在但非法时整包拒绝：不降级为图片/文本，也不回退内部剪贴板。
 * @returns 是否实际执行了粘贴
 */
export function pasteFromClipboardContent(
  content: ClipboardPasteContent,
  at: { x: number; y: number }
): boolean {
  if (content.payloadJson !== undefined) {
    return pasteCanvasClipboardJson(content.payloadJson, at);
  }
  if (content.imageFiles.length > 0) {
    void createNodesFromFiles(content.imageFiles, at);
    return true;
  }
  const text = content.text ?? "";
  const trimmed = text.trim();
  if (trimmed) {
    createTextNodeWithContent(trimmed, at);
    return true;
  }
  // 系统剪贴板无可用内容（空剪贴板 / 复制时系统写入失败）：回退内部剪贴板
  return pasteClipboard(at);
}

/** 全选画布节点 */
export function selectAllNodes(): void {
  const store = useCanvasStore.getState();
  if (store.nodes.length === 0) return;
  applySelection(store.nodes, () => true, store.setNodes);
}

/**
 * 清空选区：节点与连线都取消选中。
 *
 * 无选中项时不重建数组——否则每次点击空白都会产生新的 nodes / edges 引用，
 * 触发下游派生投影（highlightedEdgeIds 等）与 React Flow 的无谓重算；
 * 连线选中态不进入撤销栈（选中只是查看，不属于文档编辑）。
 * 画布空白点击与 Esc 共用本实现。
 */
export function clearSelection(): void {
  const store = useCanvasStore.getState();
  applySelection(store.nodes, () => false, store.setNodes);
  applySelection(store.edges, () => false, (next) => store.setEdges(next, { skipHistory: true }));
}

/** 删除当前选中的节点与连线。
    不取消节点关联的生成任务：任务生命周期独立于节点存亡，删除只解除消费关系，
    撤销复活后 monitor 按 binding 自动重连续跑（语义与原因详见
    use-sse-task-monitor scanAndConnect 处的「GEN-02 生成任务生命周期语义」注释）。 */
export function deleteSelection(): void {
  const nodeIds = getSelectedNodeIds();
  const edgeIds = getSelectedEdgeIds();
  if (nodeIds.length === 0 && edgeIds.length === 0) return;

  const store = useCanvasStore.getState();
  // 删节点 + 删边是同一原子操作：批量守卫合并为一条撤销（离散操作必定入栈，
  // 不再依赖全局节流窗口碰运气的合并语义）
  withHistoryBatch(() => {
    if (nodeIds.length > 0) store.removeNodes(nodeIds, { forceHistory: true });
    if (edgeIds.length > 0) store.removeEdges(edgeIds, { forceHistory: true });
  });
}

/** 是否存在生成/处理中的节点（用于禁止撤销/重做，避免波及生成中节点）。
    导出给键盘层：拦截发生时给出提示，而不是静默吞掉快捷键。 */
export function hasGeneratingNodeIn(nodes: AnyNode[]): boolean {
  return nodes.some((n) => isGenerating((n.data as MediaGenFields).taskBinding));
}

export function hasGeneratingNode(): boolean {
  return hasGeneratingNodeIn(useCanvasStore.getState().nodes);
}

/**
 * 画布级撤销/重做统一守卫：生成中（波及 taskBinding）或媒体编辑面板打开
 * （面板拥有键盘与编辑现场）时不可用。键盘快捷键、右键菜单、Agent「撤销此轮」
 * 等全部入口共用此判定，禁止单独复制条件。
 */
export function canUndoNow(): boolean {
  return !hasGeneratingNode() && !isMediaEditorOpen();
}

/** 把历史快照恢复为画布当前状态（节点/边去选中，避免遗留悬空选区） */
function restoreSnapshot(snapshot: HistorySnapshot): void {
  // 整理动画每帧都在写节点位置，先停掉，否则下一帧会覆盖恢复出的布局
  cancelTidyAnimation();
  // 撤销/重做是程序化恢复，不算用户对画布内容做的增量修改，不进动作历史
  runSuppressed(() => {
    const s = useCanvasStore.getState();
    // 编辑态宿主已随快照消失则退出对应编辑态（否则面板悬空指向不存在的节点）；
    // 宿主仍在则面板保留，内容随快照恢复
    const snapshotIds = new Set(snapshot.nodes.map((n) => n.id));
    const uiPatch: Partial<CanvasState> = {};
    for (const key of NODE_UI_STATE_KEYS) {
      const hostId = s[key];
      if (hostId && !snapshotIds.has(hostId)) {
        (uiPatch as Record<string, null>)[key] = null;
      }
    }
    if (Object.keys(uiPatch).length > 0) useCanvasStore.setState(uiPatch);
    // 快照节点来自历史记录，引用天然是新的：这里只需清除选中态，
    // 不必再克隆整表（updateSelection 对未变化项原样返回）。
    // 写入必须无条件执行：快照恢复本身就要整表替换 store，与选区是否变化无关。
    s.setNodes(updateSelection(snapshot.nodes, () => false));
    s.setEdges(updateSelection(snapshot.edges, () => false), { skipHistory: true });
    // 撤销/重做不恢复视口：相机跟随用户（与 Figma 等主流画布一致）。快照中的
    // viewport 仅服务保存链路；写回会造成 store 与 React Flow 实际视口脱节
    // （React Flow 只在挂载与 viewportSyncCount 变化时同步），进而把旧视口落库、
    // 视口中心类锚点计算错位
    if (snapshot.minimapVisible !== undefined) useCanvasStore.setState({ minimapVisible: snapshot.minimapVisible });
    if (snapshot.snapEnabled !== undefined) useCanvasStore.setState({ snapEnabled: snapshot.snapEnabled });
  });
  markDirtyUndo();
}

/** 撤销：恢复到最近一次改动前的状态。@returns 是否实际执行了撤销 */
export function undoAction(): boolean {
  // 统一守卫：生成期间 undo 全局快照会波及生成中节点的 taskBinding，导致 SSE
  // 结果落在过期节点上或白等后 scanAndConnect 复活僵尸任务；媒体编辑面板打开
  // 时面板拥有编辑现场，画布级恢复不得穿透
  if (!canUndoNow()) return false;
  // 先捕获现场快照（进 redoStack，供 redo 回到撤销前），再弹出恢复目标
  const prev = useHistoryStore.getState().undo(takeCanvasSnapshot());
  if (!prev) return false;
  restoreSnapshot(prev);
  return true;
}

/** 重做：回到撤销前的现场状态。@returns 是否实际执行了重做 */
export function redoAction(): boolean {
  if (!canUndoNow()) return false;
  // 先捕获现场快照（存回 undoStack，保证 redo 后还能再 undo），再弹出恢复目标
  const next = useHistoryStore.getState().redo(takeCanvasSnapshot());
  if (!next) return false;
  restoreSnapshot(next);
  return true;
}
