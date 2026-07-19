"""模型管理器 — 懒加载 + LRU 淘汰，支持多下载源自动降级。

核心设计：
    - 启动时不加载任何模型，首次调用时懒加载到显存
    - MAX_LOADED_MODELS 限制同时驻留显存的模型数，超出按 LRU 自动卸载
    - 线程安全（使用 threading.Lock，兼容 asyncio.to_thread 场景）

降级链（DOWNLOAD_SOURCE=modelscope 时）：
    魔塔 → HF 镜像 (hf-mirror.com) → HuggingFace 官方
"""

import os
import logging
import threading
import time
from typing import Any

import torch

from app.config import Settings

logger = logging.getLogger(__name__)

# ── 模型 ID 映射 ─────────────────────────────────────────────
# 每个模型在各平台的 ID。新增模型时在这里加一行。

_MODEL_ID_MAP: dict[str, dict[str, str]] = {
    "rmbg-2.0": {
        "modelscope": "AI-ModelScope/RMBG-2.0",
        "huggingface": "briaai/RMBG-2.0",
    },
    "birefnet": {
        "modelscope": "modelscope/BiRefNet",
        "huggingface": "ZhengPeng7/BiRefNet",
    },
    "birefnet-hr": {
        "modelscope": "",   # ModelScope 暂无，直接走 HF 降级链
        "huggingface": "ZhengPeng7/BiRefNet_HR",
    },
}

# ── 降级链 ───────────────────────────────────────────────────

_FALLBACK_CHAINS: dict[str, list[dict[str, str]]] = {
    "modelscope": [
        {"label": "ModelScope",     "type": "modelscope"},
        {"label": "HF Mirror",      "type": "hf", "endpoint": "https://hf-mirror.com"},
        {"label": "HuggingFace",    "type": "hf", "endpoint": "https://huggingface.co"},
    ],
    "huggingface": [
        {"label": "HuggingFace",    "type": "hf", "endpoint": "https://huggingface.co"},
    ],
}


