/**
 * 文件上传公共工具：并发限制 + 失败重试 + 双模式分派。
 * 供画布拖入上传（use-file-drop）与资产管理上传（AssetCreateDialog）共用。
 *
 * 链路按后端能力二选一（specs/storage-s3-backend.md 业务规则 6，mode 来自
 * upload-limits 启动预热缓存）：
 * - relay（local 后端 / 缓存未就绪）：multipart 中转批次（原始路径）；
 * - direct（S3 后端）：逐文件 增量 SHA256 → upload-ticket（秒传短路）→
 *   PUT 预签名 URL → upload-complete（服务端提升复验），字节不经应用服务器。
 */
import {
  api,
  ApiError,
  apiPresignedPutWithProgress,
  apiUploadWithProgress,
  UnauthorizedError,
  type UploadErrorKind,
  UploadTransportError,
} from "@/lib/api/client";
import { resolveApiError } from "@/lib/api/error-message";
import i18n from "@/lib/i18n/config";
import { captureSession, SessionChangedError } from "@/lib/session-lifecycle";
import { getUploadMode, invalidateUploadLimits } from "@/lib/upload-formats";
import { computeFileSha256 } from "@/lib/utils/upload-hash";

/** 单个上传失败后的最大重试次数 */
export const UPLOAD_MAX_RETRIES = 1;

/** PUT 同 URL 重试上限（不含首次）：预签名 PUT 同 URL 同内容幂等，可安全重发 */
const PUT_MAX_RETRIES = 2;

/** 直传并发上限：与服务端按用户并发闸门呼应，避免打满排队深度 */
const DIRECT_CONCURRENCY = 3;

export interface UploadResult {
  url: string;
  key: string;
  /** 服务端 file_objects 探测的媒体尺寸（EXIF 旋转已归一）；探测失败为 null */
  width?: number | null;
  height?: number | null;
  /** 服务端视频体检：标称时长 vs 实际可解码时长（截断 / 损坏时非空） */
  media_warning?: { declared: number; decodable: number } | null;
}

/** POST /api/files/upload 的批量响应（apiUploadWithProgress 已剥离 { code, data, msg } 信封） */
export interface UploadBatchResponse {
  items: Array<
    | { index: number; ok: true; data: UploadResult }
    | { index: number; ok: false; error: { code: string; ctx?: Record<string, string | number> } }
  >;
}

