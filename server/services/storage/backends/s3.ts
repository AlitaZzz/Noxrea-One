/**
 * S3 兼容对象存储后端（specs/storage-s3-backend.md 业务规则 2/3/4/9/10；
 * 提供方差异见 specs/storage-provider-portability.md）。
 * 基于 @aws-sdk/client-s3，适配 MinIO / Cloudflare R2 / 各云 S3 网关：
 * - put/get/stat/delete/list 对齐 StorageBackend 接口语义，delete 含规则 9 派生联动；
 * - 预签名 GET/PUT 支撑浏览器直连、直传与媒体工具输入；GET 的签名时间对齐到
 *   逐调用窗口（缺省 TTL/4，浏览器读路径用 `PRESIGNED_READ_WINDOW_SECONDS`）
 *   的 epoch 绝对边界，同窗口签出字节一致的 URL；URL 寿命 = TTL，窗口只决定
 *   稳定期（specs/storage-signed-direct-delivery.md 规则 4.2）；
 * - 校验和策略固定 `WHEN_REQUIRED`、寻址风格由 provider profile 决定并显式传入
 *   `forcePathStyle`（不做 SDK 推断），厂商差异止于 profile 与启动探测；
 * - `storage.s3.prefix` 作为对象 key 统一前缀在内部映射，接口层 key 不含前缀。
 * 错误面：对象不存在统一收敛为 stat → null / delete → 成功（对象存储语义）；
 * 其余 S3 错误原样上抛由调用方映射——写失败明确报错，禁止静默降级（spec 异常边界）。
 */

import { Readable } from "stream";
import { pipeline } from "stream/promises";
import fs from "fs/promises";
import { randomUUID } from "crypto";
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
import {
  isKeyWithinNamespace,
  listDerivedArtifactKeys,
  PROBE_ROOT_PREFIX,
  StorageTraversalError,
  type StorageBackend,
  type StorageProbeReport,
} from "@server/services/storage/backend";
import { allocateTempPath, tmpDir } from "@server/services/storage/workspace";
import { rmQuiet } from "@server/services/storage/fs-utils";
import { extOfName, mimeByExt } from "@server/services/storage/mime";
import {
  addressingCandidates,
  baselineCapabilities,
  type AddressingStyle,
  type StorageCapabilities,
  type StorageProvider,
} from "@server/services/storage/providers";
import { presignedWindow } from "@server/services/storage/signing";

/** bucket 统一前缀归一化（去首尾斜杠）：前缀映射函数与后端构造共用单一实现 */
export function normalizeS3Prefix(prefix: string): string {
  return prefix.replace(/^\/+|\/+$/g, "");
}

/** 接口层 key → 带 bucket 统一前缀的对象 key（类与迁移脚本共用；前缀先归一化） */
export function applyS3Prefix(prefix: string, key: string): string {
  const p = normalizeS3Prefix(prefix);
  return p ? `${p}/${key}` : key;
}

/** 带 bucket 统一前缀的对象 key → 接口层 key（仅本后端内部使用；前缀先归一化） */
function stripS3Prefix(prefix: string, objectKey: string): string {
  const p = normalizeS3Prefix(prefix);
  if (!p) return objectKey;
  return objectKey.startsWith(`${p}/`) ? objectKey.slice(p.length + 1) : objectKey;
}

