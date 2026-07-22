"""
模型能力推断服务。

数据来源：OpenRouter 模型列表（本地缓存 backend/app/data/openrouter_models.json）。
该列表每个模型带 `architecture.output_modalities`（text/image/audio/video），
与本项目的 4 个能力维度一一对应，是最可靠的能力数据源。

推断三级优先级：
  1. OpenRouter 索引命中（按 全名 或 去前缀名 查）：用 output_modalities 映射。
  2. 静态白名单兜底：本地 model_capabilities_whitelist.json（人工维护）命中，
     按全名或去前缀名做包含(子串)匹配；用于 OpenRouter 索引未收录的模型（如视频生成模型）。
  3. 都无：返回空，留给用户在 UI 手动勾选。

注：不再使用模型名关键字兜底，能力只来自 OpenRouter 索引 + 人工维护的白名单。

注意：视频生成模型（wan/veo/sora 等）不在标准 /models 列表里（独立 /videos 端点），
因此 video 几乎只能靠命名兜底命中。
"""

from __future__ import annotations

import json
import logging
import os
from typing import Any, Dict, List

logger = logging.getLogger(__name__)

# 标准输出模态 -> 本项目能力
_VALID_CAPS = ("text", "image", "audio", "video")

_DATA_FILE = os.path.join(os.path.dirname(os.path.dirname(__file__)), "data", "openrouter_models.json")
_WHITELIST_FILE = os.path.join(os.path.dirname(os.path.dirname(__file__)), "data", "model_capabilities_whitelist.json")


def load_records() -> list:
    """读取本地缓存文件（约 517K）。由调用方在「一次拉取」时读取一次，匹配在内存进行，不跨请求缓存。"""
    try:
        with open(_DATA_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
    except FileNotFoundError:
        logger.warning("model_capabilities: 数据文件缺失 %s，仅使用命名兜底", _DATA_FILE)
        return []
    except Exception as e:  # noqa: BLE001
        logger.warning("model_capabilities: 加载失败 %s: %s", _DATA_FILE, e)
        return []
    return data.get("data", [])


def load_whitelist() -> list:
    """
    读取人工维护的静态能力白名单（model_capabilities_whitelist.json）。
    返回 [(能力, 条目小写), ...]，供「一次拉取」时读取一次，匹配在内存进行。
    匹配为「包含(子串)」：模型名或其去前缀名包含某条目即命中。
    文件缺失/损坏时返回空 list，退化为仅用命名兜底。
    """
    try:
        with open(_WHITELIST_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
    except FileNotFoundError:
        logger.warning("model_capabilities: 白名单文件缺失 %s，跳过白名单兜底", _WHITELIST_FILE)
        return []
    except Exception as e:  # noqa: BLE001
        logger.warning("model_capabilities: 白名单加载失败 %s: %s", _WHITELIST_FILE, e)
        return []

    entries = []
    for cap in _VALID_CAPS:
        for raw in (data.get(cap) or []):
            name = str(raw).strip().lower()
            if name:
                entries.append((cap, name))
    return entries


def _find_whitelist(whitelist: list, model_id: str) -> List[str]:
    """
    包含(子串)匹配：模型全名或其去前缀名（'/' 最后一段）包含白名单条目即命中，
    返回排序后的能力列表。例如白名单 "veo3" 可命中 "google/veo3-fast"。
    """
    if not whitelist or not model_id:
        return []
    low = model_id.lower()
    candidates = (low, low.split("/")[-1])
    caps = set()
    for cap, entry in whitelist:
        if any(entry in c for c in candidates):
            caps.add(cap)
    return [c for c in _VALID_CAPS if c in caps]


def _find_record(records: list, model_id: str):
    """按全名或去前缀名查找模型记录。"""
    stripped = model_id.split("/")[-1]
    for rec in records:
        mid = rec.get("id")
        if mid == model_id or mid == stripped:
            return rec
    return None


def _capabilities_from_record(rec: dict) -> List[str]:
    arch = rec.get("architecture") or {}
    out = arch.get("output_modalities") or []
    caps = set()
    for mod in out:
        if mod in _VALID_CAPS:
            caps.add(mod)
    # 语音合成：supported_voices 非空即判 audio
    if rec.get("supported_voices"):
        caps.add("audio")
    return [c for c in _VALID_CAPS if c in caps]


def infer_capabilities(model_id: str, records: list | None = None, whitelist: list | None = None) -> Dict[str, Any]:
    """
    返回 { "suggested": ModelCapability[], "source": "openrouter" | "whitelist" | "none" }
    source 含义：
      - openrouter: 命中本地 OpenRouter 索引，按 output_modalities 映射
      - whitelist:  索引未命中但命中人工维护的静态白名单（model_capabilities_whitelist.json）
      - none:       OpenRouter 索引与白名单都无线索，需用户在 UI 手动勾选

    不再使用模型名关键字兜底：能力来源只认 OpenRouter 索引 + 人工维护的白名单。
    records / whitelist: 均由调用方在「一次拉取」时通过 load_records() / load_whitelist()
                         读取一次后传入，匹配在内存进行；为 None 时退化为本次调用内读取一次
                         （仍不跨请求缓存）。
    """
    if not model_id:
        return {"suggested": [], "source": "none"}

    if records is None:
        records = load_records()
    if records:
        rec = _find_record(records, model_id)
        if rec:
            caps = _capabilities_from_record(rec)
            # output_modalities 至少包含 text（绝大多数 LLM），命中即给 text
            if caps:
                return {"suggested": caps, "source": "openrouter"}

    # 索引未覆盖（如视频生成模型）时，用人工维护的静态白名单兜底
    wl_caps = _find_whitelist(whitelist, model_id)
    if wl_caps:
        return {"suggested": wl_caps, "source": "whitelist"}

    return {"suggested": [], "source": "none"}
