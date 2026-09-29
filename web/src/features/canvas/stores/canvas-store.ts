/**
 * 画布核心状态仓库。
 * 持有节点 / 连线 / 视口 / 背景 / 主题等画布状态与各类浮层开关，
 * 提供节点增删改与快照能力，并通过 SaveManager 做脏标记与延迟保存。
 * 视口高频变更走模块级变量以避免重渲染循环。
 */
import type { Edge } from "@xyflow/react";
import { create } from "zustand";

import { pruneEdgesToCapability } from "@/features/canvas/shared/connection-rules";
import { pruneEmptyGroups } from "@/features/canvas/shared/group-bounds";
import { useHistoryStore } from "@/features/canvas/stores/history-store";
import type { BackgroundType, ViewportState } from "@/features/canvas/types";
import type { AnyNode } from "@/features/canvas/types";
import { saveManager } from "@/features/project/save-manager";
import type { HistorySnapshot } from "@/features/project/types";
import { DEFAULT_BACKGROUND, DEFAULT_VIEWPORT, NODE_TYPE } from "@/lib/constants";
import { nodeRectOf } from "@/lib/utils/image-utils";

/** updateNodeData 自动压栈防抖时间（ms） */
const HISTORY_THROTTLE = 300;
let _lastHistoryTime = 0;

/**
 * 模块级 viewport 跟踪变量。
 * onViewportChange 高频触发时只更新此变量（不触发 Zustand set），
 * 避免 useSyncExternalStore 同步重渲染 -> React Flow 再次 emit onViewportChange 的无限循环。
 * 保存/快照/undo 时从此变量读取最新值。
 */
let _liveViewport: ViewportState = DEFAULT_VIEWPORT;

/**
 * 内容所有者：当前画布内容所属的项目 ID，未加载为 null。
 * 保存一律以此寻址，与 UI 激活态（activeProjectId）解耦，
 * 项目切换窗口期内编辑仍能正确存回原项目。
 */
let _canvasProjectId: string | null = null;

/** 当前画布内容所属项目 ID（未加载为 null） */
export function getCanvasProjectId(): string | null {
  return _canvasProjectId;
}

/**
 * Mark canvas as modified — SaveManager 负责 trailing save。
 */
export function markDirty() {
  saveManager.markDirty();
}

/** 立即保存（离散操作，100ms 合并） */
export function markDirtyImmediate() {
  saveManager.markDirtyImmediate();
}

export function markDirtyUndo() {
  saveManager.markDirtyUndo();
}

/**
 * 高频 viewport 变更入口（onViewportChange 调用）。
 * 只更新模块级变量 + markDirty，不触发 Zustand set()，避免渲染循环。
 * 与当前值相同的同步（React Flow 挂载/程序化 setRfViewport 后的回声）不标脏——
 * 否则零编辑进画布也会被标脏，造成「刚进画布就触发保存」的误报。
 */
export function syncLiveViewport(vp: ViewportState) {
  const prev = _liveViewport;
  _liveViewport = vp;
  if (prev.x === vp.x && prev.y === vp.y && prev.zoom === vp.zoom) return;
  saveManager.markDirty();
}

/** 读取最新 viewport（供 save / snapshot / getViewportCenter 使用） */
export function getLiveViewport(): ViewportState {
  return _liveViewport;
}

/** 等待保存完成并确保最终状态已落盘（项目切换等场景） */
export function flushAndWait(): Promise<void> {
  return saveManager.flushAndWait();
}

/**
 * 组件卸载 / 路由离开时兜底保存（fire-and-forget）。
 *
 * 此时页面仍然存活，必须走普通请求：keepalive 有约 64KB 请求体上限，
 * 大画布会直接抛 TypeError: Failed to fetch，导致编辑内容静默丢失。
 * 真正的页面卸载由 SaveManager 内部监听 pagehide/beforeunload 处理。
 */
export function flushBeforeUnload(): void {
  saveManager.flushSave();
}