/** 连接四要素（后端构造与迁移脚本的裸客户端共用，见 createS3Client） */
export interface S3ConnectionOptions {
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export interface S3BackendOptions extends S3ConnectionOptions {
  bucket: string;
  /** provider profile：唯一决定寻址风格候选与能力基线（业务代码不读它，只读能力位） */
  provider: StorageProvider;
  prefix: string;
  /** 预签名有效期（秒）：URL 自身可用时长 */
  signedUrlTtlSeconds: number;
  /**
   * 浏览器访问本站的来源（`network.public_base_url` 的 scheme+host）。
   *
   * CORS 是「按来源放行」的：探测必须拿真实站点来源去问，白名单式 bucket 才会
   * 回显它。缺省（未配置公开地址）退回探测专用假域名，此时只有通配放行才能通过
   * ——探测会就此输出警告说明判定口径。
   */
  browserOrigin?: string;
}

/**
 * S3 SDK 的连接与空闲超时：@smithy 两项缺省都是 0（不限），端点黑洞（丢包而非拒绝）
 * 会让调用永不返回。
 *
 * 两档，按用途分而不是按调用点分：
 * - **运行期**（`createS3Client` 缺省）：连接 10s、空闲 5 分钟。空闲上限要容纳大文件
 *   上传的慢链路——它是「多久没有数据流动」而不是总时长，持续有数据流动时不会触发。
 * - **探测期**（`createProbeS3Client`）：连接 5s、空闲 15s。探测对象只有 1KB，任何
 *   正常的对象存储都在毫秒级完成；探测还串联着六项检查，逐项都按运行期上限等一遍
 *   会让一次黑洞端点的启动耗时叠加到分钟级，掩盖「到底卡在哪一项」。
 */
const S3_CONNECT_TIMEOUT_MS = 10_000;
const S3_SOCKET_IDLE_TIMEOUT_MS = 300_000;
const PROBE_S3_CONNECT_TIMEOUT_MS = 5_000;
const PROBE_S3_SOCKET_IDLE_TIMEOUT_MS = 15_000;
/** SDK 缺省重试次数：运行期保留（瞬时抖动不该冒到业务层），探测期关掉（见 createProbeS3Client） */
const S3_MAX_ATTEMPTS = 3;

/** S3 客户端配置的公共部分：校验和、超时与重试策略（两条组装路径共用，口径不会分叉） */
function s3ClientConfig(
  connection: S3ConnectionOptions,
  addressing: AddressingStyle,
  timeouts: { connect: number; socket: number },
  maxAttempts: number,
): NonNullable<ConstructorParameters<typeof S3Client>[0]> {
  return {
    endpoint: connection.endpoint,
    region: connection.region,
    credentials: {
      accessKeyId: connection.accessKeyId,
      secretAccessKey: connection.secretAccessKey,
    },
    forcePathStyle: addressing === "path",
    // 校验和两向固定 `WHEN_REQUIRED`（规则 2.1）：SDK 缺省 `WHEN_SUPPORTED` 会给
    // PutObject/CopyObject 附加厂商不一定实现的 `x-amz-checksum-*`，而本项目从不
    // 消费 SDK 的完整性校验结果（对象身份是本地 sha256，迁移校验有自己的降级矩阵）
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    maxAttempts,
    requestHandler: { connectionTimeout: timeouts.connect, socketTimeout: timeouts.socket },
  };
}

/**
 * S3 客户端组装单一来源（后端运行期与迁移脚本共用）：寻址风格**显式**传入，
 * 不依赖 SDK 对自定义端点的推断（规则 1.4）。超时见上方两档说明。
 */
export function createS3Client(
  connection: S3ConnectionOptions,
  addressing: AddressingStyle,
): S3Client {
  return new S3Client(
    s3ClientConfig(
      connection,
      addressing,
      { connect: S3_CONNECT_TIMEOUT_MS, socket: S3_SOCKET_IDLE_TIMEOUT_MS },
      // SDK 缺省的 3 次重试是运行期要的（瞬时抖动不该冒到业务层）
      S3_MAX_ATTEMPTS,
    ),
  );
}

/**
 * 启动探测专用客户端（规则 3.1）：与运行期同一份配置，只把超时收紧到探测量级。
 * 探测的六项检查各自都是一次小请求，任何一项卡住都必须在启动阶段快速暴露。
 */
function createProbeS3Client(
  connection: S3ConnectionOptions,
  addressing: AddressingStyle,
): S3Client {
  return new S3Client(
    s3ClientConfig(
      connection,
      addressing,
      { connect: PROBE_S3_CONNECT_TIMEOUT_MS, socket: PROBE_S3_SOCKET_IDLE_TIMEOUT_MS },
      // 探测不重试：启动阶段的结论要的是「现在能不能用」，重试只会把一次黑洞
      // 端点的等待乘上重试次数（默认 3 次），而失败信息已经带阶段名，人工重跑即可
      1,
    ),
  );
}

/** 寻址风格的可读 URL 形态：探测失败信息必须能区分两种尝试（规则 1.6） */
export function addressingUrlShape(
  endpoint: string,
  bucket: string,
  addressing: AddressingStyle,
): string {
  const url = new URL(endpoint);
  return addressing === "path"
    ? `${url.origin}/${bucket}/<key>`
    : `${url.protocol}//${bucket}.${url.host}/<key>`;
}

/**
 * 探测用裸 HTTP 请求的唯一出口：只负责超时。
 *
 * 超时是硬要求——这些请求不走 SDK，undici 的缺省上界（5 分钟且只到响应头）足以
 * 把一次黑洞端点的 bootstrap 拖成事实上的永久挂起。
 *
 * `Origin` 不在这里加：它是 CORS 探测的**被测输入**，不是所有探测的公共头。
 * 给覆盖头探测也带上它，会让「端点是否响应带 Origin 的请求」混进覆盖头的结论。
 */
function probeFetch(url: string, init?: RequestInit): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(PROBE_HTTP_TIMEOUT_MS) });
}

