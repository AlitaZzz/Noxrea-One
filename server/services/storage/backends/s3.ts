/**
 * S3 兼容对象存储后端（specs/storage-s3-backend.md 业务规则 2/3/4/9/10）。
 * 基于 @aws-sdk/client-s3，适配 MinIO / Cloudflare R2 / 各云 S3 网关：
 * - put/get/stat/delete/list 对齐 StorageBackend 接口语义，delete 含规则 9 派生联动；
 * - 预签名 GET/PUT 支撑 redirect 分发、直传与媒体工具输入，签名时间对齐 TTL/4
 *   的 epoch 绝对窗口（多实例签出字节一致的 URL，配合 response-cache-control
 *   命中浏览器缓存）；
 * - `storage.s3.prefix` 作为对象 key 统一前缀在内部映射，接口层 key 不含前缀。
 * 错误面：对象不存在统一收敛为 stat → null / delete → 成功（对象存储语义）；
 * 其余 S3 错误原样上抛由调用方映射——写失败明确报错，禁止静默降级（spec 异常边界）。
 */

import { Readable } from "stream";
import { pipeline } from "stream/promises";
import fs from "fs/promises";
import { createReadStream, createWriteStream } from "fs";
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { listDerivedArtifactKeys, StorageTraversalError, type StorageBackend } from "@server/services/storage/backend";
import { allocateTempPath, tmpDir } from "@server/services/storage/workspace";
import { rmQuiet } from "@server/services/storage/fs-utils";
import { extOfName, mimeByExt } from "@server/services/storage/mime";

export interface S3BackendOptions {
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  pathStyle: boolean;
  prefix: string;
  signedUrlTtlSeconds: number;
}

/** 接口层 key 的防护：绝对形态与 `..` 段在 local 后端是穿越、在对象存储是脏 key，统一拒绝 */
function guardKey(key: string): void {
  if (key.startsWith("/") || key.split("/").includes("..")) {
    throw new StorageTraversalError(key);
  }
}

export class S3Backend implements StorageBackend {
  private readonly client: S3Client;
  private readonly bucket: string;
  /** 对象 key 统一前缀（bucket 复用）；空串表示直接用 bucket 根 */
  private readonly prefix: string;
  private readonly ttlSeconds: number;
  /** 端点仅用于启动探测失败时的诊断输出，不参与签名 */
  readonly endpoint: string;

  constructor(opts: S3BackendOptions) {
    this.endpoint = opts.endpoint;
    this.bucket = opts.bucket;
    this.prefix = opts.prefix.replace(/^\/+|\/+$/g, "");
    this.ttlSeconds = opts.signedUrlTtlSeconds;
    this.client = new S3Client({
      endpoint: opts.endpoint,
      region: opts.region,
      credentials: {
        accessKeyId: opts.accessKeyId,
        secretAccessKey: opts.secretAccessKey,
      },
      forcePathStyle: opts.pathStyle,
    });
  }

  /** 接口层 key → 带前缀的对象 key */
  private objectKey(key: string): string {
    guardKey(key);
    return this.prefix ? `${this.prefix}/${key}` : key;
  }

  private stripPrefix(objectKey: string): string {
    if (!this.prefix) return objectKey;
    return objectKey.startsWith(`${this.prefix}/`)
      ? objectKey.slice(this.prefix.length + 1)
      : objectKey;
  }

