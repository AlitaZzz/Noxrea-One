/**
 * SaveManager - 画布保存的唯一入口。
 *
 * 职责：
 *  - dirty 状态管理
 *  - trailing save queue（只保存最终最新状态）
 *  - save: PUT /api/canvas/projects/{id}
 *  - flushSave / flushOnHide：页面存活场景的紧急保存（普通请求，无 64KB 限制）
 *  - flushOnUnload：页面真正卸载前的兜底（keepalive，受 64KB 请求体上限约束）
 *  - 错误处理与重试
 *
 * 不依赖 React component 生命周期。
 * 仅支持登录用户，画布不允许游客访问。
 */

import { getLiveViewport, takeCanvasSnapshot, useCanvasStore } from "@/features/canvas/stores/canvas-store";
import type { AnyEdge, AnyNode } from "@/features/canvas/types";
import { projectApi } from "@/features/project/api";
import { clearDraft, saveDraft } from "@/features/project/draft-store";
import { useProjectStore } from "@/features/project/store";

type CanvasSnapshot = ReturnType<typeof takeCanvasSnapshot>;

interface ImageRef {
  url?: unknown;
}

const SAVE_DELAY = 2000;
const SAVE_DELAY_IMMEDIATE = 100;
/** undo/redo 专用延迟，比 immediate 稍长以合并连续撤销/重做 */
const SAVE_DELAY_UNDO = 500;
/** 离线草稿写入防抖（ms）：拖拽等高频操作不逐帧写 IndexedDB */
const DRAFT_WRITE_DELAY = 500;
/**
 * 持续操作时的强制保存上限（ms）。
 * 防抖定时器会被每次改动不断重置，若用户一直操作（长时间拖拽、连续摆放节点），
 * 保存会被无限推迟、服务端数据长期落后。它保证距本轮首次改脏不超过该值必存一次。
 */
const MAX_SAVE_WAIT = 10000;
/** flushAndWait 单次等待当前保存的上限（ms）：宁可超时放行，也不能让项目切换永久挂起 */
const FLUSH_WAIT_TIMEOUT = 5000;

/** 给等待加超时上限；超时后放行调用方并记录告警 */
function withTimeout(p: Promise<void>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      console.warn("[SaveManager] flushAndWait timed out after", ms, "ms");
      resolve();
    }, ms);
    p.then(
      () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve();
      },
      () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve();
      },
    );
  });
}

// ── fingerprint：追踪画布文件引用变化 ──
// 提取 /api/files/{user_id}/{hash[:2]}/{hash}{ext} 中的 64 位 hash
function _extractHashFromUrl(url: string): string | null {
  if (!url || typeof url !== "string") return null;
  const idx = url.indexOf("/api/files/");
  if (idx === -1) return null;
  const path = url.slice(idx + "/api/files/".length);
  const parts = path.split("/");
  if (parts.length !== 3) return null;
  const fn = parts[2];
  const dot = fn.lastIndexOf(".");
  const h = dot > 0 ? fn.slice(0, dot) : fn;
  return h.length === 64 ? h : null;
}

function _collectCanvasHashes(nodes: ReadonlyArray<{ data?: Record<string, unknown> }>): string[] {
  const hashes: string[] = [];
  for (const node of nodes) {
    const d = node?.data ?? {};
    // image-node / video-node: data.src
    if (typeof d.src === "string") {
      const h = _extractHashFromUrl(d.src);
      if (h) hashes.push(h);
    }
    if (Array.isArray(d.images)) {
      for (const img of d.images as ImageRef[]) {
        if (typeof img?.url === "string") {
          const h = _extractHashFromUrl(img.url);
          if (h) hashes.push(h);
        }
      }
    }
  }
  return [...new Set(hashes)].sort();
}

/** 按 projectId 区分指纹，项目切换时自动隔离 */
const fingerprintMap = new Map<string, string>();

