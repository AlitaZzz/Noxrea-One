/**
 * 画布框选手势会话。
 *
 * 空白区左键拖拽由本会话接管，不再使用 React Flow 内建框选：按下后超过阈值
 * 才激活；激活时冻结一份节点几何索引，手势期间每帧只做「读视口 → 查询命中 →
 * 写选框一个元素 + 命中集合差量属性」，不写 store。松手时节点与边的选中态
 * 恰好提交一次（边跳过历史），待渲染层采用新节点后释放预览属性。
 *
 * 规则与边界见 specs/canvas-marquee-gesture-session.md。
 * 非 React 模块：由 `InfiniteCanvas` 持有并注入 store / React Flow 访问器。
 * DOM 契约依赖本仓库固定的 React Flow 12.12 受控模式（`.react-flow__pane`、
 * `.react-flow__node[data-id]`），升级 React Flow 必须重新验证。
 */
import type { Edge } from "@xyflow/react";
import { calcAutoPan } from "@xyflow/system";
import type { RefObject } from "react";

import { isEditableTarget } from "@/features/canvas/shared/dom";
import { edgeTouchesSelection } from "@/features/canvas/shared/edge-selection";
import type { Point, Rect } from "@/features/canvas/shared/geometry";
import type { HistoryPushOptions, InteractionAction } from "@/features/canvas/stores/canvas-store";
import type { AnyNode } from "@/features/canvas/types";

import {
  buildMarqueeGeometryIndex,
  type MarqueeGeometryIndex,
  queryMarqueeSelection,
} from "./marquee-geometry";

/** 激活阈值：按下点到当前指针的屏幕距离（px）。 */
const MARQUEE_ACTIVATION_DISTANCE = 1;

const EMPTY_SELECTION: ReadonlySet<string> = new Set();

interface GestureSnapshot {
  nodeIds: ReadonlySet<string>;
  edgeIds: ReadonlySet<string>;
  nodesSelectionActive: boolean;
  projectId: string | null;
}

/** 当前视口：平移量与缩放；zoom 已校验为有限正数。 */
interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

/** 会话可派发的交互动作；类型从 store 的动作联合派生，避免两处字面量漂移。 */
type MarqueeInteractionAction = Extract<
  InteractionAction,
  { type: "selection-start" | "click" }
>["type"];

export interface MarqueeSessionDeps {
  /** 画布容器（包含 `.react-flow__pane` 与选框元素）。 */
  root: RefObject<HTMLElement | null>;
  getNodes: () => AnyNode[];
  getEdges: () => Edge[];
  setNodes: (nodes: AnyNode[]) => void;
  setEdges: (edges: Edge[], options?: HistoryPushOptions) => void;
  /** 画布交互状态机；激活进入 box-selecting，取消回到 idle。 */
  dispatchInteraction: (action: MarqueeInteractionAction) => void;
  /** 当前画布内容所属项目；用于取消时避免把旧项目选区恢复到新项目。 */
  getProjectId: () => string | null;
  getTransform: () => readonly [number, number, number];
  panBy: (delta: Point) => Promise<boolean>;
  getNodesSelectionActive: () => boolean;
  setNodesSelectionActive: (active: boolean) => void;
  /** 是否允许开始框选（元素可选中、连线未进行中）。 */
  canStartMarquee: () => boolean;
}

/** 只克隆选中态发生变化的条目；返回是否发生变化。 */
function mapSelected<T extends { selected?: boolean }>(
  items: readonly T[],
  isSelected: (item: T) => boolean,
): { next: T[]; changed: boolean } {
  let changed = false;
  const next = items.map((item) => {
    const selected = isSelected(item);
    if ((item.selected === true) === selected) return item;
    changed = true;
    return { ...item, selected } as T;
  });
  return { next, changed };
}

type Phase = "idle" | "candidate" | "active";

export class MarqueeSession {
  private phase: Phase = "idle";
  /** 提交后等待渲染层采用新节点；期间保留预览属性，采用后释放。 */
  private commitPending = false;
  private attached = false;
  /** attach 时捕获的容器：dispose 必须从同一元素移除监听，不能重读 ref。 */
  private rootEl: HTMLElement | null = null;
  private pane: HTMLElement | null = null;
  private marqueeEl: HTMLElement | null = null;

