/**
 * 参考图解析。
 * 将用户传入的参考图路径或 URL 解析为可访问的资源，并做路径穿越防护。
 */

import { isStorageKey, buildManagedFileUrl, stripTrailingSlash } from "@noxrea/shared/url";
import { logEvent } from "@server/core/logger/utils";
import { getSetting } from "@server/core/settings";
import fs from "fs/promises";
import path from "path";
import { StorageTraversalError } from "@server/services/storage/backend";
import { acquireMediaFile } from "@server/services/storage/media-source";
import { getStorageBackend } from "@server/services/storage/service";
import { CAPABILITY_URL_TTL_SECONDS } from "@server/services/storage/signing";
import { signFileUrlParams } from "@server/services/storage/file-url-signature";
import { mimeByExt } from "@server/services/storage/mime";
import { GenerationFailureError } from "@server/services/tasks/failure";

/** 规则 12 交付失败统一错误码：参考素材无法按选定形态交付上游（落库供失败分类与统计） */
const REFERENCE_UNAVAILABLE = "generation.reference_unavailable";

/**
 * 将存储 key 引用的素材转为完整的 data: URL（base64）。
 * local 后端直接读存储文件；S3 后端先下载到工作区再读（base64 整体上传属重操作）。
 * 读取失败（含 key 逃出命名空间）直接抛错——把损坏的引用原样传给上游只会得到
 * 一个必然失败的上游任务（且计费），不如在本环节就明确失败原因。
 */
async function readSelfFile(storageKey: string): Promise<string> {
  let file: Awaited<ReturnType<typeof acquireMediaFile>>;
  try {
    file = await acquireMediaFile(storageKey);
  } catch (err) {
    if (err instanceof StorageTraversalError) {
      logEvent("resolver.reference", {
        stage: "path_traversal_blocked",
        path: storageKey.slice(0, 80),
      });
    }
    throw new GenerationFailureError(
      `参考素材读取失败: ${storageKey}`,
      REFERENCE_UNAVAILABLE
    );
  }

  try {
    let data: Buffer;
    try {
      data = await fs.readFile(file.path);
    } catch (err) {
      logEvent("resolver.reference", {
        stage: "self_file_read_failed",
        path: storageKey.slice(0, 80),
        error: (err as Error).message,
      });
      throw new GenerationFailureError(
        `参考素材读取失败: ${storageKey}`,
        REFERENCE_UNAVAILABLE
      );
    }

    const ext = path.extname(storageKey).toLowerCase();
    const mime = mimeByExt(ext);
    const b64 = data.toString("base64");
    return `data:${mime};base64,${b64}`;
  } finally {
    await file.release();
  }
}

/**
 * 签发不能成立的统一出口：记 signed_url_failed 日志、抛 GenerationFailureError
 * （统一错误码 + 指明配置动作，并统一携带「或改 base64」备选动作）。
 * 三类签发失败共用，「一律明确失败」契约的单一实现。
 */
function signedUrlFailure(key: string, reason: unknown, hint: string): never {
  logEvent("resolver.reference", {
    stage: "signed_url_failed",
    key: key.slice(0, 80),
    error: reason instanceof Error ? reason.message : String(reason),
  });
  throw new GenerationFailureError(
    `参考素材签名失败: ${key}（${hint}，或将 storage.upstream_ref_delivery 改为 base64）`,
    REFERENCE_UNAVAILABLE,
  );
}

