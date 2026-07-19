"use client";

import { useEffect, useRef } from "react";
import { useCanvasStore, markDirtyImmediate } from "@/stores/canvas-store";
import { useI18nStore } from "@/stores/i18n-store";
import { computeThumbScale, loadMediaDimensions } from "@/lib/image-utils";

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
  notifRef.current = notif;
  const sseCtrlsRef = useRef<Map<string, AbortController>>(new Map());
  const notifiedTasksRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    import("@/lib/api").then(({ BASE, getTokenHeader }) => {
      const scanAndConnect = () => {
        const allNodes = useCanvasStore.getState().nodes;
        for (const node of allNodes) {
          const d = node.data as any;
          if (!d?.task_id) continue;
          const st = d?.task_status;
          if (st !== "pending" && st !== "processing") continue;
          if (sseCtrlsRef.current.has(d.task_id)) continue;

          const taskId = d.task_id;
          const nodeId = node.id;
          const ctrl = new AbortController();
          sseCtrlsRef.current.set(taskId, ctrl);

          (async () => {
            try {
              const res = await fetch(`${BASE}/api/generate/task/${taskId}/stream`, {
                headers: { ...getTokenHeader() },
                signal: ctrl.signal,
              });
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
                    if (evt.status === "completed" && evt.result_url) {
                      const cur = useCanvasStore.getState().nodes.find(n => n.id === nodeId);
                      if (!cur || (cur.data as any)?.task_id !== taskId) {
                        sseCtrlsRef.current.delete(taskId);
                        // 节点 task_id 已消失（撤销/取消）→ 补清理，防止 Ctrl+Y 后卡 generating
                        if (cur && !(cur.data as any)?.task_id) {
                          useCanvasStore.getState().updateNodeData(nodeId, {
                            _generating: false, task_status: undefined, task_id: undefined,
                          }, undefined, { skipHistory: true });
                        }
                        return;
                      }
                      const d = cur.data as any;
                      const prompt = evt.prompt || "";

                      if (d.pendingAction === "bg_removal") {
                        // 抠图 → 创建新节点，不覆盖原图
                        const { createNodeFromUrl } = await import("@/lib/image-utils");
                        const defW = 1024, defH = 1024;
                        const newNode = await createNodeFromUrl(nodeId, evt.result_url, defW, defH, " (bg-removed)");
                        // Clear source node state
                        useCanvasStore.getState().updateNodeData(nodeId, {
                          _generating: false, task_status: undefined, task_id: undefined, pendingAction: undefined,
                        }, undefined, { skipHistory: true });
                        markDirtyImmediate();
                        // Load real dimensions for the new node
                        if (newNode) {
                          loadMediaDimensions(evt.result_url, false).then((dims) => {
                            if (dims.w > 0) {
                              const { displayW, displayH } = computeThumbScale(dims.w, dims.h);
                              const titleH = 24;
                              useCanvasStore.getState().updateNodeData(newNode.id, {
                                naturalWidth: dims.w, naturalHeight: dims.h,
                              }, { width: displayW, height: displayH + titleH }, { skipHistory: true });
                              markDirtyImmediate();
                            }
                          });
                        }
                        const t = useI18nStore.getState().t;
                        if (!notifiedTasksRef.current.has(taskId)) {
                          notifiedTasksRef.current.add(taskId);
                          notifRef.current.success({ title: t("generation.image.success"), description: "Background removed", placement: "bottomRight", duration: 5 });
                        }
                        sseCtrlsRef.current.delete(taskId);
                        return;
                      }

                      const label = prompt.slice(0, 20);
                      const isVideoNode = cur.type === "video-node";
                      // Immediately show result with default size
                      const defW = isVideoNode ? 1152 : 1024;
                      const defH = isVideoNode ? 768 : 1024;
                      useCanvasStore.getState().updateNodeData(nodeId, {
                        src: evt.result_url, label, alt: label,
                        naturalWidth: defW, naturalHeight: defH,
                        lockAspectRatio: true, _generating: false,
                        task_status: undefined, task_id: undefined,
                      }, undefined, { skipHistory: true });
                      markDirtyImmediate();
                      // Async load real dimensions
                      loadMediaDimensions(evt.result_url, isVideoNode).then((dims) => {
                        if (dims.w > 0) {
                          const { displayW, displayH } = computeThumbScale(dims.w, dims.h);
                          const titleH = 24;
                          useCanvasStore.getState().updateNodeData(nodeId, {
                            naturalWidth: dims.w, naturalHeight: dims.h,
                          }, { width: displayW, height: displayH + titleH }, { skipHistory: true });
                          markDirtyImmediate();
                        }
                      });
                      const t = useI18nStore.getState().t;
                      const desc = prompt.length > 80 ? prompt.slice(0, 77) + "..." : prompt;
                      if (!notifiedTasksRef.current.has(taskId)) {
                        notifiedTasksRef.current.add(taskId);
                        notifRef.current.success({ title: t(isVideoNode ? "generation.video.success" : "generation.image.success"), description: desc, placement: "bottomRight", duration: 5 });
                      }
                      sseCtrlsRef.current.delete(taskId);
                      return;
                    } else if (evt.status === "failed") {
                      const cur = useCanvasStore.getState().nodes.find(n => n.id === nodeId);
                      if (!cur || (cur.data as any)?.task_id !== taskId) {
                        sseCtrlsRef.current.delete(taskId);
                        if (cur && !(cur.data as any)?.task_id) {
                          useCanvasStore.getState().updateNodeData(nodeId, {
                            _generating: false, task_status: undefined, task_id: undefined,
                          }, undefined, { skipHistory: true });
                        }
                        return;
                      }
                      const isVideoNode = cur.type === "video-node";
                      const d = cur.data as any;
                      useCanvasStore.getState().updateNodeData(nodeId, {
                        _generating: false, task_status: undefined, task_id: undefined,
                        pendingAction: undefined,
                      }, undefined, { skipHistory: true });
                      markDirtyImmediate();
                      if (!notifiedTasksRef.current.has(taskId)) {
                        notifiedTasksRef.current.add(taskId);
                        const t = useI18nStore.getState().t;
                        notifRef.current.error({ title: d.pendingAction === "bg_removal" ? "Background removal failed" : t(isVideoNode ? "generation.video.failed" : "generation.image.failed"), description: evt.error || "", placement: "bottomRight", duration: 5 });
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
      const timer = setInterval(scanAndConnect, 3000);
      return () => {
        clearInterval(timer);
        for (const ctrl of sseCtrlsRef.current.values()) ctrl.abort();
        sseCtrlsRef.current.clear();
      };
    });
  }, []);
}
