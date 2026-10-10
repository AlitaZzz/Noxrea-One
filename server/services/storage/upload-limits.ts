/**
 * 上传批次限制的轻量单一来源。
 * 只依赖 config 与 response，供 body-limit 中间件与上传路由共用，
 * 避免中间件为取限制值引入整个批次处理服务的传递依赖（hash / probe / persist 等）。
 */
import { getConfig } from "@server/core/config";
import { failCode } from "@server/core/response";

/** 上传批次限制：单批文件数、单批总字节（由配置的 MiB 值换算）。 */
export interface UploadBatchLimits {
  maxFiles: number;
  maxMb: number;
  maxBytes: number;
}

/** 读取当前配置的批次上限，供路由校验、body-limit 中间件和 upload-limits 端点共用。 */
export function getUploadBatchLimits(): UploadBatchLimits {
  const cfg = getConfig();
  return {
    maxFiles: cfg.UPLOAD_BATCH_MAX_FILES,
    maxMb: cfg.UPLOAD_BATCH_MAX_MB,
    maxBytes: cfg.UPLOAD_BATCH_MAX_MB * 1024 * 1024,
  };
}

/** 批次超过文件数或总大小上限的统一 413 响应：错误码与 ctx 只在此定义一次。 */
export function failBatchTooLarge(): Response {
  const limits = getUploadBatchLimits();
  return failCode(413, "upload.batch_too_large", {
    files: limits.maxFiles,
    totalMb: limits.maxMb,
  });
}
