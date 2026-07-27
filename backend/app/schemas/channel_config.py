"""
ChannelConfig - 渠道高级设置配置模型。

将用户高级设置 JSON 解析为结构化的 ChannelConfig 对象，
包含 request 和 protocol 两块配置。

config JSON 格式示例：
{
    "request": {
        "mapping": {"reference_images": "extra_body.image"},
        "body_patch": {"response_format": "url"},
        "model_overrides": {
            "gpt-image-*": {"mapping": {"ratio": "size"}}
        }
    },
    "protocol": {
        "endpoints": {"image.generate": "/images/generations"},
        "unwrap": true
    }
}
"""

from __future__ import annotations

import fnmatch
from typing import Any

from pydantic import BaseModel, Field


class RequestConfig(BaseModel):
    """请求构造配置 -- 控制 request_builder 层如何将内部请求转为 Provider 请求体。

    所有字段均为可选，空即为不启用。
    """

    # 提交方式：json（默认，application/json） | multipart（form-data 上传）
    # TODO: 暂未使用，预留字段
    submit_style: str = Field(default="json")

    # 字段映射：{"内部字段名": "目标嵌套路径"} -- 支持改名 + 挪到嵌套位置
    # 例：{"reference_images": "extra_body.image"}
    # target=None 即删除该字段
    mapping: dict[str, str | None] = Field(default_factory=dict)

    # 固定注入：直接 deep merge 到请求体，常用于注入厂商固定参数
    # 例：{"response_format": "url"}
    body_patch: dict[str, Any] = Field(default_factory=dict)

    # 按模型覆盖：key 支持通配符（fnmatch），value 为 {mapping, body_patch} 覆盖
    # 例：{"gpt-image-*": {"mapping": {"ratio": "size"}}}
    model_overrides: dict[str, dict] = Field(default_factory=dict)


class ProtocolConfig(BaseModel):
    """协议配置 -- 控制 Protocol 层的端点、解包、结果提取方式。"""

    # 端点覆盖：{"image.generate": "/custom/path", "image.edit": "/custom/edit"}
    # key 为 operation 名称，value 为自定义端点路径
    endpoints: dict[str, str] = Field(default_factory=dict)

    # 是否解包外层 data 包裹：true 时从 {"data": {...}} 中提取内层
    unwrap: bool = Field(default=False)

    # 结果模式："url"（默认，返回 CDN URL）| "content_endpoint"（需额外请求下载）
    # TODO: 暂未使用，预留字段
    result_mode: str = Field(default="url")

    # 结果路径：指定从响应的哪个嵌套路径取结果
    # 例："output.choices.0" -> data["output"]["choices"][0]
    # TODO: 暂未使用，预留字段
    result_path: str = Field(default="")


def _deep_merge_dicts(base: dict, override: dict) -> dict:
    """递归合并两个 dict，override 中的值覆盖 base。"""
    result = dict(base)
    for key, val in override.items():
        if key in result and isinstance(result[key], dict) and isinstance(val, dict):
            result[key] = _deep_merge_dicts(result[key], val)
        else:
            result[key] = val
    return result


def _match_override(model_name: str, overrides: dict) -> dict | None:
    """fnmatch 匹配 model_overrides，优先精确名，其次通配符。"""
    if model_name in overrides:
        return overrides[model_name]
    for pattern, cfg in overrides.items():
        if "*" in pattern or "?" in pattern:
            if fnmatch.fnmatch(model_name, pattern):
                return cfg
    return None


class ChannelConfig(BaseModel):
    """渠道配置 -- 聚合 request 和 protocol 两块配置。

    由 ChannelConfig.parse() 从用户高级设置 JSON 解析生成。
    """

    request: RequestConfig = Field(default_factory=RequestConfig)
    protocol: ProtocolConfig = Field(default_factory=ProtocolConfig)

    @classmethod
    def parse(cls, raw: dict | None) -> "ChannelConfig":
        """容错解析：从 dict 或 None 生成 ChannelConfig。

        - None -> 返回全默认 ChannelConfig
        - 合法 JSON -> 按模型校验并填充
        - 非法 JSON -> 返回全默认 ChannelConfig（静默降级）
        """
        if not raw:
            return cls()
        try:
            return cls.model_validate(raw)
        except Exception:
            return cls()

    def get_endpoint_override(self, operation: str) -> str | None:
        """获取指定 operation 的自定义端点路径。

        Args:
            operation: "image.generations" / "image.edits" / "video.generate" / "llm.chat" / "audio.speech"

        Returns:
            自定义路径或 None（使用 Protocol 默认端点）
        """
        return self.protocol.endpoints.get(operation)

    def resolve_request(self, model_name: str) -> RequestConfig:
        """返回 base config + model_overrides merge 后的 RequestConfig。

        - model_overrides 为空 -> 直接返回 base
        - 有 override -> fnmatch 匹配，mapping/body_patch 浅 merge
        """
        if not self.request.model_overrides:
            return self.request

        override = _match_override(model_name, self.request.model_overrides)
        if not override:
            return self.request

        return RequestConfig(
            submit_style=override.get("submit_style", self.request.submit_style),
            mapping={**self.request.mapping, **override.get("mapping", {})},
            body_patch=_deep_merge_dicts(
                self.request.body_patch, override.get("body_patch", {})
            ),
        )
