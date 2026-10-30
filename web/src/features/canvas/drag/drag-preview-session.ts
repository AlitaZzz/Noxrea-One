/**
 * 画布拖动预览会话。
 *
 * 拖动期间位置帧不写受控 store：会话把每帧拖动位置按 rAF 合并，直接写 DOM 的
 * `style.translate`（节点 wrapper、边、框选外框、节点编辑面板），
 * 松手时按吸附后的最终几何一次 `setNodes` 提交，待渲染层采用新位置后再清除
 * 预览偏移。完整规则见 specs/canvas-drag-preview-session.md。
 *
 * 非 React 模块：由 `InfiniteCanvas` 持有并注入 store / React Flow 访问器。
 * DOM 契约依赖本仓库固定的 React Flow 12.12 受控模式（`.react-flow__node[data-id]`、
 * `.react-flow__edge[data-id]`、`.react-flow__nodesselection`、
 * `.react-flow__node-toolbar[data-id]`、`.react-flow__edgelabel-renderer`），
 * 升级 React Flow 必须重新验证。
 */
import type { RefObject } from "react";

import type { AlignmentGuide } from "@/features/canvas/shared/alignment-guides";
import { computeEdgePath } from "@/features/canvas/shared/edge-geometry";
import { buildNodeIndex } from "@/features/canvas/shared/group-bounds";
import { groupMembers, isGroupNode } from "@/features/canvas/shared/group-membership";
import {
  applyNodePositions,
  type PositionFrame,
  toPositionFrames,
  toPositionMap,
} from "@/features/canvas/shared/node-positions";
import {
  emptySnapState,
  type Point,
  resolveSnap,
  type SnapBounds,
  type SnapSessionState,
  type SnapTarget,
} from "@/features/canvas/shared/snap-engine";
import type { AnyNode } from "@/features/canvas/types";
import { DEFAULT_SNAP_ENABLED, DEFAULT_SNAP_GRID_SIZE } from "@/lib/constants";

import { type DragInput, dragModifiersFromEvent } from "./drag-input";
import {
  applySnapOffset,
  buildSnapFrame,
  buildSnapTargets,
  type DragSnapSettings,
  type MovingBox,
  nodeAbsoluteBounds,
} from "./drag-snap";
import { getEdgeGeometry, type RegisteredEdgeGeometry } from "./edge-geometry-registry";
import { clearPreviewGuides, setPreviewGuides } from "./preview-guides";

export interface DragPreviewSessionDeps {
  /** 画布根元素：DOM 预览只在它内部查询与写入（会话只在事件/rAF 中读取 current） */
  root: RefObject<HTMLElement | null>;
  /** 受控 store 的实时节点 */
  getNodes: () => AnyNode[];
  /** 提交入口（会话唯一的 store 写入口，规则 1.8） */
  setNodes: (nodes: AnyNode[]) => void;
  /** 提交后立即落库（拖动期不 markDirty，规则 6.2） */
  markDirtyImmediate: () => void;
  /** 当前视口缩放（屏幕空间叠层按位移 × zoom 平移，规则 5.2） */
  getZoom: () => number;
}

interface ComputedFrame {
  /** 拖动项吸附后的相对位置（提交写入口径；无吸附偏移时为拖动帧原 Map） */
  positions: ReadonlyMap<string, Point>;
  /** 受影响节点的最终绝对位移（拖动项 + 跟随的组成员，已含吸附偏移） */
  finalDeltas: Map<string, Point>;
  guides: AlignmentGuide[];
}

export interface DragBeginOptions extends Partial<DragInput> {
  /** 按下点 → 阈值事件点的屏幕位移（px），由会话按 zoom 换算成画布位移 */
  preThresholdOffset?: Point;
}

interface EdgeDom {
  group: SVGElement;
  paths: SVGPathElement[];
  mode: "none" | "translate" | "path";
}

interface ToolbarDom {
  el: HTMLElement;
  nodeId: string;
  originalTranslate: string;
}

interface LayerDom {
  el: HTMLElement;
  visibility: string;
  translate: string;
}

