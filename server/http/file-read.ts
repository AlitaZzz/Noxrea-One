/**
 * 托管文件读管线（specs/storage-signed-direct-delivery.md 规则 2.2）。
 *
 * GET 字节路由与 POST 描述路由共用同一份实现：归属校验 → 路径穿越防护 →
 * 可读键域 → `w` 派生生成 → `stat`。凭据判定由调用方先做（{@link FileReadCredential}），
 * 本管线只接受已通过的凭据——描述路由整批只判定一次，逐条只走这里。
 *
 * 失败以**类型化原因**返回而不是 Response：字节路由把原因映射为 HTTP 响应，
 * 描述路由把同一原因映射为逐条错误码。映射本身也在此单点维护，两条路径不会分叉。
 */
import path from "path";

import { logEvent } from "@server/core/logger/utils";
import { metrics } from "@server/core/metrics";
import { failCode } from "@server/core/response";
import { truncateUtf16, wellFormedUtf16 } from "@noxrea/shared/text";
import { failMediaBusy, mediaBusyCode } from "@server/http/media-busy";
import type { FileReadCredential } from "@server/http/file-read-auth";
import { isKeyWithinNamespace, StorageTraversalError } from "@server/services/storage/backend";
import { derivedSourceStemOf, isReadableFileKey } from "@server/services/storage/derived-keys";
import { isVideoExt } from "@server/services/storage/formats";
import {
  MediaPoolBusyError,
  type MediaPoolName,
  type MediaPoolScope,
} from "@server/services/storage/media-pool";
import { extOfName } from "@server/services/storage/mime";
import { isKeyOwner } from "@server/services/storage/ownership";
import { getResizedWebP, getVideoPosterWebP } from "@server/services/storage/resize-cache";
import { getStorageBackend } from "@server/services/storage/service";

/** 已通过凭据判定的读取请求（会话或能力凭据） */
type GrantedReadCredential = Extract<FileReadCredential, { ok: true }>;

type PreparedRead = {
  /** 请求的存储 key（原图或派生 key），附件名与流式 URL 以它为准 */
  requestedKey: string;
  /** 实际取字节的对象 key（`w` 派生命中时为派生 key） */
  objectKey: string;
  stat: { size: number; mtimeMs: number };
  ext: string;
  /** 实际生效的派生宽度（派生 key 忽略 `w`，见 prepareFileRead 的说明） */
  width: number | undefined;
};

/**
 * 读管线失败原因（语义即验收表，specs/storage-signed-direct-delivery.md 规则 2.4）。
 * 不带 Response：调用方按自己的响应形态映射（整响应或逐条错误码）。
 */
type ReadFailure =
  | { reason: "not_found" }
  | { reason: "invalid_path" }
  | { reason: "access_denied" }
  | { reason: "media_busy"; pool: MediaPoolName; scope: MediaPoolScope };

type PreparedReadResult =
  | { ok: true; read: PreparedRead }
  | { ok: false; failure: ReadFailure };

const notFound = (): PreparedReadResult => ({ ok: false, failure: { reason: "not_found" } });

/**
 * 鉴权 → 归属 → 穿越检查 → 按需派生 → stat。
 * @param credential 调用方已完成凭据判定的结果（能力凭据不叠加归属比对）
 */
export async function prepareFileRead(
  requestedKey: string,
  width: number | undefined,
  signal: AbortSignal,
  credential: GrantedReadCredential,
): Promise<PreparedReadResult> {
  if (!authorizeKeyRead(requestedKey, credential)) return notFound();

  // 路径穿越防护（鉴权之后：key 形态的 403 信息只暴露给通过凭据校验的调用方；
  // 会话路径下穿越键已在归属守卫被 404 吸收，此检查服务签名路径）。
  // 判据与各后端入口共用 isKeyWithinNamespace——两处各写一套就意味着一处会先漂移。
  if (!isKeyWithinNamespace(requestedKey)) {
    return { ok: false, failure: { reason: "invalid_path" } };
  }

  // 可读键域（规则 2.1）：内容键或派生产物才可读；staging 等未提交的缓冲键与
  // 「对象不存在」同响应（鉴权之后判定，不构成存在性预言机）
  if (!isReadableFileKey(requestedKey)) return notFound();

  let objectKey = requestedKey;
  // 派生 key 是缓存终点：不再按 `w` 派生下一层（否则 `_cache/v2/480/_cache/v2/...`
  // 会一层层套下去，成为放大存储的入口）。只对内容键应用缩放参数。
  const effectiveWidth = derivedSourceStemOf(requestedKey) === null ? width : undefined;

  // w 缩放参数 -> WebP 缓存：
  // 图片走 sharp 缩放；视频走 ffmpeg 抽帧缩放（首帧），按需惰性生成并缓存。
  // 透传 signal：客户端断开时中止缩放任务，及时释放源文件句柄。
  if (effectiveWidth !== undefined) {
    const video = isVideoExt(extOfName(requestedKey));
    try {
      const cached = video
        ? await getVideoPosterWebP(requestedKey, effectiveWidth, signal)
        : await getResizedWebP(requestedKey, effectiveWidth, signal);
      if (cached) {
        objectKey = cached;
      } else if (video) {
        // 视频缩略图生成失败：不回退原视频（否则 <img> 解码失败），返回 404 由前端兜底
        return notFound();
      }
    } catch (err: unknown) {
      // 媒体池过载：全局阶段 503 media.busy，个人阶段 429 media.user_busy；不回退原图
      // （原图上限 100MB，回退会把 CPU 过载变成带宽洪峰）
      if (err instanceof MediaPoolBusyError) {
        // 过载拒绝的唯一分类点：字节路由（503/429 响应）与描述路由（逐条错误码）
        // 都从这里拿到失败，指标在此记一次，两种出口不会漏计或重复
        metrics.mediaBusyRejected();
        return { ok: false, failure: { reason: "media_busy", pool: err.pool, scope: err.scope } };
      }
      throw err;
    }
  }

  // 存在性与穿越校验：后端解析 key 时逃出命名空间抛 StorageTraversalError（403），
  // key 不存在（含缩放缓存未生成）返回 null（404）
  const backend = getStorageBackend();
  let stat: { size: number; mtimeMs: number } | null;
  try {
    stat = await backend.stat(objectKey);
  } catch (err: unknown) {
    if (err instanceof StorageTraversalError) {
      return { ok: false, failure: { reason: "access_denied" } };
    }
    throw err;
  }

  if (!stat) return notFound();

  return {
    ok: true,
    read: { requestedKey, objectKey, stat, ext: extOfName(objectKey), width: effectiveWidth },
  };
}

