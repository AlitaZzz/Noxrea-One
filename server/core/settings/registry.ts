/**
 * 系统设置注册表：键集合、校验规则与默认值的唯一定义（specs/system-settings-db.md）。
 * 启动时按此表把缺失的键以默认值写入 system_settings；值统一以规范化文本存储。
 */
import { z } from "zod";
import { isValidTrustedProxyCidrs } from "@server/core/ratelimit/client-ip";

interface SettingDef<T> {
  readonly schema: z.ZodType<T, z.ZodTypeDef, unknown>;
  readonly default: T;
}

const bool = (value: boolean): SettingDef<boolean> => ({
  schema: z.enum(["true", "false"]).transform((v) => v === "true"),
  default: value,
});

// 数值只接受规范化的十进制文本：z.coerce.number() 会把空串 / 空白当成 0、把 "Infinity" 当成有效值，
// 与「非法值启动失败」相悖，因此先校验文本形态，再转数字并校验取值范围
const INT_TEXT = /^\d+$/;
const DECIMAL_TEXT = /^\d+(\.\d+)?$/;

const int = (value: number, min = 1, max = Number.MAX_SAFE_INTEGER): SettingDef<number> => ({
  schema: z
    .string()
    .regex(INT_TEXT, "must be an integer written as plain digits")
    .transform(Number)
    .pipe(z.number().int().safe().min(min).max(max)),
  default: value,
});

const positive = (value: number, max: number): SettingDef<number> => ({
  schema: z
    .string()
    .regex(DECIMAL_TEXT, "must be a number written as plain digits with an optional fraction")
    .transform(Number)
    .pipe(z.number().finite().positive().max(max)),
  default: value,
});

/**
 * 换算成定时器延迟的时长上限：1 天。系统内的超时、轮询间隔、等待时限都远低于此；
 * 同时保证代码里的倍数换算（如排空时限 ×3、轮询退避 ×2）仍远小于 Node 定时器上限
 * 2^31-1 ms（约 24.8 天）——超出该上限时 setTimeout 不报错，而是把延迟改成 1ms。
 */
const MAX_TIMER_SECONDS = 24 * 60 * 60;

/** 配额 MB 上限：换算字节后仍在 Number 安全域（MB × 1024² ≤ MAX_SAFE_INTEGER） */
const MAX_QUOTA_MB = Math.floor(Number.MAX_SAFE_INTEGER / 1024 ** 2);

/** 用作定时器延迟的秒数；integer 为 true 时只接受整数秒 */
const timerSeconds = (value: number, { integer = false } = {}): SettingDef<number> =>
  integer ? int(value, 1, MAX_TIMER_SECONDS) : positive(value, MAX_TIMER_SECONDS);

const text = (value = ""): SettingDef<string> => ({
  schema: z.string(),
  default: value,
});

const isHttpUrl = (value: string): boolean => {
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
};

/** 留空表示未配置；非空必须是 http(s) URL，错误在启动期暴露而不是首次出站请求时 */
const httpUrlOrEmpty = (): SettingDef<string> => ({
  schema: z.string().refine((v) => v === "" || isHttpUrl(v), "must be empty or an http(s) URL"),
  default: "",
});

const cidrList = (): SettingDef<string> => ({
  schema: z.string().refine(isValidTrustedProxyCidrs, "must be comma-separated IP/CIDR values"),
  default: "",
});

/** 枚举文本设置（后端选择、分发模式等有限值域） */
const enumText = <T extends string>(values: readonly T[], value: T): SettingDef<T> => ({
  schema: z.enum(values as [T, ...T[]]),
  default: value,
});