interface DomSnapshot {
  wrappers: Map<string, HTMLElement>;
  edges: Map<string, EdgeDom>;
  labelLayers: { el: HTMLElement; visibility: string }[];
  selectionFrame: LayerDom | null;
  toolbars: ToolbarDom[];
}

/** 相对基准位置的位移：相对坐标与绝对坐标共享同一差值（规则 9.1） */
function deltaFrom(position: Point, base: Point): Point {
  return { x: position.x - base.x, y: position.y - base.y };
}

export class DragPreviewSession {
  private active = false;
  private commitPending = false;
  private dragItemIds: string[] = [];
  private affectedIds = new Set<string>();
  /** 组成员 → 所属组 id：成员位移跟随被拖动的组 */
  private memberGroupByNode = new Map<string, string>();
  /** 移动集节点的基准绝对盒（拖动开始时构建，每帧只加原始位移） */
  private baseAbsoluteById = new Map<string, SnapBounds>();
  /** 吸附候选目标（拖动开始时构建；外部写入重建基准时同步重建） */
  private targets: SnapTarget[] = [];
  /** 每轴锁定关系（滞回） */
  private snapState: SnapSessionState = emptySnapState();
  /** 本次拖动开始时的缩放（阈值换算；拖动中缩放不改变本次会话） */
  private snapZoom = 1;
  /** 修饰键瞬态：Ctrl/Meta 旁路，Shift 轴限 */
  private bypassHeld = false;
  private shiftHeld = false;
  private modifierListenersAttached = false;
  /** 触屏拖动无修饰键（规则 8.5）：不监听键盘，也不接受初值 */
  private modifiersEnabled = true;
  private baseById = new Map<string, AnyNode>();
  private selectedIds: string[] = [];
  /** 拖动开始时由 begin 覆盖；初值与 store 默认共用同一常量 */
  private settings: DragSnapSettings = {
    snapEnabled: DEFAULT_SNAP_ENABLED,
    snapGridSize: DEFAULT_SNAP_GRID_SIZE,
  };
  /** 拖动参考点补偿（画布坐标）：按下点到阈值事件点之间的指针位移 */
  private pointerOffset: Point = { x: 0, y: 0 };
  private dom: DomSnapshot | null = null;
  private pendingFrame: Map<string, Point> | null = null;
  private lastFrame: Map<string, Point> | null = null;
  private rafId: number | null = null;

  constructor(private readonly deps: DragPreviewSessionDeps) {}

  isActive(): boolean {
    return this.active;
  }

  /**
   * 拖动开始（React Flow 越过阈值后回调）：快照基准与 DOM，隐藏边标签层。
   *
   * `preThresholdOffset` = 指针按下点 → 阈值事件点的屏幕位移（px）。React Flow 在
   * 越过阈值的首个指针事件才建立拖动参考点（`getDragItems` 的 `distance`），
   * 按下到该事件之间的指针位移会从整段拖动中永久丢失，节点因此始终落后指针
   * （低缩放下节点屏显更小、更明显）；会话按该位移补偿预览与提交位置，
   * 使按下点始终落在指针下（规则 2.7）。
   *
   * 该事件本身也不产出位置帧（`startDrag` 把 `lastPos` 设为同一指针位置，
   * 紧随的 `updateNodes` 判定被跳过），节点要等下一次移动才首次位移；
   * `begin` 因此补出首帧，起手不空等一次事件（规则 2.8）。
   */
  begin(
    dragItemIds: string[],
    settings: DragSnapSettings,
    options: DragBeginOptions = {},
  ): void {
    if (this.active) this.cancel();
    const nodes = this.deps.getNodes();
    const existing = new Set(nodes.map((node) => node.id));
    const ids = dragItemIds.filter((id) => existing.has(id));
    if (ids.length === 0) return;
    this.active = true;
    this.commitPending = false;
    this.dragItemIds = ids;
    this.settings = { ...settings };
    const zoom = this.deps.getZoom();
    this.snapZoom = zoom;
    // zoom 无效时吸附整体关闭（规则 4.4）；指针补偿仍需有限除数
    const pointerZoom = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
    this.pointerOffset = options.preThresholdOffset
      ? {
          x: options.preThresholdOffset.x / pointerZoom,
          y: options.preThresholdOffset.y / pointerZoom,
        }
      : { x: 0, y: 0 };
    this.modifiersEnabled = options.touch !== true;
    this.bypassHeld = this.modifiersEnabled && (options.modifiers?.bypass ?? false);
    this.shiftHeld = this.modifiersEnabled && (options.modifiers?.shift ?? false);
    this.pendingFrame = null;
    this.lastFrame = null;
    this.rebuildBaseline(nodes);
    if (this.modifiersEnabled) this.attachModifierListeners();
    this.dom = this.captureDom();
    // 首帧先于标签隐藏落位：两者都不跨帧，但落位是起手可见结果，其他都是辅助
    this.seedFirstFrame();
    this.hideLabelLayers();
  }

