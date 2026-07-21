from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
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
    DEBUG: bool = False
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

    # SSRF
    ALLOWED_INTERNAL_HOSTS: str = ""     # 逗号分隔的内网地址白名单，如 "192.168.1.50,192.168.1.51"

    # Inference Service (background removal, etc.)
    INFERENCE_SERVICE_URL: str = "http://localhost:8100"
    INFERENCE_SERVICE_API_KEY: str = ""


settings = Settings()
