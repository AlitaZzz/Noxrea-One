"""
ModelParamsRegistry - 模型参数注册表单例。

加载 model_params.json，按需检查 mtime 实现热更新。
匹配优先级：精确名 > fnmatch 通配符 > _default。

被 engine.py 调用获取 transforms；
被 routers/model_params.py 调用返回 params + defaults + constraints 给前端。
"""

from __future__ import annotations

import fnmatch
import json
import logging
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

_DATA_FILE = Path(__file__).resolve().parent.parent / "data" / "model_params.json"


@dataclass
class ModelParams:
    """单个模型在某 capability 下的参数配置。"""
    params: list[str] = field(default_factory=list)
    defaults: dict[str, Any] = field(default_factory=dict)
    constraints: dict[str, list] = field(default_factory=dict)
    transforms: dict[str, Any] = field(default_factory=dict)


class ModelParamsRegistry:
    """单例：加载 model_params.json，按需检查 mtime 热更新，fnmatch 匹配。"""

    _instance: "ModelParamsRegistry | None" = None

    def __new__(cls) -> "ModelParamsRegistry":
        if cls._instance is None:
            cls._instance = super().__new__(cls)
            cls._instance._initialized = False
        return cls._instance

    def __init__(self) -> None:
        if self._initialized:
            return
        self._initialized = True
        self._data: dict[str, dict] = {}
        self._mtime: float = 0.0
        self._load()

    def _load(self) -> None:
        """从磁盘加载 JSON，记录 mtime。"""
        try:
            self._mtime = os.path.getmtime(_DATA_FILE)
            with open(_DATA_FILE, "r", encoding="utf-8") as f:
                self._data = json.load(f)
            logger.info(
                f"ModelParamsRegistry loaded {len(self._data)} entries from {_DATA_FILE.name}"
            )
        except FileNotFoundError:
            logger.warning(f"model_params.json not found at {_DATA_FILE}")
            self._data = {}
        except Exception as e:
            logger.error(f"ModelParamsRegistry load error: {e}")
            self._data = {}

    def _check_reload(self) -> None:
        """按需检查文件 mtime，变化则重新加载。"""
        try:
            mtime = os.path.getmtime(_DATA_FILE)
            if mtime != self._mtime:
                logger.info("model_params.json changed, reloading...")
                self._load()
        except OSError:
            pass

    def get(self, model_name: str, capability: str) -> ModelParams | None:
        """查找模型参数配置。

        匹配优先级：精确名 > fnmatch 通配符 > _default
        未找到返回 None。
        """
        self._check_reload()

        caps = self._data.get(model_name) or {}
        cap_config = caps.get(capability)
        if cap_config:
            return ModelParams(
                params=cap_config.get("params", []),
                defaults=cap_config.get("defaults", {}),
                constraints=cap_config.get("constraints", {}),
                transforms=cap_config.get("transforms", {}),
            )

        # fnmatch 通配符匹配
        for pattern, caps in self._data.items():
            if pattern == "_default" or pattern == model_name:
                continue
            if "*" in pattern or "?" in pattern:
                if fnmatch.fnmatch(model_name, pattern):
                    cap_config = caps.get(capability)
                    if cap_config:
                        return ModelParams(
                            params=cap_config.get("params", []),
                            defaults=cap_config.get("defaults", {}),
                            constraints=cap_config.get("constraints", {}),
                            transforms=cap_config.get("transforms", {}),
                        )

        # _default 兜底
        default_caps = self._data.get("_default") or {}
        cap_config = default_caps.get(capability)
        if cap_config:
            return ModelParams(
                params=cap_config.get("params", []),
                defaults=cap_config.get("defaults", {}),
                constraints=cap_config.get("constraints", {}),
                transforms=cap_config.get("transforms", {}),
            )

        return None

    def get_public(self) -> dict:
        """返回所有模型的 params + defaults + constraints（不返回 transforms）。

        供 API 路由返回给前端。
        """
        self._check_reload()
        result: dict[str, dict] = {}
        for model_name, caps in self._data.items():
            if model_name == "_default":
                continue
            result[model_name] = {}
            for cap_name, cap_config in caps.items():
                result[model_name][cap_name] = {
                    "params": cap_config.get("params", []),
                    "defaults": cap_config.get("defaults", {}),
                    "constraints": cap_config.get("constraints", {}),
                }
        # 始终包含 _default
        default_caps = self._data.get("_default") or {}
        if default_caps:
            result["_default"] = {}
            for cap_name, cap_config in default_caps.items():
                result["_default"][cap_name] = {
                    "params": cap_config.get("params", []),
                    "defaults": cap_config.get("defaults", {}),
                    "constraints": cap_config.get("constraints", {}),
                }
        return result


__all__ = ["ModelParams", "ModelParamsRegistry"]