  /**
   * 修饰键监听：拖动期间 Ctrl/Meta/Shift 变化必须立即用最后一帧重算，
   * 不能等下一次指针移动；窗口失焦清空全部状态（规则 8.3、8.4）。
   */
  private attachModifierListeners(): void {
    if (this.modifierListenersAttached) return;
    window.addEventListener("keydown", this.handleModifierKey);
    window.addEventListener("keyup", this.handleModifierKey);
    window.addEventListener("blur", this.handleWindowBlur);
    this.modifierListenersAttached = true;
  }

  private detachModifierListeners(): void {
    if (!this.modifierListenersAttached) return;
    window.removeEventListener("keydown", this.handleModifierKey);
    window.removeEventListener("keyup", this.handleModifierKey);
    window.removeEventListener("blur", this.handleWindowBlur);
    this.modifierListenersAttached = false;
  }

  private readonly handleModifierKey = (event: KeyboardEvent): void => {
    const modifiers = dragModifiersFromEvent(event);
    this.setModifiers(modifiers.bypass, modifiers.shift);
  };

  private readonly handleWindowBlur = (): void => {
    this.setModifiers(false, false);
  };

  private setModifiers(bypass: boolean, shift: boolean): void {
    if (!this.active) return;
    if (this.bypassHeld === bypass && this.shiftHeld === shift) return;
    this.bypassHeld = bypass;
    this.shiftHeld = shift;
    if (this.commitPending) return;
    // 最新未应用的原始帧优先；没有帧时不做重算
    const frame = this.pendingFrame ?? this.lastFrame;
    if (frame) this.applyFrame(frame);
  }

  /**
   * 阈值事件补首帧（规则 2.8）：按基准位置出一帧，经参考点补偿后即为指针
   * 当前位置对应的落点；同步应用，起手当帧就能看到节点跟手。
   */
  private seedFirstFrame(): void {
    if (this.pointerOffset.x === 0 && this.pointerOffset.y === 0) return;
    const seed = new Map<string, Point>();
    for (const id of this.dragItemIds) {
      const base = this.baseById.get(id);
      if (base) seed.set(id, base.position);
    }
    if (seed.size > 0) this.applyFrame(seed);
  }

  /** 拖动位置帧：按 rAF 合并，每帧最多一次 DOM 预览（规则 1.3） */
  preview(frames: PositionFrame[]): void {
    if (!this.active || this.commitPending || frames.length === 0) return;
    this.pendingFrame = toPositionMap(frames);
    if (this.rafId !== null) return;
    this.rafId = requestAnimationFrame(() => {
      this.rafId = null;
      const next = this.pendingFrame;
      this.pendingFrame = null;
      if (!this.active || this.commitPending || !next) return;
      this.applyFrame(next);
    });
  }

