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

const int = (value: number, min = 1): SettingDef<number> => ({
  schema: z
    .string()
    .regex(INT_TEXT, "must be an integer written as plain digits")
    .transform(Number)
    .pipe(z.number().int().safe().min(min)),
  default: value,
});

const positive = (value: number): SettingDef<number> => ({
  schema: z
    .string()
    .regex(DECIMAL_TEXT, "must be a number written as plain digits with an optional fraction")
    .transform(Number)
    .pipe(z.number().finite().positive()),
  default: value,
});

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
  /** 对外可访问的服务根地址；配置后参考素材以 URL 发给上游，留空则回退 base64 */
  "network.public_base_url": httpUrlOrEmpty(),

  // 上传（批次总大小上限 UPLOAD_BATCH_MAX_MB 与 Next 代理层共用，保留在 env）
  "upload.max_file_mb": int(100),
  "upload.batch_max_files": int(20),
  /** 单个用户同时处理的上传批次数 */
  "upload.batch_max_concurrent": int(1),
  /** 单个用户上传批次等待队列深度上限；超额立即 429 */
  "upload.batch_max_pending": int(10),

  // Worker
  "worker.poll_interval_seconds": int(1),
  "worker.max_concurrency": int(10),
  "worker.api_timeout_seconds": int(240),
  /** 僵尸判定阈值（分钟）：轮询期间有心跳持续推进 updatedAt，这里只需兜住「轮询线程真的挂了」 */
  "worker.stuck_timeout_minutes": int(15),
  "worker.zombie_scan_interval_seconds": int(60),
  "worker.max_retries": int(2, 0),
  "worker.drain_timeout_seconds": int(15),
  "worker.poll_check_interval_ms": int(200),
  "worker.async_poll_interval_seconds": positive(3),
  "worker.async_poll_max_attempts": int(120),
  "worker.async_poll_initial_delay_seconds": positive(0.5),

  // 出站 HTTP 超时
  "http.download_timeout_seconds": positive(45),
  "http.poll_timeout_seconds": positive(15),
  "http.api_timeout_seconds": positive(120),
  /** fetchWithTimeout 的默认 body idle 超时：响应体内相邻数据块的最大空闲 */
  "http.body_idle_timeout_seconds": positive(60),
  /** 单次结果下载总时长上限：防慢滴漏响应长期占用下载与 Worker 槽位 */
  "http.download_total_timeout_seconds": positive(600),

  // 存储引用 GC
  /** 引用归零后的保留宽限期，覆盖撤销 / 恢复等短暂重引用场景 */
  "storage.gc_grace_hours": int(48),
  /** 试运行模式：只扫描报告不删除；确认扫描结果无误后再关闭 */
  "storage.gc_dry_run": bool(true),
};

export type SettingKey = keyof typeof SETTING_DEFS;
export type SettingValue<K extends SettingKey> = (typeof SETTING_DEFS)[K]["default"];
