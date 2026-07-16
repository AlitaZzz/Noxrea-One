/**
 * SaveManager — 画布保存的唯一入口。
 *
 * 职责：
 *  - dirty 状态管理
 *  - trailing save queue（只保存最终最新状态）
 *  - save: PUT /api/canvas/projects/{id}
 *  - flushSave（页面隐藏时紧急保存，keepalive: true）
 *  - 错误处理与重试
 *
 * 不依赖 React component 生命周期。
 * 仅支持登录用户，画布不允许游客访问。
 */

import { useCanvasStore, takeCanvasSnapshot } from "@/stores/canvas-store";
import { useProjectStore } from "@/stores/project-store";
import { BASE, getTokenHeader } from "@/lib/api";

const SAVE_DELAY = 3000;

class SaveManager {
  private dirty = false;
  private saving = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private registered = false;
  private savePromise: Promise<void> = Promise.resolve();
  private resolveSave: (() => void) | null = null;

  // ==================== 公开接口 ====================

  /** 标记改脏 — 开始 trailing save 计时 */
  markDirty(): void {
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
    this.resetTimer();
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

  /** 查询保存状态，供 UI 显示 */
  get status(): { dirty: boolean; saving: boolean } {
    return { dirty: this.dirty, saving: this.saving };
  }

  // ==================== 内部实现 ====================

  private resetTimer(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    if (this.saving) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.save(false);
    }, SAVE_DELAY);
  }

  private async save(keepalive: boolean): Promise<void> {
    if (!this.dirty) return;
    this.dirty = false;
    this.saving = true;
    this.savePromise = new Promise((r) => { this.resolveSave = r; });

    try {
      const activeId = useProjectStore.getState().activeProjectId;
      if (!activeId) return;

      const snapshot = takeCanvasSnapshot();
      await this.saveToApi(activeId, snapshot, keepalive);
    } catch (e) {
      console.error("[SaveManager] save failed:", e);
      this.dirty = true;
    } finally {
      this.saving = false;
      this.resolveSave?.();
    }

    if (this.dirty) this.resetTimer();
  }

  private async saveToApi(
    projectId: string,
    snapshot: ReturnType<typeof takeCanvasSnapshot>,
    keepalive: boolean,
  ): Promise<void> {
    const id = parseInt(projectId, 10);
    if (isNaN(id)) return;

    const body = JSON.stringify({
      canvas_data: {
        nodes: snapshot.nodes,
        edges: snapshot.edges,
        viewport: snapshot.viewport,
        background: snapshot.background,
        theme: snapshot.theme,
        minimapVisible: snapshot.minimapVisible,
        snapToGrid: snapshot.snapToGrid,
      },
    });

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const auth = getTokenHeader().Authorization;
    if (auth) headers["Authorization"] = auth;

    await fetch(`${BASE}/api/canvas/projects/${id}`, {
      method: "PUT",
      headers,
      body,
      keepalive,
    });
  }

  /** 全局只注册一次 pagehide/visibilitychange */
  private registerFlushOnce(): void {
    if (this.registered) return;
    this.registered = true;
    if (typeof window === "undefined") return;

    const onHide = () => {
      if (document.visibilityState === "hidden") this.flushSave();
    };
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", () => this.flushSave());
  }
}

/** 全局单例 */
export const saveManager = new SaveManager();
