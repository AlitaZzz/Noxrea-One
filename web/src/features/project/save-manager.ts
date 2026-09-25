/**
 * SaveManager - 画布保存的唯一入口。
 *
 * 不变量：
 *  1. 内容有主 —— 保存与草稿一律按 canvasProjectId（画布内容所属项目）寻址，
 *     与 UI 激活态（activeProjectId）解耦；派发即定格（快照/所有者在同一同步 tick 捕获），
 *     互斥锁内只做网络请求，项目切换窗口期不可能把 A 的内容发给 B。
 *  2. 写通道单飞 —— 服务端写请求任意时刻至多一个（saveMutex 串行）；
 *     卸载兜底不再并发第二个 PUT（同 baseRevision 并发必然 409），
 *     在途请求已携带其派发快照，此后增量由本地草稿承接。
 *  3. 草稿按代际判定 —— 草稿 rev = 落库将产生的 revision；rev <= 服务端 revision
 *     的草稿即陈旧（含竞态幽灵记录），删除或忽略均安全，不依赖时钟比较。
 *
 * 职责：
 *  - dirty 状态管理（trailing save queue，只保存最终最新状态）
 *  - save: PUT /api/canvas/projects/{id}
 *  - flushSave / flushOnHide：页面存活场景的紧急保存（普通请求，无 64KB 限制）
 *  - flushOnUnload：页面真正卸载前的兜底（keepalive，受 64KB 请求体上限约束）
 *  - 错误处理与重试
 *
 * 不依赖 React component 生命周期。
 * 仅支持登录用户，画布不允许游客访问。
 */

import { getCanvasProjectId, takeCanvasSnapshot, useCanvasStore } from "@/features/canvas/stores/canvas-store";
import type { AnyEdge, AnyNode } from "@/features/canvas/types";
import { projectApi } from "@/features/project/api";
import { clearStaleDraft, type DraftCanvasData, saveDraft } from "@/features/project/draft-store";
import { saveMutex } from "@/features/project/save-mutex";
import { useSessionExpiredStore } from "@/features/project/session-expired-store";
import { useProjectStore } from "@/features/project/store";
import { parseErrorBody } from "@/lib/api/error-message";

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

/** 服务端当前 revision（项目不在列表内存时按 1 处理） */
function currentRevision(projectId: string): number {
  return useProjectStore.getState().projects.find((p) => p.id === projectId)?.revision ?? 1;
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

/** 提取单个节点引用的文件 hash；当前媒体节点只使用 data.src。 */
function _collectNodeHashes(node: { data?: Record<string, unknown> }): Set<string> {
  const hashes = new Set<string>();
  const d = node?.data ?? {};
  if (typeof d.src === "string") {
    const hash = _extractHashFromUrl(d.src);
    if (hash) hashes.add(hash);
  }
  return hashes;
}

/** 按节点数量统计画布文件引用；复制节点会带来新的数量。 */
function _collectCanvasHashCounts(
  nodes: ReadonlyArray<{ data?: Record<string, unknown> }>,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const node of nodes) {
    for (const hash of _collectNodeHashes(node)) {
      counts.set(hash, (counts.get(hash) ?? 0) + 1);
    }
  }
  return counts;
}

