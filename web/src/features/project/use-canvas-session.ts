/**
 * 画布编辑会话 hook。
 *
 * 每个页面实例（打开 / 刷新）持有一条 SSE 连接，实时感知编辑权变化：
 *   - evict：其他页面实例取得编辑权 → 立即进入过期态，不等自己保存撞 409；
 *   - sync：断线重连后服务端 revision 比本地新 → 同样进入过期态
 *     （仅重连处理；首连的 sync 是噪音，见 connect 内注释）。
 * 过期态由页面渲染不可关闭的提示，唯一出口是刷新——刷新即新页面实例，
 * 重新取得编辑权。
 *
 * 会话 ID 是**页面实例级**的：每次整页加载生成新值，SSE 断线重连则复用。
 * 这是「刷新即抢占」的根据——服务端只对全新 ID 广播抢占，重连不会打扰
 * 正在编辑的对方（详见 server/http/canvas-presence.ts）。
 * 因此不需要 sessionStorage 持久化，也不需要 BroadcastChannel 克隆探测：
 * 复制标签页本身就是新页面实例，天然拿到新 ID。
 */
"use client";

import { useEffect } from "react";

import { apiStream } from "@/lib/api/client";
import {
  readSseStream,
  SSE_CONNECT_TIMEOUT_MS,
  SSE_WATCHDOG_CHECK_MS,
  SSE_WATCHDOG_TIMEOUT_MS,
} from "@/lib/sse";

import { saveManager } from "./save-manager";
import { useProjectStore } from "./store";

/**
 * 重连间隔。注意：服务端空置宽限（canvas-presence 的 EMPTY_ROOM_GRACE_MS）
 * 的推算依赖本值（看门狗 30s 判死 + 本间隔为最坏断链时长），调整需同步。
 */
const SSE_RECONNECT_DELAY_MS = 3_000;

/** 页面实例标识：模块级变量，整页加载即重新生成 */
let pageSessionId: string | null = null;

function getPageSessionId(): string {
  if (!pageSessionId) {
    pageSessionId =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `page-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
  return pageSessionId;
}

function knownRevision(projectId: string): number | null {
  const project = useProjectStore.getState().projects.find((p) => p.id === projectId);
  return project ? project.revision : null;
}

/**
 * 画布事件处理（导出供单测）。
 * evict / sync 判定落后时：同步服务端 revision（store 内有单调保护）、
 * 联动 saveManager 停用保存（过期弹窗出现后不再发出必 409 的请求），再进入过期态。
 */
export function handleCanvasSessionEvent(
  projectId: string,
  eventName: string,
  data: { revision?: unknown }
): void {
  const revision = typeof data.revision === "number" ? data.revision : undefined;

  if (eventName === "evict") {
    if (revision !== undefined) {
      useProjectStore.getState().updateProjectRevision(projectId, revision);
    }
    saveManager.notifyEvicted();
    return;
  }

  if (eventName === "sync" && revision !== undefined) {
    const known = knownRevision(projectId);
    // 项目尚未加载（直接打开 / 刷新画布页，store 数据仍在途）：无法判定落后，
    // 忽略本次 sync——首次加载的画布内容本就取自服务端最新快照，无需过期；
    // 「断线期间错过的变更」场景项目必然已加载；他人进入必发 evict 兜底
    if (known === null) return;
    if (revision > known) {
      // 保存响应未返回期间 SSE 闪断重连：sync 推送的 revision 恰为本地在途保存
      // 的落库结果（known + 1），是自己刚提交的保存，不是他人编辑——排除误判。
      // revision 不在此代写：保存若失败版本不能凭空前进，由保存响应自行回写。
      if (saveManager.isOwnInFlightRevision(projectId, revision)) return;
      useProjectStore.getState().updateProjectRevision(projectId, revision);
      saveManager.notifyEvicted();
    }
  }
}

/** 订阅当前画布的编辑权事件流；离开画布页即断开 */
export function useCanvasSession(projectId: string): void {
  useEffect(() => {
    if (!projectId) return;

    let disposed = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let connection: AbortController | null = null;
    // 本 hook 实例是否已成功建立过连接。首连的 sync 帧无意义且有害：
    // 页面初始数据由 refreshProject 全量拉取，但 store 里可能还留着项目列表的
    // 陈旧缓存 revision（另一窗口编辑过）——首连 sync 比对陈旧值会把刚取得
    // 编辑权的用户误判过期、锁进弹窗。sync 只对断线重连有意义：
    // 重连期间页面不再拉数据，靠 sync 才能发现错过的变更。
    let hasConnected = false;

    const connect = () => {
      if (disposed) return;
      // 每次连接独立 controller：看门狗判死 abort 后重连需要新的信号
      connection = new AbortController();
      const { signal } = connection;

      void (async () => {
        let lastDataAt = Date.now();
        let connected = false;
        // 终态标志：401 后不再重连（全局处理器已跳转登录页，重连只会白打请求）
        let stopReconnect = false;
        const watchdog = setInterval(() => {
          const budget = connected ? SSE_WATCHDOG_TIMEOUT_MS : SSE_CONNECT_TIMEOUT_MS;
          if (Date.now() - lastDataAt > budget) connection?.abort();
        }, SSE_WATCHDOG_CHECK_MS);

        try {
          const query = new URLSearchParams({ sid: getPageSessionId() });
          const res = await apiStream(
            `/api/canvas/projects/${projectId}/events?${query.toString()}`,
            { signal }
          );

          // 401 表示登录态已失效：apiRaw 已触发全局处理（登出 + 跳转登录页），
          // 页面卸载即断开，本流不再安排重连
          if (res.status === 401) {
            stopReconnect = true;
            await res.body?.cancel().catch(() => {});
            return;
          }

          lastDataAt = Date.now();
          connected = true;
          if (!res.ok || !res.body) {
            // 非 ok 响应（5xx 等）：释放响应体再走重连，不悬挂连接
            await res.body?.cancel().catch(() => {});
            return;
          }

          const isFirstConnection = !hasConnected;
          hasConnected = true;

          await readSseStream(
            res.body,
            (event, data) => {
              // 首连忽略 sync（理由见 hasConnected 声明处注释）；
              // evict 是权威信号，任何连接都立即处理
              if (isFirstConnection && event === "sync") return;
              handleCanvasSessionEvent(projectId, event, data);
            },
            { onActivity: () => { lastDataAt = Date.now(); } }
          );
        } catch {
          // 连接中断：稍后重连；服务端按连接身份判定回归，不产生误抢占
        } finally {
          clearInterval(watchdog);
          if (!disposed && !stopReconnect) {
            retryTimer = setTimeout(connect, SSE_RECONNECT_DELAY_MS);
          }
        }
      })();
    };

    connect();

    return () => {
      disposed = true;
      if (retryTimer) clearTimeout(retryTimer);
      connection?.abort();
    };
  }, [projectId]);
}