export class S3Backend implements StorageBackend {
  /** 构造时按 provider 首个候选寻址创建；`generic` 的探测可在候选间切换 */
  private client: S3Client;
  private readonly connection: S3ConnectionOptions;
  private readonly candidates: readonly AddressingStyle[];
  private readonly bucket: string;
  /** 对象 key 统一前缀（bucket 复用）；空串表示直接用 bucket 根 */
  private readonly prefix: string;
  private readonly ttlSeconds: number;
  private readonly provider: StorageProvider;
  /**
   * 能力位：构造时取 profile 基线，探测完成后整体覆盖。构造函数即给出可用口径，
   * 使「被注入、未探测」的后端（单测、脚本）行为确定。
   */
  private caps: StorageCapabilities;
  /** 端点仅用于启动探测失败时的诊断输出，不参与签名 */
  readonly endpoint: string;
  /** CORS 探测用的浏览器来源（见 `S3BackendOptions.browserOrigin`） */
  private readonly probeOrigin: string;
  /** 是否拿到了部署自己的来源：未配置时探测只能验证通配放行，须在结论里说明 */
  private readonly browserOriginConfigured: boolean;

  constructor(opts: S3BackendOptions) {
    this.endpoint = opts.endpoint;
    this.bucket = opts.bucket;
    this.prefix = normalizeS3Prefix(opts.prefix);
    this.ttlSeconds = opts.signedUrlTtlSeconds;
    this.provider = opts.provider;
    this.probeOrigin = opts.browserOrigin ?? PROBE_ORIGIN;
    this.browserOriginConfigured = opts.browserOrigin !== undefined;
    this.connection = {
      endpoint: opts.endpoint,
      region: opts.region,
      accessKeyId: opts.accessKeyId,
      secretAccessKey: opts.secretAccessKey,
    };
    this.candidates = addressingCandidates(opts.provider);
    this.caps = baselineCapabilities(opts.provider);
    this.client = createS3Client(this.connection, this.caps.addressing);
  }

  /** 能力位（只读副本：调用方不能改写进程级不变量） */
  capabilities(): StorageCapabilities {
    return { ...this.caps };
  }

  /**
   * 接口层 key → 带前缀的对象 key。形态守卫与读管线共用 isKeyWithinNamespace：
   * 脏 key 永不写入、也永不寻址，抛 StorageTraversalError 由路由层映射 403。
   */
  private objectKey(key: string): string {
    if (!isKeyWithinNamespace(key)) throw new StorageTraversalError(key);
    return applyS3Prefix(this.prefix, key);
  }