/**
 * 规则 12：引用 key 即时签发为短期签名 URL。
 * - S3 后端：presignGet 直连 bucket（前提端点对上游可达，见规则 12）；
 * - local 后端：应用层 HMAC 签名 + public_base_url 拼绝对地址。
 * 交付形态仅由 storage.upstream_ref_delivery 单一开关决定；signed-url 模式下
 * 签发不能成立（S3 签名故障 / local 未配 public_base_url / 签名操作故障）
 * 一律明确失败——与读取失败同一哲学：不静默改变载荷契约，错误信息指明配置动作。
 * TTL 使用 `CAPABILITY_URL_TTL_SECONDS`（常量 1h，覆盖上游拉取窗口；
 * 浏览器读路径的 4h 寿命不适用于上游能力凭据）。
 * 这是**能力型凭据**：签发即用，不传签名窗口（`windowSeconds`）——浏览器读路径的长窗口
 * 只服务于 URL 缓存稳定性，能力凭据没有复用诉求，不应继承缓存寿命方案；后端缺省的
 * TTL/4 对齐窗口保持原语义，`expiresIn` 恒为 TTL、窗口不延长有效期
 * （specs/storage-signed-direct-delivery.md 规则 4.6）。
 */
async function upstreamSignedUrl(key: string): Promise<string> {
  const backend = getStorageBackend();
  if (backend.presignGet) {
    try {
      return await backend.presignGet(key);
    } catch (err) {
      signedUrlFailure(key, err, "请检查 storage.s3 凭据与签名配置");
    }
  }
  const base = stripTrailingSlash(getSetting("network.public_base_url"));
  if (!base) {
    signedUrlFailure(key, "network.public_base_url 未配置", "请配置 network.public_base_url");
  }
  try {
    const { expires, signature } = signFileUrlParams(key, CAPABILITY_URL_TTL_SECONDS);
    const query = new URLSearchParams({ expires: String(expires), signature });
    return `${base}${buildManagedFileUrl(key)}?${query.toString()}`;
  } catch (err) {
    signedUrlFailure(key, err, "请检查服务端签名密钥配置");
  }
}

/**
 * 参考素材通用解析（对齐 Python resolve_refs 三档策略 + storage-s3-backend 规则 12 双凭据）：
 * 1) data: URL → 直接透传
 * 2) 存储 key（任务 ref* 列持久化的托管引用形态）→ 按 `storage.upstream_ref_delivery`
 *    单一开关：signed-url（默认）即时签发短期签名 URL（S3 直连 bucket，local 拼
 *    public_base_url）；base64 读本机磁盘转 data URL。交付形态仅由设置决定，
 *    signed-url 模式下签发不能成立（S3 签名故障 / local 未配 public_base_url /
 *    签名操作故障）一律明确失败，绝不静默回退另一形态。
 * 3) 外链 URL → 透传原串
 * 本地素材读取失败时抛 GenerationFailureError，外链透传不涉及读取、不会失败。
 * 签名 URL 不入库不持久化：解析发生在每次提交/重试时，天然即时重签。
 *
 * 契约：返回数组与输入严格等长同序（1:1）——任一 URL 解析失败即抛错，绝不静默跳过。
 * 消费方（如 llm 的 resolveMessageImages）依赖此契约按下标对位回写，非空断言因此成立。
 */
async function resolveRefList(urls: string[]): Promise<string[]> {
  if (!urls || urls.length === 0) return [];

  const resolved: string[] = [];

  for (const url of urls) {
    // 已经是 data: URL → 直接透传
    if (url.startsWith("data:")) {
      resolved.push(url);
      continue;
    }

    // 存储 key：交付形态仅由单一开关决定，签发不能成立一律明确失败（详见 upstreamSignedUrl）
    if (isStorageKey(url)) {
      if (getSetting("storage.upstream_ref_delivery") === "signed-url") {
        resolved.push(await upstreamSignedUrl(url));
        continue;
      }
      resolved.push(await readSelfFile(url));
      continue;
    }

    // 外链 → 透传
    resolved.push(url);
  }

  return resolved;
}

/** 解析参考图列表 */
export function resolveRefImages(urls: string[]): Promise<string[]> {
  return resolveRefList(urls);
}

/** 解析参考音频列表 */
export function resolveRefAudio(urls: string[]): Promise<string[]> {
  return resolveRefList(urls);
}

/** 解析参考视频列表 */
export function resolveRefVideo(urls: string[]): Promise<string[]> {
  return resolveRefList(urls);
}