/** 自动压栈 throttle 辅助函数 */
function maybePushHistory(options?: { skipHistory?: boolean; forceHistory?: boolean }) {
  if (options?.skipHistory) return;
  const now = Date.now();
  if (options?.forceHistory || now - _lastHistoryTime > HISTORY_THROTTLE) {
    useHistoryStore.getState().push(takeCanvasSnapshot());
    _lastHistoryTime = now;
  }
}

interface CanvasState {
  // Viewport
  viewport: ViewportState;
  setViewport: (viewport: ViewportState) => void;

  // Nodes and edges (controlled mode)
  nodes: AnyNode[];
  edges: Edge[];
  setNodes: (nodes: AnyNode[]) => void;
  /** 读取当前最新节点列表。异步回调中应通过它取数，避免持有过期快照 */
  getNodes: () => AnyNode[];
  setEdges: (edges: Edge[], options?: { skipHistory?: boolean }) => void;
  addNodes: (nodes: AnyNode[], options?: { skipHistory?: boolean }) => void;
  updateNodeData: (nodeId: string, data: Record<string, unknown>, style?: Record<string, unknown>, options?: { skipHistory?: boolean; forceHistory?: boolean }) => void;
  /**
   * 节点视觉态单写通道（position/style/data 一次性合并写入）。
   * 取代已拆除的 NODE_UPDATE_DATA window 事件总线：此前节点组件经事件总线
   * 转译回 store，store 写入存在两条通道。position 存在时单次 setNodes 合并
   * （分两次 set 触发两轮全画布重渲染，缩放逐帧操作下掉帧），否则走
   * updateNodeData（含历史压栈语义）。
   */
  updateNodeVisual: (
    nodeId: string,
    patch: {
      data?: Record<string, unknown>;
      style?: Record<string, unknown>;
      position?: { x: number; y: number };
      /** 透传 updateNodeData 的历史压栈选项（仅非 position 路径） */
      skipHistory?: boolean;
      /** 写入后额外 markDirtyImmediate（上传回填、配色即时生效等场景） */
      immediate?: boolean;
    },
  ) => void;
  removeNodes: (nodeIds: string[], options?: { skipHistory?: boolean }) => void;
  removeEdges: (edgeIds: string[], options?: { skipHistory?: boolean }) => void;

  // Background
  background: BackgroundType;
  setBackground: (bg: BackgroundType) => void;

  // Minimap visibility
  minimapVisible: boolean;
  toggleMinimap: () => void;

  // Reset viewport
  resetViewport: () => void;

  // Shortcuts help
  shortcutsVisible: boolean;
  setShortcutsVisible: (v: boolean) => void;

  // Modal open (blocks canvas keyboard shortcuts)
  modalOpen: boolean;
  setModalOpen: (v: boolean) => void;

  // Annotation mode (hides node toolbar for the annotating node)
  annotatingNodeId: string | null;
  setAnnotatingNodeId: (id: string | null) => void;
  croppingNodeId: string | null;
  setCroppingNodeId: (id: string | null) => void;
  // Text node rich-text editing mode (hides node toolbar while editing)
  editingTextNodeId: string | null;
  setEditingTextNodeId: (id: string | null) => void;
  // 帧序列选帧模式（hides node toolbar for the capturing node，并让生成面板让位）
  frameCaptureNodeId: string | null;
  setFrameCaptureNodeId: (id: string | null) => void;
  // 片段截取模式（与选帧互斥：同一节点同一时刻只允许一个编辑条浮层）
  clipCaptureNodeId: string | null;
  setClipCaptureNodeId: (id: string | null) => void;
  // 音频片段截取模式（与选帧/片段截取互斥：同一节点同一时刻只允许一个编辑条浮层）
  audioClipNodeId: string | null;
  setAudioClipNodeId: (id: string | null) => void;
  // 图片节点多图展开态（hides node toolbar；展开网格自带下载/设主图/收起入口）
  multiExpandedNodeId: string | null;
  setMultiExpandedNodeId: (id: string | null) => void;
  // 图片打光模式（hides node toolbar；面板经 RfNodeToolbar 悬浮于节点下方）
  lightingNodeId: string | null;
  setLightingNodeId: (id: string | null) => void;
  // 多视角编辑模式（hides node toolbar；面板经 RfNodeToolbar 悬浮于节点下方，形态同打光面板）
  angleEditorNodeId: string | null;
  setAngleEditorNodeId: (id: string | null) => void;
  // 全景查看模式（hides node toolbar；与其余编辑态互斥，点空白/他节点即退出；
  // 查看态不属于节点内容——不落库、不进撤销历史，刷新后不自动恢复）
  panoramaNodeId: string | null;
  setPanoramaNodeId: (id: string | null) => void;

