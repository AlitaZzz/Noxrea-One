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
import { signFileUrlParams } from "@server/services/storage/file-url-signature";
import { mimeByExt } from "@server/services/storage/mime";
import { GenerationFailureError } from "@server/services/tasks/failure";

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
      "generation.reference_unavailable"
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
        "generation.reference_unavailable"
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
 * 规则 12：引用 key 即时签发为短期签名 URL。
 * - S3 后端：presignGet 直连 bucket（端点需对上游可达）；签名操作失败向上抛
 *   （交付形态由 storage.upstream_ref_delivery 决定，临时故障不静默改变载荷契约）；
 * - local 后端：应用层 HMAC 签名 + public_base_url 拼绝对地址；
 *   未配置 public_base_url 属结构性不可用，返回 null 由调用方按设置回退 base64。
 * TTL 沿用 `storage.s3.signed_url_ttl_seconds`（规则 12：默认 1h，覆盖上游拉取窗口）。
 */
async function upstreamSignedUrl(key: string): Promise<string | null> {
  const backend = getStorageBackend();
  if (backend.presignGet) return await backend.presignGet(key);
  const base = stripTrailingSlash(getSetting("network.public_base_url"));
  if (!base) return null;
  const ttl = getSetting("storage.s3.signed_url_ttl_seconds");
  const { expires, signature } = signFileUrlParams(key, ttl);
  const query = new URLSearchParams({ expires: String(expires), signature });
  return `${base}${buildManagedFileUrl(key)}?${query.toString()}`;
}

/**
 * 参考素材通用解析（对齐 Python resolve_refs 三档策略 + storage-s3-backend 规则 12 双凭据）：
 * 1) data: URL → 直接透传
 * 2) 存储 key（任务 ref* 列持久化的托管引用形态）→ 按 `storage.upstream_ref_delivery`：
 *    signed-url（默认）即时签发短期签名 URL（S3 直连 bucket，local 拼 public_base_url）；
 *    base64、或 local 未配 public_base_url（结构性不可用）时回退读本机磁盘转 data URL；
 *    签名操作失败（如 S3 临时故障）按失败处理，不静默改变载荷契约
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

    // 存储 key：签名 URL 优先（上游自行拉取，字节不过应用服务器）；
    // 设置选 base64、或 local 未配 public_base_url（结构性不可用）时回退读盘转 base64；
    // 签名操作失败按本环节明确失败处理（与 readSelfFile 同一哲学，不静默改走 base64）
    if (isStorageKey(url)) {
      if (getSetting("storage.upstream_ref_delivery") === "signed-url") {
        const signed = await upstreamSignedUrl(url).catch((err: unknown) => {
          logEvent("resolver.reference", {
            stage: "signed_url_failed",
            key: url.slice(0, 80),
            error: err instanceof Error ? err.message : String(err),
          });
          throw new GenerationFailureError(`参考素材签名失败: ${url}`, "generation.reference_unavailable");
        });
        if (signed) {
          resolved.push(signed);
          continue;
        }
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
