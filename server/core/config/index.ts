import { z } from "zod";

// 占位符密钥（对应 Python _PLACEHOLDER_SECRETS）
const PLACEHOLDER_SECRETS: Record<string, string> = {
  JWT_SECRET_KEY: "change-me-to-a-random-secret",
  ADMIN_PASSWORD: "change-me-to-a-strong-password",
};

// ── Zod schema 定义 ──

const configSchema = z.object({
  // Database
  DATABASE_URL: z.string().default("file:./prisma/dev.db"),
  DB_TIMEOUT: z.coerce.number().int().positive().default(30),

  // JWT
  JWT_SECRET_KEY: z.string().min(1, "JWT_SECRET_KEY is required"),
  JWT_ALGORITHM: z.string().default("HS256"),
  JWT_EXPIRE_MINUTES: z.coerce.number().int().positive().default(1440),

  // Admin
  ADMIN_USERNAME: z.string().default("admin"),
  ADMIN_PASSWORD: z.string().min(1, "ADMIN_PASSWORD is required"),

  // App
  APP_NAME: z.string().default("Noxrea AI Canvas"),
  LOG_LEVEL: z.string().default("INFO"),

  // Worker
  WORKER_POLL_INTERVAL: z.coerce.number().int().positive().default(1),
  WORKER_MAX_CONCURRENCY: z.coerce.number().int().positive().default(10),
  WORKER_API_TIMEOUT: z.coerce.number().int().positive().default(240),
  WORKER_STUCK_TIMEOUT: z.coerce.number().int().positive().default(5),
  WORKER_ZOMBIE_INTERVAL: z.coerce.number().int().positive().default(60),
  WORKER_MAX_RETRIES: z.coerce.number().int().nonnegative().default(2),

  // Async polling
  WORKER_ASYNC_POLL_INTERVAL: z.coerce.number().positive().default(3.0),
  WORKER_ASYNC_POLL_MAX_ATTEMPTS: z.coerce.number().int().positive().default(120),
  WORKER_ASYNC_POLL_INITIAL_DELAY: z.coerce.number().positive().default(0.5),

  // SSRF
  ALLOWED_INTERNAL_HOSTS: z.string().default(""),

  // Upload
  MAX_UPLOAD_SIZE_MB: z.coerce.number().int().positive().default(30),

  // HTTP timeouts — scene-based
  HTTP_DL_CONNECT: z.coerce.number().positive().default(15),
  HTTP_DL_READ: z.coerce.number().positive().default(30),
  HTTP_DL_WRITE: z.coerce.number().positive().default(10),
  HTTP_DL_POOL: z.coerce.number().positive().default(10),

  HTTP_POLL_CONNECT: z.coerce.number().positive().default(10),
  HTTP_POLL_READ: z.coerce.number().positive().default(15),
  HTTP_POLL_WRITE: z.coerce.number().positive().default(10),
  HTTP_POLL_POOL: z.coerce.number().positive().default(5),

  HTTP_API_CONNECT: z.coerce.number().positive().default(10),
  HTTP_API_READ: z.coerce.number().positive().default(120),
  HTTP_API_WRITE: z.coerce.number().positive().default(30),
  HTTP_API_POOL: z.coerce.number().positive().default(10),

  HTTP_ASYNC_CONNECT: z.coerce.number().positive().default(10),
  HTTP_ASYNC_READ: z.coerce.number().positive().default(30),
  HTTP_ASYNC_WRITE: z.coerce.number().positive().default(30),
  HTTP_ASYNC_POOL: z.coerce.number().positive().default(10),

  HTTP_TIMEOUT_INFERENCE: z.coerce.number().positive().default(300),

  // Inference service
  INFERENCE_SERVICE_URL: z.string().default("http://localhost:8100"),
  INFERENCE_SERVICE_API_KEY: z.string().default(""),

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

  // FFmpeg (video frame capture)
  FFMPEG_PATH: z.string().default("bin/ffmpeg"),

  // Proxy (for accessing upstream APIs behind firewall)
  USE_SYSTEM_PROXY: z
    .enum(["true", "false", "1", "0"])
    .transform((v) => v === "true" || v === "1")
    .default("false"),
  PROXY_URL: z.string().default(""),
});

export type Config = z.infer<typeof configSchema>;

// ── 单例配置 ──

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

  // 占位符密钥校验（对应 Python _check_placeholder_secrets）
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
