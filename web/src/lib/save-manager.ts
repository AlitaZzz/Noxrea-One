/**
 * SaveManager — 画布保存的唯一入口。
 *
 * 职责：
 *  - dirty 状态管理
 *  - trailing save queue（只保存最终最新状态）
 *  - save: PUT /api/canvas/projects/{id}
 *  - flushSave / flushOnUnload（页面卸载/组件卸载时紧急保存，keepalive: true）
 *  - 错误处理与重试
 *
 * 不依赖 React component 生命周期。
 * 仅支持登录用户，画布不允许游客访问。
 */

import { BASE, checkUnauthorized,getTokenHeader } from "@/lib/api";
import { takeCanvasSnapshot,useCanvasStore } from "@/stores/canvas-store";
import { useProjectStore } from "@/stores/project-store";

type CanvasSnapshot = ReturnType<typeof takeCanvasSnapshot>;

interface ImageRef {
  url?: unknown;
}

const SAVE_DELAY = 2000;
const SAVE_DELAY_IMMEDIATE = 100;

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

/** 深拷贝并剔除 React Flow 运行时字段（selected/dragging/positionAbsolute） */
function stripRuntimeFields(snapshot: CanvasSnapshot) {
  return {
    ...snapshot,
    nodes: snapshot.nodes.map((n) => {
      const rest = { ...(n as Record<string, unknown>) };
      delete rest.selected;
      delete rest.dragging;
      delete rest.positionAbsolute;
      return rest;
    }),
    edges: snapshot.edges.map((e) => {
      const rest = { ...(e as Record<string, unknown>) };
      delete rest.selected;
      return rest;
    }),
  };
}

class SaveManager {
  private dirty = false;
  private saving = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private registered = false;
  private savePromise: Promise<void> = Promise.resolve();
  private resolveSave: (() => void) | null = null;
  /** saving 期间被跳过的最紧急 delay，恢复时用此值而非默认值 */
  private pendingDelay: number = SAVE_DELAY;

  // ==================== 公开接口 ====================

  /** 标记改脏 — 2s trailing save（连续操作：拖拽/打字/缩放） */
  markDirty(): void {
    this.setDirty(SAVE_DELAY);
  }

  /** 标记改脏 — 100ms trailing save（离散操作：增删节点/编组/粘贴/连接） */
  markDirtyImmediate(): void {
    this.setDirty(SAVE_DELAY_IMMEDIATE);
  }

  private setDirty(delay: number): void {
    // 确保项目列表内存状态已同步
    const s = useCanvasStore.getState();
    const pid = useProjectStore.getState().activeProjectId;
    if (pid) {
      useProjectStore.getState().syncCanvasState(
        pid, s.nodes, s.edges, s.viewport,
        s.background, s.theme, s.minimapVisible, s.snapToGrid,
      );
    }
    if (!this.dirty) {
      this.dirty = true;
      this.registerFlushOnce();
    }
    this.pendingDelay = Math.min(this.pendingDelay, delay);
    this.resetTimer(delay);
  }

  /** 立即保存最新状态（页面隐藏等，fire-and-forget） */
  flushSave(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (this.saving) return;
    void this.save(true);
  }

  /**
   * 等待当前保存完成并确保最终状态已落盘。
   * 用于项目切换等需要保证数据完整性的场景。
   * 最多重试 3 次，防止持久失败导致无限循环。
   */
  async flushAndWait(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    let retries = 3;
    while ((this.saving || this.dirty) && retries > 0) {
      if (this.saving) {
        await this.savePromise;
      }
      if (this.dirty) {
        retries--;
        await this.save(true);
      }
    }
  }

  /**
   * 页面生命周期兜底保存（关闭/刷新/组件卸载），fire-and-forget。
   * 与 save() 不同：
   *  - 检查 dirty 但跳过 saving（避免与 save() 冲突）
   *  - 不重试，不改变内部状态
   *  - 始终使用 keepalive: true
   */
  flushOnUnload(): void {
    if (!this.dirty) return;
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }

    const pid = useProjectStore.getState().activeProjectId;
    if (!pid) return;

    const snapshot = takeCanvasSnapshot();
    if (!snapshot.nodes.length && !snapshot.edges.length) return;

    this.saveToApi(pid, snapshot, true).catch(() => {});
  }

  /** 查询保存状态，供 UI 显示 */
  get status(): { dirty: boolean; saving: boolean } {
    return { dirty: this.dirty, saving: this.saving };
  }

  // ==================== 内部实现 ====================

  private resetTimer(delay: number = SAVE_DELAY): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    if (this.saving) {
      this.pendingDelay = Math.min(this.pendingDelay, delay);
      return;
    }
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.save(false);
    }, delay);
  }

  private async save(keepalive: boolean): Promise<void> {
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

      const snapshot = takeCanvasSnapshot();
      await this.saveToApi(activeId, snapshot, keepalive);
    } catch (e) {
      console.error("[SaveManager] save failed:", e);
      this.dirty = true;
    } finally {
      this.saving = false;
      this.resolveSave?.();
    }

    if (this.dirty) {
      this.resetTimer(this.pendingDelay);
    }
    this.pendingDelay = SAVE_DELAY;
  }

  private async saveToApi(
    projectId: string,
    snapshot: ReturnType<typeof takeCanvasSnapshot>,
    keepalive: boolean,
  ): Promise<void> {
    const id = parseInt(projectId, 10);
    if (isNaN(id)) return;

    const clean = stripRuntimeFields(snapshot);

    // 计算当前 fingerprint，判断文件引用是否变化
    const currentFp = _collectCanvasHashes(clean.nodes).join(",");
    const prevFp = fingerprintMap.get(projectId) ?? "";
    const needRefRecalc = currentFp !== prevFp;

    const payload: Record<string, unknown> = {
      canvas_data: {
        nodes: clean.nodes,
        edges: clean.edges,
        viewport: snapshot.viewport,
        background: snapshot.background,
        theme: snapshot.theme,
        minimapVisible: snapshot.minimapVisible,
        snapToGrid: snapshot.snapToGrid,
      },
    };
    if (needRefRecalc) {
      payload.needRefRecalc = true;
    }

    const body = JSON.stringify(payload);
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const auth = getTokenHeader().Authorization;
    if (auth) headers["Authorization"] = auth;

    const res = await fetch(`${BASE}/api/canvas/projects/${id}`, {
      method: "PUT",
      headers,
      body,
      keepalive,
    });

    // keepalive 请求无法读取响应体，且页面即将卸载时无需处理 401
    if (!keepalive && checkUnauthorized(res.status)) return;

    fingerprintMap.set(projectId, currentFp);
  }

  /** 全局只注册一次页面生命周期监听 */
  private registerFlushOnce(): void {
    if (this.registered) return;
    this.registered = true;
    if (typeof window === "undefined") return;

    const onUnload = () => this.flushOnUnload();
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") onUnload();
    });
    window.addEventListener("pagehide", onUnload);
    window.addEventListener("beforeunload", onUnload);
  }
}

/** 全局单例 */
export const saveManager = new SaveManager();