export const SETTING_DEFS = {
  // 认证
  "auth.registration_enabled": bool(true),
  "auth.token_ttl_minutes": int(1440),

  // 网络
  /** 可信反向代理网段（逗号分隔 IP/CIDR）；只有直连 peer 命中时才解析 X-Forwarded-For */
  "network.trusted_proxy_cidrs": cidrList(),
  /** SSRF 防护放行的内网主机（逗号分隔），留空表示禁止访问内网 */
  "network.ssrf_allowed_internal_hosts": text(),
  "network.outbound_proxy_enabled": bool(false),
  "network.outbound_proxy_url": httpUrlOrEmpty(),
  /** 对外可访问的服务根地址；local 后端 signed-url 交付（上游引用签名 URL）的拼接基址，未配置时签名明确失败 */
  "network.public_base_url": httpUrlOrEmpty(),

  // 上传（批次总大小上限 UPLOAD_BATCH_MAX_MB 与 Next 代理层共用，保留在 env）
  "upload.max_file_mb": int(100),
  "upload.batch_max_files": int(20),
  /** 单个用户同时处理的上传批次数 */
  "upload.batch_max_concurrent": int(1),
  /** 单个用户上传批次等待队列深度上限；超额立即 429 */
  "upload.batch_max_pending": int(10),
  // 媒体处理并发门（specs/media-processing-concurrency.md）：
  // ffmpeg 重型 / ffmpeg 轻型 / sharp 三个独立池，重型池两级准入（个人名额 → 全局槽位）
  /** 全站同时运行的重型 ffmpeg 任务数（整段解码 / 重编码，所有用户合计） */
  "media.ffmpeg_heavy_max_concurrency": int(2),
  /** 全站重型任务排队上限（已拿到个人名额、在等全局槽位的请求） */
  "media.ffmpeg_heavy_max_pending": int(4, 0),
  /** 重型请求从到达到开始运行的最长等待（个人排队与全局排队合计，秒） */
  "media.ffmpeg_heavy_max_wait_seconds": timerSeconds(60),
  /** 每个用户同时运行的重型任务数；大于等于全局上限时个人限额失去作用 */
  "media.ffmpeg_heavy_user_max_concurrency": int(1),
  /** 每个用户在个人队列里排队的重型请求数上限 */
  "media.ffmpeg_heavy_user_max_pending": int(2, 0),
  /** 全站同时运行的轻型 ffmpeg 任务数（海报母版、截帧、流拷贝） */
  "media.ffmpeg_light_max_concurrency": int(2),
  /** 全站轻型任务排队上限 */
  "media.ffmpeg_light_max_pending": int(16, 0),
  /** 轻型任务的最长排队时间（秒） */
  "media.ffmpeg_light_max_wait_seconds": timerSeconds(10),
  /** 同时运行的受控 sharp 缩放任务数上限 */
  "media.sharp_max_concurrency": int(2),
  /** sharp 缩放的排队上限 */
  "media.sharp_max_pending": int(64, 0),
  /** sharp 缩放的最长排队时间（秒） */
  "media.sharp_max_wait_seconds": timerSeconds(10),

  // Worker（specs/task-queue-bullmq.md：派发由 BullMQ 驱动，无进程内轮询间隔键）
  "worker.max_concurrency": int(10),
  "worker.api_timeout_seconds": timerSeconds(240, { integer: true }),
  /** 租约判定阈值（分钟）：执行段经心跳/闸门/下载持续推进 updatedAt，
   *  轮询段由 tick 持续推进 nextPollAt；这里只兜「执行者真的挂了」 */
  "worker.stuck_timeout_minutes": int(15),
  "worker.zombie_scan_interval_seconds": int(60),
  "worker.max_retries": int(2, 0),
  "worker.drain_timeout_seconds": timerSeconds(15, { integer: true }),
  "worker.async_poll_interval_seconds": timerSeconds(3),
  "worker.async_poll_max_attempts": int(120),
  "worker.async_poll_initial_delay_seconds": timerSeconds(0.5),

  // 出站 HTTP 超时
  "http.download_timeout_seconds": timerSeconds(45),
  "http.poll_timeout_seconds": timerSeconds(15),
  "http.api_timeout_seconds": timerSeconds(120),
  /** fetchWithTimeout 的默认 body idle 超时：响应体内相邻数据块的最大空闲 */
  "http.body_idle_timeout_seconds": timerSeconds(60),
  /** 单次结果下载总时长上限：防慢滴漏响应长期占用下载与 Worker 槽位 */
  "http.download_total_timeout_seconds": timerSeconds(600),

  // 存储引用 GC
  /** 引用归零后的保留宽限期，覆盖撤销 / 恢复等短暂重引用场景 */
  "storage.gc_grace_hours": int(48),
  /** 试运行模式：只扫描报告不删除；确认扫描结果无误后再关闭 */
  "storage.gc_dry_run": bool(true),

  // 存储后端选择与 S3 连接（specs/storage-s3-backend.md 规则 1/2）。
  // 重启生效，永不参与快照热刷新；backend=s3 时必填键的跨项联合校验
  // 放在存储初始化点（service.ts），注册表维持各项独立校验的现状
  /** 存储后端：local（默认）| s3；切换须停写 + 迁移脚本 */
  "storage.backend": enumText(["local", "s3"] as const, "local"),
  "storage.s3.endpoint": httpUrlOrEmpty(),
  "storage.s3.bucket": text(),
  "storage.s3.region": text(),
  /** 凭据与 model_providers.api_key 同级明文存库（项目已确认的密钥处理基准） */
  "storage.s3.access_key_id": text(),
  "storage.s3.secret_access_key": text(),
  /** path-style 寻址（MinIO 等自建默认 true） */
  "storage.s3.path_style": bool(true),
  /** 对象 key 统一前缀（bucket 复用）；存储层内部映射，接口层 key 不含前缀 */
  "storage.s3.prefix": text(),
  /** 预签名有效期（秒）：读取重定向、媒体工具输入、上游拉取共用 */
  "storage.s3.signed_url_ttl_seconds": timerSeconds(3600),
  /** files 路由分发：redirect（302 预签名，默认）| proxy（服务器流式转发） */
  "storage.s3.delivery": enumText(["redirect", "proxy"] as const, "redirect"),
  /** 上游 AI 引用下发形态（唯一开关）：signed-url（默认，签发不能成立时明确失败）| base64 */
  "storage.upstream_ref_delivery": enumText(["signed-url", "base64"] as const, "signed-url"),
  // 存储配额（specs/storage-user-quota.md）：MB 与同族 upload.max_file_mb 同口径，读取时换算字节
  /** 每用户存储配额（MB）；0 = 不限量。上限保证换算字节后仍在 Number 安全域 */
  "storage.quota.default_mb": int(0, 0, MAX_QUOTA_MB),
};

export type SettingKey = keyof typeof SETTING_DEFS;
export type SettingValue<K extends SettingKey> = (typeof SETTING_DEFS)[K]["default"];
