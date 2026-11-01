/**
 * 画布缩放手势会话。
 *
 * 缩放期间尺寸帧不写受控 store：会话把每帧尺寸按 rAF 合并，直接写节点 wrapper 的
 * 行内 `width` / `height`；松手时按最终几何一次 `setNodes` 提交（同时写 `style` 与
 * `measured`），待渲染层采用新 `nodes` 后释放。活动期消费本节点的尺寸回传，
 * 避免 ResizeObserver 再写一次 store。完整规则见 specs/canvas-resize-gesture-session.md。
 *
 * 非 React 模块：由 `InfiniteCanvas` 持有并注入 store / 历史访问器。
 * DOM 契约依赖本仓库固定的 React Flow 12.12 受控模式
 * （`.react-flow__node[data-id]`、行内尺寸由 `style.width/height` 决定），
 * 升级 React Flow 必须重新验证。
 */
import type { RefObject } from "react";

import type { Point } from "@/features/canvas/shared/geometry";
import type { AnyNode } from "@/features/canvas/types";
import type { HistorySnapshot } from "@/features/project/types";

import { computeResizeSize, type ResizeSize, type ResizeStart } from "./resize-geometry";

export interface ResizeSessionDeps {
  /** 画布根元素：DOM 预览只在它内部查询（会话只在事件/rAF 中读取 current） */
  root: RefObject<HTMLElement | null>;
  /** 受控 store 的实时节点 */
  getNodes: () => AnyNode[];
  /** 提交入口（会话唯一的 store 写入口） */
  setNodes: (nodes: AnyNode[]) => void;
  /** 提交后立即落库（缩放期不 markDirty） */
  markDirtyImmediate: () => void;
  /** 按下时的历史快照：有变化时提交一条 */
  takeSnapshot: () => HistorySnapshot;
  pushHistory: (snapshot: HistorySnapshot) => void;
}

export interface ResizeBeginOptions {
  nodeId: string;
  /** 发起本次手势的指针；其它指针的事件不参与会话 */
  pointerId: number;
  /** 按下点（client 坐标，屏幕像素） */
  pointer: Point;
  /** 按下时锁定的视口缩放 */
  zoom: number;
  minWidth: number;
  minHeight: number;
}

interface InlineSize {
  width: string;
  height: string;
}

interface StoreGeometry {
  width: number | null;
  height: number | null;
  x: number;
  y: number;
  measuredWidth: number | null;
  measuredHeight: number | null;
}

/** 起始尺寸取值链与改造前一致：显式 style 优先，0/缺省回退实测（画布单位） */
function startSize(value: unknown, fallback: number): number {
  const size = Number(value);
  return size || fallback;
}

function numericStyleSize(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  const size = Number(value);
  return Number.isFinite(size) ? size : null;
}

function toCssSize(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "number") return `${value}px`;
  return String(value);
}

function captureStoreGeometry(node: AnyNode): StoreGeometry {
  return {
    width: numericStyleSize(node.style?.width),
    height: numericStyleSize(node.style?.height),
    x: node.position.x,
    y: node.position.y,
    measuredWidth: node.measured?.width ?? null,
    measuredHeight: node.measured?.height ?? null,
  };
}

/** 外部写入是否改动了被缩放节点的几何（未改动时手势继续） */
function sameStoreGeometry(node: AnyNode, base: StoreGeometry): boolean {
  const width = numericStyleSize(node.style?.width);
  const height = numericStyleSize(node.style?.height);
  return (
    width === base.width &&
    height === base.height &&
    node.position.x === base.x &&
    node.position.y === base.y &&
    (node.measured?.width ?? null) === base.measuredWidth &&
    (node.measured?.height ?? null) === base.measuredHeight
  );
}

export class ResizeSession {
  private active = false;
  private commitPending = false;
  private nodeId = "";
  private pointerId = -1;
  private wrapper: HTMLElement | null = null;
  private start: ResizeStart | null = null;
  private storeGeometry: StoreGeometry | null = null;
  private originalInline: InlineSize | null = null;
  private min: ResizeSize = { width: 0, height: 0 };
  private snapshot: HistorySnapshot | null = null;
  private lastPointer: Point | null = null;
  private pendingPointer: Point | null = null;
  private lastApplied: ResizeSize | null = null;
  private rafId: number | null = null;
  private listenersAttached = false;

  constructor(private readonly deps: ResizeSessionDeps) {}