  private pointerId = -1;
  private startClient: Point = { x: 0, y: 0 };
  private lastClient: Point = { x: 0, y: 0 };
  /** 按下点在 flow 坐标系中的位置（激活时换算，视口变化由每帧公式吸收）。 */
  private startFlow: Point = { x: 0, y: 0 };
  /** 追加选择的起点（按下时快照；手势中途按键不改变本次模式）。 */
  private baseline: ReadonlySet<string> = EMPTY_SELECTION;

  private index: MarqueeGeometryIndex | null = null;
  private wrappers = new Map<string, HTMLElement>();
  /** 当前以 DOM 预览高亮的命中集合（尚未提交）。 */
  private previewedIds: ReadonlySet<string> = EMPTY_SELECTION;
  private snapshot: GestureSnapshot | null = null;
  private rafId: number | null = null;
  private lastFrameKey: string | null = null;
  private panInFlight = false;

  private spaceHeld = false;
  /** 手势结束后吞掉紧随的一次 pane click；在下一次按下时解除。 */
  private clickSuppressed = false;

  constructor(private readonly deps: MarqueeSessionDeps) {}

  /**
   * 绑定画布容器与键盘监听。监听挂在容器而非 `.react-flow__pane` 上：
   * 项目切换可能重建 React Flow 的 pane 元素，容器在画布生命周期内保持不变。
   * 须在 React Flow 首次渲染后调用；重复调用无副作用。
   */
  attach(): void {
    if (this.attached) return;
    const root = this.deps.root.current;
    if (!root) return;
    this.attached = true;
    this.rootEl = root;
    root.addEventListener("pointerdown", this.handleContainerPointerDown);
    window.addEventListener("keydown", this.handleKeyDown, true);
    window.addEventListener("keyup", this.handleKeyUp, true);
    window.addEventListener("blur", this.handleWindowBlur);
    // 右键菜单接管画布时结束手势；与 blur 分开处理，避免误清 Space 按下状态
    window.addEventListener("contextmenu", this.handleWindowContextMenu);
  }

  /** 卸载：结束会话并清理全部监听；不恢复选区（即将离开画布）。 */
  dispose(): void {
    if (this.attached) {
      this.rootEl?.removeEventListener("pointerdown", this.handleContainerPointerDown);
      this.rootEl = null;
      window.removeEventListener("keydown", this.handleKeyDown, true);
      window.removeEventListener("keyup", this.handleKeyUp, true);
      window.removeEventListener("blur", this.handleWindowBlur);
      window.removeEventListener("contextmenu", this.handleWindowContextMenu);
      this.attached = false;
    }
    this.abort();
    this.disarmClickSuppression();
    this.pane = null;
  }

  /**
   * 渲染层采用了新的 `nodes`（React Flow 受控同步完成）后调用。
   * 提交路径 → 释放预览；手势期间 → 项目切换则取消，其余外部写入不重建
   * 冻结几何（规则 4）。
   */
  syncRenderedNodes(): void {
    if (this.commitPending) {
      this.resetGesture();
      return;
    }
    if (this.phase === "idle" || !this.snapshot) return;
    if (this.deps.getProjectId() !== this.snapshot.projectId) this.cancel();
  }

  // ---- 指针与键盘 ----

