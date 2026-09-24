/**
 * 生成任务监控 hook。
 * 主路径：SSE 订阅任务状态，服务端经事件总线即时推送终态；
 * 兜底：SSE 带心跳看门狗（连接静默死亡即断开重连），页面重新可见 /
 * 网络恢复时按 DB 批量对账一次，保证「已落盘」的任务最终一定回填到节点。
 */
"use client";

import { createElement, useEffect, useRef } from "react";

import { runSuppressed } from "@/features/canvas/agent/user-action-tracker";
import { generationApi, isTerminalTaskStatus, type TaskStatusEvent } from "@/features/canvas/api/generation-api";
import TaskErrorDetail from "@/features/canvas/shared/TaskErrorDetail";
import { markDirtyImmediate, useCanvasStore } from "@/features/canvas/stores/canvas-store";
import type { MediaGenFields } from "@/features/canvas/types";
import i18n from "@/lib/i18n/config";
import { computeNodeSize, loadMediaDimensions } from "@/lib/utils/image-utils";

/** 失败详情的长度上限：仅用于拦截上游返回整页 HTML 等失控内容 */
const MAX_ERROR_LEN = 1000;

/** SSE 看门狗超时：服务端每 15s 发心跳，30s 收不到任何字节即判定连接已静默死亡 */
const SSE_WATCHDOG_TIMEOUT_MS = 30_000;
/** 连接建立阶段（fetch 至响应头）的预算：TLS/代理握手慢不等于连接死亡，放宽到 60s，
 * 否则慢握手会陷入「30s abort → 3s 重连」的死循环 */
const SSE_CONNECT_TIMEOUT_MS = 60_000;
const SSE_WATCHDOG_CHECK_MS = 5_000;

/**
 * 截断错误文案。
 * 常规失败原因由 TaskErrorDetail 折叠为两行摘要并可展开全文，
 * 这里只兜底超长内容，避免通知区被撑破。
 */
function truncateError(text: string): string {
  return text.length > MAX_ERROR_LEN ? `${text.slice(0, MAX_ERROR_LEN - 1)}…` : text;
}

/**
 * 生成任务失败通知的描述文案。
 * 服务端对自身可判定的失败（超时、网络不可达、任务取消等）会附带错误码，据此取本地化文案；
 * 上游返回的原因无法翻译，截断后原样展示。
 */
function resolveTaskError(evt: { error?: string; errorCode?: string }): string {
  if (evt.errorCode) {
    const key = `error.${evt.errorCode}`;
    if (i18n.exists(key)) return i18n.t(key);
  }
  return truncateError(evt.error ?? "");
}

/**
 * 将 LLM 返回的纯文本转成文本节点编辑器可渲染的 HTML。
 * 按空行分段为 <p>，段内换行转 <br/>，并转义 HTML 特殊字符，避免被当作标签解析。
 */
function textToHtml(text: string): string {
  const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  return text
    .split(/\n{2,}/)
    .map((block) => {
      const trimmed = block.replace(/\n+$/, "");
      if (!trimmed.trim()) return "";
      const lines = trimmed.split("\n").map((line) => escapeHtml(line)).join("<br/>");
      return `<p>${lines}</p>`;
    })
    .join("");
}

/**
 * SSE 任务监控 hook。
 *
 * 扫描画布中有 pendingAction/task_id 标记的节点，建立 SSE 流
 * 监听生成任务完成/失败，自动更新节点数据。
 *
 * @param notif  antd App.useApp() 返回的 notification 实例，用于展示生成结果通知
 */