  /** 关闭不属于 nodeId 的编辑态（nodeId 传 null 即全部关闭） */
  closeForeignNodeEditors: (nodeId: string | null) => void;

  // Director overlay
  directorOverlayOpen: boolean;
  setDirectorOverlayOpen: (v: boolean) => void;

  // Agent model (persisted to canvasData, project-level)
  agentModel: string | null;
  setAgentModel: (model: string) => void;

  // Agent 提议-确认的幻影预览：待确认操作的目标节点 id（红蒙层；不入持久化）
  agentPreviewNodeIds: string[];
  setAgentPreview: (ids: string[]) => void;
  clearAgentPreview: () => void;

  // 拖入组高亮：节点拖拽中「松手将加入的组」id（组边框高亮的宿主），
  // 瞬态交互反馈，不落库、不进撤销历史，拖拽结束即清空
  dragOverGroupId: string | null;
  setDragOverGroup: (id: string | null) => void;

  // 画布交互状态机（瞬态）：不落库、不进撤销历史，事件派发见 dispatchInteraction
  interaction: CanvasInteraction;
  dispatchInteraction: (action: InteractionAction) => void;

  // Snap to grid
  snapToGrid: boolean;
  toggleSnapToGrid: () => void;
  snapGridSize: number;
  /** 节点间对齐吸附阈值（px），默认 5 */
  snapThreshold: number;

  // Persistence
  /**
   * restoreFromProject 的应用次数：作为视口同步信号。
   * React Flow 的内部视口只在挂载与 activeProjectId 变化时同步，
   * 同项目的内容恢复不换项目 ID，靠订阅此计数把恢复出的视口应用到 React Flow。
   */
  viewportSyncCount: number;
  restoreFromProject: (projectId: string, data: { nodes?: AnyNode[]; edges?: Edge[]; viewport?: ViewportState; background?: BackgroundType; minimapVisible?: boolean; snapToGrid?: boolean; agentModel?: string }) => void;
}

/**
 * 节点级 UI 态字段名（值为节点 id 或 null）：
 * - 目标节点被删除时需在 removeNodes 中同步清空——
 *   残留 id 本身无害（uid 会话内永不复用），但撤销会以同一 id 复活节点，
 *   不清空就会带着对应模式（展开/标注/裁剪/文本编辑/选帧）回来。
 * - 十个编辑态全局互斥（同一时刻只允许一个编辑浮层），由 applyNodeUiState
 *   统一收口，调用方不再各自手工罗列关闭清单。
 */
export const NODE_UI_STATE_KEYS = [
  "multiExpandedNodeId",
  "annotatingNodeId",
  "croppingNodeId",
  "editingTextNodeId",
  "frameCaptureNodeId",
  "clipCaptureNodeId",
  "lightingNodeId",
  "audioClipNodeId",
  "angleEditorNodeId",
  "panoramaNodeId",
] as const;

type NodeUiStateKey = (typeof NODE_UI_STATE_KEYS)[number];

// ── 画布交互状态机（瞬态；真相源在 store，节点组件可按需读取）──
// 把「画布当前处于哪种交互」建模为一组互斥状态：状态互斥、不存在未定义组合，
// 与交互相关的 UI 可见性（handle、节点工具栏、生成面板、光标）全部从状态派生。
// 状态放在 store（而非组件内 reducer）：节点组件（如 VideoNode 在连线 / 拖动
// 期间抑制 hover 预览）与 InfiniteCanvas 共用同一状态，无需再逐层传递。

