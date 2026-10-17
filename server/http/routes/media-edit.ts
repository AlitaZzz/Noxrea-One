/**
 * 媒体编辑路由工厂。
 *
 * 抽帧、裁剪、片段截取、音轨分离、变速、预览代理、雪碧图这批路由共享同一套
 * 前置链路（鉴权 → 请求体校验 → 源键归属与路径穿越防护 → 源文件存在性检查）
 * 与同一套临时目录生命周期、错误映射，历史上各自复制粘贴，校验细节逐渐漂移。
 * 本工厂把这条链路收敛为单一实现，路由只声明 schema、源键取法与业务执行体。
 *
 * 归属校验：存储键格式为 {userId}/{hash[:2]}/{hash}{ext}，首段即属主；
 * 源键必须属于当前登录用户（_sprite/_proxy/_cache 等派生物与他人的文件一律 403）。
 *
 * 统一错误码（media.*）：
 * - 源文件不存在 → 404 media.source_not_found
 * - 客户端断开 → 499 media.cancelled
 * - ffmpeg 缺失 → 500 media.ffmpeg_missing
 * - 处理超时 → 504 media.timeout
 * - 其余失败 → 各路由的 failureCode
 */
import type { Context, Handler } from "hono";
import type { ZodType } from "zod";
import path from "path";
import fs from "fs/promises";
import { randomUUID } from "crypto";

import { authenticateRequest } from "@server/http/middleware/auth";
import { StorageTraversalError } from "@server/services/storage/backend";
import { computeFileHash } from "@server/services/storage/hash";
import { buildFileUrl, buildStorageKey, getStorageBackend } from "@server/services/storage/service";
import { persistFileObject } from "@server/services/storage/persist";
import { acquireMediaFile, mediaSourceInput, resolveMediaSource } from "@server/services/storage/media-source";
import { tmpDir as workspaceTmpDir } from "@server/services/storage/workspace";
import { failClientDisconnected, failCode } from "@server/core/response";
import { checkUserRateLimit } from "@server/core/ratelimit";
import { logger } from "@server/core/logger";
import type { ErrorCode } from "@server/core/errors/codes";
import { MediaPoolBusyError } from "@server/services/storage/media-pool";
import { failMediaBusy } from "../media-busy";

export interface MediaEditContext<T> {
  /** 请求上下文（响应序列化、query 读取） */
  c: Context;
  /** 校验通过的请求体 */
  data: T;
  /** 客户端传入的源存储键 */
  sourceKey: string;
  /**
   * 媒体工具输入串：lease 模式恒为本地路径（local 存储路径 / S3 工作区下载副本）；
   * direct 模式为源解析产物（local 存储路径 / S3 预签名 URL）。已通过归属与存在性校验。
   */
  sourceInput: string;
  userId: number;
  /** 客户端断开信号：向下游 ffmpeg 传导取消 */
  signal: AbortSignal;
  /** 本次请求独享的临时目录：首次调用时创建，请求结束自动清理；用不到临时文件的路由不会创建 */
  tmpDir: () => Promise<string>;
}

export interface MediaEditRouteOptions<T> {
  /** 请求体 schema */
  schema: ZodType<T>;
  /** 从请求体中取出源存储键 */
  resolveKey: (data: T) => string;
  /** 路由名：日志标签与临时目录前缀 */
  name: string;
  /** 处理失败（非取消/超时/缺 ffmpeg）的错误码 */
  failureCode: ErrorCode;
  /**
   * 路由是否落库新的文件对象（产出类编辑）。默认 true：受「每人 20 次/分钟」的
   * 按用户限流约束——它限制的是单个用户每分钟产生的派生文件数量（存储增长），
   * CPU 保护由媒体池负责。雪碧图 / 预览代理等只产出可缓存派生产物的路由为 false，
   * 不计数（CPU 由重型池的个人与全局限额约束，specs/media-processing-concurrency.md 规则 5）。
   */
  persistsFileObject?: boolean;
  /**
   * 源交付方式（specs/storage-s3-backend.md 规则 8 短/重操作分类）：
   * - "lease"(默认)：租约出本地路径——重操作（全量解码 / 转码 / 重剪辑），
   *   S3 下先整体下载到工作区，规避预签名 URL 中途过期与 HTTP seek 往返；
   * - "direct"：短操作（单帧抽帧）经源解析直接取输入，不下载不租约，
   *   S3 下 ffmpeg 直接消费预签名 GET URL。
   */
  sourceDelivery?: "lease" | "direct";
  /** 路由特有的错误映射，返回 Response 时优先采用；返回 undefined 走默认映射 */
  mapError?: (err: unknown) => Response | undefined;
  run: (ctx: MediaEditContext<T>) => Promise<Response>;
}

/** 源存储键是否属于该用户（键首段为属主 userId） */
function keyBelongsTo(storageKey: string, userId: number): boolean {
  const owner = storageKey.split("/", 1)[0];
  return owner === String(userId);
}

/**
 * 媒体处理失败的统一错误映射。
 * 底层细节（ffmpeg 输出、路径、退出码）只进日志，不下发客户端。
 */
