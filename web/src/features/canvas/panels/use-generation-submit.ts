/**
 * 生成提交的 ownership / lifecycle fencing（GEN-01 根因修复）。
 *
 * 一次生成的 owner 由三元组共同定义：projectId（画布内容所有者）+ nodeId
 * （目标节点）+ generationRunId（本轮提交世代）。旧实现只有 generationRunRef
 * 一个失效信号，只覆盖「用户主动取消 / 新一轮生成」；节点删除、面板卸载、
 * 项目切换（画布换主）这三类 owner 失效后，迟到的 taskId 仍会走写绑定路径——
 * 数据层是 no-op，却会压入空撤销快照、误标保存脏，且后端任务无人取消成为
 * 孤儿任务。
 *
 * 本 hook 把 owner 校验收口到一处：
 * - unmount 即失效所有在途 run（StrictMode 双挂载下 effect 重入会恢复 alive）；
 * - 提交返回后做同步原子的 owner 终验（与写绑定之间无 await 插入）；
 *   任一失效：主动取消后端已创建的任务（避免孤儿），绝不写绑定；
 * - 取消只可能命中本次 POST 返回的 taskId，不存在误取消其它任务。
 *
 * Image / Video / Text 三条生成链共用，消灭三份漂移的提交逻辑。
 */
"use client";

import { useCallback, useEffect, useRef } from "react";

import { generationApi } from "@/features/canvas/api/generation-api";
import { flushAndWait, getCanvasProjectId, useCanvasStore } from "@/features/canvas/stores/canvas-store";
import { useHistoryStore } from "@/features/canvas/stores/history-store";
import type { HistorySnapshot } from "@/features/project/types";
import { parseErrorBody, resolveApiError } from "@/lib/api/error-message";
import i18n from "@/lib/i18n/config";

/** 提交结果：submitted = 绑定已写入；stale = owner 已失效（已静默取消，勿提示）；failed = 提交失败 */
export type GenerationSubmitOutcome =
  | { status: "submitted" }
  | { status: "stale" }
  | { status: "failed"; error: string };

export function useGenerationSubmit() {
  /** 当前提交世代：每次 beginRun / invalidate / unmount 递增 */
  const runRef = useRef(0);
  /** 组件是否仍挂载：unmount 后闭包仍存活，runRef 无法区分「存活但未变」与「已卸载」 */
  const aliveRef = useRef(true);
  /** handleGenerate 压入的「预生成快照」，供失败 / 取消时精确回滚 */
  const pushedSnapshotRef = useRef<HistorySnapshot | null>(null);

  useEffect(() => {
    // StrictMode 双挂载：cleanup 使首次挂载的在途 run 全部失效后，
    // 二次挂载必须恢复 alive，否则新实例的所有提交都会被判 stale
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      // unmount 即失效所有在途 run：迟到 taskId 一律取消、不写绑定
      runRef.current += 1;
    };
  }, []);

  /** 登记新一轮生成：使旧一轮的在途提交全部失效 */
  const beginRun = useCallback(() => ++runRef.current, []);

  /** 该 run 是否仍是最新一轮且组件仍挂载 */
  const isCurrent = useCallback(
    (runId: number) => aliveRef.current && runRef.current === runId,
    []
  );

  /** 失效所有在途 run（用户主动取消） */
  const invalidate = useCallback(() => {
    runRef.current += 1;
  }, []);

  /**
   * 回滚 handleGenerate 压入的预生成快照。
   * 按引用比对、只在它仍是栈顶时弹出：提交期间若有别的操作入栈，
   * 说明它已不是栈顶，此时放弃弹出，避免误删无关快照导致撤销行为错乱。
   */
  const dropPendingHistory = useCallback(() => {
    const pushed = pushedSnapshotRef.current;
    pushedSnapshotRef.current = null;
    if (pushed) useHistoryStore.getState().popIfTop(pushed);
  }, []);

  /**
   * 提交生成任务并执行 ownership fencing。
   * owner 终验与写绑定之间同步无 await：校验通过即在同一 JS 任务内写完。
   */
  const submitWithOwner = useCallback(
    async (args: {
      /** beginRun 返回的本轮世代 */
      runId: number;
      nodeId: string;
      /** 实际的提交请求（由调用方组装业务参数） */
      request: () => Promise<Response>;
    }): Promise<GenerationSubmitOutcome> => {
      const { runId, nodeId, request } = args;
      // 发起前的最后一道校验：发起前已被取消 / 组件已卸载则不发请求
      if (!isCurrent(runId)) return { status: "stale" };
      // 快照画布所有者：返回后画布已切换项目即失去写资格
      const ownerProjectId = getCanvasProjectId();
      try {
        const res = await request();
        if (!res.ok) {
          const body = parseErrorBody(await res.json().catch(() => null));
          return { status: "failed", error: resolveApiError(body, res.status, "generate.submit_failed") };
        }
        const json = await res.json();
        const taskId: string | undefined = json.data?.id;
        if (!taskId) return { status: "failed", error: i18n.t("error.generate.no_task_id") };

        // owner 终验：runId 未被取消或新轮替代 + 组件未卸载 + 画布未切换项目
        // + 目标节点仍存在。任一失效：本前端实体已无资格消费该任务，主动取消
        // 后端任务避免孤儿；绝不写绑定——写进已删节点是 no-op，却会压入
        // 空撤销快照并误标保存脏（GEN-01 根因）
        const nodeStillExists = useCanvasStore.getState().nodes.some((n) => n.id === nodeId);
        if (!isCurrent(runId) || getCanvasProjectId() !== ownerProjectId || !nodeStillExists) {
          void generationApi.cancelGenerationTask(taskId).catch(() => {});
          return { status: "stale" };
        }

        // 拿到 taskId 才写绑定：taskId 与状态同步落地，不存在「空 taskId 落库」中间态。
        // forceHistory 先压入不含绑定的干净快照，取消 / 失败时按引用精确回滚（见 dropPendingHistory）。
        const depthBefore = useHistoryStore.getState().undoStack.length;
        useCanvasStore.getState().updateNodeData(nodeId, { taskBinding: { taskId, status: "pending", startedAt: Date.now() } }, undefined, { forceHistory: true });
        const stack = useHistoryStore.getState().undoStack;
        pushedSnapshotRef.current = stack.length > depthBefore ? stack[stack.length - 1] : null;
        await flushAndWait();
        return { status: "submitted" };
      } catch (e: unknown) {
        return { status: "failed", error: e instanceof Error ? e.message : "Failed to submit task" };
      }
    },
    [isCurrent]
  );

  return { beginRun, isCurrent, invalidate, submitWithOwner, dropPendingHistory };
}