/**
 * 上传失败且尚未落库的占位节点：留在画布上供用户重试，但没有有效 src。
 * 落库会留下空节点，且刷新后重试上下文失效会变成无法处理的僵尸节点，故保存时剔除。
 */
function isUnresolvedUploadNode(node: unknown): boolean {
  const data = (node as { data?: Record<string, unknown> } | undefined)?.data;
  const upload = data?.upload as { error?: unknown } | undefined;
  return Boolean(upload?.error) && !data?.src;
}

/** 深拷贝并剔除 React Flow 运行时字段（selected/dragging/positionAbsolute） */
function stripRuntimeFields(snapshot: CanvasSnapshot) {
  // 悬空边（任一端指向被剔除的失败节点）一并剔除，避免存下指向空节点的连线
  const removed = new Set(
    snapshot.nodes.filter(isUnresolvedUploadNode).map((n) => (n as { id: string }).id),
  );
  return {
    ...snapshot,
    nodes: snapshot.nodes
      .filter((n) => !isUnresolvedUploadNode(n))
      .map((n) => {
        const rest = { ...(n as Record<string, unknown>) };
        delete rest.selected;
        delete rest.dragging;
        delete rest.positionAbsolute;
        return rest;
      }),
    edges: snapshot.edges
      .filter((e) => !removed.has(e.source) && !removed.has(e.target))
      .map((e) => {
        const rest = { ...(e as Record<string, unknown>) };
        delete rest.selected;
        // 已废弃的箭头字段：新版连线不渲染箭头，保存时主动剔除旧数据残留
        delete rest.markerEnd;
        return rest;
      }),
  };
}

class SaveManager {
  private dirty = false;
  private saving = false;
  /** 是否离线：离线时暂停自动保存，恢复在线后立即补存 */
  private offline = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  /** 离线草稿写入的防抖定时器 */
  private draftTimer: ReturnType<typeof setTimeout> | null = null;
  private registered = false;
  private savePromise: Promise<void> = Promise.resolve();
  private resolveSave: (() => void) | null = null;
  /** saving 期间收到的保存诉求：由当前保存收尾后补存，避免并发 save 互相覆盖 */
  private pendingSave: { keepalive: boolean; skipUnauthorized: boolean } | null = null;
  /** saving 期间被跳过的最紧急 delay，恢复时用此值而非默认值 */
  private pendingDelay: number = SAVE_DELAY;
  /** 本轮 dirty 的起始时刻（ms），配合 MAX_SAVE_WAIT 限制保存延迟上限 */
  private dirtySince: number | null = null;

  // ==================== 公开接口 ====================

  /** 标记改脏 - 2s trailing save（连续操作：拖拽/打字/缩放） */
  markDirty(): void {
    this.setDirty(SAVE_DELAY);
  }

  /** 标记改脏 - 100ms trailing save（离散操作：增删节点/编组/粘贴/连接） */
  markDirtyImmediate(): void {
    this.setDirty(SAVE_DELAY_IMMEDIATE);
  }

  /** 标记改脏 - 500ms trailing save（撤销/重做：合并连续 Ctrl+Z / Ctrl+Y） */
  markDirtyUndo(): void {
    this.setDirty(SAVE_DELAY_UNDO);
  }

  private setDirty(delay: number): void {
    // NOTE: syncCanvasState 已移至 save() 中执行，避免拖动时每帧重建 projects 数组
    if (!this.dirty) {
      this.dirty = true;
      this.dirtySince = Date.now();
      this.registerFlushOnce();
    }
    this.pendingDelay = Math.min(this.pendingDelay, delay);
    this.resetTimer(delay);
    this.scheduleDraftWrite();
  }

  /** 防抖写离线草稿：markDirty 后延迟写入，避免拖拽逐帧写 IndexedDB */
  private scheduleDraftWrite(): void {
    if (this.draftTimer) clearTimeout(this.draftTimer);
    this.draftTimer = setTimeout(() => {
      this.draftTimer = null;
      void this.writeDraft();
    }, DRAFT_WRITE_DELAY);
  }