/** 非瞬时交互状态：空闲/点击选中、框选选中。拖动中会记住进入前的状态 */
type StableInteractionMode = "idle" | "box-selecting";

/** 画布交互状态（互斥） */
export type CanvasInteraction =
  /** 空闲或点击选中：正常显示选中态 UI（工具栏 / 生成面板 / 选中 handle） */
  | { mode: "idle" }
  /** 框选（Shift 拖拽）产生的选中：只做高亮，不显示选中态 UI，直到下次点击 */
  | { mode: "box-selecting" }
  /** 拖动节点中：隐藏 handle / 工具栏 / 生成面板，避免跟随节点飘动；prev 用于松手后恢复 */
  | { mode: "dragging-nodes"; prev: StableInteractionMode }
  /** 拖拽连线中：画布保持十字准星光标 */
  | { mode: "connecting" };

export type InteractionAction =
  | { type: "selection-start" }
  | { type: "click" }
  | { type: "node-drag-start" }
  | { type: "node-drag-stop" }
  | { type: "connect-start" }
  | { type: "connect-end" };

function interactionReducer(state: CanvasInteraction, action: InteractionAction): CanvasInteraction {
  switch (action.type) {
    case "selection-start":
      return state.mode === "box-selecting" ? state : { mode: "box-selecting" };

    // 单击节点或点击空白：视为「点击选中」，恢复正常显示
    case "click":
      return state.mode === "idle" ? state : { mode: "idle" };

    // 记录进入拖动前的状态，松手后原样恢复：
    // 框选一批节点后再拖动，松手仍属于批量选中态；单击选中后拖动则恢复空闲态
    case "node-drag-start": {
      if (state.mode === "dragging-nodes") return state;
      const prev: StableInteractionMode = state.mode === "box-selecting" ? "box-selecting" : "idle";
      return { mode: "dragging-nodes", prev };
    }

    case "node-drag-stop":
      return state.mode === "dragging-nodes" ? { mode: state.prev } : state;

    case "connect-start":
      return state.mode === "connecting" ? state : { mode: "connecting" };

    case "connect-end":
      return state.mode === "connecting" ? { mode: "idle" } : state;

    default:
      return state;
  }
}

/** 节点级 UI 态快照形状（各键值为宿主节点 id 或 null） */
export type NodeUiStateSnapshot = { [K in NodeUiStateKey]: string | null };

/**
 * 节点是否担任任一编辑态浮层的宿主。
 * 工具栏隐藏条件与宿主校验共用此清单，新增编辑态只改 NODE_UI_STATE_KEYS 一处。
 */
export function isNodeInUiState(ui: NodeUiStateSnapshot, nodeId: string): boolean {
  return NODE_UI_STATE_KEYS.some((k) => ui[k] === nodeId);
}

/** 互斥写入口：id 非空时清空其余编辑态；id 为空时仅清自身（避免误关别处刚打开的面板） */
function applyNodeUiState(s: CanvasState, key: NodeUiStateKey, id: string | null): Partial<CanvasState> {
  if (id === null) return { [key]: null } as Partial<CanvasState>;
  const patch: Partial<CanvasState> = {};
  for (const k of NODE_UI_STATE_KEYS) {
    (patch as Record<string, unknown>)[k] = k === key ? id : null;
  }
  return patch;
}

