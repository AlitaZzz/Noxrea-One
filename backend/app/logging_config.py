"""
统一日志配置：彩色 + 结构化 format + 第三方库静默 + 日志摘要工具。

调用 setup_logging()（main.py 启动时）：
- 默认级别 INFO，可通过环境变量 LOG_LEVEL 覆盖
- 业务模块 INFO 可见，轮询/SSE 等高频诊断放 DEBUG
- 第三方库（httpx/sqlalchemy/aiosqlite）压到 WARNING，uvicorn access log 压到 WARNING

结构化格式：[module] | task=8位id | stage=阶段 | key=value | ...（字段间用 " | " 分隔）
彩色：仅 [module] 模块名上色，每个模块一种不同的颜色，其余字段保持纯文本便于阅读
非 TTY 环境自动去色，方便日志文件 grep。
"""

from __future__ import annotations

import copy
import logging
import re
import sys
import time as _time
import zlib
from typing import Any

import colorama


# ── 彩色（Windows 终端兼容）──────────────────────────────────────

_RESET = colorama.Style.RESET_ALL
# 每个模块固定一种不同颜色（仅模块名上色，其余字段保持纯文本）
_MODULE_COLORS = {
    "generate": colorama.Fore.LIGHTCYAN_EX,
    "executor": colorama.Fore.LIGHTBLUE_EX,
    "gateway":  colorama.Fore.LIGHTMAGENTA_EX,
    "builder":  colorama.Fore.LIGHTYELLOW_EX,
    "image":    colorama.Fore.LIGHTGREEN_EX,
    "video":    colorama.Fore.LIGHTRED_EX,
    "audio":    colorama.Fore.CYAN,
    "llm":      colorama.Fore.LIGHTWHITE_EX,
    "worker":   colorama.Fore.BLUE,
    "download": colorama.Fore.GREEN,
    "storage":  colorama.Fore.MAGENTA,
}

# 未知模块兜底调色板（用稳定哈希分配，保证每个模块都上色且与众不同）
_MODULE_PALETTE = [
    colorama.Fore.LIGHTCYAN_EX, colorama.Fore.LIGHTBLUE_EX, colorama.Fore.LIGHTMAGENTA_EX,
    colorama.Fore.LIGHTYELLOW_EX, colorama.Fore.LIGHTGREEN_EX, colorama.Fore.LIGHTRED_EX,
    colorama.Fore.CYAN, colorama.Fore.BLUE, colorama.Fore.MAGENTA, colorama.Fore.GREEN,
    colorama.Fore.RED, colorama.Fore.YELLOW, colorama.Fore.WHITE,
]


def _module_color(name: str) -> str:
    """解析模块颜色：显式映射优先，其次按末段名，最后用稳定哈希兜底（每个模块都上色）。"""
    if name in _MODULE_COLORS:
        return _MODULE_COLORS[name]
    last = name.split(".")[-1]
    if last in _MODULE_COLORS:
        return _MODULE_COLORS[last]
    return _MODULE_PALETTE[zlib.crc32(name.encode()) % len(_MODULE_PALETTE)]


def _is_tty() -> bool:
    """检测 stdout 是否为终端（非管道/重定向）。"""
    try:
        return sys.stdout.isatty()
    except Exception:
        return False


def _short_name(name: str) -> str:
    """app.services.worker.executor → worker.executor；app.routers.generate → routers.generate。
    取最后 2 层作为短名，避免同名冲突（多个 executor/service/manager）。"""
    parts = name.split(".")
    if len(parts) >= 2:
        return ".".join(parts[-2:])
    return parts[-1] if parts else name


def _colorize_structured(msg: str) -> str:
    """只给开头的 [module] 上色（每个模块一种不同颜色），其余字段保持纯文本。"""
    m = re.match(r"^\[([\w.]+)\](.*)$", msg, re.DOTALL)
    if not m:
        return msg
    mod = m.group(1)
    rest = m.group(2)
    c = _module_color(mod)
    return c + f"[{mod}]" + _RESET + rest


class ColorFormatter(logging.Formatter):
    """统一彩色 Formatter：每一行都以彩色 [module] 标签开头，去掉杂乱的单独模块列。
    - 结构化日志（消息以 [ 开头）：复用消息内自带的 [module]，按语义元素上色
    - 非结构化日志：用 logger 名补一个彩色 [module] 前缀，风格保持一致
    非 TTY 环境：全部去色，输出纯文本。
    """

    def format(self, record: logging.LogRecord) -> str:
        levelname = f"{record.levelname:<5}"
        msg = record.getMessage()
        is_structured = msg.startswith("[")

        if not _is_tty():
            # 纯文本模式：去色，便于 grep。结构化日志已含 [module]，不再重复加 logger 名
            if is_structured:
                return f"{self.formatTime(record, '%H:%M:%S')} {levelname} {msg}"
            prefix = f"[{_short_name(record.name)}] "
            return f"{self.formatTime(record, '%H:%M:%S')} {levelname} {prefix}{msg}"

        # 终端模式：仅 [module] 模块名上色，其余纯文本，字段以 " | " 分隔
        ts = f"{colorama.Fore.LIGHTBLACK_EX}{self.formatTime(record, '%H:%M:%S')}{_RESET}"
        if is_structured:
            msg = _colorize_structured(msg)
            return f"{ts} {levelname} {msg}"
        short = _short_name(record.name)
        mod_color = _module_color(short)
        return f"{ts} {levelname} {mod_color}[{short}]{_RESET} {msg}"


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


