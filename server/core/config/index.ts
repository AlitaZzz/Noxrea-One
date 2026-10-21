/**
 * 引导期配置加载与校验（env）。
 * 只含后端进程的引导 / 部署拓扑 / 密钥类配置（前端变量以 WEB_ 开头，由 Next 读取）；运行期业务参数见 core/settings（system_settings 表）。
 */
import { z } from "zod";

// 占位符密钥
const PLACEHOLDER_SECRETS: Record<string, string> = {
  JWT_SECRET_KEY: "change-me-to-a-random-secret",
};

// DATABASE_URL 由 core/database/client 直接读取 process.env，不经此处
const configSchema = z.object({
  // JWT（密钥与算法属引导配置；有效期在 system_settings）
  JWT_SECRET_KEY: z.string().min(1, "JWT_SECRET_KEY is required"),
  JWT_ALGORITHM: z.string().default("HS256"),

  // 任务队列（specs/task-queue-bullmq.md）：Redis 连接串，专用实例。
  // 启动探测 PING 失败即启动失败（无队列无法服务，规则 7）
  REDIS_URL: z.string().min(1, "REDIS_URL is required"),

  LOG_LEVEL: z.string().default("INFO"),

  // HTTP Server（Hono 监听地址；前端代理目标见 web/next.config.ts 的 WEB_API_ORIGIN）
  API_PORT: z.coerce.number().int().positive().default(4000),
  API_HOST: z.string().default("0.0.0.0"),

  // Upload：批次总大小上限与 Next 代理层（proxyClientMaxBodySize）共用同一 env 来源，故不入库
  UPLOAD_BATCH_MAX_MB: z.coerce.number().int().positive().default(128),
  // 上传文件根目录（相对项目根，或绝对路径）
  UPLOAD_DIR: z.string().default("uploads"),
  /** 资源目录（模型配置等 JSON 资源根目录），相对项目根或绝对路径；Docker 指向 /data/resources */
  RESOURCES_DIR: z.string().default("server/resources"),

  // Dev escape
  ALLOW_INSECURE_SECRETS: z
    .enum(["true", "false", "1", "0"])
    .transform((v) => v === "true" || v === "1")
    .default("false"),

  // FFmpeg distribution directory: contains ffmpeg and ffprobe (with .exe on Windows).
  FFMPEG_PATH: z.string().default("bin"),
});

export type Config = z.infer<typeof configSchema>;

// 单例配置

let _config: Config | null = null;

export function loadConfig(): Config {
  if (_config) return _config;

  // 环境变量由进程入口注入（--env-file=.env / entrypoint source / compose -e）。
  // 本模块不做 .env 兜底加载：模块级 loadEnvFile 是隐式全局副作用，谁先加载 config
  // 谁就改写共享 process.env，环境内容随模块加载顺序漂移（曾致测试门控在
  // 全量/单文件两种执行模式下行为不同）；缺 env 时下方 schema 校验立即大声失败
  const raw = process.env;
  const parsed = configSchema.safeParse(raw);

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid configuration:\n${issues}`);
  }

  const cfg = parsed.data;

  // 占位符密钥校验
  if (!cfg.ALLOW_INSECURE_SECRETS) {
    const offenders: string[] = [];
    for (const [k, ph] of Object.entries(PLACEHOLDER_SECRETS)) {
      if ((cfg as Record<string, unknown>)[k] === ph) {
        offenders.push(k);
      }
    }
    if (offenders.length > 0) {
      throw new Error(
        `Insecure placeholder secrets still in use: ${offenders.join(", ")}. ` +
          `Set real values in .env, or set ALLOW_INSECURE_SECRETS=true for local dev.`
      );
    }
  }

  _config = cfg;
  return cfg;
}

/** 获取已加载的配置（必须先调用 loadConfig()） */
export function getConfig(): Config {
  if (!_config) {
    return loadConfig();
  }
  return _config;
}
