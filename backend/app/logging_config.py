"""
统一日志配置：彩色 + 对齐 format + 第三方库静默。

调用 setup_logging()（main.py 启动时）：
- 默认级别 INFO，可通过环境变量 LOG_LEVEL 覆盖
- 业务模块 INFO 可见，轮询/SSE 等高频诊断放 DEBUG
- 第三方库（httpx/sqlalchemy/aiosqlite）压到 WARNING，uvicorn access log 压到 WARNING

格式：时间 LEVEL[固定宽] 模块[左对齐] 消息
彩色：DEBUG 灰 / INFO 绿 / WARN 黄 / ERROR 红
"""

import logging
import sys

import colorama


# ── 彩色（Windows 终端兼容）──────────────────────────────────────

_RESET = colorama.Style.RESET_ALL
_LEVEL_COLOR = {
    logging.DEBUG: colorama.Fore.LIGHTBLACK_EX,
    logging.INFO: colorama.Fore.GREEN,
    logging.WARNING: colorama.Fore.YELLOW,
    logging.ERROR: colorama.Fore.RED,
    logging.CRITICAL: colorama.Fore.RED + colorama.Style.BRIGHT,
}


def _short_name(name: str) -> str:
    """app.services.worker.executor → worker.executor；app.routers.generate → routers.generate。
    取最后 2 层作为短名，避免同名冲突（多个 executor/service/manager）。"""
    parts = name.split(".")
    if len(parts) >= 2:
        return ".".join(parts[-2:])
    return parts[-1] if parts else name


class ColorFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        # 固定宽度的级别名 + 左对齐 16 的模块名
        levelname = f"{record.levelname:<5}"
        module_name = f"{_short_name(record.name):<16}"
        color = _LEVEL_COLOR.get(record.levelno, "")
        msg = record.getMessage()
        if color:
            return (
                f"{colorama.Fore.LIGHTBLACK_EX}{self.formatTime(record, '%H:%M:%S')}{_RESET} "
                f"{color}{levelname}{_RESET} "
                f"{colorama.Fore.CYAN}{module_name}{_RESET} "
                f"{msg}"
            )
        return (
            f"{self.formatTime(record, '%H:%M:%S')} {levelname} {module_name} {msg}"
        )


# ── 第三方库静默清单 ─────────────────────────────────────────────

_NOISY_LOGGERS = [
    "aiosqlite",
    "sqlalchemy.engine",
    "httpcore",
    "httpx",
    "urllib3",
    "watchfiles",
    "PIL",  # Pillow 首次 Image.open 懒加载全部插件的 DEBUG 日志，纯噪音
    "PngImagePlugin",
    "Image",
]


def setup_logging() -> None:
    """配置根 logger。应在 main.py 最早期调用一次。"""
    from app.config import settings

    colorama.init(autoreset=False)

    level = getattr(logging, settings.LOG_LEVEL.upper(), logging.INFO)

    root = logging.getLogger()
    root.setLevel(level)

    # 清掉可能的默认 handler，确保用我们的
    for h in list(root.handlers):
        root.removeHandler(h)
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(ColorFormatter())
    root.addHandler(handler)

    # 第三方库压到 WARNING（DEBUG 模式下也不刷屏）
    for name in _NOISY_LOGGERS:
        logging.getLogger(name).setLevel(logging.WARNING)
    # uvicorn：保留 error 日志，静默 access（每请求一行太噪）
    logging.getLogger("uvicorn.access").setLevel(logging.WARNING)
    logging.getLogger("uvicorn").setLevel(logging.INFO)