export const useCanvasStore = create<CanvasState>((set, get) => ({
  viewport: DEFAULT_VIEWPORT,
  setViewport: (viewport) => {
    _liveViewport = viewport;
    set({ viewport });
    saveManager.markDirty();
  },

  nodes: [],
  edges: [],
  viewportSyncCount: 0,
  setNodes: (nodes) => {
    set({ nodes });
  },
  getNodes: () => get().nodes,
  setEdges: (edges, options) => {
    maybePushHistory(options);
    set({ edges });
  },
  addNodes: (nodes, options) => {
    maybePushHistory(options);
    set((s) => ({ nodes: [...s.nodes, ...nodes] }));
    saveManager.markDirtyImmediate();
  },
  updateNodeData: (nodeId, data, style, options) => {
    maybePushHistory(options);
    set((s) => ({
      nodes: s.nodes.map((n) =>
        n.id === nodeId
          ? ({ ...n, data: { ...n.data, ...data }, style: style ?? n.style } as AnyNode)
          : n
      ),
    }));
    saveManager.markDirty();
  },
  updateNodeVisual: (nodeId, patch) => {
    const { data, style, position, skipHistory, immediate } = patch;
    if (position) {
      // 位置、尺寸、数据同批写入一次：分两次 set 会触发两轮全画布重渲染，
      // 缩放这类逐帧操作下掉帧会直接表现为「框不跟手」（原事件总线合并写语义）
      const hasData = !!data && Object.keys(data).length > 0;
      set((s) => ({
        nodes: s.nodes.map((n) =>
          n.id === nodeId
            ? ({
                ...n,
                position,
                ...(style ? { style: { ...n.style, ...style } } : {}),
                ...(hasData ? { data: { ...n.data, ...data } } : {}),
              } as AnyNode)
            : n,
        ),
      }));
      saveManager.markDirty();
      if (immediate) saveManager.markDirtyImmediate();
      return;
    }
    get().updateNodeData(nodeId, data ?? {}, style, { skipHistory });
    if (immediate) saveManager.markDirtyImmediate();
  },
  removeNodes: (nodeIds, options) => {
    maybePushHistory(options);
    set((s) => {
      const toDelete = new Set(nodeIds);
      // 容器型语义：删组连带成员——组成员并入待删集合，成员的连线随边清理一并移除；
      // 想保留内容只拆壳走「取消编组」，不在此处
      for (const n of s.nodes) {
        if (n.type !== NODE_TYPE.GROUP && n.data?.groupId && toDelete.has(n.data.groupId)) {
          toDelete.add(n.id);
        }
      }
      // 空组即删：先移除待删节点再判空——待删成员不能给自己的组续命
      const stripped = s.nodes.filter((n) => !toDelete.has(n.id));
      // 成员全部被删除的组也随之移除（空组即删，唯一口径见 pruneEmptyGroups）
      const nodes = pruneEmptyGroups(stripped);
      // 级联删除的空组也要参与边清理与编辑态清理（组不连边、不承载编辑态，
      // 属于防御性一致，不会误删成员相关状态）
      const removedIds = new Set(toDelete);
      for (const n of stripped) {
        if (n.type === NODE_TYPE.GROUP && !nodes.includes(n)) removedIds.add(n.id);
      }
      const patch: Partial<CanvasState> = {
        nodes,
        edges: s.edges.filter(
          (e) => !removedIds.has(e.source) && !removedIds.has(e.target)
        ),
      };
      for (const key of NODE_UI_STATE_KEYS) {
        const id = s[key];
        if (id && removedIds.has(id)) patch[key] = null;
      }
      // 高亮宿主组被删（如拖拽中的异步删除）：一并清空，避免残留高亮
      if (s.dragOverGroupId && removedIds.has(s.dragOverGroupId)) patch.dragOverGroupId = null;
      return patch;
    });
    saveManager.markDirtyImmediate();
  },
  removeEdges: (edgeIds, options) => {
    maybePushHistory(options);
    const idSet = new Set(edgeIds);
    set((s) => ({
      edges: s.edges.filter((e) => !idSet.has(e.id)),
    }));
    saveManager.markDirtyImmediate();
  },
  background: DEFAULT_BACKGROUND,
  setBackground: (background) => {
    set({ background });
    saveManager.markDirtyImmediate();
  },

  minimapVisible: true,
  toggleMinimap: () => {
    set((s) => ({ minimapVisible: !s.minimapVisible }));
    saveManager.markDirtyImmediate();
  },

  resetViewport: () => {
    _liveViewport = DEFAULT_VIEWPORT;
    set({ viewport: DEFAULT_VIEWPORT });
  },

  shortcutsVisible: false,
  setShortcutsVisible: (v) => set({ shortcutsVisible: v }),

  modalOpen: false,
  setModalOpen: (v) => set({ modalOpen: v }),

  annotatingNodeId: null,
  setAnnotatingNodeId: (id) => set((s) => applyNodeUiState(s, "annotatingNodeId", id)),
  croppingNodeId: null,
  setCroppingNodeId: (id) => set((s) => applyNodeUiState(s, "croppingNodeId", id)),
  editingTextNodeId: null,
  setEditingTextNodeId: (id) => set((s) => applyNodeUiState(s, "editingTextNodeId", id)),
  frameCaptureNodeId: null,
  setFrameCaptureNodeId: (id) => set((s) => applyNodeUiState(s, "frameCaptureNodeId", id)),
  clipCaptureNodeId: null,
  setClipCaptureNodeId: (id) => set((s) => applyNodeUiState(s, "clipCaptureNodeId", id)),
  audioClipNodeId: null,
  setAudioClipNodeId: (id) => set((s) => applyNodeUiState(s, "audioClipNodeId", id)),
  multiExpandedNodeId: null,
  setMultiExpandedNodeId: (id) => set((s) => applyNodeUiState(s, "multiExpandedNodeId", id)),
  lightingNodeId: null,
  setLightingNodeId: (id) => set((s) => applyNodeUiState(s, "lightingNodeId", id)),
  angleEditorNodeId: null,
  setAngleEditorNodeId: (id) => set((s) => applyNodeUiState(s, "angleEditorNodeId", id)),
  panoramaNodeId: null,
  setPanoramaNodeId: (id) => set((s) => applyNodeUiState(s, "panoramaNodeId", id)),

  closeForeignNodeEditors: (nodeId) => {
    set((s) => {
      const patch: Partial<CanvasState> = {};
      let changed = false;
      for (const k of NODE_UI_STATE_KEYS) {
        const id = s[k];
        if (id && id !== nodeId) {
          (patch as Record<string, unknown>)[k] = null;
          changed = true;
        }
      }
      return changed ? patch : s;
    });
  },

  directorOverlayOpen: false,
  setDirectorOverlayOpen: (v) => set({ directorOverlayOpen: v }),

  agentModel: null,
  setAgentModel: (model) => {
    set({ agentModel: model });
    saveManager.markDirtyImmediate();
  },

  agentPreviewNodeIds: [],
  setAgentPreview: (ids) => {
    set({ agentPreviewNodeIds: ids });
  },
  clearAgentPreview: () => {
    set((s) => (s.agentPreviewNodeIds.length ? { agentPreviewNodeIds: [] } : s));
  },

  dragOverGroupId: null,
  setDragOverGroup: (id) => {
    set((s) => (s.dragOverGroupId === id ? s : { dragOverGroupId: id }));
  },

  interaction: { mode: "idle" },
  // 无变化的派发返回原状态引用，订阅方选择器相等即不重渲染
  dispatchInteraction: (action) => {
    set((s) => ({ interaction: interactionReducer(s.interaction, action) }));
  },

  snapToGrid: false,
  toggleSnapToGrid: () => {
    set((s) => ({ snapToGrid: !s.snapToGrid }));
    saveManager.markDirtyImmediate();
  },
  snapGridSize: 20,
  snapThreshold: 5,

  /** 从项目恢复画布状态（内容所有者随之切换；未落库的尾部编辑不随新内容派发保存） */
  restoreFromProject: (projectId: string, data: { nodes?: AnyNode[]; edges?: Edge[]; viewport?: ViewportState; background?: BackgroundType; minimapVisible?: boolean; snapToGrid?: boolean; agentModel?: string }) => {
    // 过期态只在「真正的项目切换」时随切换清除；同项目 / 首次加载的服务端数据
    // 恢复保留过期态——加载在途时收到的 evict 不能被恢复完成冲掉
    // （过期弹窗唯一出口是刷新，同项目恢复并不重新取得编辑权）
    const previousOwner = _canvasProjectId;
    const isProjectSwitch = previousOwner !== null && previousOwner !== projectId;
    saveManager.resetForProjectSwitch({ clearExpired: isProjectSwitch });
    _canvasProjectId = projectId;
    const vp = data.viewport || DEFAULT_VIEWPORT;
    _liveViewport = vp;
    // 边界归一化：服务端数据在进画布的唯一入口清洗一次。
    // 1. 空组清洗：落库数据可能产生于「空组即删」不变量确立之前（旧规则
    //    允许空壳组收缩存活），清洗后全库可依赖「组必有成员」前置条件；
    // 2. className 剥离：渲染挂钩类随 type 由 React Flow 自动派生
    //    （group-node → .react-flow__node-group-node），不属于持久化数据；
    //    旧数据曾借 xyflow 库存保留类 react-flow__node-group 挂样式钩，
    //    会把库存 text-align/padding 泄漏进节点。
    // 3. 边能力清洗：落库数据可能包含「连线能力规则（acceptsInput）确立之前」
    //    拖到上传素材上建出的边；target 无输入轨，渲染时 xyflow 找不到 Handle
    //    会抛 error #008。清洗后全库可依赖「边的 target 必可接受输入」前置条件
    //    （见 connection-rules 的 pruneEdgesToCapability）。
    const nodes = pruneEmptyGroups(
      (data.nodes || []).map(({ className: _stale, ...n }) => ({ ...n, data: { ...n.data } }) as AnyNode),
    );
    const edges = pruneEdgesToCapability(nodes, (data.edges || []) as Edge[]);
    set({
      nodes,
      edges,
      viewport: vp,
      background: data.background || DEFAULT_BACKGROUND,
      minimapVisible: data.minimapVisible !== false,
      snapToGrid: data.snapToGrid || false,
      agentModel: data.agentModel ?? null,
      viewportSyncCount: get().viewportSyncCount + 1,
    });
  },
}));