export function useSseTaskMonitor(notif: { success: Function; error: Function }) {
  const notifRef = useRef(notif);
  useEffect(() => { notifRef.current = notif; }, [notif]);
  const sseCtrlsRef = useRef<Map<string, AbortController>>(new Map());
  const notifiedTasksRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    let cleanupListeners: (() => void) | null = null;
    // 卸载后 reconcile 不再落地：allSettled 期间卸载时，响应仍会回来，
    // 不能再回填节点或弹通知
    let disposed = false;

    /**
     * 终态落地：SSE 推送与批量对账共用。
     * 按结果类型回填节点数据并清除 taskBinding（遮罩此时消失）；
     * 节点已删除或绑定已换绑（重新生成）时静默忽略。
     */
    const handleTerminal = (nodeId: string, taskId: string, evt: TaskStatusEvent) => {
      const cur = useCanvasStore.getState().nodes.find(n => n.id === nodeId);
      const curBinding = cur ? (cur.data as MediaGenFields).taskBinding : undefined;
      if (!cur || curBinding?.taskId !== taskId) return;

      const isVideoNode = cur.type === "video-node";
      const isTextNode = cur.type === "text-node";
      const t = i18n.t;
      // 同一任务只弹一次通知（SSE 与对账可能先后送达同一终态）；
      // 失败类通知必须走 error 通道（红色/错误图标），不能与成功混用
      const notifyOnce = (
        kind: "success" | "error",
        payload: {
          title: string;
          description?: React.ReactNode;
          placement: string;
          duration: number;
        }
      ) => {
        if (notifiedTasksRef.current.has(taskId)) return;
        notifiedTasksRef.current.add(taskId);
        if (kind === "success") notifRef.current.success(payload);
        else notifRef.current.error(payload);
      };

      // LLM 文本结果：从 resultText 更新 content
      if (evt.status === "completed" && evt.resultText) {
        const resultText = evt.resultText;
        // 生成结果回填是程序化写回，不算用户操作（用户操作感知不应记录）
        runSuppressed(() => useCanvasStore.getState().updateNodeData(nodeId, {
          content: textToHtml(resultText),
          plainText: resultText,
          taskBinding: undefined,
        }, undefined, { skipHistory: true }));
        markDirtyImmediate();
        notifyOnce("success", { title: t("generation.textSuccess"), placement: "bottomRight", duration: 5 });
        return;
      }

      const completedUrls = evt.resultUrls || [];
      if (evt.status === "completed" && completedUrls.length) {
        const prompt = evt.prompt || "";
        const firstUrl = completedUrls[0];
        // 节点尺寸不在此刻定死：保持生成前占位框当前尺寸，
        // 待异步探测到真实分辨率后，统一用 computeNodeSize(真实宽高) 落地（与上传同一算法）。
        const desc = prompt.length > 80 ? prompt.slice(0, 77) + "..." : prompt;
        // 一次性回填：图片 + 多图列表 + 产物大小 + 清除生成中状态（遮罩此时才消失）。
        // naturalWidth/naturalHeight 先置 0（标题栏暂不显示），节点尺寸保持占位框不变，
        // 异步探测到真实分辨率后再统一回填真实尺寸。
        // fileSize 由服务端终态事件直接给出（resultSizes 与 resultUrls 对齐），重新生成时覆盖旧值。
        runSuppressed(() => useCanvasStore.getState().updateNodeData(nodeId, {
          src: firstUrl,
          naturalWidth: 0, naturalHeight: 0,
          lockAspectRatio: true, taskBinding: undefined,
          source: "generate",
          fileSize: evt.resultSizes?.[0] ?? undefined,
          // 多图结果：>=2 张写入 multiResultUrls 进入堆叠/网格模式；否则清空，回到单图
          // （必须无条件处理，否则重新生成只返回 1 张时旧的 multiResultUrls 会残留，导致仍层叠）
          multiResultUrls: completedUrls.length >= 2 ? completedUrls : undefined,
          multiResultTotalCount: completedUrls.length >= 2 ? completedUrls.length : undefined,
        }, undefined, { skipHistory: true }));
        markDirtyImmediate();
        notifyOnce("success", { title: t(isVideoNode ? "generation.videoSuccess" : "generation.imageSuccess"), description: desc, placement: "bottomRight", duration: 15 });

        // 异步回填真实分辨率与节点尺寸：与上传共用 computeNodeSize(真实宽高) 同一算法，
        // 内容区比例与真实内容严格一致（无留白/无裁切）。与显示共享浏览器缓存，不双倍下载；
        // 失败/节点内容已变更时静默放弃。
        loadMediaDimensions(firstUrl, isVideoNode).then((dims) => {
          // effect 卸载后不再写 store（ disposed 只护 reconcile 路径，SSE 路径在此补防）
          if (disposed) return;
          if (dims.w <= 0 || dims.h <= 0) return;
          const s = useCanvasStore.getState();
          const n = s.nodes.find(x => x.id === nodeId);
          if (!n) return;
          if ((n.data as { src?: string }).src !== firstUrl) return;
          const natural = { naturalWidth: dims.w, naturalHeight: dims.h };
          const { width, height } = computeNodeSize(dims.w, dims.h);
          runSuppressed(() => s.updateNodeData(nodeId, natural, { width, height }, { skipHistory: true }));
          markDirtyImmediate();
        });
        return;
      }

      // 失败 / 取消 / completed 但无结果（上游未回传 resultText/resultUrls）：
      // 三种情况都必须清理 taskBinding，否则节点永久停留在「生成中」遮罩，
      // 且 hasGeneratingNode() 会全局禁用撤销 / 重做，用户只能刷新页面才能恢复。
      useCanvasStore.getState().updateNodeData(nodeId, {
        taskBinding: undefined,
      }, undefined, { skipHistory: true });
      markDirtyImmediate();
      // 取消是用户主动操作，只清遮罩不弹「生成失败」——误导性通知比没有通知更糟
      if (evt.status === "cancelled") return;
      notifyOnce("error", {
        title: t(
          evt.status === "completed"
            ? "generation.failed"
            : isVideoNode ? "generation.videoFailed" : isTextNode ? "generation.failed" : "generation.imageFailed"
        ),
        description: createElement(TaskErrorDetail, {
          message: evt.error || evt.errorCode ? resolveTaskError(evt) : t("error.unknown"),
        }),
        placement: "bottomRight",
        duration: 15,
      });
    };

    const scanAndConnect = () => {
      const allNodes = useCanvasStore.getState().nodes;
      // 清理 notifiedTasksRef：只保留当前节点中仍存在的任务 ID，避免 Set 无界增长
      const activeTaskIds = new Set<string>();
      for (const n of allNodes) {
        const tb = (n.data as MediaGenFields).taskBinding;
        if (tb?.taskId) activeTaskIds.add(tb.taskId);
      }
      for (const id of notifiedTasksRef.current) {
        if (!activeTaskIds.has(id)) notifiedTasksRef.current.delete(id);
      }
      // 任务已从画布消失（节点被删 / taskBinding 被清/换）：这些流已无人消费，
      // 但服务端会一直推送心跳，必须主动断开，否则连接与内存都挂着。
      for (const [id, ctrl] of sseCtrlsRef.current) {
        if (activeTaskIds.has(id)) continue;
        ctrl.abort();
        sseCtrlsRef.current.delete(id);
      }
      for (const node of allNodes) {
        const binding = (node.data as MediaGenFields).taskBinding;
        if (!binding?.taskId) continue;
        if (binding.status !== "pending" && binding.status !== "processing") continue;
        if (sseCtrlsRef.current.has(binding.taskId)) continue;

        const taskId = binding.taskId;
        const nodeId = node.id;
        const ctrl = new AbortController();
        sseCtrlsRef.current.set(taskId, ctrl);
        /** 收尾：先摘表再中断连接。
         *  只摘表不 abort 的话，未读完的流会一直挂着，且卸载时已无法找到它。 */
        const finish = () => {
          sseCtrlsRef.current.delete(taskId);
          ctrl.abort();
        };

        (async () => {
          // 看门狗：连接静默死亡（代理掐流 / 睡眠唤醒 / 网络切换）时 read() 永远挂起，
          // 任务完成后前台也不知道。30s 无任何字节即断开，交给扫描器重连并取快照。
          // 连接建立阶段（fetch 未返回）用更宽的 60s 预算，避免慢握手被误杀。
          let lastDataAt = Date.now();
          let connected = false;
          const watchdog = setInterval(() => {
            const budget = connected ? SSE_WATCHDOG_TIMEOUT_MS : SSE_CONNECT_TIMEOUT_MS;
            if (Date.now() - lastDataAt > budget) ctrl.abort();
          }, SSE_WATCHDOG_CHECK_MS);
          try {
            const res = await generationApi.streamGenerationTask(taskId, ctrl.signal);
            // 看门狗从收到响应头起算
            lastDataAt = Date.now();
            connected = true;
            if (!res.ok || !res.body) return;
            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buffer = "";
            while (true) {
              const { done, value } = await reader.read();
              lastDataAt = Date.now();
              if (done) break;
              buffer += decoder.decode(value, { stream: true });
              const lines = buffer.split("\n");
              buffer = lines.pop() || "";
              for (const line of lines) {
                if (!line.startsWith("data: ")) continue;
                try {
                  const evt = JSON.parse(line.slice(6)) as TaskStatusEvent;
                  if (isTerminalTaskStatus(evt.status)) {
                    // 终态：落地后直接退出（服务端推完即关流）
                    handleTerminal(nodeId, taskId, evt);
                    return;
                  }
                } catch {}
              }
            }
          } catch { /* SSE 断开：扫描器稍后重连取快照 */ }
          finally {
            clearInterval(watchdog);
            finish();
          }
        })();
      }
    };

    // 对账兜底：页面重新可见 / 网络恢复时，按 DB 批量查询生成中任务的真实状态。
    // SSE 推送全部丢失（连接挂死期间任务完成、token 过期等）时，这是唯一能收敛状态的路径。
    const reconcile = async () => {
      const nodes = useCanvasStore.getState().nodes;
      const watching: { nodeId: string; taskId: string }[] = [];
      for (const n of nodes) {
        const b = (n.data as MediaGenFields).taskBinding;
        if (b?.taskId && (b.status === "pending" || b.status === "processing")) {
          watching.push({ nodeId: n.id, taskId: b.taskId });
        }
      }
      if (watching.length === 0) return;
      try {
        // 服务端单次查询上限 100：超出的 id 分批并行请求后合并。
        // 单块失败只跳过该块——SSE 已死的场景下对账是唯一恢复路径，
        // 一次瞬时 502 不能把已拿到的其余块结果一并丢掉。
        const ids = [...new Set(watching.map(w => w.taskId))];
        const byId = new Map<string, TaskStatusEvent>();
        const chunkResults = await Promise.allSettled(
          Array.from({ length: Math.ceil(ids.length / 100) }, (_, i) =>
            generationApi.fetchTasksStatus(ids.slice(i * 100, (i + 1) * 100))
          )
        );
        if (disposed) return;
        for (const chunk of chunkResults) {
          // 非 2xx / 网络失败在 api() 内抛错，allSettled 已归为 rejected 跳过
          if (chunk.status !== "fulfilled") continue;
          const events = chunk.value;
          if (!Array.isArray(events)) continue;
          for (const t of events) {
            byId.set(t.taskId, t);
          }
        }
        for (const { nodeId, taskId } of watching) {
          const evt = byId.get(taskId);
          if (evt && isTerminalTaskStatus(evt.status)) {
            handleTerminal(nodeId, taskId, evt);
          }
        }
      } catch { /* 网络不可达：等下次对账 */ }
    };

    const onVisible = () => {
      if (document.visibilityState === "visible") void reconcile();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", reconcile);
    cleanupListeners = () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", reconcile);
    };

    scanAndConnect();
    timer = setInterval(scanAndConnect, 3000);

    return () => {
      disposed = true;
      if (timer) clearInterval(timer);
      cleanupListeners?.();
      for (const ctrl of sseCtrlsRef.current.values()) ctrl.abort();
      sseCtrlsRef.current.clear();
    };
  }, []);
}