  private async writeDraft(): Promise<void> {
    // 没有未落库的改动、也不在保存中 → 不需要草稿。
    // 关键：保存成功后 dirty 与 saving 均为 false，此时若仍有排队的 draftTimer 触发，
    // 会把「已落库的状态」重新写回本地，形成幽灵草稿，导致下次进入误报「有未保存编辑」。
    if (!this.dirty && !this.saving) return;
    const activeId = useProjectStore.getState().activeProjectId;
    if (!activeId) return;
    const s = useCanvasStore.getState();
    const clean = stripRuntimeFields(takeCanvasSnapshot());
    await saveDraft(activeId, {
      nodes: clean.nodes as AnyNode[],
      edges: clean.edges as AnyEdge[],
      viewport: clean.viewport,
      background: clean.background,
      theme: clean.theme,
      minimapVisible: clean.minimapVisible,
      snapToGrid: clean.snapToGrid,
      agentModel: s.agentModel ?? undefined,
    });
  }

  /** 立即保存最新状态（fire-and-forget；页面存活，故无需 keepalive） */
  flushSave(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (this.saving) return;
    void this.save(false);
  }

  /**
   * 等待当前保存完成并确保最终状态已落盘。
   * 用于项目切换等需要保证数据完整性的场景。
   * 有整体截止时间兜底：持久失败或保存迟迟不结束时放行调用方，
   * 避免项目切换流程被无限阻塞（未落库的改动仍保留 dirty，后续继续重试）。
   */
  async flushAndWait(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    // 整体截止时间：等待中（saving）不消耗重试次数，若只按次数收敛，
    // 保存迟迟不结束时会退化成「每 5s 重试一次」的无限循环。
    const deadline = Date.now() + FLUSH_WAIT_TIMEOUT * 3;
    while ((this.saving || this.dirty) && Date.now() < deadline) {
      if (this.saving) {
        // 加超时：savePromise 理论上必被 resolve，但任何意外都不该让项目切换卡死
        await withTimeout(this.savePromise, FLUSH_WAIT_TIMEOUT);
      }
      if (this.dirty && Date.now() < deadline) {
        // 项目切换场景需要读取响应确认落库，故用普通请求（keepalive 无法读响应体）
        // 同样要加超时：save() 在保存进行中会直接返回尚未完成的 savePromise，
        // 裸 await 会退化成原来的无限期挂起
        await withTimeout(this.save(false), FLUSH_WAIT_TIMEOUT);
      }
    }
  }

  /**
   * 页面进入后台时的保存（切换标签页、最小化、关闭前的 visibilitychange）。
   *
   * 此刻页面仍然存活，普通请求完全可以正常收发，因此**不走 keepalive**：
   * keepalive 有约 64KB 请求体上限，画布稍大就会抛 TypeError: Failed to fetch，
   * 导致保存静默丢失。放在这里保存，绝大多数关闭场景都能可靠落库。
   */
  flushOnHide(): void {
    this.flush({ keepalive: false, skipUnauthorized: true });
  }

  /**
   * 页面真正卸载前的兜底保存（pagehide / beforeunload）。
   *
   * 只有这时才需要 keepalive 让请求活过页面销毁；超过浏览器上限的会失败，
   * 属预期行为——dirty 标记会被保留，下次进入继续保存。
   */
  flushOnUnload(): void {
    this.flush({ keepalive: true, skipUnauthorized: true });
  }

  /** 兜底保存的公共实现；保留空画布保护，防止误覆盖有效数据 */
  private flush(opts: { keepalive: boolean; skipUnauthorized: boolean }): void {
    if (!this.dirty) return;
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }

    const snapshot = takeCanvasSnapshot();
    if (!snapshot.nodes.length && !snapshot.edges.length) return;