  private handleContainerPointerDown = (event: PointerEvent): void => {
    // 手势中的按下由 window 级 pointerdown 统一处理（第二指针取消）；
    // 这里只负责空闲态起手，且不提前解散 click 抑制
    if (this.phase !== "idle") return;
    // 空闲下的新按下意味着上一次手势的 click 窗口结束
    this.disarmClickSuppression();
    // 上一次提交尚未被渲染层采用：先释放旧预览，避免两个手势的命中属性叠加
    if (this.commitPending) this.resetGesture();

    const target = event.target;
    if (!(target instanceof HTMLElement) || !target.classList.contains("react-flow__pane")) return;
    if (event.button !== 0 || event.isPrimary === false) return;
    // 只接受鼠标与手写笔（规则 1.1）；触屏走原生滚动/平移，未知指针类型不猜测
    if (event.pointerType !== "mouse" && event.pointerType !== "pen") return;
    if (this.spaceHeld) return;
    if (!this.deps.canStartMarquee()) return;

    const viewport = this.readViewport();
    if (!viewport) return;
    const bounds = target.getBoundingClientRect();

    this.phase = "candidate";
    this.pane = target;
    this.pointerId = event.pointerId;
    this.startClient = { x: event.clientX, y: event.clientY };
    this.lastClient = { ...this.startClient };
    // 按下点固定映射到 flow 坐标：手势中缩放/平移后仍以该点作为对角锚点
    this.startFlow = {
      x: (event.clientX - bounds.left - viewport.x) / viewport.zoom,
      y: (event.clientY - bounds.top - viewport.y) / viewport.zoom,
    };
    const nodes = this.deps.getNodes();
    const edges = this.deps.getEdges();
    const additive = event.shiftKey || event.ctrlKey || event.metaKey;
    this.baseline = additive
      ? new Set(
          nodes
            .filter((node) => node.selected === true && node.selectable !== false)
            .map((node) => node.id),
        )
      : EMPTY_SELECTION;
    // 快照取按下时状态：取消恢复与项目切换保护都以手势起点为准
    this.snapshot = {
      nodeIds: new Set(nodes.filter((node) => node.selected === true).map((node) => node.id)),
      edgeIds: new Set(edges.filter((edge) => edge.selected === true).map((edge) => edge.id)),
      nodesSelectionActive: this.deps.getNodesSelectionActive(),
      projectId: this.deps.getProjectId(),
    };

    window.addEventListener("pointerdown", this.handleWindowPointerDown);
    window.addEventListener("pointermove", this.handleWindowPointerMove);
    window.addEventListener("pointerup", this.handleWindowPointerUp);
    window.addEventListener("pointercancel", this.handleWindowPointerCancel);
  };

  /**
   * 手势期间任意位置出现第二指针（触屏/手写笔）即取消：第二根手指可能落在
   * 画布外（侧栏、工具条），不能只在容器上判定。同一指针的重复按下
   * （如手势中按下右键）忽略，且不解散 click 抑制。
   */
  private handleWindowPointerDown = (event: PointerEvent): void => {
    if (this.phase !== "idle" && event.pointerId !== this.pointerId) this.cancel();
  };

  private handleWindowPointerMove = (event: PointerEvent): void => {
    if (event.pointerId !== this.pointerId) return;
    // 指针在窗口外松开时可能收不到 pointerup（也没有 blur/pointercancel）：
    // 后续 move 的 buttons 为 0，按取消兜底，避免无按键状态下继续框选
    if (event.buttons === 0) {
      if (this.phase === "candidate") this.endCandidate();
      else this.cancel();
      return;
    }
    this.lastClient = { x: event.clientX, y: event.clientY };

    if (this.phase === "candidate") {
      const dx = event.clientX - this.startClient.x;
      const dy = event.clientY - this.startClient.y;
      // 与 React Flow 的 paneClickDistance 语义一致：恰好等于阈值仍算点击
      if (dx * dx + dy * dy <= MARQUEE_ACTIVATION_DISTANCE ** 2) return;
      this.activate();
    }
    // 激活后由持续 rAF 帧消费最新指针位置；这里无需再调度
  };

  private handleWindowPointerUp = (event: PointerEvent): void => {
    if (event.pointerId !== this.pointerId) return;
    // 鼠标的每个按键抬起都会派发 pointerup；只认左键，避免右键提前结束手势
    if (event.button !== 0) return;
    if (this.phase === "candidate") {
      this.endCandidate();
      return;
    }
    if (this.phase !== "active") return;

    this.lastClient = { x: event.clientX, y: event.clientY };
    // 指针可能停在上一次 move 之外；提交前用最终位置补一帧，但不触发自动平移
    this.applyFrame(false);
    this.commit();
  };

  private handleWindowPointerCancel = (event: PointerEvent): void => {
    if (event.pointerId !== this.pointerId) return;
    if (this.phase !== "idle") this.cancel();
  };

  private handleLostPointerCapture = (): void => {
    if (this.phase === "active") this.cancel();
  };

  private handleKeyDown = (event: KeyboardEvent): void => {
    if (event.code === "Space") {
      if (!isEditableTarget(event.target)) this.spaceHeld = true;
      return;
    }
    // Esc 取消后全局 Escape 仍按现有语义清空选区（Spec 规则 9.4）：
    // 这里不 preventDefault，冒泡阶段的 use-canvas-keyboard 照常接管
    if (event.key === "Escape" && this.phase !== "idle") this.cancel();
  };

