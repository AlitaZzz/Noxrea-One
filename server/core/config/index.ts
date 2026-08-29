/**
 * 全局配置加载与校验。
 * 从环境变量读取服务配置，经 zod 校验并提供带默认值的强类型访问。
 */
import { z } from "zod";

// 占位符密钥
const PLACEHOLDER_SECRETS: Record<string, string> = {
  JWT_SECRET_KEY: "change-me-to-a-random-secret",
};

const configSchema = z.object({
  // Database
  DATABASE_URL: z.string().default("file:./prisma/dev.db"),
  DB_TIMEOUT: z.coerce.number().int().positive().default(30),

  // JWT
  JWT_SECRET_KEY: z.string().min(1, "JWT_SECRET_KEY is required"),
  JWT_ALGORITHM: z.string().default("HS256"),
  JWT_EXPIRE_MINUTES: z.coerce.number().int().positive().default(1440),

  // App
  APP_NAME: z.string().default("Noxrea AI Canvas"),
  LOG_LEVEL: z.string().default("INFO"),

  // HTTP Server
  SERVER_PORT: z.coerce.number().int().positive().default(4000),
  SERVER_HOST: z.string().default("0.0.0.0"),

  // Worker
  WORKER_POLL_INTERVAL: z.coerce.number().int().positive().default(1),
  WORKER_MAX_CONCURRENCY: z.coerce.number().int().positive().default(10),
  WORKER_API_TIMEOUT: z.coerce.number().int().positive().default(240),
  WORKER_STUCK_TIMEOUT: z.coerce.number().int().positive().default(5),
  WORKER_ZOMBIE_INTERVAL: z.coerce.number().int().positive().default(60),
  WORKER_MAX_RETRIES: z.coerce.number().int().nonnegative().default(2),
  WORKER_DRAIN_TIMEOUT: z.coerce.number().int().positive().default(15),
  WORKER_POLL_CHECK_INTERVAL: z.coerce.number().int().positive().default(200),

  // Async polling
  WORKER_ASYNC_POLL_INTERVAL: z.coerce.number().positive().default(3.0),
  WORKER_ASYNC_POLL_MAX_ATTEMPTS: z.coerce.number().int().positive().default(120),
  WORKER_ASYNC_POLL_INITIAL_DELAY: z.coerce.number().positive().default(0.5),

  // SSRF
  ALLOWED_INTERNAL_HOSTS: z.string().default(""),

  // Upload
  MAX_UPLOAD_SIZE_MB: z.coerce.number().int().positive().default(30),
  // 上传文件根目录（相对项目根，或绝对路径）
  UPLOAD_DIR: z.string().default("uploads"),
  /** 资源目录（JSON 配置与技能文件根目录），相对项目根或绝对路径；Docker 指向 /data/resources */
  RESOURCES_DIR: z.string().default("server/resources"),

  // HTTP timeouts - scene-based（单位：秒）
  HTTP_TIMEOUT_DL: z.coerce.number().positive().default(45),
  HTTP_TIMEOUT_POLL: z.coerce.number().positive().default(15),
  HTTP_TIMEOUT_API: z.coerce.number().positive().default(120),
  HTTP_TIMEOUT_ASYNC: z.coerce.number().positive().default(30),

  // Dev escape
  ALLOW_INSECURE_SECRETS: z
    .enum(["true", "false", "1", "0"])
    .transform((v) => v === "true" || v === "1")
    .default("false"),

  // Registration
  ALLOW_REGISTRATION: z
    .enum(["true", "false", "1", "0"])
    .transform((v) => v === "true" || v === "1")
    .default("true"),

  // FFmpeg (video frame capture) - 目录路径，代码自动拼接 ffmpeg / ffmpeg.exe
  FFMPEG_PATH: z.string().default("bin"),

  // Proxy (for accessing upstream APIs behind firewall)
  USE_SYSTEM_PROXY: z
    .enum(["true", "false", "1", "0"])
    .transform((v) => v === "true" || v === "1")
    .default("false"),
  PROXY_URL: z.string().default(""),
});

export type Config = z.infer<typeof configSchema>;

// 单例配置

let _config: Config | null = null;

export function loadConfig(): Config {
  if (_config) return _config;

  // 兜底加载 .env（兼容直接 node 运行、非 --env-file 场景）
  // Node.js 21.7+ 内置，无需安装 dotenv
  try {
    if (typeof process.loadEnvFile === "function") {
      process.loadEnvFile(".env");
    }
  } catch {
    // .env 不存在或无法读取时忽略
  }

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