/** 引用指纹包含数量；仅 hash 列表会让复制节点被误判为无变化。 */
function _buildCanvasHashFingerprint(
  nodes: ReadonlyArray<{ data?: Record<string, unknown> }>,
): string {
  return [..._collectCanvasHashCounts(nodes)]
    .sort(([hashA], [hashB]) => hashA.localeCompare(hashB))
    .map(([hash, count]) => `${hash}:${count}`)
    .join(",");
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
function stripRuntimeFields(snapshot: ReturnType<typeof takeCanvasSnapshot>) {
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

/** 从当前画布构建可持久化的画布数据（同步，供保存派发与草稿写入共用） */
function buildCanvasData(): DraftCanvasData {
  const clean = stripRuntimeFields(takeCanvasSnapshot());
  return {
    nodes: clean.nodes as AnyNode[],
    edges: clean.edges as AnyEdge[],
    viewport: clean.viewport,
    background: clean.background,
    minimapVisible: clean.minimapVisible,
    snapToGrid: clean.snapToGrid,
    agentModel: useCanvasStore.getState().agentModel ?? undefined,
  };
}

class SaveManager {
  private dirty = false;
  private saving = false;
  /** 是否离线：离线时暂停自动保存，恢复在线后立即补存 */
  private offline = false;
  /**
   * 会话已过期：画布已在其他标签页 / 浏览器被修改（保存收到 409）。
   * 同页写通道已由 saveMutex 串行化且卸载兜底不再并发第二个请求，
   * 409 不可能来自本窗口——停用一切后续保存，本地改动继续写草稿，
   * 由过期弹窗引导用户刷新后经草稿恢复承接。
   */
  private expired = false;
  /** 过期期间有新的本地改动：驱动草稿持续写入（保存请求已停用） */
  private expiredDirty = false;
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
    // 过期后不发保存请求；本地改动仍驱动草稿持续写入，刷新后经草稿恢复承接。
    if (this.expired) {
      this.expiredDirty = true;
      this.scheduleDraftWrite();
      return;
    }
    if (!this.dirty) {
      this.dirty = true;
      this.dirtySince = Date.now();
      this.registerFlushOnce();
    }
    this.pendingDelay = Math.min(this.pendingDelay, delay);
    this.resetTimer(delay);
    this.scheduleDraftWrite();
  }

  /**
   * 切换 / 重载画布内容前调用（restoreFromProject 换 owner 之前）。
   * 语义：未派发的尾部编辑以草稿为准，不随新内容派发保存——
   * 此刻先按旧 owner 固化草稿，再清空全部派发状态。
   * 过期态属于旧画布内容：一并解除（换项目 / 重新加载即恢复全新编辑会话，
   * 冲突语义不随导航带到其他项目）。
   */
  resetForProjectSwitch(): void {
    if (this.dirty || this.expiredDirty) void this.writeDraftCore();
    this.dirty = false;
    this.expired = false;
    this.expiredDirty = false;
    this.dirtySince = null;
    this.pendingSave = null;
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (this.draftTimer) {
      clearTimeout(this.draftTimer);
      this.draftTimer = null;
    }
    useSessionExpiredStore.getState().resetExpired();
  }

  /** 防抖写离线草稿：markDirty 后延迟写入，避免拖拽逐帧写 IndexedDB */
  private scheduleDraftWrite(): void {
    if (this.draftTimer) clearTimeout(this.draftTimer);
    this.draftTimer = setTimeout(() => {
      this.draftTimer = null;
      this.queueDraftWrite();
    }, DRAFT_WRITE_DELAY);
  }

  /** 草稿写入排队到写互斥锁上：与保存的 put/clearStaleDraft 全局串行，杜绝交错 */
  private queueDraftWrite(): void {
    void saveMutex.runExclusive(() => this.writeDraftCore());
  }

  /**
   * 草稿写入核心。快照与 owner 在同步前缀捕获。
   * 互斥锁内的调用（防抖路径）在此复查 guard——若期间保存已把内容落库，
   * 则跳过写入，幽灵草稿从构造上不可能产生；
   * 卸载 / 切换项目的直调路径由调用方保证 dirty 语义。
   */
  private async writeDraftCore(): Promise<void> {
    const projectId = getCanvasProjectId();
    if (!projectId) return;
    if (!this.dirty && !this.saving && !this.expiredDirty) return;
    const canvasData = buildCanvasData();
    // 快照已定格即视为消费完毕；标志必须在 await 前清掉，
    // 否则与过期期间的并发编辑竞态（在途写入的完成回调会覆盖掉新一轮编辑的置位）。
    // await 期间的编辑会重新置位，由下一次防抖写入承接。
    this.expiredDirty = false;
    // 代际：若落库将产生的 revision。在途保存成功会推高服务端版本，
    // 故在途时 +1，保证草稿在「在途保存成功」之后仍被判定为更新。
    const rev = currentRevision(projectId) + (this.saving ? 1 : 0) + 1;
    await saveDraft(projectId, rev, canvasData);
  }

  /** 保存失败时按失败的 job 内容固化草稿（rev = 该请求本应产生的版本号） */
  private writeJobDraft(projectId: string, baseRevision: number, canvasData: DraftCanvasData): void {
    // 已有更新的未落库改动：防抖草稿内容更新且代际更准，由其覆盖
    if (this.dirty) return;
    void saveDraft(projectId, baseRevision + 1, canvasData);
  }

  /** 立即保存最新状态（fire-and-forget；页面存活，故无需 keepalive） */
  flushSave(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (this.saving) {
      // 在途保存收尾后立即补存，而非丢弃定时器等默认延迟重排
      if (this.dirty) {
        this.pendingSave = { keepalive: false, skipUnauthorized: false };
      }
      return;
    }
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

  /** 兜底保存的公共实现 */
  private flush(opts: { keepalive: boolean; skipUnauthorized: boolean }): void {
    if (this.expired || !this.dirty) return;
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }

    if (this.saving) {
      if (opts.keepalive) {
        // 页面即将卸载：绝不发第二个写请求（与在途请求同 baseRevision 并发必然 409）。
        // 在途请求已携带其派发快照，此后的增量直接固化进本地草稿（IndexedDB 事务
        // 同步发起，不依赖页面存活；put 先于在途保存的清理创建，顺序有保证）。
        void this.writeDraftCore();
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

  // ==================== 内部实现 ====================

  private resetTimer(delay: number = SAVE_DELAY): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    // 离线暂停自动保存：不排定时器，保持 dirty 等待 online 事件触发补存
    if (this.offline || this.expired) return;
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
    if (this.expired) return;
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
    // 派发即定格：所有者与快照在同一同步 tick 捕获，之后任何 await 都不重读全局状态。
    // 内容无主（画布未加载）时没有可保存对象，保持 dirty 等待加载完成。
    const projectId = getCanvasProjectId();
    if (!projectId) return;
    const s = useCanvasStore.getState();
    const canvasData = buildCanvasData();
    useProjectStore.getState().syncCanvasState(
      projectId, s.nodes, s.edges, canvasData.viewport,
      canvasData.background, canvasData.minimapVisible, canvasData.snapToGrid, s.agentModel,
    );
    this.dirty = false;
    this.saving = true;
    this.savePromise = new Promise((r) => { this.resolveSave = r; });

    try {
      // 网络段进入写互斥锁：与项目重命名共用同一条串行通道，
      // baseRevision 在锁内发请求前一刻读取，同页 409 从构造上不可能发生。
      await saveMutex.runExclusive(() =>
        this.saveToApi(projectId, canvasData, { keepalive, skipUnauthorized }),
      );
    } catch (e) {
      console.error("[SaveManager] save failed:", e);
      if (getCanvasProjectId() === projectId) {
        this.dirty = true;
        // 失败后补写一次草稿：此刻服务端没有这份数据，本地兜底最有价值
        this.scheduleDraftWrite();
      } else {
        // 派发后已切换内容所有者：失败 job 属于旧项目，按其本应产生的代际固化草稿
        //（网络异常路径没有 saveToApi 里的 writeJobDraft 兜底，这里是唯一固化点）；
        // 失败不标到新项目头上，否则新项目的原始内容会被无意义重存并误写草稿。
        // 若切换前已固化过更新代际的草稿，saveDraft 的代际单调性会拒绝本次回退写入。
        void saveDraft(projectId, currentRevision(projectId) + 1, canvasData);
      }
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
    canvasData: DraftCanvasData,
    opts: { keepalive: boolean; skipUnauthorized: boolean },
  ): Promise<void> {
    // 计算当前 fingerprint，判断文件引用数量是否变化
    const currentFp = _buildCanvasHashFingerprint(canvasData.nodes);
    const prevFp = fingerprintMap.get(projectId) ?? "";
    const needRefRecalc = currentFp !== prevFp;
    // 每次更新都携带保存前的版本；服务端校验后递增，防止迟到请求回退引用账本。
    // 在互斥锁内、请求发出前一刻读取，保证同页写通道严格串行。
    const baseRevision = currentRevision(projectId);

    const payload: Record<string, unknown> = { baseRevision, canvasData };
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

    // 只有真正落库成功（2xx）才更新 fingerprint 并清陈旧草稿：失败时若也更新 fingerprint，
    // 下次保存会误判「文件引用未变化」而跳过 needRefRecalc，造成引用计数长期不一致。
    // 401：重试也无意义（需重新登录），按失败 job 固化草稿交给下次进入提示恢复。
    // 其余失败（5xx 等）必须抛错 —— 否则 save() 开头的 dirty=false 不会被撤销、
    // 也不重排定时器，改动静默丢失，草稿却还留着（刷新后误报且救不回来）。
    if (!res.ok) {
      if (res.status === 401) {
        this.writeJobDraft(projectId, baseRevision, canvasData);
        return;
      }
      if (res.status === 409) {
        // 409 即该画布已在其他标签页 / 浏览器被修改（同页写通道已由 saveMutex 串行化、
        // 卸载兜底不再并发第二个请求）。同步服务端版本并按派发所有者归属结局：
        // owner 未变 → 进入过期态，停用本窗口后续保存，草稿承接未落库改动；
        // owner 已切换（409 迟到）→ 冲突属于旧项目，按服务端当前版本固化其草稿，
        // 绝不把过期态带给新进入的画布。
        const respBody = parseErrorBody(await res.json().catch(() => null));
        const conflictRevision = respBody?.ctx?.revision;
        if (typeof conflictRevision === "number") {
          useProjectStore.getState().updateProjectRevision(projectId, conflictRevision);
        }
        // 服务端内容已经变化；清空指纹，刷新恢复后如继续编辑会重算引用账本。
        fingerprintMap.delete(projectId);
        if (getCanvasProjectId() === projectId) {
          this.markExpired();
        } else {
          void saveDraft(projectId, currentRevision(projectId) + 1, canvasData);
        }
        return;
      }
      this.writeJobDraft(projectId, baseRevision, canvasData);
      throw new Error(`[SaveManager] save failed: HTTP ${res.status}`);
    }

    fingerprintMap.set(projectId, currentFp);
    // 服务端更新成功必然 revision + 1；本地同步后下一次保存才能携带正确版本。
    const serverRev = baseRevision + 1;
    useProjectStore.getState().updateProjectRevision(projectId, serverRev);
    // 只清陈旧代际：在途期间写入的较新草稿（含切换项目前固化的）保留承接未落库改动
    await clearStaleDraft(projectId, serverRev);
  }

  /** 进入过期态：停用全部保存路径，立即固化草稿，交由过期弹窗引导刷新。 */
  private markExpired(): void {
    this.expired = true;
    this.dirty = false;
    this.expiredDirty = true;
    this.pendingSave = null;
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    // 排队到当前保存回调之后执行（此刻仍在互斥锁内，直接跑会嵌套排队自己）；
    // 执行时 revision 已同步为服务端当前版本，草稿代际据此推算
    this.queueDraftWrite();
    useSessionExpiredStore.getState().markExpired();
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