  /** 活动期（含提交后等待渲染层采用）内，本节点的尺寸回传由会话消费 */
  isResizingNode(nodeId: string): boolean {
    return this.active && this.nodeId === nodeId;
  }

  /**
   * 开始缩放：冻结起点几何、wrapper、原始行内尺寸与历史快照。
   * 节点或 wrapper 不存在时不建立会话。
   */
  begin(options: ResizeBeginOptions): boolean {
    // 同一时刻只允许一个会话：先按上一会话的当前预览结束它（规则 1.4）
    if (this.active) {
      this.commitAt(this.pendingPointer ?? this.lastPointer ?? this.start?.pointer ?? options.pointer);
      this.reset();
    }

    const node = this.deps.getNodes().find((n) => n.id === options.nodeId);
    if (!node) return false;
    const wrapper = this.resolveWrapper(options.nodeId);
    if (!wrapper) return false;

    const zoom = Number.isFinite(options.zoom) && options.zoom > 0 ? options.zoom : 1;
    const rect = wrapper.getBoundingClientRect();
    this.active = true;
    this.commitPending = false;
    this.nodeId = options.nodeId;
    this.pointerId = options.pointerId;
    this.wrapper = wrapper;
    this.start = {
      pointer: options.pointer,
      width: startSize(node.style?.width, rect.width / zoom),
      height: startSize(node.style?.height, rect.height / zoom),
      zoom,
    };
    this.storeGeometry = captureStoreGeometry(node);
    this.originalInline = { width: wrapper.style.width, height: wrapper.style.height };
    this.min = { width: options.minWidth, height: options.minHeight };
    this.snapshot = this.deps.takeSnapshot();
    this.lastPointer = options.pointer;
    this.pendingPointer = null;
    this.lastApplied = null;
    this.attachListeners();
    return true;
  }

  /** 丢弃未提交尺寸（外部改写/删除）：DOM 恢复为当前 store 几何，store 不变 */
  cancel(): void {
    if (!this.active) return;
    this.cancelRaf();
    this.pendingPointer = null;
    this.restoreFromStore(this.deps.getNodes());
    this.reset();
  }

  /** 卸载/项目切换：只清理会话，不提交也不恢复（规则 5.4） */
  dispose(): void {
    this.cancelRaf();
    this.pendingPointer = null;
    this.reset();
  }

  /**
   * 渲染层采用了新的 `nodes`（React Flow 受控同步完成）后调用：
   * 提交路径 → 释放；活动路径 → 校验外部写入是否改写了被缩放节点。
   */
  syncRenderedNodes(): void {
    if (!this.active) return;
    if (this.commitPending) {
      this.release();
      return;
    }
    const node = this.deps.getNodes().find((n) => n.id === this.nodeId);
    if (!node || !this.storeGeometry || !sameStoreGeometry(node, this.storeGeometry)) {
      this.cancel();
    }
  }

  // ---- 内部：指针生命周期 ----

  private attachListeners(): void {
    if (this.listenersAttached) return;
    window.addEventListener("pointermove", this.handlePointerMove);
    window.addEventListener("pointerup", this.handlePointerUp);
    window.addEventListener("pointercancel", this.handlePointerCancel);
    window.addEventListener("blur", this.handleWindowBlur);
    this.listenersAttached = true;
  }

  private detachListeners(): void {
    if (!this.listenersAttached) return;
    window.removeEventListener("pointermove", this.handlePointerMove);
    window.removeEventListener("pointerup", this.handlePointerUp);
    window.removeEventListener("pointercancel", this.handlePointerCancel);
    window.removeEventListener("blur", this.handleWindowBlur);
    this.listenersAttached = false;
  }

  private readonly handlePointerMove = (event: PointerEvent): void => {
    if (!this.active || this.commitPending || event.pointerId !== this.pointerId) return;
    this.pendingPointer = { x: event.clientX, y: event.clientY };
    if (this.rafId !== null) return;
    this.rafId = requestAnimationFrame(() => {
      this.rafId = null;
      const pointer = this.pendingPointer;
      this.pendingPointer = null;
      if (!this.active || this.commitPending || !pointer) return;
      this.applyPreview(pointer);
    });
  };

  private readonly handlePointerUp = (event: PointerEvent): void => {
    if (!this.active || this.commitPending || event.pointerId !== this.pointerId) return;
    this.commitAt({ x: event.clientX, y: event.clientY });
  };

  private readonly handlePointerCancel = (event: PointerEvent): void => {
    if (!this.active || this.commitPending || event.pointerId !== this.pointerId) return;
    this.commitAt(this.pendingPointer ?? this.lastPointer ?? this.start?.pointer);
  };