  /** 终态帧：取消未执行预览，按吸附后的最终几何一次提交（规则 1.4、1.5） */
  commit(frames: PositionFrame[]): void {
    if (!this.active || this.commitPending) return;
    this.cancelRaf();
    this.pendingFrame = null;
    this.commitPending = true;

    const frame = toPositionMap(frames);
    const result = this.computeFrame(frame);
    // 终态帧先落到预览层：提交写入与渲染层采用新位置之间不出现一帧旧位置
    this.lastFrame = frame;
    this.applyComputed(result);

    const { nodes: next, changed } = applyNodePositions(this.deps.getNodes(), result.positions);
    if (changed) {
      this.deps.setNodes(next);
      // 只有真正写入位置才需要落库（规则 6.2）；无变化时不产生一次空保存
      this.deps.markDirtyImmediate();
      return;
    }
    // 位置未变时渲染层不会采用新节点，没有可等待的释放信号：立即结束
    this.release();
  }

  /**
   * `onNodeDragStop` 兜底：终态帧未到达时以最后预览几何提交（规则 1.4）；
   * 终态帧已提交时只清理辅助线，偏移留到渲染层采用新位置后释放。
   */
  stop(): void {
    if (!this.active) return;
    if (!this.commitPending) {
      // 未执行的预览帧比已应用帧新：兜底提交必须用它，否则会丢掉最后一段位移
      const frame = this.pendingFrame ?? this.lastFrame;
      if (!frame || frame.size === 0) {
        this.cancel();
        return;
      }
      this.commit(toPositionFrames(frame));
    }
    // 拖动已结束：锁定状态不再参与任何一帧，辅助线在提交后清空（规则 10.2）
    clearPreviewGuides();
    this.snapState = emptySnapState();
  }

  /** 丢弃未提交位移（卸载/项目切换）：恢复被改写的边路径，store 不变（规则 1.7） */
  cancel(): void {
    if (!this.active) return;
    this.cancelRaf();
    this.pendingFrame = null;
    const dom = this.dom;
    if (dom) {
      this.clearDomOffsets(dom);
      this.restoreEdgePaths(dom);
    }
    this.reset();
  }

  dispose(): void {
    this.cancel();
    clearPreviewGuides();
  }

  /**
   * 渲染层采用了新的 `nodes`（React Flow 受控同步完成）后调用：
   * 提交路径 → 释放预览；否则说明 store 被外部写入 → 以新数组为基准重建（规则 7）。
   */
  syncRenderedNodes(): void {
    if (!this.active) return;
    if (this.commitPending) {
      this.release();
      return;
    }
    this.rebuildFromStore();
  }

  /** 外部写入（撤销/重做、生成回填、远端同步等）后重建基准，拖动不中断（规则 7.2） */
  private rebuildFromStore(): void {
    const nodes = this.deps.getNodes();
    const existing = new Set(nodes.map((node) => node.id));
    const surviving = this.dragItemIds.filter((id) => existing.has(id));
    if (surviving.length === 0) {
      this.cancel();
      return;
    }
    this.dragItemIds = surviving;
    if (this.dom) this.clearDomOffsets(this.dom);
    this.rebuildBaseline(nodes);
    this.dom = this.captureDom();
    this.hideLabelLayers();
    const last = this.lastFrame;
    if (!last) return;
    // 同步应用保证节点不跳；边几何登记在被动副作用里才刷新，下一帧再重算一次边路径
    this.applyFrame(last);
    this.preview(toPositionFrames(last));
  }

  // ---- 内部：帧计算与 DOM 应用 ----

  private applyFrame(frame: Map<string, Point>): void {
    this.lastFrame = frame;
    this.applyComputed(this.computeFrame(frame));
  }