export function mapMediaError(
  err: unknown,
  info: { sourceKey: string; label: string; failureCode: ErrorCode },
): Response {
  const message = err instanceof Error ? err.message : String(err);
  const code = typeof err === "object" && err !== null && "code" in err ? err.code : undefined;

  // 全局媒体池过载：全局阶段 503 media.busy，个人阶段 429 media.user_busy，与处理失败严格区分
  if (err instanceof MediaPoolBusyError) {
    return failMediaBusy(err.pool, err.scope);
  }

  // 客户端断开：不记 error 级别，也无需向已断开的一端回复杂信息
  if ((err as Error).name === "AbortError") {
    logger.debug({ sourceKey: info.sourceKey }, `${info.label} aborted by client`);
    return failClientDisconnected("media.cancelled");
  }

  logger.error({ err, sourceKey: info.sourceKey }, `${info.label} failed`);

  if (code === "ENOENT" || message.includes("ENOENT")) {
    return failCode(500, "media.ffmpeg_missing");
  }
  if (message.includes("timed out")) {
    return failCode(504, "media.timeout");
  }
  return failCode(500, info.failureCode);
}

/** 按内容哈希落盘 + 登记文件对象，返回可访问地址与体积 */
export async function persistDerived(params: {
  userId: number;
  tmpPath: string;
  ext: string;
  mime: string;
}): Promise<{ key: string; url: string; size: number }> {
  const hash = await computeFileHash(params.tmpPath);
  const { size } = await fs.stat(params.tmpPath);
  const storageKey = buildStorageKey(params.userId, hash, params.ext);

  // 传路径而非 Buffer：内容不进内存（local 后端工作区内 rename / copyFile，S3 后端读流上传）
  await getStorageBackend().put(storageKey, params.tmpPath);
  await persistFileObject({
    userId: params.userId,
    hash,
    size,
    mimeType: params.mime,
    ext: params.ext,
    source: "derived",
  });

  return { key: storageKey, url: buildFileUrl(storageKey), size };
}

export function createMediaEditRoute<T>(opts: MediaEditRouteOptions<T>): Handler {
  return async (c: Context) => {
    const request = c.req.raw;
    const auth = await authenticateRequest(request);
    if ("error" in auth) return auth.error;

    // 按用户限流（仅产出类编辑）：每条都落库新文件，单用户 20 次/分钟（交互式点击远低于此）；
    // CPU 保护由媒体池负责，预览产物类路由不计数
    if (opts.persistsFileObject !== false) {
      const limitCheck = checkUserRateLimit("media-edit", auth.user.id, 20, 60);
      if (!limitCheck.allowed) {
        return failCode(429, "common.rate_limited", undefined, {
          "Retry-After": String(limitCheck.retryAfterSeconds),
          "Cache-Control": "no-store",
        });
      }
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return failCode(400, "common.invalid_json");
    }

    const parsed = opts.schema.safeParse(body);
    if (!parsed.success) {
      return failCode(422, "common.invalid_request");
    }

    const sourceKey = opts.resolveKey(parsed.data);

    // 归属防护：源键必须属于当前用户（他人文件与派生物一律拒绝）
    if (!keyBelongsTo(sourceKey, auth.user.id)) {
      return failCode(403, "files.access_denied");
    }

    // 穿越防护与存在性检查：后端解析 key 时逃出命名空间抛 StorageTraversalError（403），
    // key 不存在返回 null（404）。S3 后端无文件系统语义，但未约束 key 形态的请求
    // 仍在此统一拒绝，错误码与 local 一致
    try {
      if (!(await getStorageBackend().stat(sourceKey))) {
        return failCode(404, "media.source_not_found");
      }
    } catch (err: unknown) {
      if (err instanceof StorageTraversalError) {
        return failCode(403, "files.invalid_path");
      }
      throw err;
    }

    // 请求独享的临时目录按需创建（UUID 避免并发请求互相踩踏临时文件）；
    // 派生产物类路由（雪碧图 / 预览代理）由 ensureArtifact 自管临时文件，不会用到
    const tmpDirPath = path.join(workspaceTmpDir(), `${opts.name}_${randomUUID()}`);
    let tmpDirCreated = false;
    const tmpDir = async () => {
      await fs.mkdir(tmpDirPath, { recursive: true });
      tmpDirCreated = true;
      return tmpDirPath;
    };

    try {
      const baseCtx = {
        c,
        data: parsed.data,
        sourceKey,
        userId: auth.user.id,
        signal: request.signal,
        tmpDir,
      };
      if (opts.sourceDelivery === "direct") {
        // 短操作：不租约、不下载，源输入直接交给 run（local 为存储路径，S3 为预签名 URL）
        const source = await resolveMediaSource(sourceKey);
        return await opts.run({ ...baseCtx, sourceInput: mediaSourceInput(source) });
      }
      // 源租约：local 后端零成本取存储路径；S3 后端下载到工作区（重操作，业务规则 8），
      // 客户端断开经 signal 中止下载。获取失败与处理失败走同一套错误映射，
      // 请求结束（含失败）统一释放
      const source = await acquireMediaFile(sourceKey, request.signal);
      try {
        return await opts.run({ ...baseCtx, sourceInput: source.path });
      } finally {
        await source.release();
      }
    } catch (err: unknown) {
      const mapped = opts.mapError?.(err);
      if (mapped) return mapped;
      return mapMediaError(err, {
        sourceKey,
        label: opts.name,
        failureCode: opts.failureCode,
      });
    } finally {
      if (tmpDirCreated) {
        await fs.rm(tmpDirPath, { recursive: true, force: true }).catch((err: unknown) => {
          logger.warn({ err, tmpDir: tmpDirPath }, `Failed to remove temp ${opts.name} dir`);
        });
      }
    }
  };
}
