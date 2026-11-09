/**
 * 批量上传驱动：超限剔除、分批、会话中止 / 离线短路与逐批传输。
 *
 * 资产原始上传与画布节点上传共用这一层，调用方只提供「条目 → 文件」映射
 * 与自身领域的结算副作用（写结果 / 建失败态 / 进度态），不各自重写批次编排。
 * 发请求前的本地失败（超限 / 会话中止 / 离线）与批次传输结果统一以
 * PromiseSettledResult 交付；失败分类仍由调用方用 classifyUploadError 完成。
 */
import { resolveApiError } from "@/lib/api/error-message";
import { captureSession } from "@/lib/session-lifecycle";
import { FALLBACK_UPLOAD_LIMITS, loadUploadLimits } from "@/lib/upload-formats";
import {
  isOffline,
  oversizeUploadErrorBody,
  splitUploadBatches,
  UPLOAD_MAX_RETRIES,
  uploadBatchWithRetry,
  UploadBusinessError,
  UploadOfflineError,
  type UploadProgressValue,
  type UploadResult,
} from "@/lib/utils/upload";

/** 批次驱动终止原因：调用方据此执行批次之外的收尾（预览释放 / 汇总口径）。 */
export type UploadBatchRunStatus = "completed" | "aborted" | "offline";

export interface UploadBatchHooks<T> {
  /** 条目 → 待上传文件（批次拆分与上传共用） */
  fileOf(item: T): File;
  /** 传输归属：upload=原始上传 / derived=画布加工派生 */
  source?: "upload" | "derived";
  /** 单个条目结算：本地拒绝（超限 / 中止 / 离线）与批次传输结果共用 */
  settle(item: T, result: PromiseSettledResult<UploadResult>): void;
  /** 逐文件进度（条目按原数组身份回传） */
  progress?(item: T, progress: UploadProgressValue): void;
  /** 一批开始传输前的调用方准备（如进度态登记） */
  batchStarted?(batch: readonly T[]): void;
}

export async function runUploadBatches<T>(
  items: readonly T[],
  hooks: UploadBatchHooks<T>,
): Promise<UploadBatchRunStatus> {
  if (items.length === 0) return "completed";

  const session = captureSession();
  const rejectAll = (pending: readonly T[], reason: unknown): void => {
    for (const item of pending) hooks.settle(item, { status: "rejected", reason });
  };

  const limits = await loadUploadLimits().catch(() => FALLBACK_UPLOAD_LIMITS);
  if (session.signal.aborted) {
    rejectAll(items, session.signal.reason);
    return "aborted";
  }

  // 单文件上限与批次字节上限是两条独立约束：超限文件即使能放进批次，服务端也会拒绝，
  // 必须在发请求前按业务失败结算，不能依赖调用方预过滤。
  const batchable: T[] = [];
  for (const item of items) {
    const limitError = oversizeUploadErrorBody(hooks.fileOf(item).size, limits.maxSizeMb, limits.maxBatchBytes);
    if (limitError) {
      hooks.settle(item, {
        status: "rejected",
        reason: new UploadBusinessError(resolveApiError(limitError)),
      });
      continue;
    }
    batchable.push(item);
  }

  const batches = splitUploadBatches(
    batchable,
    (item) => hooks.fileOf(item).size,
    limits.maxBatchFiles,
    limits.maxBatchBytes,
  );
  for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
    const batch = batches[batchIndex];
    if (session.signal.aborted) {
      rejectAll(batches.slice(batchIndex).flat(), session.signal.reason);
      return "aborted";
    }
    if (isOffline()) {
      // 不再发送请求，但必须逐项结算剩余条目，避免占位节点 / 资产卡片一直处于等待态。
      rejectAll(batches.slice(batchIndex).flat(), new UploadOfflineError());
      return "offline";
    }

    hooks.batchStarted?.(batch);
    const results = await uploadBatchWithRetry(
      batch.map((item) => hooks.fileOf(item)),
      (index, progress) => {
        if (session.signal.aborted) return;
        hooks.progress?.(batch[index], progress);
      },
      UPLOAD_MAX_RETRIES,
      hooks.source,
      session,
    );
    for (let i = 0; i < batch.length; i++) {
      hooks.settle(batch[i], results[i]);
    }
  }

  // 最后一批传输期间发生会话中止：结果已交付，调用方仍须按中止口径收尾
  return session.signal.aborted ? "aborted" : "completed";
}