class ModelManager:
    """管理所有模型的懒加载、LRU 淘汰和卸载。"""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self._models: dict[str, Any | None] = {}     # key → model 或 None（未加载）
        self._loaded_count = 0                        # 当前已加载到显存的模型数
        self._access_order: list[str] = []             # LRU 顺序：最近使用的在前
        self._lock = threading.Lock()                  # 保护以上状态
        self._fallback_chain = _FALLBACK_CHAINS[settings.DOWNLOAD_SOURCE]
        self._setup_env()

    # ── 环境准备 ────────────────────────────────────────────

    def _setup_env(self) -> None:
        """在所有模型加载之前设置环境变量。"""
        cache_dir = os.path.abspath(self.settings.MODEL_CACHE_DIR)
        os.makedirs(cache_dir, exist_ok=True)

        os.environ.setdefault("HF_HOME", cache_dir)
        os.environ.setdefault("MODELSCOPE_CACHE", cache_dir)
        if self.settings.HF_TOKEN:
            os.environ.setdefault("HF_TOKEN", self.settings.HF_TOKEN)

        if hasattr(torch, 'set_float32_matmul_precision'):
            torch.set_float32_matmul_precision('high')

        logger.info(f"模型缓存目录: {cache_dir}")
        logger.info(f"降级链: {' → '.join(s['label'] for s in self._fallback_chain)}")
        logger.info(f"显存策略: 懒加载, 上限={self.settings.MAX_LOADED_MODELS or '无限'}")

    # ── 公共接口 ────────────────────────────────────────────

    def register(self, key: str) -> None:
        """注册一个模型 key（不加载，仅占位）。技能发现后调用。"""
        with self._lock:
            if key not in self._models:
                self._models[key] = None  # 占位，尚未加载
                logger.info(f"已注册模型: {key}")

    def preload_all(self) -> None:
        """预加载所有已注册的模型到显存。仅在 MODEL_PRELOAD=True 时调用。"""
        with self._lock:
            keys = [k for k, v in self._models.items() if v is None]

        for key in keys:
            logger.info(f"预加载模型: {key}...")
            self.get(key)  # get() 会触发懒加载

        logger.info(f"预加载完成，当前显存中模型: {self._loaded_count}")

    def get(self, key: str) -> Any:
        """获取模型实例。未加载时自动加载到显存，超出上限则先淘汰 LRU。

        线程安全：可在 asyncio.to_thread 中并发调用。
        """
        # 快速路径：已加载，只更新 LRU
        with self._lock:
            if key in self._models and self._models[key] is not None:
                self._touch(key)
                return self._models[key]
            if key not in self._models:
                raise ValueError(f"未知的模型 key: {key}（可用: {list(self._models.keys())}）")

        # 慢路径：需要加载模型，在锁外执行（加载可能很久）
        # 先检查是否需要淘汰
        with self._lock:
            limit = self.settings.MAX_LOADED_MODELS
            if limit > 0 and self._loaded_count >= limit:
                self._evict_lru_locked()

        # 加载模型（IO 密集，不在锁内）
        model = self._load_model_with_fallback(key)

        # 存入并更新 LRU
        with self._lock:
            self._models[key] = model
            self._loaded_count += 1
            self._touch(key)

        return model

    def unload(self, key: str) -> None:
        """显式卸载指定模型，释放显存。"""
        with self._lock:
            if key not in self._models or self._models[key] is None:
                return

            model = self._models[key]
            self._models[key] = None
            self._loaded_count -= 1
            if key in self._access_order:
                self._access_order.remove(key)

        # 在锁外释放：先搬到 CPU，再删对象，最后清 CUDA 缓存
        if torch.cuda.is_available():
            before = torch.cuda.memory_allocated() / 1024**3

        try:
            model.to("cpu")        # 先释放 GPU tensor
        except Exception:
            pass
        del model                  # 删除引用

        if torch.cuda.is_available():
            torch.cuda.empty_cache()
            after = torch.cuda.memory_allocated() / 1024**3
            logger.info(f"已卸载 {key}，显存: {before:.1f}G → {after:.1f}G (释放 {before - after:.1f}G)")

    def unload_all(self) -> None:
        """释放所有已加载的模型。"""
        with self._lock:
            keys = [k for k, v in self._models.items() if v is not None]
        for key in keys:
            self.unload(key)
        logger.info("所有模型已卸载")

    def list_loaded(self) -> list[str]:
        """返回当前已加载到显存的模型列表。"""
        with self._lock:
            return [k for k, v in self._models.items() if v is not None]

    def get_loader(self, key: str):
        """返回一个可调用对象 skill.get_model() → model。

        Skill 不直接持有 ModelManager，而是通过这个闭包获取模型，
        从而实现懒加载的透明化。
        """
        return lambda: self.get(key)

    # ── LRU 跟踪 ────────────────────────────────────────────

    def _touch(self, key: str) -> None:
        """将 key 标记为最近使用（需持有锁）。"""
        if key in self._access_order:
            self._access_order.remove(key)
        self._access_order.insert(0, key)

    def _evict_lru_locked(self) -> None:
        """淘汰最久未使用的模型（需持有锁，且 _loaded_count >= MAX_LOADED_MODELS）。"""
        if not self._access_order:
            return

        lru_key = self._access_order[-1]  # 最久未使用
        model = self._models.get(lru_key)
        if model is None:
            return

        logger.info(f"显存超限 ({self._loaded_count}/{self.settings.MAX_LOADED_MODELS})，淘汰 LRU: {lru_key}")
        self._models[lru_key] = None
        self._loaded_count -= 1
        self._access_order.pop()

        # 在锁外删除（但我们已经在锁内了，这里快速释放引用就行）
        del model
        if torch.cuda.is_available():
            torch.cuda.empty_cache()

    # ── 降级链加载 ──────────────────────────────────────────

    def _load_model_with_fallback(self, key: str) -> Any:
        """按降级链依次尝试加载模型，任一源成功即返回。"""
        last_error = None
        chain = self._fallback_chain

        for i, step in enumerate(chain):
            try:
                logger.info(f"  [{i+1}/{len(chain)}] 尝试从 {step['label']} 加载 {key}...")
                result = self._load_model_from(key, step)
                logger.info(f"  ✓ 从 {step['label']} 加载成功")
                return result
            except Exception as e:
                logger.warning(f"  ✗ {step['label']} 失败: {e}")
                last_error = e
                continue

        raise RuntimeError(
            f"所有下载源均失败 ({key})，最后错误: {last_error}"
        )

    def _load_model_from(self, key: str, source: dict) -> Any:
        """从指定源加载模型。"""
        model_ids = _MODEL_ID_MAP.get(key)
        if not model_ids:
            raise ValueError(f"未知的模型 key: {key}")

        if source["type"] == "modelscope":
            if not model_ids.get("modelscope"):
                raise ValueError("ModelScope 暂无此模型")
            return self._load_from_modelscope(key, model_ids)
        else:
            return self._load_from_huggingface(key, model_ids, source.get("endpoint"))

    def _load_from_modelscope(self, key: str, model_ids: dict) -> Any:
        """通过 ModelScope SDK 下载模型到本地，再用 transformers 加载。"""
        model_id = model_ids["modelscope"]
        from modelscope import snapshot_download

        model_dir = snapshot_download(model_id, cache_dir=self.settings.MODEL_CACHE_DIR)
        logger.info(f"  ModelScope 模型已下载到: {model_dir}")
        return self._init_model(key, model_dir)

    def _load_from_huggingface(self, key: str, model_ids: dict, endpoint: str | None) -> Any:
        """通过 HuggingFace（或镜像）加载模型。"""
        model_id = model_ids["huggingface"]
        if endpoint:
            os.environ["HF_ENDPOINT"] = endpoint
            logger.info(f"  HF_ENDPOINT = {endpoint}")
        return self._init_model(key, model_id)

    # ── 模型初始化（与加载源解耦）───────────────────────────

    def _init_model(self, key: str, model_path_or_id: str) -> Any:
        """初始化模型实例。新增模型类型时在这里加分支。"""
        if key in ("rmbg-2.0", "birefnet", "birefnet-hr"):
            from transformers import AutoModelForImageSegmentation

            device = "cuda" if torch.cuda.is_available() else "cpu"
            logger.info(f"  设备: {device}")

            model = AutoModelForImageSegmentation.from_pretrained(
                model_path_or_id,
                trust_remote_code=True,
            )
            model.to(device)
            model.eval()
            return model

        raise ValueError(f"未知的模型 key: {key}")