# ── 统一结构化日志助手 ─────────────────────────────────────────

def log_event(module: str, *, task_id: str | None = None, stage: str | None = None, **fields) -> str:
    """生成统一结构化日志行：[module] | task=xxx | stage=xxx | key=value | ...

    规则：
    - bool 值转为小写 true/false
    - None 值自动跳过
    - module 和 stage 必填（至少预期填）
    """
    parts = [f"[{module}]"]
    if task_id is not None:
        parts.append(f"task={task_id}")
    if stage is not None:
        parts.append(f"stage={stage}")
    for key, val in fields.items():
        if val is None:
            continue
        if isinstance(val, bool):
            val = str(val).lower()
        parts.append(f"{key}={val}")
    return " | ".join(parts)


def classify_error(error: str | None = None, http_status: int | None = None) -> tuple[str, bool]:
    """将上游错误归类为 (category, retry)。

    category:
        - timeout          → 可重试
        - content_policy_error → 不可重试
        - invalid_request  → 不可重试
        - protocol_error   → 不可重试（兜底）
    """
    e = (error or "").lower()
    if "timed out" in e or "timeout" in e:
        return "timeout", True
    if "content_policy" in e or "unsafe" in e or "content policy" in e:
        return "content_policy_error", False
    if http_status and 400 <= http_status < 500:
        return "invalid_request", False
    if "invalid" in e or "validation" in e:
        return "invalid_request", False
    return "protocol_error", False


async def run_upstream(
    logger,
    capability: str,
    task_id: str,
    endpoint: str,
    submit_coro,
) -> dict:
    """提交上游请求，记录 upstream_request / completed / failed（含耗时分类）。

    用法：在图像/视频/音频/LLM 能力服务中替代直接调用 TaskManager.submit_and_wait：
        result = await run_upstream(logger, self.capability, task_id, endpoint,
                                     TaskManager.submit_and_wait(...))
    """
    t0 = _time.monotonic()
    logger.info(log_event(capability, task_id=task_id, stage="upstream_request", endpoint=endpoint))
    result = await submit_coro
    dur = int(_time.monotonic() - t0)

    if result.get("status") == "completed":
        urls_count = len(result.get("urls") or [])
        files_count = len(result.get("files") or [])
        count = urls_count + files_count
        logger.info(log_event(capability, task_id=task_id, stage="completed", urls=count, duration=f"{dur}s"))
    else:
        category = result.get("category")
        retry = result.get("retry")
        if category is None or retry is None:
            category, retry = classify_error(result.get("error"), result.get("http_status"))
        msg = result.get("message") or result.get("error") or ""
        logger.info(log_event(capability, task_id=task_id, stage="failed",
                              category=category, retry=retry, message=f'"{msg}"', duration=f"{dur}s"))
    return result


# ── 日志摘要工具：截断长文本字段防止日志膨胀 ────────────────────────

# 需要截断的字段名
_TRUNCATE_KEYS: set[str] = {"prompt", "input", "content", "text"}

# 截断长度
_TRUNCATE_LEN: int = 50


def _format_long(val: str) -> str:
    """长文本仅显示总字符数，不输出原文。"""
    return f"({len(val)} chars)"


def _sanitize_value(val: Any, ref_key: bool = False) -> Any:
    """递归清理：替换 base64/data URI 和参考图数组。

    - 字符串以 "data:" 开头 → "(data URI, N chars)"
    - ref_urls 类列表 → "(N refs)"
    - 嵌套 dict 递归处理
    """
    if isinstance(val, str):
        if val.startswith("data:"):
            return f"(data URI, {len(val)} chars)"
        return val
    if isinstance(val, list):
        if ref_key:
            return f"({len(val)} refs)"
        return [_sanitize_value(v, False) for v in val]
    if isinstance(val, dict):
        return {k: _sanitize_value(v, k in _REF_KEYS) for k, v in val.items()}
    return val


# 可能含参考图/base64 数据的字段名
_REF_KEYS: set[str] = {"ref_urls", "image", "image_url", "image_urls", "b64_json", "reference_images"}


def summarize_body(body: dict) -> dict:
    """生成日志安全的 body 副本，截断长文本和 base64 数据。

    - prompt / input / content → 长文本截断显示字数
    - data:xxx;base64,... → 替换为 "(data URI, N chars)"
    - ref_urls 列表 → 替换为 "(N refs)"
    - 不修改原始 dict
    """
    if not body:
        return {}
    # 先做 base64 清理（可能会改变 dict 结构），再做文本截断
    d = copy.deepcopy(body)
    d = _sanitize_value(d)

    # 截断顶层长文本字段
    for key in _TRUNCATE_KEYS:
        val = d.get(key)
        if isinstance(val, str) and len(val) > _TRUNCATE_LEN:
            d[key] = _format_long(val)

    # 截断 messages 中各条目的 content
    messages = d.get("messages")
    if isinstance(messages, list):
        for msg in messages:
            if isinstance(msg, dict):
                for key in _TRUNCATE_KEYS:
                    val = msg.get(key)
                    if isinstance(val, str) and len(val) > _TRUNCATE_LEN:
                        msg[key] = _format_long(val)

    return d


def summarize_text(text: str | None) -> str:
    """截断单段文本用于日志输出，超过 50 字符时显示总字数。"""
    if not text:
        return "(空)"
    if len(text) <= _TRUNCATE_LEN:
        return text
    return _format_long(text)
