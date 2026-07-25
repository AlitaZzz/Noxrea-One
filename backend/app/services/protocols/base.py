"""
BaseProtocol — 协议抽象基类。

职责严格限制：
- ✓ 构造 HTTP 请求（build_request）
- ✓ 解析同步结果（extract_result → GenerationResult | None）
- ✓ 提取上游 task_id（extract_task_id → str | None）
- ✓ 构造轮询 URL（build_poll_url）
- ✓ 解析轮询响应（parse_poll_response → PollResult）

禁止：
- ✗ while 循环
- ✗ sleep / asyncio.sleep
- ✗ 重试逻辑
- ✗ 任务状态管理（这些由 TaskManager 负责）
"""

from __future__ import annotations

from abc import ABC, abstractmethod

from app.schemas.result import GenerationResult, PollResult


# ── 状态归一化：统一的 pending / completed / failed 集合 ──

PENDING_STATUSES = {
    "pending", "queued", "submitted", "processing", "running", "started", "in_progress",
}

SUCCESS_STATUSES = {
    "success", "succeeded", "completed", "done", "ready", "finished",
}

FAILED_STATUSES = {
    "failed", "error", "cancelled", "canceled", "timeout", "aborted",
}


class BaseProtocol(ABC):
    """协议基类。

    每个具体协议（OpenAI / Gemini / Ark）按 capability（image/video/llm/audio）
    提供子类实现。
    """

    # 协议名称，由子类声明（"openai" / "gemini" / "ark"）
    protocol_name: str = ""

    def __init_subclass__(cls, **kwargs):
        super().__init_subclass__(**kwargs)
        if not cls.protocol_name:
            raise TypeError(f"{cls.__name__} 必须声明 protocol_name")

    # ── 抽象接口 ──────────────────────────────────────────────

    @abstractmethod
    def build_request(
        self,
        base_url: str,
        api_key: str,
        body: dict,
        capability: str,
    ) -> tuple[str, dict, dict]:
        """构造 HTTP 请求。

        Args:
            base_url: 上游服务地址（含 /v1 或其等价前缀）
            api_key: 认证密钥
            body: Adapter 加工后的请求体
            capability: "image" / "video" / "llm" / "audio"

        Returns:
            (endpoint_url, headers, body) — 完整的请求 URL、headers、请求体
        """
        ...

    @abstractmethod
    def extract_result(self, data: dict, capability: str) -> GenerationResult | None:
        """尝试从同步响应中提取结果。

        Args:
            data: 上游返回的 JSON 响应
            capability: "image" / "video" / "llm" / "audio"

        Returns:
            GenerationResult on success, None if this is an async response
        """
        ...

    @abstractmethod
    def supports(self, capability: str) -> bool:
        """该协议是否支持指定能力。"""
        ...

    @abstractmethod
    def build_poll_url(self, base_url: str, upstream_task_id: str) -> str:
        """构造轮询 URL。"""
        ...

    @abstractmethod
    def parse_poll_response(self, data: dict, capability: str) -> PollResult:
        """解析轮询响应。"""
        ...

    # ── 默认实现 ──────────────────────────────────────────────

    def extract_task_id(self, data: dict) -> str | None:
        """从响应中提取上游异步 task_id。

        支持常见 task_id 字段位置：
        1. data["task_id"]
        2. data["data"]["task_id"]
        3. data["data"][0]["task_id"]

        对 "id" 字段谨慎处理：只有当 status 属于 pending 类时才将其视为 task_id，
        避免误判如 {"id":"request_id","status":"completed"}。
        """
        # 1. 顶层 task_id
        tid = data.get("task_id")
        if tid:
            return str(tid)

        # 2. data.task_id
        inner = data.get("data")
        if isinstance(inner, dict):
            tid = inner.get("task_id")
            if tid:
                return str(tid)
        elif isinstance(inner, list) and inner and isinstance(inner[0], dict):
            tid = inner[0].get("task_id")
            if tid:
                return str(tid)

        # 3. "id" 字段：仅当 status 为 pending 类时才接受
        id_val = data.get("id")
        if id_val:
            status = str(data.get("status", "")).lower()
            if status in PENDING_STATUSES:
                return str(id_val)
            # 同时检查 data.status / data[0].status
            if isinstance(inner, dict) and inner.get("id"):
                inner_status = str(inner.get("status", "")).lower()
                if inner_status in PENDING_STATUSES:
                    return str(inner["id"])
            elif isinstance(inner, list) and inner and isinstance(inner[0], dict):
                inner_id = inner[0].get("id")
                inner_status = str(inner[0].get("status", "")).lower()
                if inner_id and inner_status in PENDING_STATUSES:
                    return str(inner_id)

        return None

    # ── 工具方法 ──────────────────────────────────────────────

    @staticmethod
    def build_endpoint(api_base: str, suffix: str) -> str:
        """拼接 base_url 与 endpoint suffix。base_url 需含 /v1，suffix 只写 /v1 之后的路径。"""
        return api_base.rstrip("/") + suffix

    @staticmethod
    def normalize_status(raw: str) -> str:
        """将上游状态统一归一化到 pending / completed / failed。"""
        s = raw.lower().strip()
        if s in PENDING_STATUSES:
            return "pending"
        if s in SUCCESS_STATUSES:
            return "completed"
        if s in FAILED_STATUSES:
            return "failed"
        return s  # 未知状态原样返回

    @staticmethod
    def _unwrap(data: dict) -> dict | list | None:
        """解掉 {code, data} 或顶层 data 的外层包裹。

        如果响应顶层有 "data" 键且值为 dict/list，则返回内层 data；
        否则返回原始数据。兼容：
        - 扁平响应（标准 OpenAI）：{"status":"succeeded","output":[...]} → 原样返回
        - 包裹响应（APIMart/Ark）：{"code":200,"data":{"status":"completed",...}} → 解包为内层
        """
        inner = data.get("data")
        if isinstance(inner, (dict, list)):
            return inner
        return data


# ── 协议注册表 ────────────────────────────────────────────────

class ProtocolRegistry:
    """协议注册表：按 protocol_name + capability 查找协议实例。"""

    _protocols: dict[str, dict[str, BaseProtocol]] = {}  # {protocol_name: {capability: instance}}

    @classmethod
    def register(cls, proto: BaseProtocol, capability: str) -> None:
        """注册一个协议实例到指定 capability。"""
        name = proto.protocol_name
        if name not in cls._protocols:
            cls._protocols[name] = {}
        cls._protocols[name][capability] = proto

    @classmethod
    def get(cls, protocol_name: str, capability: str) -> BaseProtocol | None:
        """按协议名 + 能力查找协议实例。"""
        return cls._protocols.get(protocol_name, {}).get(capability)

    @classmethod
    def list_capabilities(cls, protocol_name: str) -> list[str]:
        """列出指定协议支持的所有能力。"""
        return list(cls._protocols.get(protocol_name, {}).keys())

    @classmethod
    def list_protocols(cls) -> list[str]:
        return list(cls._protocols.keys())