  private handleKeyUp = (event: KeyboardEvent): void => {
    if (event.code === "Space") this.spaceHeld = false;
  };

  private handleWindowBlur = (): void => {
    this.spaceHeld = false;
    if (this.phase !== "idle") this.cancel();
  };

  /** 右键菜单弹出即接管画布：结束手势并恢复选区，Space 状态由 keyup/blur 维护。 */
  private handleWindowContextMenu = (): void => {
    if (this.phase !== "idle") this.cancel();
  };

  // ---- 会话生命周期 ----

  private activate(): void {
    const pane = this.pane;
    if (!pane || this.phase !== "candidate") return;
    const snapshot = this.snapshot;
    // 候选期间切换项目：手势已不属于当前画布，直接结束且不写任何状态
    if (!snapshot || snapshot.projectId !== this.deps.getProjectId()) {
      this.endCandidate();
      return;
    }
    // 视口非法（缩放为 0 或非有限）无法换算，按候选结束处理
    if (!this.readViewport()) {
      this.endCandidate();
      return;
    }

    const nodes = this.deps.getNodes();
    this.phase = "active";
    this.index = buildMarqueeGeometryIndex(nodes);
    this.previewedIds = EMPTY_SELECTION;
    this.lastFrameKey = null;
    this.captureDomWrappers();

    // 清空已提交选中：依赖选中的面板/工具条按现有行为关闭，视觉交给预览
    this.writeSelection(() => false, () => false, false);

    this.deps.dispatchInteraction("selection-start");
    this.armClickSuppression();
    try {
      pane.setPointerCapture(this.pointerId);
    } catch {
      // 指针已释放（极短手势）；后续 window 监听仍能完成/取消会话
    }
    pane.addEventListener("lostpointercapture", this.handleLostPointerCapture);

    this.applyFrame(true);
    this.scheduleFrame();
  }

  private cancel(): void {
    if (this.phase === "idle") return;
    const wasActive = this.phase === "active";
    const snapshot = this.snapshot;
    this.stopPointerSession();

    // 恢复 → 清理预览 → 回到 idle：先撤下预览属性再让界面按恢复后的选区渲染
    if (wasActive && snapshot && snapshot.projectId === this.deps.getProjectId()) {
      this.restoreSnapshot(snapshot);
    }
    this.resetGesture();
    if (wasActive) this.deps.dispatchInteraction("click");
  }

  private commit(): void {
    const snapshot = this.snapshot;
    // 松手前项目已切换：手势结果属于旧项目，不能写入新项目（规则 9.1）；
    // cancel 会因项目不匹配跳过选区恢复
    if (!snapshot || snapshot.projectId !== this.deps.getProjectId()) {
      this.cancel();
      return;
    }
    this.stopPointerSession();

    // 以当前节点集合过滤预览命中，并同时应用 selectable：
    // 节点、边与外框状态都基于这份最终选中集（规则 8.3 / 6.3），
    // 避免手势中节点被锁定后出现「外框激活但无选中节点」或「端点未选中但边选中」
    const selectedIds = new Set<string>();
    for (const node of this.deps.getNodes()) {
      if (this.previewedIds.has(node.id) && node.selectable !== false) selectedIds.add(node.id);
    }

    const nodesChanged = this.writeSelection(
      (node) => selectedIds.has(node.id),
      (edge) => edge.selectable !== false && edgeTouchesSelection(edge, selectedIds),
      selectedIds.size > 0,
    );

    if (nodesChanged) {
      // 预览属性保留到渲染层采用新节点，避免选中视觉闪断；
      // 释放信号只取节点变化——边选中不改变节点渲染
      this.commitPending = true;
    } else {
      this.resetGesture();
    }
  }

  /** 结束指针阶段（提交/取消/候选结束共用），不触碰 store。 */
  private stopPointerSession(): void {
    this.detachPointerListeners();
    this.releasePointerCapture();
    this.cancelFrame();
    this.phase = "idle";
    this.pointerId = -1;
    this.snapshot = null;
    // 保留 pane 引用：提交/取消后仍需用它判定「吞掉紧随的 pane click」
  }

