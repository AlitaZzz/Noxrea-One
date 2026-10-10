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
import { resolveApiError } from "@/lib/api/error-message";
import i18n from "@/lib/i18n/config";
import { captureSession, SessionChangedError } from "@/lib/session-lifecycle";

/** 单个上传失败后的最大重试次数 */
export const UPLOAD_MAX_RETRIES = 1;

export interface UploadResult {
  url: string;
  key: string;
  /** 服务端 file_objects 探测的媒体尺寸（EXIF 旋转已归一）；探测失败为 null */
  width?: number | null;
  height?: number | null;
  /** 服务端视频体检：标称时长 vs 实际可解码时长（截断 / 损坏时非空） */
  media_warning?: { declared: number; decodable: number } | null;
}

interface UploadBatchResponse {
  items: Array<
    | { index: number; ok: true; data: UploadResult }
    | { index: number; ok: false; error: { code: string; ctx?: Record<string, string | number> } }
  >;
}

function isUploadResult(value: unknown): value is UploadResult {
  if (!value || typeof value !== "object") return false;
  const result = value as Partial<UploadResult>;
  return typeof result.url === "string" && result.url.length > 0
    && typeof result.key === "string" && result.key.length > 0;
}

/** 会话句柄：捕获自 captureSession，供批次重试等异步流程归属校验复用 */
export type UploadSession = ReturnType<typeof captureSession>;

/** 业务错误：服务端返回了响应但 code !== 200，不应重试 */
export class UploadBusinessError extends Error {
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
  if (err instanceof SessionChangedError) {
    return { category: "abort", message: i18n.t("error.upload.aborted"), retryable: false };
  }
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
  const [result] = await uploadBatchWithRetry([file], onProgress, maxRetries, source);
  if (result.status === "fulfilled") return result.value;
  throw result.reason;
}

/**
 * 上传一个批次并按文件返回 PromiseSettledResult。
 * 传输层失败时整个批次按退避策略重试；业务层单文件失败只影响自身。
 */
export async function uploadBatchWithRetry(
  files: File[],
  onProgress?: (pct: number, loaded: number) => void,
  maxRetries: number = UPLOAD_MAX_RETRIES,
  source?: "upload" | "derived",
  sessionOverride?: UploadSession,
): Promise<PromiseSettledResult<UploadResult>[]> {
  if (files.length === 0) return [];
  const session = sessionOverride ?? captureSession();
  const sourceQuery = source ? `?source=${source}` : "";
  let lastErr: unknown;
  const rejected = (reason: unknown): PromiseSettledResult<UploadResult>[] =>
    files.map(() => ({ status: "rejected", reason }));

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (isOffline()) {
      return rejected(new UploadTransportError("network", i18n.t("error.upload.offline")));
    }
    try {
      const formData = new FormData();
      for (const file of files) formData.append("file", file);
      const data = await session.run(() => apiUploadWithProgress<UploadBatchResponse>(
        `/api/files/upload${sourceQuery}`,
        formData,
        onProgress,
      ));
      session.assertCurrent();

      const results: PromiseSettledResult<UploadResult>[] = files.map(() => ({
        status: "rejected",
        reason: new UploadBusinessError(i18n.t("error.upload.upload_failed")),
      }));
      for (const item of data?.items ?? []) {
        if (item.index < 0 || item.index >= results.length) continue;
        if (item.ok) {
          if (isUploadResult(item.data)) results[item.index] = { status: "fulfilled", value: item.data };
          continue;
        }
        results[item.index] = {
          status: "rejected",
          reason: new UploadBusinessError(resolveApiError(
            { error: item.error.code, ctx: item.error.ctx },
            undefined,
            "upload.upload_failed",
          )),
        };
      }
      return results;
    } catch (err) {
      try {
        session.assertCurrent();
      } catch (sessionError) {
        return rejected(sessionError);
      }
      if (err instanceof UploadBusinessError || err instanceof UnauthorizedError) return rejected(err);
      if (err instanceof UploadTransportError && !err.retryable) return rejected(err);
      if (isOffline()) return rejected(new UploadTransportError("network", i18n.t("error.upload.offline")));

      lastErr = err;
      if (attempt >= maxRetries) break;
      onProgress?.(0, 0);
      const retryAfter = err instanceof UploadTransportError ? err.retryAfterMs : undefined;
      const backoff = retryAfter ?? Math.min(30_000, 1_000 * 2 ** attempt);
      try {
        await new Promise<void>((resolve, reject) => {
          const onAbort = () => {
            clearTimeout(timer);
            session.signal.removeEventListener("abort", onAbort);
            reject(session.signal.reason);
          };
          const timer = setTimeout(() => {
            session.signal.removeEventListener("abort", onAbort);
            resolve();
          }, backoff);
          session.signal.addEventListener("abort", onAbort, { once: true });
        });
      } catch (waitError) {
        return rejected(waitError);
      }
    }
  }

  return rejected(lastErr instanceof Error ? lastErr : new Error(i18n.t("error.upload.upload_failed")));
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
