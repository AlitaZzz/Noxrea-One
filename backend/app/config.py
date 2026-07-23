from pydantic_settings import BaseSettings, SettingsConfigDict
from pydantic import model_validator

# 启动时必须替换的占位符（来自 .env.example 默认值），生产环境带占位符启动有严重安全风险
_PLACEHOLDER_SECRETS = {
    "JWT_SECRET_KEY": "change-me-to-a-random-secret",
    "ADMIN_PASSWORD": "change-me-to-a-strong-password",
}


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",  # .env 里多余的字段忽略而非报错（避免历史 DEBUG= 等导致启动崩）
    )

    # Database — SQLite 默认，生产换 MySQL/PostgreSQL
    DATABASE_URL: str = "sqlite+aiosqlite:///./data/app.db"
    # MySQL 示例: "mysql+aiomysql://root:<password>@localhost:3306/noxrea"
    # PostgreSQL 示例: "postgresql+asyncpg://user:<password>@localhost:5432/noxrea"
    DB_TIMEOUT: int = 30  # SQLite connection timeout in seconds

    # JWT
    JWT_SECRET_KEY: str  # REQUIRED — must be set in .env or environment
    JWT_ALGORITHM: str = "HS256"
    JWT_EXPIRE_MINUTES: int = 1440  # 24 hours

    # Admin account (auto-created on first run)
    ADMIN_USERNAME: str = "admin"
    ADMIN_PASSWORD: str  # REQUIRED — must be set in .env or environment

    # App
    APP_NAME: str = "Noxrea AI Canvas API"
    # 日志级别：默认 INFO（看业务关键流），DEBUG 看轮询/SSE 等诊断细节
    LOG_LEVEL: str = "INFO"

    # Public URL for file links (e.g. "http://localhost:8000" or "https://api.example.com")
    PUBLIC_URL: str = "http://localhost:8000"

    # CORS allowed origins (comma-separated, e.g. "http://localhost:3000,https://myapp.com")
    # The frontend URL(s) that are allowed to call this API from the browser.
    # For production, replace with your actual frontend domain(s).
    CORS_ORIGINS: str = "http://localhost:3000,http://localhost:5173"

    # Worker
    WORKER_POLL_INTERVAL: int = 2       # seconds between worker main loop iterations
    WORKER_MAX_CONCURRENCY: int = 10    # max simultaneous AI API calls
    WORKER_API_TIMEOUT: int = 240       # seconds before an AI API call times out
    WORKER_STUCK_TIMEOUT: int = 20      # minutes before a processing task is considered stuck
    WORKER_ZOMBIE_INTERVAL: int = 60    # seconds between zombie cleanup checks

    # Async polling (used by async providers like APIMart)
    WORKER_ASYNC_POLL_INTERVAL: float = 3.0          # seconds between polls
    WORKER_ASYNC_POLL_MAX_ATTEMPTS: int = 60         # max poll attempts (60 * 3s = 3min 上限)
    WORKER_ASYNC_POLL_INITIAL_DELAY: float = 0.0     # seconds to wait before first poll（0=立即开始）

    # SSRF
    ALLOWED_INTERNAL_HOSTS: str = ""     # 逗号分隔的内网地址白名单，如 "192.168.1.50,192.168.1.51"

    # Upload
    MAX_UPLOAD_SIZE_MB: int = 30  # 单文件上传上限（MB），超限返回 413

    # Inference Service (background removal, etc.)
    INFERENCE_SERVICE_URL: str = "http://localhost:8100"
    INFERENCE_SERVICE_API_KEY: str = ""

    # 开发逃生开关：本地调试时可设为 true 跳过占位符密钥校验（生产严禁开启）
    ALLOW_INSECURE_SECRETS: bool = False

    # 是否开放自助注册（默认 true=开放，向后兼容；生产建议 false）
    ALLOW_REGISTRATION: bool = True

    @model_validator(mode="after")
    def _check_placeholder_secrets(self) -> "Settings":
        """JWT_SECRET_KEY / ADMIN_PASSWORD 仍为占位符时拒绝启动（除非显式 ALLOW_INSECURE_SECRETS=true）。"""
        if self.ALLOW_INSECURE_SECRETS:
            return self
        offenders = [k for k, ph in _PLACEHOLDER_SECRETS.items() if getattr(self, k) == ph]
        if offenders:
            raise ValueError(
                f"Insecure placeholder secrets still in use: {offenders}. "
                f"Set real values in .env, or set ALLOW_INSECURE_SECRETS=true for local dev."
            )
        return self


settings = Settings()