export function isUploadResult(value: unknown): value is UploadResult {
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
  /** 服务端错误码（如有）：批次执行层按码执行副作用（如 direct_unavailable 清 limits 缓存） */
  code?: string;
  constructor(detail?: string, code?: string) {
    super(detail ?? "Upload failed");
    this.name = "UploadBusinessError";
    this.detail = detail;
    this.code = code;
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

/** 退避等待：优先服务端 Retry-After，否则指数退避；会话中止立即以中止原因抛出 */
async function waitBackoff(session: UploadSession, attempt: number, retryAfterMs?: number): Promise<void> {
  const backoff = retryAfterMs ?? Math.min(30_000, 1_000 * 2 ** attempt);
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
}

/** 逐文件进度值：哈希校验阶段（UI 走不定态，附已读字节数）与字节传输阶段（百分比） */
export type UploadProgressValue =
  | { phase: "hashing"; loadedBytes: number }
  | { phase: "uploading"; pct: number };

/**
 * 上传单个文件，网络错误自动重试。
 * - 网络错误 -> 重试，重试前通过 onProgress 重置传输进度
 * - 业务错误（code !== 200）-> 不重试，直接抛出 UploadBusinessError
 * - 鉴权错误（401）-> 不重试，直接抛出 UnauthorizedError（由全局处理器跳转登录）
 *
 * @param file       要上传的文件
 * @param onProgress 进度回调（含阶段，见 UploadProgressValue）
 * @param maxRetries 最大重试次数（默认 1）
 * @param source     文件归属标记（upload=原始上传 / derived=画布加工派生），写入 file_object.source
 * @returns UploadResult 包含 url 和 key
 */
export async function uploadWithRetry(
  file: File,
  onProgress?: (progress: UploadProgressValue) => void,
  maxRetries: number = UPLOAD_MAX_RETRIES,
  source?: "upload" | "derived",
): Promise<UploadResult> {
  // 批次层契约是逐文件 (index, progress)：单文件入口只回传自身的进度值
  const [result] = await uploadBatchWithRetry([file], onProgress ? (_index, progress) => onProgress(progress) : undefined, maxRetries, source);
  if (result.status === "fulfilled") return result.value;
  throw result.reason;
}

/**
 * 上传一个批次并按文件返回 PromiseSettledResult。
 * 模式分派后各自执行：传输层失败按退避重试；业务层单文件失败只影响自身。
 * 进度契约是逐文件 (index, progress)：阶段划分与归因由各模式用自己的真实语义
 * 完成（relay 只有传输阶段，按 FormData 字节区间归因；direct 区分哈希/传输
 * 两阶段），批次层不解释进度值的含义。
 */
export async function uploadBatchWithRetry(
  files: File[],
  onProgress?: (index: number, progress: UploadProgressValue) => void,
  maxRetries: number = UPLOAD_MAX_RETRIES,
  source?: "upload" | "derived",
  sessionOverride?: UploadSession,
): Promise<PromiseSettledResult<UploadResult>[]> {
  if (files.length === 0) return [];
  const params: BatchUploadParams = {
    files,
    onProgress,
    maxRetries,
    source,
    session: sessionOverride ?? captureSession(),
  };
  // mode 取自启动预热的 upload-limits 缓存；缓存未就绪按 relay（服务端兜底校验不变）
  if (getUploadMode() === "direct") {
    return uploadBatchDirect(params);
  }
  return uploadBatchRelay(params);
}

/** 批次上下文参数束：分派入口与两条模式路径共用 */
interface BatchUploadParams {
  files: File[];
  /** 逐文件进度：(批内下标, 阶段化进度值) */
  onProgress?: (index: number, progress: UploadProgressValue) => void;
  maxRetries: number;
  source?: "upload" | "derived";
  session: UploadSession;
}

/** 把累计已传字节按区间归因到单个文件：[offset, offset+size) 内已传部分占该文件自身体积的百分比 */
function filePctOf(loaded: number, size: number, offset: number): number {
  if (size <= 0) return 100;
  const uploaded = Math.min(Math.max(loaded - offset, 0), size);
  return Math.round((uploaded / size) * 100);
}

/** relay 模式：multipart 中转批次（一个请求承载全部文件） */
async function uploadBatchRelay(params: BatchUploadParams): Promise<PromiseSettledResult<UploadResult>[]> {
  const { files, onProgress, maxRetries, source, session: currentSession } = params;
  const sourceQuery = source ? `?source=${source}` : "";
  // 浏览器按 FormData append 顺序发送各 part：按体积预计算每个文件的字节区间，
  // XHR 的累计已传字节据此归因到单文件（该区间语义只在此处成立，故归因留在 relay 内部）
  const offsets: number[] = [];
  let batchBytes = 0;
  for (const file of files) {
    offsets.push(batchBytes);
    batchBytes += file.size;
  }
  const reportAll = (loaded: number) => {
    if (!onProgress) return;
    for (let i = 0; i < files.length; i++) {
      onProgress(i, { phase: "uploading", pct: filePctOf(loaded, files[i].size, offsets[i]) });
    }
  };
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
      const data = await currentSession.run(() => apiUploadWithProgress<UploadBatchResponse>(
        `/api/files/upload${sourceQuery}`,
        formData,
        (_pct, loaded) => reportAll(loaded),
      ));
      currentSession.assertCurrent();

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
        currentSession.assertCurrent();
      } catch (sessionError) {
        return rejected(sessionError);
      }
      if (err instanceof UploadBusinessError || err instanceof UnauthorizedError) return rejected(err);
      if (err instanceof UploadTransportError && !err.retryable) return rejected(err);
      if (isOffline()) return rejected(new UploadTransportError("network", i18n.t("error.upload.offline")));

      lastErr = err;
      if (attempt >= maxRetries) break;
      reportAll(0);
      try {
        await waitBackoff(currentSession, attempt, err instanceof UploadTransportError ? err.retryAfterMs : undefined);
      } catch (waitError) {
        return rejected(waitError);
      }
    }
  }

  return rejected(lastErr instanceof Error ? lastErr : new Error(i18n.t("error.upload.upload_failed")));
}