  private stripPrefix(objectKey: string): string {
    return stripS3Prefix(this.prefix, objectKey);
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
    // 规则 9：派生联动覆盖四命名空间（枚举半边为接口级共享实现，specs/derived-deletion-linkage.md；
    // 对象存储无空目录概念，逐对象删除即可）
    for (const derived of await listDerivedArtifactKeys(this, key)) {
      await this.deleteObject(derived);
    }
  }

  private async deleteObject(key: string): Promise<void> {
    // S3 DeleteObject 对不存在的 key 同样返回 2xx，「不存在视为成功」天然成立
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: this.objectKey(key) }));
  }

  /** ListObjectsV2 分页力学单点（list / listCommonPrefixes 共用）：逐页收集对象与子前缀 */
  private async collectPages(prefix: string, delimiter?: string): Promise<{
    objects: Array<{ key: string; size: number; lastModifiedMs: number }>;
    prefixes: string[];
  }> {
    const objects: Array<{ key: string; size: number; lastModifiedMs: number }> = [];
    const prefixes: string[] = [];
    const fullPrefix = this.objectKey(prefix);
    let token: string | undefined;
    do {
      const res = await this.client.send(new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: fullPrefix,
        ...(delimiter ? { Delimiter: delimiter } : {}),
        MaxKeys: 1000,
        ...(token ? { ContinuationToken: token } : {}),
      }));
      for (const obj of res.Contents ?? []) {
        if (!obj.Key) continue;
        objects.push({
          key: this.stripPrefix(obj.Key),
          size: obj.Size ?? 0,
          lastModifiedMs: obj.LastModified ? obj.LastModified.getTime() : 0,
        });
      }
      for (const cp of res.CommonPrefixes ?? []) {
        if (cp.Prefix) prefixes.push(this.stripPrefix(cp.Prefix));
      }
      token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token);
    return { objects, prefixes };
  }

  async list(prefix: string): Promise<Array<{ key: string; size: number; lastModifiedMs: number }>> {
    return (await this.collectPages(prefix)).objects;
  }

  /**
   * 子前缀列举能力（specs/derived-deletion-linkage.md 规则 2）：Delimiter 一层列举
   * （CommonPrefixes，含查询前缀与尾随 /），派生删除联动的版本段发现是其唯一消费方。
   */
  async listCommonPrefixes(prefix: string): Promise<string[]> {
    return (await this.collectPages(prefix, "/")).prefixes;
  }

  /**
   * 预签名 GET（浏览器读路径的长窗口与能力凭据的缺省窗口见
   * specs/storage-signed-direct-delivery.md 规则 4.2 / 4.6）：
   * 签名时间对齐到 `windowSeconds` 的 **epoch 绝对边界**——同窗口内所有实例、所有请求签出
   * 字节一致的 URL，缓存键因此稳定（浏览器 `immutable` 缓存、进程内以 URL 为键的探测缓存
   * 都依赖这一点）。`expiresIn = ttl`：URL 寿命即 TTL，实际剩余有效期落在 `[ttl - window, ttl]`。
   *
   * 窗口缺省 `ceil(ttl / 4)`：能力型凭据（上游拉取、媒体工具输入）沿用既有对齐窗口，
   * 既保持 URL 在进程内可作缓存键，又不把有效期抬到浏览器读路径的量级。
   * 浏览器读路径（描述接口）显式传 `PRESIGNED_READ_WINDOW_SECONDS`（长窗口 = 长稳定期）。
   *
   * `response-*` 覆盖按能力位使用（specs/storage-provider-portability.md 规则 4.2）：
   * 端点不遵守覆盖时不带这些参数——对象自身的 Content-Type 在 PutObject 时已写入，
   * 展示无需覆盖；需要自定义附件名/缓存语义的场景由调用方改走 `stream`。
   */
  async presignGet(key: string, opts?: {
    ttlSeconds?: number;
    windowSeconds?: number;
    responseContentDisposition?: string;
    cacheControl?: string;
  }): Promise<string> {
    return this.signGet(key, opts, this.caps.responseOverrides);
  }

  /**
   * 探测回读用签址（规则 3.3）：**不带** `response-*`。
   * 回读项断言的是对象自身的 Content-Type；若带上覆盖，端点回显的正是覆盖值，
   * 断言会退化成同义反复，覆盖头是否生效也就测不出来了（那是 3.4 的职责）。
   */
  private presignProbeRead(key: string): Promise<string> {
    return this.signGet(key, undefined, false);
  }

  /** 探测覆盖头用签址（规则 3.4）：**带** `response-*`——被测对象就是覆盖是否生效 */
  private presignProbeOverrides(key: string): Promise<string> {
    return this.signGet(key, {
      responseContentDisposition: 'attachment; filename="probe.txt"',
      cacheControl: "private, max-age=60",
    }, true);
  }

  private async signGet(key: string, opts: {
    ttlSeconds?: number;
    windowSeconds?: number;
    responseContentDisposition?: string;
    cacheControl?: string;
  } | undefined, withOverrides: boolean): Promise<string> {
    const ttl = opts?.ttlSeconds ?? this.ttlSeconds;
    const window = opts?.windowSeconds ?? Math.ceil(ttl / 4);
    // 签名时刻与客户端描述窗口同源于 presignedWindow：参数守卫（规则 4.6）只在那里
    // 执行一次，本处消费其 issuedAt——两处各算一遍时刻会把「URL 与描述窗口必须同窗」
    // 的约束重新拆成两份可以漂移的实现
    const signedAt = new Date(presignedWindow(ttl, window).issuedAt * 1000);
    const cmd = new GetObjectCommand({
      Bucket: this.bucket,
      Key: this.objectKey(key),
      // Content-Type 由 key 扩展名推导（put 已写入，presign 覆盖为权威值）
      ...(withOverrides
        ? { ResponseContentType: mimeByExt(extOfName(key)) }
        : {}),
      ...(withOverrides && opts?.responseContentDisposition
        ? { ResponseContentDisposition: opts.responseContentDisposition }
        : {}),
      ...(withOverrides && opts?.cacheControl
        ? { ResponseCacheControl: opts.cacheControl }
        : {}),
    });
    // expiresIn 只取 TTL（不从窗口起点额外延长）：URL 寿命 = TTL，
    // 窗口只决定「同窗口内签出同一 URL」的稳定期（规则 4.2）
    return getSignedUrl(this.client, cmd, { expiresIn: ttl, signingDate: signedAt });
  }

  /** 预签名 PUT（直传）；TTL 用后端装配的 `ttlSeconds`（= `CAPABILITY_URL_TTL_SECONDS`，与浏览器读路径的 4h 无关），无缓存诉求，不做窗口对齐 */
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

  /**
   * 启动探测（specs/storage-provider-portability.md 规则 3）：连通（HeadBucket）→
   * 写 → 回读字节一致 → stat → 预签名 GET 回读 → 覆盖头 → 删除探测对象。
   * 任一致命项失败即启动失败；CORS 与时钟警告只记录。
   */
  async probe(): Promise<StorageProbeReport> {
    const attempts: string[] = [];
    for (const addressing of this.candidates) {
      const client = createProbeS3Client(this.connection, addressing);
      try {
        await client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      } catch (err: unknown) {
        attempts.push(
          `${addressing}（${addressingUrlShape(this.endpoint, this.bucket, addressing)}）→ ${describeS3Error(err)}`,
        );
        continue;
      }
      // 连通性确认后才切换客户端：非寻址类失败不做风格重试——那是配置问题，
      // 换一种寻址只会把真实原因埋进第二个错误里
      this.client = client;
      this.caps = { ...this.caps, addressing };
      try {
        return await this.runCapabilityProbe();
      } finally {
        // 探测结束切回运行期客户端：探测档的短超时（15s 空闲）不该留给大文件传输
        this.client = createS3Client(this.connection, addressing);
      }
    }
    // 全部候选失败：两种寻址各自的 URL 形态与 HTTP 状态都必须出现在错误里（规则 1.6）
    throw new Error(
      `Storage backend s3 probe failed at connect: bucket ${this.bucket} 在 ${attempts.length} 种寻址下均不可达 `
      + `(endpoint=${this.endpoint}, provider=${this.provider}); attempts: ${attempts.join(" | ")}`,
    );
  }

  /** 寻址确认后的能力探测（规则 3.1 的第 2–7 项） */
  private async runCapabilityProbe(): Promise<StorageProbeReport> {
    const warnings: string[] = [];
    const probeKey = `${PROBE_ROOT_PREFIX}${randomUUID()}.txt`;
    // 1KB 定长载荷：既是写权限探测，也是字节一致性与 Content-Type 的比对基准
    const payload = Buffer.from(
      `noxrea storage probe ${probeKey}\n`.padEnd(PROBE_PAYLOAD_BYTES, "."),
      "utf8",
    );
    const expectedMime = mimeByExt(extOfName(probeKey));

    try {
      await this.step("write", "PutObject 被拒（HeadBucket 已通过，端点与凭据本身正常）", () =>
        this.put(probeKey, payload));

      const readBack = await this.step("read", "GetObject 失败", async () =>
        collectStream(await this.get(probeKey)));
      if (!readBack.equals(payload)) {
        throw this.probeError("read", `回读字节与写入不一致（${readBack.length} vs ${payload.length} 字节）`);
      }

      const stat = await this.step("stat", "HeadObject 失败", () => this.stat(probeKey));
      if (!stat || stat.size !== payload.length) {
        throw this.probeError("stat", `对象大小为 ${stat?.size ?? "null"}，期望 ${payload.length}`);
      }

      // 预签名回读（规则 3.3）：与业务同一路径签址，无凭据 HTTP GET 取回。
      // 带 Origin 发起——这正是浏览器的请求形态，3.5 的 CORS 判定复用同一响应
      // （不带 Origin 时端点不会回 `Access-Control-Allow-Origin`，CORS 会假阴性）。
      // origin 与预检同源（`probeOrigin`），两处比较的必须是同一个值
      const signedUrl = await this.step("presign_sign", "预签名 URL 生成失败", () =>
        this.presignProbeRead(probeKey));
      const readResponse = await this.step("presign_read", "预签名 URL 请求失败", () =>
        probeFetch(signedUrl, { headers: { Origin: this.probeOrigin } }));
      if (readResponse.status !== 200) {
        throw this.probeError("presign_read", `HTTP ${readResponse.status}（签名参数或时钟偏差不符）`);
      }
      const fetched = Buffer.from(await readResponse.arrayBuffer());
      if (!fetched.equals(payload)) {
        throw this.probeError("presign_read", `回读字节与写入不一致（${fetched.length} vs ${payload.length} 字节）`);
      }
      const contentType = (readResponse.headers.get("content-type") ?? "").split(";")[0].trim();
      if (contentType !== expectedMime) {
        throw this.probeError("presign_read", `Content-Type=${contentType || "(空)"}，期望 ${expectedMime}`);
      }

      // 时钟（规则 3.6）：用回读响应的 Date 头
      const clockSkewSeconds = clockSkewSecondsOf(readResponse.headers.get("date"), Date.now());
      if (clockSkewSeconds === null) {
        warnings.push("回读响应缺少可解析的 Date 头，时钟偏差未能校验");
      } else if (Math.abs(clockSkewSeconds) > CLOCK_SKEW_FAIL_SECONDS) {
        throw this.probeError(
          "clock",
          `端点与本机相差 ${clockSkewSeconds}s，超过 ${CLOCK_SKEW_FAIL_SECONDS}s（SigV4 容差 15 分钟，多实例签名会时好时坏）`,
        );
      } else if (Math.abs(clockSkewSeconds) > CLOCK_SKEW_WARN_SECONDS) {
        warnings.push(`端点时钟偏差 ${clockSkewSeconds}s（超过 ${CLOCK_SKEW_WARN_SECONDS}s）`);
      }

      const overrides = await this.step("response_overrides", "覆盖头验证请求失败", () =>
        this.probeResponseOverrides(probeKey));
      if (!overrides.supported) {
        warnings.push(`覆盖头探测未通过（${overrides.detail}）：下载形态降级为 stream`);
      }

      // 跨域（规则 3.5）：只警告不失败——缺陷面仅限浏览器读图，硬失败会让整站不可用
      const browserCors = await this.probeBrowserCors(signedUrl, readResponse.headers, warnings);

      this.caps = {
        addressing: this.caps.addressing,
        responseOverrides: overrides.supported,
        browserCors,
      };
      return {
        provider: this.provider,
        capabilities: this.capabilities(),
        clockSkewSeconds: clockSkewSeconds ?? 0,
        warnings,
      };
    } finally {
      // 尽力删除（规则 3.2）：该命名空间不在可读键域内，残留由 GC 的 `_probe/` 按龄清扫回收
      await this.delete(probeKey).catch((err: unknown) => {
        warnings.push(`探测对象删除失败（残留交存储 GC 处理）：${describeS3Error(err)}`);
      });
    }
  }

  /** 覆盖头验证（规则 3.4）：带 response-* 再签一次，确认响应确实携带这两个头 */
  private async probeResponseOverrides(
    probeKey: string,
  ): Promise<{ supported: boolean; detail: string }> {
    const url = await this.presignProbeOverrides(probeKey);
    let res: Response;
    try {
      res = await probeFetch(url);
    } catch (err: unknown) {
      // 传输层故障按「不支持」降级：该能力位只决定下载形态（规则 4.2），
      // 不构成启动失败；回读与 HeadBucket 已在前面的致命项里验证过连通性
      return {
        supported: false,
        detail: `带覆盖参数的签名 GET 请求失败：${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (res.status !== 200) {
      return { supported: false, detail: `带覆盖参数的签名 GET 返回 HTTP ${res.status}` };
    }
    const disposition = res.headers.get("content-disposition") ?? "";
    const cacheControl = res.headers.get("cache-control") ?? "";
    const missing: string[] = [];
    if (!disposition.includes("probe.txt")) missing.push(`Content-Disposition=${disposition || "(空)"}`);
    if (!cacheControl.includes("max-age=60")) missing.push(`Cache-Control=${cacheControl || "(空)"}`);
    return missing.length === 0
      ? { supported: true, detail: "两项覆盖均生效" }
      : { supported: false, detail: missing.join(", ") };
  }

  /**
   * 跨域探测（规则 3.5）：预检 + GET 响应头；结果只写能力位与警告。
   *
   * 判定按 CORS 的回显语义：端点对**请求里给出的** `Origin` 回显同一值（或回 `*`）
   * 即视为放行。origin 取部署自己的浏览器来源（`network.public_base_url` 的源），
   * 不取探测专用假域名——白名单式配置只会放行真实站点，拿假域名去问必然得到
   * 「未放行」，能力位恒假。未配置公开地址时才退回哨兵值，此时只能验证 `*`。
   */
  private async probeBrowserCors(
    signedUrl: string,
    getHeaders: Headers,
    warnings: string[],
  ): Promise<boolean> {
    /** 响应是否放行了探测 origin：回 `*` 或回显请求值 */
    const allowedFor = (headers: Headers): boolean => {
      const allowOrigin = headers.get("access-control-allow-origin");
      return allowOrigin === "*" || allowOrigin === this.probeOrigin;
    };
    const getAllowed = allowedFor(getHeaders);
    let preflightAllowed = false;
    try {
      const preflight = await probeFetch(signedUrl, {
        method: "OPTIONS",
        headers: {
          Origin: this.probeOrigin,
          "Access-Control-Request-Method": "GET",
        },
      });
      preflightAllowed = allowedFor(preflight.headers);
    } catch (err: unknown) {
      warnings.push(`CORS 预检请求失败：${err instanceof Error ? err.message : String(err)}`);
    }
    if (!getHeaders.get("access-control-expose-headers")) {
      warnings.push("签名 GET 响应缺少 Access-Control-Expose-Headers（浏览器读不到 Content-Length / Range 等头）");
    }
    if (!this.browserOriginConfigured) {
      warnings.push(
        `未配置 network.public_base_url：CORS 只能用探测源 ${PROBE_ORIGIN} 验证「通配放行」，`
        + "白名单式配置会被判为未放行。配置公开地址后重启即可按真实来源判定",
      );
    }
    if (!getAllowed || !preflightAllowed) {
      warnings.push(
        `bucket 未对浏览器来源放行（origin=${this.probeOrigin}，GET=${getAllowed ? "放行" : "未放行"}，`
        + `预检=${preflightAllowed ? "放行" : "未放行"}）：浏览器读图会失败，须按 README 配置 bucket CORS`,
      );
    }
    return getAllowed && preflightAllowed;
  }

  /** 探测阶段的 SDK 调用统一包装：错误信息带阶段名与诊断字段（规则 3.1） */
  private async step<T>(stage: string, hint: string, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (err: unknown) {
      throw this.probeError(stage, `${hint}: ${describeS3Error(err)}`);
    }
  }

  private probeError(stage: string, detail: string): Error {
    return new Error(
      `Storage backend s3 probe failed at ${stage}: ${detail} `
      + `(endpoint=${this.endpoint}, bucket=${this.bucket}, provider=${this.provider}, `
      + `addressing=${this.caps.addressing})`,
    );
  }
}

/** 探测对象载荷大小（命名空间见 backend.ts `PROBE_ROOT_PREFIX`） */
const PROBE_PAYLOAD_BYTES = 1024;
/** CORS 探测来源：与任何真实部署不相交，只看桶是否按配置回显/放行 */
const PROBE_ORIGIN = "https://probe.noxrea.invalid";
/**
 * 探测的裸 HTTP 请求（预签名回读 / 覆盖头 / 预检）超时：这些请求不走 SDK，
 * 而 undici 的缺省 headers/body 超时是 5 分钟且只覆盖到响应头与空闲，端点黑洞时
 * 足以把 bootstrap 拖成事实上的永久挂起。探测请求对象只有 1KB，给一个启动能接受的上界。
 */
const PROBE_HTTP_TIMEOUT_MS = 10_000;
/** 时钟偏差阈值（规则 3.6）：SigV4 容差 15 分钟，硬失败取 3 倍余量 */
const CLOCK_SKEW_FAIL_SECONDS = 5 * 60;
const CLOCK_SKEW_WARN_SECONDS = 60;

/** 端点 Date 头 → 本机时钟偏差（秒，正数表示端点更快）；缺失或不可解析返回 null */
export function clockSkewSecondsOf(dateHeader: string | null, nowMs: number): number | null {
  if (!dateHeader) return null;
  const serverMs = Date.parse(dateHeader);
  if (Number.isNaN(serverMs)) return null;
  return Math.round((serverMs - nowMs) / 1000);
}

/** SDK 错误的人类可读形态（含 HTTP 状态；SDK 错误信息不含凭据） */
function describeS3Error(err: unknown): string {
  const status = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
  const name = (err as { name?: string })?.name ?? "Error";
  const message = err instanceof Error ? err.message : String(err);
  return `${status ? `HTTP ${status} ` : ""}${name}: ${message}`;
}

/** Node Readable → Buffer（探测载荷只有 1KB） */
function collectStream(stream: Readable): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

/** HeadObject 404 的双形态：SDK 错误名 NotFound 或 HTTP 404（各网关实现不一） */
function isNotFoundError(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === "NotFound" || e?.$metadata?.httpStatusCode === 404;
}
