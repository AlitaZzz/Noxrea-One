/**
 * 派生媒体编辑任务的统一编排（specs/client-video-editing.md 能力降级契约）。
 * VideoNode / AudioNode 的六个编辑动作（抽帧 / 分离音频 / 片段截取 / 画面裁剪 /
 * 音频截取 / 音频变速）共用同一骨架：
 * - busy 守卫：同节点任务互斥，拒绝时给 busy 反馈而不是静默吞掉（面板保持
 *   打开、选区原样保留可重试）；互斥判定读 ref，连点与闭包快照下依然准确。
 * - AbortController 与 busy 浮层接线：startedAt 驱动耗时，onProgress 更新
 *   进度；客户端任务给取消入口（onCancel），纯服务端任务不给。
 * - 客户端管线失败语义归一：用户取消静默复位；ClientUnsupportedError 切换
 *   服务端兜底（回退不循环）；派生产物上传失败（ClientUploadError，Spec 规则
 *   1.6 回退边界：不回退）与其余异常向上归入统一失败提示（可手动重试）。
 * - 服务端兜底失败由任务自行提示并返回 undefined；取消与意外异常由本 Hook
 *   统一收口（取消静默、异常 console.error + notifyActionFailed）。
 * 任务本身（客户端实现 / 服务端路由 / 派生节点写入）由调用方注入，本 Hook
 * 只负责编排语义。
 */
"use client";

import { useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { useAppFeedback } from "@/components/ui/use-app-feedback";
import { ClientUnsupportedError, ClientUploadError } from "@/features/canvas/editing/client-media/client-video";
import { notifyActionFailed, notifyNodeBusy } from "@/features/canvas/shared/notify";
import { useCanvasStore } from "@/features/canvas/stores/canvas-store";

/** 本地处理忙状态（busy 浮层的唯一数据形状） */
interface MediaEditBusy {
  kind: string;
  startedAt: number;
  progress?: number;
  onCancel?: () => void;
}

/** 客户端管线上下文：中止信号与进度回调。仅 clientTask 使用——服务端兜底
    不上报进度（Spec 规则 4.3），serverTask 的上下文只有中止信号 */
interface MediaEditTaskContext {
  signal: AbortSignal;
  onProgress: (pct: number) => void;
}

interface MediaEditTaskOptions<T> {
  kind: string;
  /** 任务被接受（busy 守卫通过）后同步执行，如关闭操作面板；拒绝时不调用 */
  onAccept?: () => void;
  /** 客户端管线：失败抛 ClientUnsupportedError → serverTask；取消原样抛。
      纯服务端任务（抽帧）省略——省略时不提供取消入口 */
  clientTask?: (ctx: MediaEditTaskContext) => Promise<T>;
  /** 服务端兜底 / 纯服务端任务：失败自行提示并返回 undefined（不抛），
      不上报进度（长请求无中间进度，浮层只显示耗时） */
  serverTask: (ctx: { signal: AbortSignal }) => Promise<T | undefined>;
  /** 客户端或服务端产物就绪后的派生节点写入 */
  onSuccess: (value: T) => void | Promise<void>;
  /** 意外异常（非取消）的兜底文案 key */
  errorKey: string;
  /** 意外异常的 console.error 前缀 */
  logLabel: string;
}

/** 编辑忙文案 key 映射（VideoNode / AudioNode 共享，替代各自内联三元链）。
    kind 当前为 string（union 收敛已入档 defer），未知 kind 回落通用文案 */
const BUSY_LABEL_KEYS: Record<string, string> = {
  capture: "capture.processing",
  detach: "detach.processing",
  clip: "clip.processing",
  crop: "crop.processing",
  "audio-clip": "clip.processing",
  "audio-speed": "speed.processing",
};

export function resolveBusyLabelKey(kind: string): string {
  return BUSY_LABEL_KEYS[kind] ?? "common.processing";
}

export function useMediaEditTask(nodeId: string) {
  const { notification } = useAppFeedback();
  const { t } = useTranslation();
  const [busy, setBusy] = useState<MediaEditBusy | null>(null);
  // 互斥真相源：state 是渲染快照，异步任务并发触发时闭包里的 busy 已过期
  const busyRef = useRef(false);
  // 当前任务的控制器：换源替换 / 卸载时中止进行中的任务（如抽帧请求）
  const activeControllerRef = useRef<AbortController | null>(null);

  /** 中止当前进行中的任务（无任务时幂等）。供源替换 effect 等外部触发 */
  const cancelActive = useCallback(() => {
    activeControllerRef.current?.abort();
  }, []);

  /** 任务期间节点源是否仍是指定值：长任务跨越「换源 / 删除节点」后，
      产物仍指向旧源的旧节点就是错写。onSuccess 写派生节点前必须检查；
      节点已删除（查不到）同样判不一致。断言类型必须保留 undefined：
      否则括号会截断可选链，`(undefined).src` 抛 TypeError 而不是返回 false */
  const expectSource = useCallback(
    (expectedSrc: string) => {
      const node = useCanvasStore.getState().nodes.find((n) => n.id === nodeId);
      return (node?.data as { src?: string } | undefined)?.src === expectedSrc;
    },
    [nodeId],
  );

  const runEditTask = useCallback(
    async <T,>(opts: MediaEditTaskOptions<T>): Promise<void> => {
      if (busyRef.current) {
        notifyNodeBusy(notification, t, nodeId);
        return;
      }
      const controller = new AbortController();
      busyRef.current = true;
      activeControllerRef.current = controller;
      setBusy({
        kind: opts.kind,
        startedAt: Date.now(),
        // 纯服务端任务（无 clientTask）不支持用户取消：浮层不给取消按钮
        onCancel: opts.clientTask ? () => controller.abort() : undefined,
      });
      const onProgress = (pct: number) =>
        setBusy((b) => (b?.kind === opts.kind ? { ...b, progress: pct } : b));
      try {
        // onAccept 在 try 内：接受动作（关面板等）同步抛错时仍走 finally 复位
        // busy，不会把节点永久卡在忙状态
        opts.onAccept?.();
        let value: T;
        if (opts.clientTask) {
          try {
            value = await opts.clientTask({ signal: controller.signal, onProgress });
          } catch (err) {
            if (controller.signal.aborted) return;
            if (!(err instanceof ClientUnsupportedError)) throw err;
            // 客户端不支持 / 管线失败：切换服务端兜底（回退不循环）。清除客户端
            // 管线残留的百分比：serverTask 不上报进度，过期的「· 50%」是假信息，
            // 浮层只剩耗时
            setBusy((b) => (b ? { ...b, progress: undefined } : b));
            const fallback = await opts.serverTask({ signal: controller.signal });
            if (controller.signal.aborted || fallback === undefined) return;
            value = fallback;
          }
          // 客户端成功但取消与管线收尾竞态：产物丢弃不写节点（与 fallback /
          // 纯服务端路径的 post-await 中止检查同一语义）
          if (controller.signal.aborted) return;
        } else {
          const serverValue = await opts.serverTask({ signal: controller.signal });
          if (controller.signal.aborted || serverValue === undefined) return;
          value = serverValue;
        }
        await opts.onSuccess(value);
      } catch (e) {
        if (controller.signal.aborted) return;
        console.error(opts.logLabel, e);
        // 上传失败携带服务端错误码（upload.<code>）：与其余 error.<code> 同一
        // 本地化通道；传输类失败无码，回落 errorKey 通用文案
        notifyActionFailed(notification, t, e instanceof ClientUploadError ? e.code : undefined, opts.errorKey, nodeId);
      } finally {
        busyRef.current = false;
        activeControllerRef.current = null;
        setBusy(null);
      }
    },
    [nodeId, notification, t],
  );

  return { busy, runEditTask, cancelActive, expectSource };
}
