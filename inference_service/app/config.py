"""推理服务配置 — 所有可配项从 .env 读取，无硬编码。"""

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    model_config = {"env_file": ".env", "env_file_encoding": "utf-8"}

    # ── 服务基础配置 ──
    API_KEY: str = ""               # API 鉴权 Key（空=开发模式，不鉴权）
    HOST: str = "0.0.0.0"
    PORT: int = 8100
    LOG_LEVEL: str = "INFO"         # 日志级别

    # ── 模型下载配置 ──
    MODEL_CACHE_DIR: str = "./models"
    # 模型缓存根目录。所有模型（魔塔、HF）统一放在此目录下。
    # 通过设置 HF_HOME 和 MODELSCOPE_CACHE 环境变量让三方库走这个目录。

    DOWNLOAD_SOURCE: str = "modelscope"
    # 模型下载源，决定降级链的起点：
    # modelscope  → 魔塔 → HF 镜像 → HuggingFace 官方（默认，推荐国内）
    # huggingface → HuggingFace 官方（海外）

    HF_TOKEN: str = ""
    # HuggingFace 访问令牌。briaai/RMBG-2.0 是 gated repo，HF 官方需要 token。
    # 魔塔镜像不需要 token。

    # ── 运行时配置 ──
    INFERENCE_CONCURRENCY: int = 2
    # 并发处理上限。控制同时处理几个推理请求，避免 CPU/内存过载。

    MODEL_PRELOAD: bool = False
    # 是否在启动时预加载所有模型到显存。
    # 多模型场景必须设为 False（默认），否则显存撑爆。
    # 单模型场景可以设为 True，首次请求不需要等加载。

    MAX_LOADED_MODELS: int = 2
    # 同时驻留显存的模型数量上限（0=不限制）。
    # 超出时按 LRU 策略自动卸载最久未使用的模型。

    BG_REMOVAL_PRECISION: str = "high"
    # 抠图默认精度：fast(512) | standard(1024) | high(2048)

    UNLOAD_AFTER_USE: bool = False
    # 每次推理完成后立即卸载模型释放显存。
    # 显存紧张时开启，代价是下次请求需要重新加载。


settings = Settings()