  /**
   * 窗口失焦兜底：指针抬起可能丢失，会话不能长期停留在活动状态吞掉尺寸回传。
   * 按最后一帧提交，既不留下只存在于 DOM 的尺寸，也不产生半截预览。
   */
  private readonly handleWindowBlur = (): void => {
    if (!this.active || this.commitPending) return;
    const pointer = this.pendingPointer ?? this.lastPointer ?? this.start?.pointer;
    if (pointer) this.commitAt(pointer);
  };

  // ---- 内部：预览与提交 ----

  private applyPreview(pointer: Point): void {
    if (!this.start) return;
    this.lastPointer = pointer;
    const size = computeResizeSize(this.start, pointer, this.min);
    if (
      this.lastApplied &&
      this.lastApplied.width === size.width &&
      this.lastApplied.height === size.height
    ) {
      return;
    }
    this.applySize(size);
  }

  private applySize(size: ResizeSize): void {
    this.lastApplied = size;
    if (!this.wrapper) return;
    this.wrapper.style.width = `${size.width}px`;
    this.wrapper.style.height = `${size.height}px`;
  }

  private commitAt(pointer: Point | undefined): void {
    if (!this.active || this.commitPending || !this.start || !pointer) return;
    this.cancelRaf();
    this.pendingPointer = null;
    this.lastPointer = pointer;
    const size = computeResizeSize(this.start, pointer, this.min);
    this.applySize(size);
    this.detachListeners();

    // 无位移点按/回到起始尺寸：不写 store、不压历史；恢复原始行内尺寸，
    // 否则 React 的 style prop 未变化，会留下仅存在于 DOM 的尺寸（规则 4.2）
    if (size.width === this.start.width && size.height === this.start.height) {
      this.restoreOriginalInline();
      this.reset();
      return;
    }

    const nodes = this.deps.getNodes();
    const node = nodes.find((n) => n.id === this.nodeId);
    if (!node) {
      this.restoreFromStore(nodes);
      this.reset();
      return;
    }

    const next = nodes.map((n) =>
      n.id === this.nodeId
        ? ({
            ...n,
            style: { ...n.style, width: size.width, height: size.height },
            // 提交必须同时写实测：预览期 DOM 已到终值，不会再触发 ResizeObserver，
            // 缺 measured 时 adoptUserNodes 会用 store 旧值覆盖内部实测（规则 4.3）
            measured: { width: size.width, height: size.height },
          } as AnyNode)
        : n,
    );
    this.commitPending = true;
    this.deps.setNodes(next);
    this.deps.markDirtyImmediate();
    if (this.snapshot) this.deps.pushHistory(this.snapshot);
  }

  private restoreOriginalInline(): void {
    if (!this.wrapper || !this.originalInline) return;
    this.wrapper.style.width = this.originalInline.width;
    this.wrapper.style.height = this.originalInline.height;
  }

  private restoreFromStore(nodes: AnyNode[]): void {
    if (!this.wrapper) return;
    const node = nodes.find((n) => n.id === this.nodeId);
    const width = toCssSize(node?.style?.width);
    const height = toCssSize(node?.style?.height);
    this.wrapper.style.width = width ?? this.originalInline?.width ?? "";
    this.wrapper.style.height = height ?? this.originalInline?.height ?? "";
  }

  private resolveWrapper(nodeId: string): HTMLElement | null {
    const root = this.deps.root.current;
    if (!root) return null;
    for (const el of root.querySelectorAll<HTMLElement>(".react-flow__node[data-id]")) {
      if (el.dataset.id === nodeId) return el;
    }
    return null;
  }

  private cancelRaf(): void {
    if (this.rafId === null) return;
    cancelAnimationFrame(this.rafId);
    this.rafId = null;
  }

  /** 提交后等渲染层采用新 `nodes` 再释放；行内尺寸保留，由 React 接管 */
  private release(): void {
    this.cancelRaf();
    this.pendingPointer = null;
    this.reset();
  }

  private reset(): void {
    this.detachListeners();
    this.active = false;
    this.commitPending = false;
    this.nodeId = "";
    this.pointerId = -1;
    this.wrapper = null;
    this.start = null;
    this.storeGeometry = null;
    this.originalInline = null;
    this.min = { width: 0, height: 0 };
    this.snapshot = null;
    this.lastPointer = null;
    this.pendingPointer = null;
    this.lastApplied = null;
  }
}