  /** 候选阶段结束（未达阈值/项目切换/视口非法）：不写 store、不抑制 click。 */
  private endCandidate(): void {
    this.stopPointerSession();
    this.baseline = EMPTY_SELECTION;
  }

  /** 卸载时的静默中止：丢弃预览，不恢复选区、不派发交互状态。 */
  private abort(): void {
    this.detachPointerListeners();
    this.releasePointerCapture();
    this.phase = "idle";
    this.commitPending = false;
    this.resetGesture();
  }

  private restoreSnapshot(snapshot: GestureSnapshot): void {
    this.writeSelection(
      (node) => snapshot.nodeIds.has(node.id),
      (edge) => snapshot.edgeIds.has(edge.id),
      snapshot.nodesSelectionActive,
    );
  }

  /**
   * 统一写入节点/边选中：只在与当前状态不同时写入，边一律跳过历史。
   * 返回节点是否发生变化——预览释放只等待节点渲染采用。
   */
  private writeSelection(
    isNodeSelected: (node: AnyNode) => boolean,
    isEdgeSelected: (edge: Edge) => boolean,
    nodesSelectionActive: boolean,
  ): boolean {
    const nodes = mapSelected(this.deps.getNodes(), isNodeSelected);
    if (nodes.changed) this.deps.setNodes(nodes.next);

    const edges = mapSelected(this.deps.getEdges(), isEdgeSelected);
    if (edges.changed) this.deps.setEdges(edges.next, { skipHistory: true });

    if (this.deps.getNodesSelectionActive() !== nodesSelectionActive) {
      this.deps.setNodesSelectionActive(nodesSelectionActive);
    }
    return nodes.changed;
  }

  // ---- 帧循环与预览 ----

  private scheduleFrame(): void {
    if (this.rafId !== null || this.phase !== "active") return;
    this.rafId = requestAnimationFrame(this.handleFrame);
  }

  private handleFrame = (): void => {
    this.rafId = null;
    if (this.phase !== "active") return;
    this.applyFrame(true);
    // 持续帧循环：吸收手势中的缩放/平移、自动平移推进，无需为视口变化单独接线
    this.scheduleFrame();
  };

  private cancelFrame(): void {
    if (this.rafId === null) return;
    cancelAnimationFrame(this.rafId);
    this.rafId = null;
  }

  /** 读取视口并校验 zoom；非法视口（非有限或 ≤ 0）返回 null，由调用方按各自语义退出。 */
  private readViewport(): Viewport | null {
    const [x, y, zoom] = this.deps.getTransform();
    if (!Number.isFinite(zoom) || zoom <= 0) return null;
    return { x, y, zoom };
  }

  /**
   * 一帧：读取当前视口，计算选框屏幕矩形与 flow 命中矩形，写选框与命中差量，
   * 再按指针位置推进自动平移。不写 store。
   */
  private applyFrame(allowAutoPan: boolean): void {
    const pane = this.pane;
    const index = this.index;
    if (!pane || !index || this.phase !== "active") return;

    const viewport = this.readViewport();
    if (!viewport) return;
    const { x: viewX, y: viewY, zoom } = viewport;

    const bounds = pane.getBoundingClientRect();
    const currentX = this.lastClient.x - bounds.left;
    const currentY = this.lastClient.y - bounds.top;
    const anchorX = this.startFlow.x * zoom + viewX;
    const anchorY = this.startFlow.y * zoom + viewY;
    const screenRect: Rect = {
      x: Math.min(anchorX, currentX),
      y: Math.min(anchorY, currentY),
      width: Math.abs(currentX - anchorX),
      height: Math.abs(currentY - anchorY),
    };

    const frameKey = `${viewX}|${viewY}|${zoom}|${bounds.left}|${bounds.top}|${this.lastClient.x}|${this.lastClient.y}`;
    if (frameKey !== this.lastFrameKey) {
      this.lastFrameKey = frameKey;
      this.writeMarquee(screenRect);
      this.showPreview(
        queryMarqueeSelection(
          index,
          {
            x: (screenRect.x - viewX) / zoom,
            y: (screenRect.y - viewY) / zoom,
            width: screenRect.width / zoom,
            height: screenRect.height / zoom,
          },
          this.baseline,
        ),
      );
    }

    if (allowAutoPan) this.autoPan({ x: currentX, y: currentY }, bounds);
  }