  private computeFrame(frame: Map<string, Point>): ComputedFrame {
    const rawById = new Map<string, Point>();
    const rawDeltas = new Map<string, Point>();
    const moving: MovingBox[] = [];
    const movingIds = new Set(this.dragItemIds);

    for (const id of this.dragItemIds) {
      const raw = frame.get(id);
      const base = this.baseById.get(id);
      if (!raw || !base) continue;
      // 先补回按下点到阈值事件的指针位移（规则 2.7），再进入吸附
      const target = {
        x: raw.x + this.pointerOffset.x,
        y: raw.y + this.pointerOffset.y,
      };
      rawById.set(id, target);
      const delta = deltaFrom(target, base.position);
      rawDeltas.set(id, delta);
      const bounds = this.baseAbsoluteById.get(id);
      if (bounds) moving.push({ bounds, delta });
    }

    // 组内成员不是拖动项：以组的原始位移加入并集，吸附偏移随组统一应用
    for (const [memberId, groupId] of this.memberGroupByNode) {
      if (movingIds.has(memberId)) continue;
      const delta = rawDeltas.get(groupId);
      const bounds = this.baseAbsoluteById.get(memberId);
      if (delta && bounds) moving.push({ bounds, delta });
    }

    const snapFrame = buildSnapFrame({
      moving,
      targets: this.targets,
      zoom: this.snapZoom,
      settings: this.settings,
      modifiers: { bypass: this.bypassHeld, shift: this.shiftHeld },
      state: this.snapState,
    });
    const resolution = resolveSnap(snapFrame);
    this.snapState = resolution.state;

    const positions = applySnapOffset(rawById, resolution.offset);
    // 位移由最终位置反推：预览与提交共用同一份几何，不做第二次偏移运算
    const finalDeltas = new Map<string, Point>();
    for (const id of this.dragItemIds) {
      const position = positions.get(id);
      const base = this.baseById.get(id);
      if (!position || !base) continue;
      finalDeltas.set(id, deltaFrom(position, base.position));
    }
    // 组成员跟随所属组的最终位移（成员相对坐标不变）
    for (const [memberId, groupId] of this.memberGroupByNode) {
      const delta = finalDeltas.get(groupId);
      if (delta) finalDeltas.set(memberId, delta);
    }
    return { positions, finalDeltas, guides: resolution.guides };
  }

  private applyComputed(result: ComputedFrame): void {
    const dom = this.dom;
    if (dom) {
      for (const [id, el] of dom.wrappers) {
        const delta = result.finalDeltas.get(id);
        el.style.translate =
          delta && (delta.x !== 0 || delta.y !== 0) ? `${delta.x}px ${delta.y}px` : "";
      }
      this.applyEdges(dom, result.finalDeltas);
      this.applyOverlays(dom, result.finalDeltas);
    }
    setPreviewGuides(result.guides);
  }

  private applyEdges(dom: DomSnapshot, deltas: Map<string, Point>): void {
    for (const [edgeId, edge] of dom.edges) {
      const geometry = getEdgeGeometry(edgeId);
      if (!geometry) continue;
      const sourceAffected = this.affectedIds.has(geometry.sourceId);
      const targetAffected = this.affectedIds.has(geometry.targetId);
      if (!sourceAffected && !targetAffected) continue;
      const sourceDelta = deltas.get(geometry.sourceId);
      const targetDelta = deltas.get(geometry.targetId);
      // 本帧缺少受影响端点的位移（节点已移出会话）：还原基准，不保留陈旧预览
      if ((sourceAffected && !sourceDelta) || (targetAffected && !targetDelta)) {
        edge.group.style.translate = "";
        if (edge.mode === "path") this.restoreEdgePath(edge, geometry);
        continue;
      }

      if (
        sourceDelta &&
        targetDelta &&
        sourceDelta.x === targetDelta.x &&
        sourceDelta.y === targetDelta.y
      ) {
        // 两端同位移：平移整条边，不改路径（规则 4.2）
        if (edge.mode === "path") this.restoreEdgePath(edge, geometry);
        edge.group.style.translate = `${sourceDelta.x}px ${sourceDelta.y}px`;
        edge.mode = "translate";
        continue;
      }

      // 混合位移或仅一端受影响：按预览端点重算路径，写入该边内所有 path（规则 4.3）
      edge.group.style.translate = "";
      const preview = computeEdgePath({
        sourceX: geometry.sourceX + (sourceDelta?.x ?? 0),
        sourceY: geometry.sourceY + (sourceDelta?.y ?? 0),
        targetX: geometry.targetX + (targetDelta?.x ?? 0),
        targetY: geometry.targetY + (targetDelta?.y ?? 0),
        sourcePosition: geometry.sourcePosition,
        targetPosition: geometry.targetPosition,
      });
      for (const path of edge.paths) path.setAttribute("d", preview.path);
      edge.mode = "path";
    }
  }

