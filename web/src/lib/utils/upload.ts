/**
 * 文件上传公共工具：并发限制 + 失败重试。
 * 供画布拖入上传（use-file-drop）与资产管理上传（AssetCreateDialog）共用。
 */
import {
  apiUploadWithProgress,
  UnauthorizedError,
  type UploadErrorKind,
  UploadTransportError,
} from "@/lib/api/client";
import { type ApiErrorBody,resolveApiError } from "@/lib/api/error-message";
import i18n from "@/lib/i18n/config";

/** 上传默认并发数 */
export const UPLOAD_CONCURRENCY = 3;
/** 单个上传失败后的最大重试次数 */
export const UPLOAD_MAX_RETRIES = 1;

export interface UploadResult {
  url: string;
  key: string;
}

/**
 * 限制并发执行异步任务，按 concurrency 数量分批运行。
 * 所有任务都完成后返回（类似 Promise.allSettled）。
 */
export async function runWithConcurrency<T>(
  tasks: (() => Promise<T>)[],
  concurrency: number = UPLOAD_CONCURRENCY,
): Promise<PromiseSettledResult<T>[]> {
  const results: PromiseSettledResult<T>[] = new Array(tasks.length);
  let nextIndex = 0;

  async function runWorker() {
    while (true) {
      const index = nextIndex++;
      if (index >= tasks.length) break;
      try {
        const value = await tasks[index]();
        results[index] = { status: "fulfilled", value };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, () => runWorker());
  await Promise.all(workers);
  return results;
}

/** 业务错误：服务端返回了响应但 code !== 200，不应重试 */
class UploadBusinessError extends Error {
  detail?: string;
  constructor(detail?: string) {
    super(detail ?? "Upload failed");
    this.name = "UploadBusinessError";
    this.detail = detail;
  }
}

/** 上传失败类别：决定 UI 是否提供「重试」入口 */
export type UploadErrorCategory = UploadErrorKind | "business" | "unknown";

/** 结构化失败信息：节点失败态与全局提示共用 */
export interface UploadErrorInfo {
  category: UploadErrorCategory;
  /** 已本地化的失败原因 */
  message: string;
  /** 是否值得重试：类型不支持 / 体积超限等业务错误重试无意义 */
  retryable: boolean;
}

/** 浏览器已明确报告离线（此时网络请求必然失败，重试只是浪费一次往返） */
export function isOffline(): boolean {
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

/**
 * 把任意上传异常归一为结构化失败信息。
 * 业务错误（code !== 200）不可重试；传输错误按其类别判定；其余按可重试处理。
 */
export function classifyUploadError(err: unknown): UploadErrorInfo {
  if (err instanceof UploadBusinessError) {
    return {
      category: "business",
      message: err.detail ?? i18n.t("error.upload.upload_failed"),
      retryable: false,
    };
  }
  if (err instanceof UploadTransportError) {
    return { category: err.kind, message: err.message, retryable: err.retryable };
  }
  if (err instanceof UnauthorizedError) {
    return { category: "unknown", message: i18n.t("error.session_expired"), retryable: false };
  }
  return {
    category: "unknown",
    message: err instanceof Error ? err.message : i18n.t("error.unknown"),
    retryable: true,
  };
}

/**
 * 上传单个文件，网络错误自动重试。
 * - 网络错误 -> 重试，重试前通过 onProgress(0) 通知调用方重置进度
 * - 业务错误（code !== 200）-> 不重试，直接抛出 UploadBusinessError
 * - 鉴权错误（401）-> 不重试，直接抛出 UnauthorizedError（由全局处理器跳转登录）
 *
 * 注：服务端只按 source 区分文件归属，不按 category 分目录，故不再传 category。
 *
 * @param file       要上传的文件
 * @param onProgress 进度回调
 * @param maxRetries 最大重试次数（默认 1）
 * @param source     文件归属标记（upload=原始上传 / derived=画布加工派生），写入 file_object.source
 * @returns UploadResult 包含 url 和 key
 */
export async function uploadWithRetry(
  file: File,
  onProgress?: (pct: number) => void,
  maxRetries: number = UPLOAD_MAX_RETRIES,
  source?: "upload" | "derived",
): Promise<UploadResult> {
  let lastErr: unknown;
  const sourceQuery = source ? `?source=${source}` : "";

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await apiUploadWithProgress<UploadResult>(
        `/api/files/upload${sourceQuery}`,
        formData,
        onProgress,
      );

      if (res.code !== 200 || !res.data?.url) {
        // 服务端返回错误（非网络问题），不重试；文案按错误码本地化
        throw new UploadBusinessError(
          resolveApiError(res as unknown as ApiErrorBody, undefined, "upload.upload_failed")
        );
      }

      return res.data;
    } catch (err) {
      // 业务错误和鉴权错误不重试，直接抛出
      if (err instanceof UploadBusinessError || err instanceof UnauthorizedError) {
        throw err;
      }
      // 传输错误按类别判定：网络 / 超时 / 5xx 重试，4xx 直接失败
      if (err instanceof UploadTransportError && !err.retryable) {
        throw err;
      }
      // 已确认离线：重试只是多一次无谓往返，直接以「离线」语义失败
      if (isOffline()) {
        throw new UploadTransportError("network", i18n.t("error.upload.offline"));
      }
      // 网络错误，准备重试
      lastErr = err;
      if (attempt < maxRetries && onProgress) {
        onProgress(0);
      }
    }
  }

  // 所有重试用尽
  throw lastErr instanceof Error ? lastErr : new Error(i18n.t("error.upload.upload_failed"));
}

/**
 * 从上传错误中提取可读的失败原因。
 * UploadBusinessError 返回其 detail，其他错误返回 message。
 */
export function getUploadErrorDetail(err: unknown): string | undefined {
  if (err instanceof UploadBusinessError) return err.detail;
  if (err instanceof Error) return err.message;
  return undefined;
}