  private writeMarquee(rect: Rect): void {
    const el = this.marqueeEl;
    if (!el) return;
    el.dataset.active = "true";
    el.style.transform = `translate(${rect.x}px, ${rect.y}px)`;
    el.style.width = `${rect.width}px`;
    el.style.height = `${rect.height}px`;
  }

  /** 只对差量写属性：大多数帧命中集合变化很小。 */
  private showPreview(next: ReadonlySet<string>): void {
    for (const id of this.previewedIds) {
      if (!next.has(id)) this.wrappers.get(id)?.removeAttribute("data-marquee-hit");
    }
    for (const id of next) {
      if (!this.previewedIds.has(id)) this.wrappers.get(id)?.setAttribute("data-marquee-hit", "");
    }
    this.previewedIds = next;
  }

  private autoPan(position: Point, dimensions: { width: number; height: number }): void {
    if (this.panInFlight) return;
    const [x, y] = calcAutoPan(position, dimensions);
    if (x === 0 && y === 0) return;
    this.panInFlight = true;
    void this.deps.panBy({ x, y }).then(
      (panned) => {
        this.panInFlight = false;
        if (!panned) this.lastFrameKey = null;
      },
      (error: unknown) => {
        // 自动平移是尽力而为：失败不终止手势，下一帧按最新视口位置重试；
        // 但不能静默吞掉异常，保留诊断以便定位视口控制器问题
        this.panInFlight = false;
        console.warn("[marquee] 自动平移失败", error);
      },
    );
  }

  private captureDomWrappers(): void {
    this.wrappers = new Map();
    const root = this.deps.root.current;
    if (!root) return;
    for (const el of root.querySelectorAll<HTMLElement>(".react-flow__node[data-id]")) {
      const id = el.dataset.id;
      if (id) this.wrappers.set(id, el);
    }
    this.marqueeEl = root.querySelector<HTMLElement>("[data-canvas-marquee]");
  }

  /** 清理手势的全部瞬态状态与 DOM 预览：冻结索引、命中属性、选框、快照与基线。 */
  private resetGesture(): void {
    this.cancelFrame();
    for (const id of this.previewedIds) {
      this.wrappers.get(id)?.removeAttribute("data-marquee-hit");
    }
    this.previewedIds = EMPTY_SELECTION;
    this.wrappers = new Map();
    this.index = null;
    this.baseline = EMPTY_SELECTION;
    this.lastFrameKey = null;
    this.commitPending = false;
    this.snapshot = null;

    const el = this.marqueeEl;
    if (el) {
      delete el.dataset.active;
      el.style.transform = "";
      el.style.width = "";
      el.style.height = "";
    }
    this.marqueeEl = null;
  }

  // ---- 指针捕获、监听与点击抑制 ----

  private detachPointerListeners(): void {
    window.removeEventListener("pointerdown", this.handleWindowPointerDown);
    window.removeEventListener("pointermove", this.handleWindowPointerMove);
    window.removeEventListener("pointerup", this.handleWindowPointerUp);
    window.removeEventListener("pointercancel", this.handleWindowPointerCancel);
    this.pane?.removeEventListener("lostpointercapture", this.handleLostPointerCapture);
  }

  private releasePointerCapture(): void {
    const pane = this.pane;
    if (!pane || this.pointerId < 0) return;
    try {
      if (pane.hasPointerCapture(this.pointerId)) pane.releasePointerCapture(this.pointerId);
    } catch {
      // 指针已失效，无需释放
    }
  }

  private armClickSuppression(): void {
    if (this.clickSuppressed) return;
    this.clickSuppressed = true;
    window.addEventListener("click", this.handleSuppressClick, true);
  }

  private disarmClickSuppression(): void {
    if (!this.clickSuppressed) return;
    this.clickSuppressed = false;
    window.removeEventListener("click", this.handleSuppressClick, true);
  }

  /** 只吞掉落在空白 pane 上的那一次 click；其他点击解除抑制后正常派发。 */
  private handleSuppressClick = (event: MouseEvent): void => {
    if (event.target === this.pane) {
      event.preventDefault();
      event.stopPropagation();
    }
    this.disarmClickSuppression();
  };
}