    if (this.saving) {
      if (opts.keepalive) {
        // 页面即将卸载：等不到当前保存结束，必须立即把最新快照发出去。
        // 只发请求、不进 save()，因此不会覆盖 saving / savePromise（那是并发竞态的根源）。
        const activeId = useProjectStore.getState().activeProjectId;
        if (activeId) {
          void this.saveToApi(activeId, snapshot, opts)
            .then(() => { this.dirty = false; })
            .catch(() => { /* 卸载兜底失败：保留 dirty，下次进入继续补存 */ });
        }
        return;
      }
      // 页面仍存活：记录诉求，由当前保存收尾后补存
      this.pendingSave = {
        keepalive: false,
        skipUnauthorized: this.pendingSave?.skipUnauthorized || opts.skipUnauthorized,
      };
      this.dirty = true;
      return;
    }

    void this.save(opts.keepalive, opts.skipUnauthorized);
  }

  /** 查询保存状态，供 UI 显示 */
  get status(): { dirty: boolean; saving: boolean } {
    return { dirty: this.dirty, saving: this.saving };
  }

  // ==================== 内部实现 ====================

  private resetTimer(delay: number = SAVE_DELAY): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    // 离线暂停自动保存：不排定时器，保持 dirty 等待 online 事件触发补存
    if (this.offline) return;
    if (this.saving) {
      this.pendingDelay = Math.min(this.pendingDelay, delay);
      return;
    }
    // maxWait：用「距本轮首次改脏的剩余额度」压缩延迟，超过上限则立即保存
    let wait = delay;
    if (this.dirtySince !== null) {
      const remain = MAX_SAVE_WAIT - (Date.now() - this.dirtySince);
      wait = remain <= 0 ? 0 : Math.min(delay, remain);
    }
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.save(false);
    }, wait);
  }

  private async save(keepalive: boolean, skipUnauthorized = false): Promise<void> {
    if (this.saving) {
      // 并发保护：保存进行中绝不启动第二次。
      // 此前每次调用都重建 savePromise 并覆盖 resolveSave，先前的 flushAndWait()
      // 会永远等不到 resolve；后来的 save 还会提前消费 dirty，让它空返回。
      if (this.dirty) {
        this.pendingSave = {
          keepalive: this.pendingSave?.keepalive || keepalive,
          skipUnauthorized: this.pendingSave?.skipUnauthorized || skipUnauthorized,
        };
      }
      return this.savePromise;
    }
    if (!this.dirty) return;
    this.dirty = false;
    this.saving = true;
    this.savePromise = new Promise((r) => { this.resolveSave = r; });

    try {
      const activeId = useProjectStore.getState().activeProjectId;
      if (!activeId) {
        this.dirty = true;
        return;
      }

      // 同步项目列表内存状态（从 setDirty 移至此处，避免拖动时每帧重建 projects 数组）
      const s = useCanvasStore.getState();
      useProjectStore.getState().syncCanvasState(
        activeId, s.nodes, s.edges, getLiveViewport(),
        s.background, s.theme, s.minimapVisible, s.snapToGrid, s.agentModel,
      );

      const snapshot = takeCanvasSnapshot();
      await this.saveToApi(activeId, snapshot, { keepalive, skipUnauthorized });
    } catch (e) {
      console.error("[SaveManager] save failed:", e);
      this.dirty = true;
      // 失败后补写一次草稿：此刻服务端没有这份数据，本地兜底最有价值
      this.scheduleDraftWrite();
    } finally {
      this.saving = false;
      this.resolveSave?.();
    }

    if (this.pendingSave) {
      // 保存期间又有新改动：尽快补存（走防抖而非立即再发请求）。
      // 直接 save 的话，持续改动画布时会退化成「一次保存结束立刻发起下一次」，
      // 请求频率只受 RTT 限制；resetTimer 保留原来的合并窗口。
      this.pendingSave = null;
      this.dirty = true;
      // 重新计时：不让过旧的 dirtySince 把这次补存压成 0 延迟
      this.dirtySince = Date.now();
      this.pendingDelay = SAVE_DELAY_IMMEDIATE;
      this.resetTimer(this.pendingDelay);
      this.pendingDelay = SAVE_DELAY;
      return;
    }

    if (this.dirty) {
      // 重新计时：不让过旧的 dirtySince 使下一次重试被 maxWait 压成 0（避免紧密重试）
      this.dirtySince = Date.now();
      this.resetTimer(this.pendingDelay);
    } else {
      this.dirtySince = null;
    }
    this.pendingDelay = SAVE_DELAY;
  }

  private async saveToApi(
    projectId: string,
    snapshot: ReturnType<typeof takeCanvasSnapshot>,
    opts: { keepalive: boolean; skipUnauthorized: boolean },
  ): Promise<void> {
    const clean = stripRuntimeFields(snapshot);

    // 计算当前 fingerprint，判断文件引用是否变化
    const currentFp = _collectCanvasHashes(clean.nodes).join(",");
    const prevFp = fingerprintMap.get(projectId) ?? "";
    const needRefRecalc = currentFp !== prevFp;

    const payload: Record<string, unknown> = {
      canvasData: {
        nodes: clean.nodes,
        edges: clean.edges,
        viewport: snapshot.viewport,
        background: snapshot.background,
        theme: snapshot.theme,
        minimapVisible: snapshot.minimapVisible,
        snapToGrid: snapshot.snapToGrid,
        agentModel: useCanvasStore.getState().agentModel ?? undefined,
      },
    };
    if (needRefRecalc) {
      payload.needRefRecalc = true;
    }

    const body = JSON.stringify(payload);

    const res = await projectApi.saveProjectRaw(
      projectId,
      body,
      opts.keepalive,
      opts.skipUnauthorized,
    );

    // 只有真正落库成功（2xx）才更新 fingerprint 并清草稿：失败时若也更新 fingerprint，
    // 下次保存会误判「文件引用未变化」而跳过 needRefRecalc，造成引用计数长期不一致。
    // 401：重试也无意义（需重新登录），保留草稿交给下次进入提示恢复。
    // 其余失败（5xx 等）必须抛错 —— 否则 save() 开头的 dirty=false 不会被撤销、
    // 也不重排定时器，改动静默丢失，草稿却还留着（刷新后误报且救不回来）。
    if (!res.ok) {
      if (res.status === 401) return;
      throw new Error(`[SaveManager] save failed: HTTP ${res.status}`);
    }

    fingerprintMap.set(projectId, currentFp);
    void clearDraft(projectId);
  }

  /** 全局只注册一次页面生命周期与网络状态监听 */
  private registerFlushOnce(): void {
    if (this.registered) return;
    this.registered = true;
    if (typeof window === "undefined") return;

    // 校正初始在线状态（SSR / 首屏时 navigator 可能尚未就绪）
    this.offline = typeof navigator !== "undefined" && navigator.onLine === false;

    // 切标签页 / 关闭前会先触发 visibilitychange(hidden)，此时页面仍存活，
    // 用普通请求保存可以承载大画布；pagehide/beforeunload 才是真正的卸载兜底
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") this.flushOnHide();
    });
    window.addEventListener("pagehide", () => this.flushOnUnload());
    window.addEventListener("beforeunload", () => this.flushOnUnload());

    // 离线暂停自动保存：清掉已排的定时器，避免离线瞬间再触发一次必失败的请求
    window.addEventListener("offline", () => {
      this.offline = true;
      if (this.saveTimer) {
        clearTimeout(this.saveTimer);
        this.saveTimer = null;
      }
    });

    // 恢复在线立即补存：dirty 且未在保存中则直接保存
    window.addEventListener("online", () => {
      this.offline = false;
      if (this.dirty && !this.saving) {
        void this.save(false);
      }
    });
  }
}

/** 全局单例 */
export const saveManager = new SaveManager();