// ── 直传（direct 模式）──

/** 服务端受管文件引用：票据秒传与完成响应共用形状，isUploadFileData 守卫同一形状 */
type RemoteFileRef = { url: string; key: string; width: number | null; height: number | null };

/** 直传票据响应（upload-ticket，envelope 已剥离） */
type TicketResponse =
  | { duplicate: true; file: RemoteFileRef }
  | { duplicate: false; staging_key: string; upload_url: string; content_type: string };

/** 直传完成响应（upload-complete，envelope 已剥离） */
interface CompleteResponse {
  file: RemoteFileRef;
  media_warning?: { declared: number; decodable: number };
}

/** 把 api() 异常归一到批次重试层的错误分类：401 透传、网络/5xx/429 可重试、其余业务失败 */
function mapDirectApiError(err: unknown): unknown {
  if (!(err instanceof ApiError)) return err;
  if (err.status === 401) return new UnauthorizedError();
  if (err.status === 0) return new UploadTransportError("network", err.message);
  if (err.status === 429 || err.status >= 500) {
    return new UploadTransportError("http", err.message, err.status);
  }
  return new UploadBusinessError(resolveApiError(
    { error: err.error, ctx: err.ctx },
    err.status,
    "upload.upload_failed",
  ), err.error);
}

/** api() 异常统一归一后重抛：票据与完成两处共用 */
function rethrowMapped(err: unknown): never {
  throw mapDirectApiError(err);
}

function isUploadFileData(value: unknown): value is RemoteFileRef {
  if (!value || typeof value !== "object") return false;
  const v = value as { url?: unknown; key?: unknown; width?: unknown; height?: unknown };
  return typeof v.url === "string" && v.url.length > 0 && typeof v.key === "string" && v.key.length > 0
    && (v.width === null || typeof v.width === "number")
    && (v.height === null || typeof v.height === "number");
}

/**
 * 单文件直传：ticket（秒传短路）→ PUT 预签名 → complete。
 * 哈希由调用方每文件只算一次（重试不重算）。PUT 同 URL 同内容幂等（spec 业务规则 6）：
 * 网络 / 超时 / 5xx 在同一预签名 URL 上退避重试（响应丢失时同字节覆盖，终态正确）；
 * 4xx（签名过期等）不可同 URL 恢复，直接上抛使该文件失败——批次层不为 4xx
 * 重开 ticket，调用方重新上传时会重新开票（旧 staging 由超龄清扫回收）。
 */