/** 获取当前画布快照（供 undo/redo 使用） */
export function takeCanvasSnapshot(): HistorySnapshot {
  const s = useCanvasStore.getState();
  return {
    // 节点 data 为纯 JSON 数据，用 structuredClone 深拷贝，比 JSON.parse(JSON.stringify())
    // 更快且能正确处理 Date/Map/Set/Blob 等类型（若有）。
    nodes: structuredClone(s.nodes),
    edges: structuredClone(s.edges),
    viewport: { ..._liveViewport },
    background: s.background,
    minimapVisible: s.minimapVisible,
    snapToGrid: s.snapToGrid,
  };
}

/** 获取视口中心的世界坐标 */
export function getViewportCenter(): { x: number; y: number } {
  const vp = _liveViewport;
  return {
    x: -vp.x / vp.zoom + (window.innerWidth / 2) / vp.zoom,
    y: -vp.y / vp.zoom + (window.innerHeight / 2) / vp.zoom,
  };
}

/**
 * 在指定锚点中心附近为新节点寻找位置。
 *
 * 仅统计与锚点区域重叠的节点数来决定偏移量，避免远处节点累积偏移把新节点推出锚点。
 * 从锚点开始每次固定偏移一小段距离（默认 30px），允许部分重叠，仅保证用户能识别新节点。
 * 类似 Figma 连续粘贴行为。
 *
 * @param nodeSize 新节点的尺寸
 * @param center 锚定中心点（世界坐标），必填
 * @param offset 每次偏移量（默认 30px）
 * @returns 节点左上角坐标
 */
export function findFreePosition(
  nodeSize: { width: number; height: number },
  center: { x: number; y: number },
  offset = 30,
): { x: number; y: number } {
  const { x: cx, y: cy } = center;
  const nodes = useCanvasStore.getState().nodes;

  // 偏移次数 = 与锚点区域重叠的节点数（忽略远处节点，避免把新节点推出锚点）
  const overlapCount = nodes.filter((n) => {
    const r = nodeRectOf(n, { width: 200, height: 120 });
    return (
      r.x < cx + nodeSize.width / 2 &&
      r.x + r.width > cx - nodeSize.width / 2 &&
      r.y < cy + nodeSize.height / 2 &&
      r.y + r.height > cy - nodeSize.height / 2
    );
  }).length;

  return {
    x: cx - nodeSize.width / 2 + overlapCount * offset,
    y: cy - nodeSize.height / 2 + overlapCount * offset,
  };
}
