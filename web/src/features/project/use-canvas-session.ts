/**
 * 画布编辑会话 hook。
 *
 * 每个页面实例（打开 / 刷新）持有一条 SSE 连接，**首帧 handshake 即会话建立**：
 * 服务端在同一写临界区内「轮换租约令牌 + 读取权威快照」后原子下发
 * 「全量项目快照 + 租约令牌」——编辑权与画布初始内容从结构上绑定，页面
 * 不再单独发 GET 拉取项目（初始内容的唯一传输就是这条 SSE）。
 * 此后接收 evict：其他页面实例的握手轮换了租约 → 立即进入过期态，
 * 不等自己保存撞 409。过期态由页面渲染不可关闭的提示，唯一出口是刷新。
 *
 * 会话 ID 是**页面实例级**的：每次整页加载生成新值，SSE 断线重连则复用。
 * 这是「刷新即抢占」的根据——服务端只对全新 ID 轮换租约，回归不打扰
 * 正在编辑的对方（详见 server/services/canvas/editor-lease.ts）。
 * 因此不需要 sessionStorage 持久化，也不需要 BroadcastChannel 克隆探测：
 * 复制标签页本身就是新页面实例，天然拿到新 ID。
 */
"use client";

import { useEffect, useState } from "react";

import { runSuppressed } from "@/features/canvas/agent/user-action-tracker";
import { useCanvasStore } from "@/features/canvas/stores/canvas-store";
import { useHistoryStore } from "@/features/canvas/stores/history-store";
import { apiStream } from "@/lib/api/client";
import {
  readSseStream,
  SSE_CONNECT_TIMEOUT_MS,
  SSE_WATCHDOG_CHECK_MS,
  SSE_WATCHDOG_TIMEOUT_MS,
} from "@/lib/sse";

import { getCanvasLease, setCanvasLease } from "./canvas-lease";
import { saveManager } from "./save-manager";
import { useProjectStore } from "./store";

/**
 * 重连间隔。注意：服务端空置宽限（editor-lease 的 EMPTY_ROOM_GRACE_MS）
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

/** 画布会话的连接状态：ready 才放行画布渲染，missing / error 为终态（页面重定向） */
export type CanvasSessionStatus = "connecting" | "ready" | "missing" | "error";

/**
 * evict 事件处理（导出供单测）：编辑权已被其他页面实例取得。同步服务端
 * revision（store 内有单调保护）、联动 saveManager 停用保存（过期弹窗出现后
 * 不再发出必 409 的请求），再进入过期态。
 */
export function handleEvictEvent(
  projectId: string,
  data: { revision?: unknown },
): void {
  const revision = typeof data.revision === "number" ? data.revision : undefined;
  if (revision !== undefined) {
    useProjectStore.getState().updateProjectRevision(projectId, revision);
  }
  saveManager.notifyEvicted();
}

/**
 * handshake 首帧处理（导出供单测）。返回会话结局：
 *   "adopted"（会话建立）| "expired"（已知失效，弹窗接管）| "rejected"（协议错误）。
 *
 * - 未持有租约（初始加载）：采纳服务端快照与租约——adoptProject 同步 upsert
 *   摘要进列表，restoreFromProject 恢复画布内容（程序化写入，不进 agent
 *   动作历史），撤销历史归零（避免撤销穿透到上一个项目）。
 * - 已持有同令牌（断线重连）：编辑权仍有效。revision 领先即本页断线期间的
 *   离线写入已落库——只同步版本，绝不恢复内容（保护本地未保存编辑）。
 * - 已持不同令牌且未过期：服务端已把租约重新签发给本页（空置超宽限后房间
 *   重建 / SPA 返回——令牌轮换只发生在 fresh join，本轮握手即重新签发凭证）。
 *   无缝续接：更新令牌、内容不动（保护本地未保存编辑）。已过期则绝不静默
 *   夺回：与 evict 同等收尾——同步版本 + notifyEvicted。
 * - 载荷不合法 / 项目 id 不一致 / 映射失败：协议错误（服务端契约保证形状，
 *   理论不可达）——按传输失败处理，不标记过期（非编辑权变更）。
 */