async function directUploadFile(
  file: File,
  opts: {
    session: UploadSession;
    hash: string;
    source?: "upload" | "derived";
    onPutProgress?: (pct: number, loaded: number) => void;
  },
): Promise<UploadResult> {
  const { hash } = opts;
  const contentType = file.type || undefined;
  const ticket = await opts.session.run(() => api<TicketResponse>("/api/files/upload-ticket", {
    method: "POST",
    body: JSON.stringify({
      hash,
      size: file.size,
      name: file.name,
      ...(contentType ? { content_type: contentType } : {}),
    }),
  })).catch(rethrowMapped);

  if (ticket.duplicate) {
    if (!isUploadFileData(ticket.file)) throw new UploadBusinessError(i18n.t("error.parse_failed"));
    return { ...ticket.file, media_warning: null };
  }

  // PUT 同 URL 同内容幂等（spec 业务规则 6）：可重试错误在同一预签名 URL 退避重试
  let putAttempt = 0;
  for (;;) {
    try {
      await apiPresignedPutWithProgress(ticket.upload_url, file, ticket.content_type, opts.onPutProgress, opts.session.signal);
      break;
    } catch (err) {
      if (!(err instanceof UploadTransportError) || !err.retryable) throw err;
      if (putAttempt >= PUT_MAX_RETRIES || isOffline()) throw err;
      opts.onPutProgress?.(0, 0);
      await waitBackoff(opts.session, putAttempt, err.retryAfterMs);
      putAttempt += 1;
    }
  }

  const done = await opts.session.run(() => api<CompleteResponse>("/api/files/upload-complete", {
    method: "POST",
    body: JSON.stringify({
      staging_key: ticket.staging_key,
      hash,
      name: file.name,
      ...(contentType ? { content_type: contentType } : {}),
      ...(opts.source ? { source: opts.source } : {}),
    }),
  })).catch(rethrowMapped);

  if (!isUploadFileData(done?.file)) throw new UploadBusinessError(i18n.t("error.parse_failed"));
  return { ...done.file, media_warning: done.media_warning ?? null };
}

/**
 * direct 模式：逐文件独立上传（小并发池）。
 * 进度按阶段归因到单文件：哈希校验阶段上报已读字节数（UI 走不定态），
 * PUT 阶段上报传输百分比——进度条全程属于真实传输，哈希不再折算成百分比。
 */
async function uploadBatchDirect(params: BatchUploadParams): Promise<PromiseSettledResult<UploadResult>[]> {
  const { files, onProgress, maxRetries, source, session: currentSession } = params;
  const results: PromiseSettledResult<UploadResult>[] = files.map(() => ({
    status: "rejected",
    reason: new UploadBusinessError(i18n.t("error.upload.upload_failed")),
  }));

  const runOne = async (index: number): Promise<void> => {
    let lastErr: unknown;
    const size = files[index].size;
    const reportItem = (progress: UploadProgressValue) => onProgress?.(index, progress);
    // 哈希每文件只算一次：重试不重算（逐块 signal 检查保证中止语义）。
    // 先同步报一次哈希初值：worker 池在 Promise.all 内同步起跑，该值与 store 的
    // begin 初值（同为哈希态）同批渲染，不会闪出 0% 帧
    reportItem({ phase: "hashing", loadedBytes: 0 });
    const hash = await computeFileSha256(files[index], {
      signal: currentSession.signal,
      onProgress: (loadedBytes) => reportItem({ phase: "hashing", loadedBytes }),
    });
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (isOffline()) {
        throw new UploadTransportError("network", i18n.t("error.upload.offline"));
      }
      try {
        const value = await directUploadFile(files[index], {
          session: currentSession,
          hash,
          source,
          onPutProgress: (_pct, loaded) => reportItem({ phase: "uploading", pct: filePctOf(loaded, size, 0) }),
        });
        reportItem({ phase: "uploading", pct: 100 });
        results[index] = { status: "fulfilled", value };
        return;
      } catch (err) {
        currentSession.assertCurrent();
        if (err instanceof UploadBusinessError) {
          // 服务端已不在直传后端（切换重启后 limits 缓存过期）：清缓存，下次自动走 relay。
          // 副作用归批次执行层，mapDirectApiError 保持纯映射
          if (err.code === "upload.direct_unavailable") invalidateUploadLimits();
          throw err;
        }
        if (err instanceof UnauthorizedError) throw err;
        if (!(err instanceof UploadTransportError) || !err.retryable) throw err;
        lastErr = err;
        if (attempt >= maxRetries) break;
        reportItem({ phase: "uploading", pct: 0 });
        await waitBackoff(currentSession, attempt, err.retryAfterMs);
      }
    }
    throw lastErr ?? new Error(i18n.t("error.upload.upload_failed"));
  };

  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      if (index >= files.length) return;
      try {
        await runOne(index);
      } catch (err) {
        results[index] = { status: "rejected", reason: err };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(DIRECT_CONCURRENCY, files.length) }, worker));
  return results;
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
