/**
 * 文件上传公共工具：并发限制 + 失败重试。
 * 供画布拖入上传（use-file-drop）与资产管理上传（AssetCreateDialog）共用。
 */
import { apiUploadWithProgress, UnauthorizedError } from "@/lib/api/client";
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