export function handleCanvasHandshake(
  projectId: string,
  data: { project?: unknown; lease?: unknown },
): "adopted" | "rejected" | "expired" {
  const lease = data.lease;
  const project = data.project as Record<string, unknown> | undefined;
  const payloadValid =
    typeof lease === "number" &&
    Number.isInteger(lease) &&
    lease > 0 &&
    typeof project === "object" &&
    project !== null &&
    typeof project.id === "string" &&
    project.id.length > 0 &&
    typeof project.name === "string" &&
    typeof project.updatedAt === "string";
  if (!payloadValid) return "rejected";
  // 协议防御：握手项目与订阅项目不一致（路由按 :id 读取，理论不可达）
  if (project.id !== projectId) return "rejected";

  const held = getCanvasLease(projectId);
  if (held !== null) {
    if (typeof project.revision === "number") {
      useProjectStore.getState().updateProjectRevision(projectId, project.revision);
    }
    if (held === lease) return "adopted";

    if (saveManager.isExpired()) {
      saveManager.notifyEvicted();
      return "expired";
    }
    setCanvasLease(projectId, lease);
    return "adopted";
  }

  // 首次进入 / 跨项目返回：先恢复内容（恢复抛错时槽位未持有，重连握手重走
  // 采纳路径自愈），再持有租约
  const adopted = useProjectStore.getState().adoptProject(data.project);
  if (!adopted) return "rejected";
  runSuppressed(() => useCanvasStore.getState().restoreFromProject(projectId, adopted));
  setCanvasLease(projectId, lease);
  useHistoryStore.getState().clear();
  return "adopted";
}

/** 订阅当前画布的编辑权事件流；离开画布页即断开 */
export function useCanvasSession(projectId: string): CanvasSessionStatus {
  const [status, setStatus] = useState<CanvasSessionStatus>("connecting");
  // 项目身份变化即新会话：渲染期重置连接状态（React 官方模式，避免 effect 内
  // 同步 setState 引发级联渲染）。不同 projectId 不得复用旧会话的 ready 门——
  // 否则旧项目内容会在新项目的握手完成前短暂放行渲染。
  const [prevProjectId, setPrevProjectId] = useState(projectId);
  if (prevProjectId !== projectId) {
    setPrevProjectId(projectId);
    setStatus("connecting");
  }

  useEffect(() => {
    if (!projectId) return;

    let disposed = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let connection: AbortController | null = null;
    // 本连接生命周期内是否已采纳握手：区分「首帧即被拒」（协议错误）与
    // 「会话建立后被拒」（令牌易主，过期弹窗接管）
    let sessionReady = false;

    const connect = () => {
      if (disposed) return;
      // 每次连接独立 controller：看门狗判死 abort 后重连需要新的信号
      connection = new AbortController();
      const { signal } = connection;

      void (async () => {
        let lastDataAt = Date.now();
        let connected = false;
        // 终态标志：missing / error 后不再重连，由页面统一重定向
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

          // 404：项目不存在 / 不属于当前用户，终态
          if (res.status === 404) {
            stopReconnect = true;
            setStatus("missing");
            await res.body?.cancel().catch(() => {});
            return;
          }

          lastDataAt = Date.now();
          connected = true;
          if (!res.ok || !res.body) {
            // 非 ok 响应（5xx 等）：会话无法建立，终态交由页面回退项目列表
            stopReconnect = true;
            setStatus("error");
            await res.body?.cancel().catch(() => {});
            return;
          }

          await readSseStream(
            res.body,
            (event, data) => {
              if (event === "evict") {
                handleEvictEvent(projectId, data);
                return;
              }
              if (event === "handshake") {
                const outcome = handleCanvasHandshake(projectId, data);
                if (outcome === "adopted") {
                  sessionReady = true;
                  setStatus("ready");
                } else if (outcome === "expired") {
                  // 已知编辑权失效：不再重连（重连也不会被接受），过期弹窗接管
                  stopReconnect = true;
                } else if (!sessionReady) {
                  // 首帧即被拒（载荷异常）：会话无法建立，终态
                  stopReconnect = true;
                  setStatus("error");
                }
                // 会话建立后的协议错误帧：忽略（理论不可达）
              }
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

  return status;
}