  private applyOverlays(dom: DomSnapshot, deltas: Map<string, Point>): void {
    const zoom = this.deps.getZoom();
    const uniform = this.uniformSelectionDelta(deltas);
    if (dom.selectionFrame) {
      const frame = dom.selectionFrame;
      if (uniform) {
        frame.el.style.visibility = frame.visibility;
        frame.el.style.translate = `${uniform.x * zoom}px ${uniform.y * zoom}px`;
      } else {
        // 位移混合：展示陈旧的包围盒只会误导，隐藏到提交后（规则 5.1）
        frame.el.style.visibility = "hidden";
        frame.el.style.translate = frame.translate;
      }
    }
    // 批量接驳轨道不在此处理：拖动期由容器 data-interaction 的 CSS 规则整体隐藏
    // （与节点轨道同一开关），松手后按提交位置自然恢复（规则 5.1）
    for (const toolbar of dom.toolbars) {
      const delta = deltas.get(toolbar.nodeId);
      toolbar.el.style.translate =
        delta && (delta.x !== 0 || delta.y !== 0)
          ? `${delta.x * zoom}px ${delta.y * zoom}px`
          : toolbar.originalTranslate;
    }
  }

  /** 全部选中节点都在受影响集合中且位移相同 → 返回该位移；否则 null */
  private uniformSelectionDelta(deltas: Map<string, Point>): Point | null {
    if (this.selectedIds.length === 0) return null;
    let first: Point | null = null;
    for (const id of this.selectedIds) {
      const delta = deltas.get(id);
      if (!delta) return null;
      if (!first) first = delta;
      else if (delta.x !== first.x || delta.y !== first.y) return null;
    }
    return first;
  }

  // ---- 内部：DOM 快照与清理 ----

  private rebuildBaseline(nodes: AnyNode[]): void {
    const nodeById = buildNodeIndex(nodes);
    this.baseById = new Map();
    this.affectedIds = new Set();
    this.memberGroupByNode = new Map();
    this.selectedIds = nodes.filter((node) => node.selected).map((node) => node.id);
    for (const id of this.dragItemIds) {
      const node = nodeById.get(id);
      if (!node) continue;
      this.baseById.set(id, node);
      this.affectedIds.add(id);
      if (!isGroupNode(node)) continue;
      for (const member of groupMembers(nodes, node.id)) {
        this.affectedIds.add(member.id);
        this.memberGroupByNode.set(member.id, node.id);
        this.baseById.set(member.id, member);
      }
    }

    // 移动集基准绝对盒：每帧只加原始位移，不再反复换算父子坐标
    this.baseAbsoluteById = new Map();
    for (const [id, node] of this.baseById) {
      const bounds = nodeAbsoluteBounds(node, nodeById);
      if (bounds) this.baseAbsoluteById.set(id, bounds);
    }
    // 候选目标排除完整移动集与隐藏节点；外部写入重建时一起重建
    this.targets = buildSnapTargets(nodes, this.affectedIds, nodeById);
    this.snapState = emptySnapState();
  }