  async put(key: string, source: string | Buffer | ReadableStream): Promise<void> {
    let stagedPath: string | null = null;
    let body: Readable | Buffer;
    let contentLength: number;

    if (Buffer.isBuffer(source)) {
      body = source;
      contentLength = source.length;
    } else if (typeof source === "string") {
      const stat = await fs.stat(source);
      contentLength = stat.size;
      body = createReadStream(source);
    } else {
      // 未知长度的 Web ReadableStream：S3 单请求上传要求已知 Content-Length，
      // 先落工作区临时文件再以文件流上传（接口契约允许的唯一重负载入口）
      stagedPath = allocateTempPath(key);
      await fs.mkdir(tmpDir(), { recursive: true });
      try {
        await pipeline(
          Readable.fromWeb(source as Parameters<typeof Readable.fromWeb>[0]),
          createWriteStream(stagedPath),
        );
      } catch (err) {
        await rmQuiet(stagedPath);
        throw err;
      }
      const staged: string = stagedPath;
      contentLength = (await fs.stat(staged)).size;
      body = createReadStream(staged);
    }

    try {
      await this.client.send(new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.objectKey(key),
        Body: body,
        ContentLength: contentLength,
        ContentType: mimeByExt(extOfName(key)),
      }));
    } finally {
      if (stagedPath) await rmQuiet(stagedPath);
    }
  }

  async get(
    key: string,
    opts?: { range?: { start: number; end?: number }; signal?: AbortSignal },
  ): Promise<Readable> {
    const res = await this.client.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: this.objectKey(key),
        ...(opts?.range ? { Range: `bytes=${opts.range.start}-${opts.range.end ?? ""}` } : {}),
      }),
      opts?.signal ? { abortSignal: opts.signal } : undefined,
    );
    if (!res.Body) throw new Error(`S3 GetObject returned empty body: ${key}`);
    return res.Body instanceof Readable ? res.Body : Readable.fromWeb(res.Body as Parameters<typeof Readable.fromWeb>[0]);
  }

  async stat(key: string): Promise<{ size: number; mtimeMs: number } | null> {
    try {
      const res = await this.client.send(new HeadObjectCommand({
        Bucket: this.bucket,
        Key: this.objectKey(key),
      }));
      return {
        size: res.ContentLength ?? 0,
        mtimeMs: res.LastModified ? res.LastModified.getTime() : 0,
      };
    } catch (err: unknown) {
      if (isNotFoundError(err)) return null;
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    await this.deleteObject(key);
    // 规则 9：派生联动（枚举半边为接口级共享实现；对象存储无空目录概念，逐对象删除即可）
    for (const derived of await listDerivedArtifactKeys(this, key)) {
      await this.deleteObject(derived);
    }
  }

  private async deleteObject(key: string): Promise<void> {
    // S3 DeleteObject 对不存在的 key 同样返回 2xx，「不存在视为成功」天然成立
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: this.objectKey(key) }));
  }

  async list(prefix: string): Promise<Array<{ key: string; size: number; lastModifiedMs: number }>> {
    const out: Array<{ key: string; size: number; lastModifiedMs: number }> = [];
    const fullPrefix = this.objectKey(prefix);
    let token: string | undefined;
    do {
      const res = await this.client.send(new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: fullPrefix,
        MaxKeys: 1000,
        ...(token ? { ContinuationToken: token } : {}),
      }));
      for (const obj of res.Contents ?? []) {
        if (!obj.Key) continue;
        out.push({
          key: this.stripPrefix(obj.Key),
          size: obj.Size ?? 0,
          lastModifiedMs: obj.LastModified ? obj.LastModified.getTime() : 0,
        });
      }
      token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token);
    return out;
  }

  /**
   * 预签名 GET（业务规则 4）：签名时间对齐到 TTL/4 的 epoch 绝对窗口——
   * 同窗口内所有实例、所有请求签出字节一致的 URL，浏览器可跨请求复用缓存。
   * expiresIn 取 ttl + window：窗口内任意时刻签发，有效期剩余都 ≥ ttl。
   */
  async presignGet(key: string, opts?: {
    ttlSeconds?: number;
    responseContentDisposition?: string;
    cacheControl?: string;
  }): Promise<string> {
    const ttl = opts?.ttlSeconds ?? this.ttlSeconds;
    const window = Math.ceil(ttl / 4);
    const signedAt = new Date(Math.floor(Date.now() / (window * 1000)) * window * 1000);
    const cmd = new GetObjectCommand({
      Bucket: this.bucket,
      Key: this.objectKey(key),
      // Content-Type 由 key 扩展名推导（put 已写入，presign 覆盖为权威值）
      ResponseContentType: mimeByExt(extOfName(key)),
      ...(opts?.responseContentDisposition
        ? { ResponseContentDisposition: opts.responseContentDisposition }
        : {}),
      ...(opts?.cacheControl ? { ResponseCacheControl: opts.cacheControl } : {}),
    });
    return getSignedUrl(this.client, cmd, { expiresIn: ttl + window, signingDate: signedAt });
  }

  /** 预签名 PUT（直传）；TTL 沿用 signed_url_ttl_seconds，无缓存诉求，不做窗口对齐 */
  async presignPut(key: string, opts?: { contentType?: string }): Promise<string> {
    const cmd = new PutObjectCommand({
      Bucket: this.bucket,
      Key: this.objectKey(key),
      ...(opts?.contentType ? { ContentType: opts.contentType } : {}),
    });
    return getSignedUrl(this.client, cmd, { expiresIn: this.ttlSeconds });
  }

  /** 同 bucket 服务端复制（直传 staging → 内容寻址 key 的提升步骤） */
  async copy(fromKey: string, toKey: string): Promise<void> {
    await this.client.send(new CopyObjectCommand({
      Bucket: this.bucket,
      // CopySource 形如 /bucket/key，key 需 URL 编码（对象名可含特殊字符）
      CopySource: `/${this.bucket}/${encodeURIComponent(this.objectKey(fromKey))}`,
      Key: this.objectKey(toKey),
    }));
  }

  /** 启动探测（业务规则 10）：HeadBucket 校验端点连通性与凭据；失败即启动失败 */
  async probe(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch (err: unknown) {
      const meta = (err as { $metadata?: { httpStatusCode?: number } }).$metadata;
      throw new Error(
        `Storage backend s3 probe failed (endpoint=${this.endpoint}, bucket=${this.bucket}, `
        + `status=${meta?.httpStatusCode ?? "n/a"}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

/** HeadObject 404 的双形态：SDK 错误名 NotFound 或 HTTP 404（各网关实现不一） */
function isNotFoundError(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === "NotFound" || e?.$metadata?.httpStatusCode === 404;
}