/**
 * 归属判定：会话凭据必须持有 key 的归属；能力凭据本身已由签名锚定 key。
 * 归属拒绝与「对象不存在」同响应（防存在性预言机），拒绝原因只进日志。
 */
function authorizeKeyRead(key: string, credential: GrantedReadCredential): boolean {
  if (credential.credential === "capability") return true;
  if (isKeyOwner(key, credential.userId)) return true;
  logEvent("files", { level: "warn", stage: "ownership_denied", userId: credential.userId, key });
  return false;
}

/** 附件名长度上限（常见文件系统 NAME_MAX）：两条读路径共用同一上限，不各写一套 */
const MAX_DOWNLOAD_NAME_LENGTH = 255;

/**
 * 下载名：基名取 `filename` 或请求 key 的文件名，扩展名一律以**实际服务的字节**为准
 * （GET 与描述接口共用，两处传同一入参 `PreparedRead.requestedKey`）。
 *
 * 基名自带的**源扩展名**（请求 key 的扩展名）先剥掉再补 `ext`：派生读（`w=` → WebP）
 * 时基名仍是用户请求的原图名（`photo.png`），直接追加会叠成 `photo.png.webp`。只剥源
 * 扩展名而不是任意末段——`report.final` 这类名字里的点属于文件名本身，不能被吃掉。
 *
 * 超长名按上限截断（保留扩展名）：文件名来自客户端，必须给响应头一个确定上界。
 * 截断按「不劈开代理对」的规则（shared/text），孤立代理在编码边界归一为 U+FFFD。
 */
export function downloadBaseName(
  filename: string | undefined,
  requestedKey: string,
  ext: string,
): string {
  const name = wellFormedUtf16(filename ?? path.basename(requestedKey));
  const sourceExt = extOfName(requestedKey);
  // 纯扩展名（`.png`）不剥，否则基名会被剥成空串
  const stem = sourceExt && name !== sourceExt && name.toLowerCase().endsWith(sourceExt)
    ? name.slice(0, -sourceExt.length)
    : name;
  const baseName = stem.toLowerCase().endsWith(ext) ? stem : stem + ext;
  if (baseName.length <= MAX_DOWNLOAD_NAME_LENGTH) return baseName;
  const truncated = baseName.slice(0, baseName.length - ext.length);
  return truncateUtf16(truncated, MAX_DOWNLOAD_NAME_LENGTH - ext.length) + ext;
}

/**
 * 非过载类失败的「状态码 + 错误码」单一来源：字节路由与描述路由各自取用其中一列，
 * 新增失败原因只改这张表，两条路径不会分叉。
 */
const FAILURE_CODES = {
  not_found: { status: 404, code: "files.file_not_found" },
  invalid_path: { status: 403, code: "files.invalid_path" },
  access_denied: { status: 403, code: "files.access_denied" },
} as const satisfies Record<Exclude<ReadFailure["reason"], "media_busy">, { status: number; code: string }>;

/** 读管线失败 → 整响应（字节路由）；过载的 Retry-After 由 failMediaBusy 单点输出 */
export function readFailureResponse(failure: ReadFailure): Response {
  if (failure.reason === "media_busy") return failMediaBusy(failure.pool, failure.scope);
  const { status, code } = FAILURE_CODES[failure.reason];
  return failCode(status, code);
}

/** 读管线失败 → 描述项错误码（描述路由）：语义与 {@link readFailureResponse} 逐条对应 */
export function readFailureCode(failure: ReadFailure): string {
  // 过载按阶段细分：错误码与整响应路径共用 mediaBusyCode，两条出口不分叉
  if (failure.reason === "media_busy") return mediaBusyCode(failure.scope);
  return FAILURE_CODES[failure.reason].code;
}