  private captureDom(): DomSnapshot | null {
    const root = this.deps.root.current;
    if (!root) return null;

    const wrappers = new Map<string, HTMLElement>();
    for (const el of root.querySelectorAll<HTMLElement>(".react-flow__node[data-id]")) {
      const id = el.dataset.id;
      if (id && this.affectedIds.has(id)) wrappers.set(id, el);
    }

    const edges = new Map<string, EdgeDom>();
    for (const el of root.querySelectorAll<SVGGElement>(".react-flow__edge[data-id]")) {
      const id = el.dataset.id;
      if (!id) continue;
      const geometry = getEdgeGeometry(id);
      // 未登记几何的边不参与预览（规则 4.5）
      if (!geometry) continue;
      if (!this.affectedIds.has(geometry.sourceId) && !this.affectedIds.has(geometry.targetId)) {
        continue;
      }
      const paths = Array.from(el.querySelectorAll<SVGPathElement>("path"));
      edges.set(id, { group: el, paths, mode: "none" });
    }

    const labelLayers = Array.from(
      root.querySelectorAll<HTMLElement>(".react-flow__edgelabel-renderer"),
    ).map((el) => ({ el, visibility: el.style.visibility }));

    const selectionEl = root.querySelector<HTMLElement>(".react-flow__nodesselection");

    const toolbars: ToolbarDom[] = [];
    for (const el of root.querySelectorAll<HTMLElement>(".react-flow__node-toolbar[data-id]")) {
      // RF 的 data-id 是节点 id 以空格连接的列表；本仓库工具条均为单节点
      const nodeId = (el.dataset.id ?? "").trim().split(/\s+/)[0];
      if (!nodeId || !this.affectedIds.has(nodeId)) continue;
      toolbars.push({ el, nodeId, originalTranslate: el.style.translate });
    }

    return {
      wrappers,
      edges,
      labelLayers,
      selectionFrame: selectionEl
        ? { el: selectionEl, visibility: selectionEl.style.visibility, translate: selectionEl.style.translate }
        : null,
      toolbars,
    };
  }

  private hideLabelLayers(): void {
    if (!this.dom) return;
    // 边标签/删除按钮基于拖动前坐标，拖动期隐藏（规则 4.4）
    for (const layer of this.dom.labelLayers) layer.el.style.visibility = "hidden";
  }

  private clearDomOffsets(dom: DomSnapshot): void {
    for (const el of dom.wrappers.values()) el.style.translate = "";
    for (const edge of dom.edges.values()) {
      edge.group.style.translate = "";
      edge.mode = "none";
    }
    for (const layer of dom.labelLayers) layer.el.style.visibility = layer.visibility;
    if (dom.selectionFrame) {
      dom.selectionFrame.el.style.visibility = dom.selectionFrame.visibility;
      dom.selectionFrame.el.style.translate = dom.selectionFrame.translate;
    }
    for (const toolbar of dom.toolbars) toolbar.el.style.translate = toolbar.originalTranslate;
  }

  private restoreEdgePaths(dom: DomSnapshot): void {
    for (const [edgeId, edge] of dom.edges) {
      if (edge.mode !== "path") continue;
      const geometry = getEdgeGeometry(edgeId);
      if (geometry) this.restoreEdgePath(edge, geometry);
      else edge.mode = "none";
    }
  }

  /**
   * 把预览改写的路径还原为基准几何：由登记几何重算（与 `DeletableEdge` 同一纯函数），
   * 不保存 DOM 里的旧 `d`——外部写入会让登记值刷新，重算永远得到当前正确路径。
   */
  private restoreEdgePath(edge: EdgeDom, geometry: RegisteredEdgeGeometry): void {
    const base = computeEdgePath(geometry).path;
    for (const path of edge.paths) path.setAttribute("d", base);
    edge.mode = "none";
  }

  private cancelRaf(): void {
    if (this.rafId === null) return;
    cancelAnimationFrame(this.rafId);
    this.rafId = null;
  }

  private release(): void {
    if (!this.active) return;
    this.cancelRaf();
    this.pendingFrame = null;
    if (this.dom) this.clearDomOffsets(this.dom);
    this.reset();
  }

  private reset(): void {
    this.detachModifierListeners();
    this.dom = null;
    this.active = false;
    this.commitPending = false;
    this.dragItemIds = [];
    this.affectedIds = new Set();
    this.baseById = new Map();
    this.baseAbsoluteById = new Map();
    this.targets = [];
    this.snapState = emptySnapState();
    this.snapZoom = 1;
    this.bypassHeld = false;
    this.shiftHeld = false;
    this.modifiersEnabled = true;
    this.memberGroupByNode = new Map();
    this.selectedIds = [];
    this.pointerOffset = { x: 0, y: 0 };
    this.lastFrame = null;
    this.pendingFrame = null;
    clearPreviewGuides();
  }
}
