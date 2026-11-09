/**
 * 原始上传：把 Blob 变成远程文件引用，不触碰任何画布状态。
 *
 * 复用 `lib/utils/upload-batches` 的批次驱动（超限剔除、会话中止 / 离线短路、
 * 分批与重试）与 `lib/upload-formats` 的类型/体积限制；本模块只负责
 * 「Blob → File」、不支持类型预检与按下标结算。每个输入项独立结算：
 * 不支持 / 离线 / 超限项直接返回错误且不发请求，其余项按服务端批次上限分组顺序上传。
 */
import { showGlobalMessage } from "@/lib/global-message";
import i18n from "@/lib/i18n/config";
import { kindOfBlob } from "@/lib/upload-formats";
import {
  classifyUploadError,
  isOffline,
  type UploadErrorInfo,
  UploadOfflineError,
  type UploadProgressValue,
  type UploadResult,
} from "@/lib/utils/upload";
import { runUploadBatches } from "@/lib/utils/upload-batches";

export interface RawUploadItem {
  blob: Blob;
  filename: string;
}

export interface RawUploadOutcome {
  result: UploadResult | null;
  error: UploadErrorInfo | null;
}

export interface RawUploadSummary {
  /** 长度与顺序和入参 items 一致。 */
  outcomes: RawUploadOutcome[];
}

interface RawUploadOptions {
  source?: "upload" | "derived";
  /** index 是原始入参 items 的下标（不是批次内下标）。 */
  onProgress?: (index: number, progress: UploadProgressValue) => void;
}

interface PreparedRawItem {
  /** 原始入参下标：结果与进度都按它归位。 */
  index: number;
  file: File;
}

function toFile(item: RawUploadItem): File {
  if (item.blob instanceof File) return item.blob;
  // 保持真实 MIME；未知类型留空，由服务端按内容判定，不能伪标成 image/png
  return new File([item.blob], item.filename, { type: item.blob.type || "" });
}

function unsupportedError(): UploadErrorInfo {
  return { category: "unsupported", message: i18n.t("error.upload.unsupported_type"), retryable: false };
}

export async function uploadMany(
  items: readonly RawUploadItem[],
  options?: RawUploadOptions,
): Promise<RawUploadSummary> {
  const outcomes: RawUploadOutcome[] = items.map(() => ({ result: null, error: null }));
  if (items.length === 0) return { outcomes };

  // 浏览器已明确离线：不发请求，也不做类型预检——失败原因统一为离线
  if (isOffline()) {
    const error = classifyUploadError(new UploadOfflineError());
    for (let i = 0; i < outcomes.length; i++) outcomes[i] = { result: null, error };
    return { outcomes };
  }

  const prepared: PreparedRawItem[] = [];
  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    if (kindOfBlob(item.blob, item.filename) === null) {
      outcomes[index] = { result: null, error: unsupportedError() };
      continue;
    }
    prepared.push({ index, file: toFile(item) });
  }
  if (prepared.length === 0) return { outcomes };

  await runUploadBatches(prepared, {
    fileOf: (item) => item.file,
    source: options?.source,
    progress: (item, progress) => options?.onProgress?.(item.index, progress),
    settle: (item, result) => {
      outcomes[item.index] = result.status === "fulfilled"
        ? { result: result.value, error: null }
        : { result: null, error: classifyUploadError(result.reason) };
    },
  });

  return { outcomes };
}

/**
 * 单文件上传：`uploadMany` 的包装，只多一个显式失败提示。
 * `notify` 为 true 时经共享 `showGlobalMessage` 弹出失败原因（默认静默）。
 */
export async function uploadOne(
  blob: Blob,
  filename: string,
  source?: "upload" | "derived",
  options?: { notify?: boolean },
): Promise<UploadResult | null> {
  const { outcomes } = await uploadMany([{ blob, filename }], { source });
  const [outcome] = outcomes;
  if (outcome.result) return outcome.result;
  if (options?.notify) {
    showGlobalMessage().error(`${i18n.t("file.uploadFailed")} - ${outcome.error?.message ?? i18n.t("error.unknown")}`);
  }
  return null;
}
