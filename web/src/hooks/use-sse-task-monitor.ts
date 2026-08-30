/**
 * 生成任务 SSE 监控 hook。
 * 扫描画布中处于生成中的节点并建立 SSE 连接，任务完成 / 失败时回填节点数据、
 * 调整节点尺寸并弹出通知。
 */
"use client";

import { useEffect, useRef } from "react";

import { markDirtyImmediate,useCanvasStore } from "@/features/canvas/stores/canvas-store";
import type { MediaGenFields } from "@/features/canvas/types";
import i18n from "@/lib/i18n/config";
import { computeNodeSize, loadMediaDimensions } from "@/lib/utils/image-utils";

/** 失败通知描述的最大展示长度 */
const MAX_ERROR_LEN = 120;

/**
 * 截断错误文案。
 * 上游返回的失败原因长度不可控，通知区仅展示摘要，避免撑破提示框。
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
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    import("@/features/canvas/api/generation-api").then(({ generationApi }) => {
      if (cancelled) return;
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
        for (const node of allNodes) {
          const binding = (node.data as MediaGenFields).taskBinding;
          if (!binding?.taskId) continue;
          if (binding.status !== "pending" && binding.status !== "processing") continue;
          if (sseCtrlsRef.current.has(binding.taskId)) continue;

          const taskId = binding.taskId;
          const nodeId = node.id;
          const ctrl = new AbortController();
          sseCtrlsRef.current.set(taskId, ctrl);

          (async () => {
            try {
              const res = await generationApi.streamGenerationTask(taskId, ctrl.signal);
              if (!res.ok || !res.body) { sseCtrlsRef.current.delete(taskId); return; }
              const reader = res.body.getReader();
              const decoder = new TextDecoder();
              let buffer = "";
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split("\n");
                buffer = lines.pop() || "";
                for (const line of lines) {
                  if (!line.startsWith("data: ")) continue;
                  try {
                    const evt = JSON.parse(line.slice(6));
                    const completedUrls: string[] = evt.resultUrls || [];

                    // LLM 文本结果：从 resultText 更新 content
                    if (evt.status === "completed" && evt.resultText) {
                      const cur = useCanvasStore.getState().nodes.find(n => n.id === nodeId);
                      const curBinding = cur ? (cur.data as MediaGenFields).taskBinding : undefined;
                      if (!cur || curBinding?.taskId !== taskId) { sseCtrlsRef.current.delete(taskId); return; }
                      useCanvasStore.getState().updateNodeData(nodeId, {
                        content: evt.resultText,
                        taskBinding: undefined,
                      }, undefined, { skipHistory: true });
                      markDirtyImmediate();
                      const t = i18n.t;
                      if (!notifiedTasksRef.current.has(taskId)) {
                        notifiedTasksRef.current.add(taskId);
                        notifRef.current.success({ title: t("generation.textSuccess"), placement: "bottomRight", duration: 5 });
                      }
                      sseCtrlsRef.current.delete(taskId);
                      return;
                    }

                    if (evt.status === "completed" && completedUrls.length) {
                      const cur = useCanvasStore.getState().nodes.find(n => n.id === nodeId);
                      const curBinding = cur ? (cur.data as MediaGenFields).taskBinding : undefined;
                      if (!cur || curBinding?.taskId !== taskId) { sseCtrlsRef.current.delete(taskId); return; }
                      const prompt = evt.prompt || "";

                      const label = prompt.slice(0, 20);
                      const isVideoNode = cur.type === "video-node";
                      const firstUrl = completedUrls[0];
                      // 节点尺寸不在此刻定死：保持生成前占位框当前尺寸，
                      // 待异步探测到真实分辨率后，统一用 computeNodeSize(真实宽高) 落地（与上传同一算法）。
                      const t = i18n.t;
                      const desc = prompt.length > 80 ? prompt.slice(0, 77) + "..." : prompt;
                      // 一次性回填：图片 + 多图列表 + 清除生成中状态（遮罩此时才消失）。
                      // naturalWidth/naturalHeight 先置 0（标题栏暂不显示），节点尺寸保持占位框不变，
                      // 异步探测到真实分辨率后再统一回填真实尺寸。
                      useCanvasStore.getState().updateNodeData(nodeId, {
                        src: firstUrl, label, alt: label,
                        naturalWidth: 0, naturalHeight: 0,
                        lockAspectRatio: true, taskBinding: undefined,
                        source: "generate",
                        // 多图结果：>=2 张写入 multiResultUrls 进入堆叠/网格模式；否则清空，回到单图
                        // （必须无条件处理，否则重新生成只返回 1 张时旧的 multiResultUrls 会残留，导致仍层叠）
                        multiResultUrls: completedUrls.length >= 2 ? completedUrls : undefined,
                        multiResultTotalCount: completedUrls.length >= 2 ? completedUrls.length : undefined,
                      }, undefined, { skipHistory: true });
                      markDirtyImmediate();
                      if (!notifiedTasksRef.current.has(taskId)) {
                        notifiedTasksRef.current.add(taskId);
                        notifRef.current.success({ title: t(isVideoNode ? "generation.videoSuccess" : "generation.imageSuccess"), description: desc, placement: "bottomRight", duration: 15 });
                      }
                      sseCtrlsRef.current.delete(taskId);

                      // 异步回填真实分辨率与节点尺寸：与上传共用 computeNodeSize(真实宽高) 同一算法，
                      // 内容区比例与真实内容严格一致（无留白/无裁切）。与显示共享浏览器缓存，不双倍下载；
                      // 失败/节点内容已变更时静默放弃。
                      loadMediaDimensions(firstUrl, isVideoNode).then((dims) => {
                        if (dims.w <= 0 || dims.h <= 0) return;
                        const s = useCanvasStore.getState();
                        const n = s.nodes.find(x => x.id === nodeId);
                        if (!n) return;
                        if ((n.data as { src?: string }).src !== firstUrl) return;
                        const natural = { naturalWidth: dims.w, naturalHeight: dims.h };
                        const { width, height } = computeNodeSize(dims.w, dims.h);
                        s.updateNodeData(nodeId, natural, { width, height }, { skipHistory: true });
                        markDirtyImmediate();
                      });
                      return;
                    } else if (evt.status === "failed") {
                      const cur = useCanvasStore.getState().nodes.find(n => n.id === nodeId);
                      const curBinding = cur ? (cur.data as MediaGenFields).taskBinding : undefined;
                      if (!cur || curBinding?.taskId !== taskId) { sseCtrlsRef.current.delete(taskId); return; }
                      const isVideoNode = cur.type === "video-node";
                      const isTextNode = cur.type === "text-node";
                      useCanvasStore.getState().updateNodeData(nodeId, {
                        taskBinding: undefined,
                      }, undefined, { skipHistory: true });
                      markDirtyImmediate();
                      if (!notifiedTasksRef.current.has(taskId)) {
                        notifiedTasksRef.current.add(taskId);
                        const t = i18n.t;
                        notifRef.current.error({ title: t(isVideoNode ? "generation.videoFailed" : isTextNode ? "generation.failed" : "generation.imageFailed"), description: resolveTaskError(evt), placement: "bottomRight", duration: 15 });
                      }
                      sseCtrlsRef.current.delete(taskId);
                      return;
                    }
                  } catch {}
                }
              }
            } catch { /* SSE disconnected */ }
            sseCtrlsRef.current.delete(taskId);
          })();
        }
      };

      scanAndConnect();
      timer = setInterval(scanAndConnect, 3000);
    });

    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
      for (const ctrl of sseCtrlsRef.current.values()) ctrl.abort();
      sseCtrlsRef.current.clear();
    };
  }, []);
}
