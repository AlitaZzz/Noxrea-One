"""
ChannelConfig — 渠道高级设置配置模型。

将用户高级设置 JSON 解析为结构化的 ChannelConfig 对象，
包含 request 和 protocol 两块配置，替代旧的 parse_channel_config 三元组。

config JSON 格式示例：
{
    "request": {
        "mapping": {"reference_images": "extra_body.image"},
        "body_patch": {"response_format": "url"},
        "transforms": {"extra_body.image": "base64"},
        "submit_style": "json",
        "ref_encode": "",
        "ref_field": "image"
    },
    "protocol": {
        "endpoints": {"image.generate": "/images/generations"},
        "unwrap": true,
        "result_mode": "url",
        "result_path": ""
    }
}
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


class RequestConfig(BaseModel):
    """请求构造配置 —— 控制 request_builder 层如何将内部请求转为 Provider 请求体。

    所有字段均为可选，空即为不启用。
    """

    # 提交方式：json（默认，application/json） | multipart（form-data 上传）
    submit_style: str = Field(default="json")

    # 字段映射：{"内部字段名": "目标嵌套路径"} —— 支持改名 + 挪到嵌套位置
    # 例：{"reference_images": "extra_body.image"}
    mapping: dict[str, str | None] = Field(default_factory=dict)

    # 值变换：{"字段路径": "base64"} —— 对指定字段做编码/格式转换
    transforms: dict[str, str] = Field(default_factory=dict)

    # 固定注入：直接 deep merge 到请求体，常用于注入厂商固定参数
    # 例：{"response_format": "url"}
    body_patch: dict[str, Any] = Field(default_factory=dict)

    # 参考图编码方式：""（不编码）| "base64"（base64 编码后内联）
    ref_encode: str = Field(default="")

    # 参考图字段名：ref_urls 映射到的目标字段名，默认 "image"
    ref_field: str = Field(default="image")


class ProtocolConfig(BaseModel):
    """协议配置 —— 控制 Protocol 层的端点、解包、结果提取方式。"""

    # 端点覆盖：{"image.generate": "/custom/path", "image.edit": "/custom/edit"}
    # key 为 operation 名称，value 为自定义端点路径
    endpoints: dict[str, str] = Field(default_factory=dict)

    # 是否解包外层 data 包裹：true 时从 {"data": {...}} 中提取内层
    unwrap: bool = Field(default=False)

    # 结果模式："url"（默认，返回 CDN URL）| "content_endpoint"（需额外请求下载）
    result_mode: str = Field(default="url")

    # 结果路径：指定从响应的哪个嵌套路径取结果
    # 例："output.choices.0" → data["output"]["choices"][0]
    result_path: str = Field(default="")


class ChannelConfig(BaseModel):
    """渠道配置 —— 聚合 request 和 protocol 两块配置。

    由 ChannelConfig.parse() 从用户高级设置 JSON 解析生成。
    """

    request: RequestConfig = Field(default_factory=RequestConfig)
    protocol: ProtocolConfig = Field(default_factory=ProtocolConfig)

    @classmethod
    def parse(cls, raw: dict | None) -> "ChannelConfig":
        """容错解析：从 dict 或 None 生成 ChannelConfig。

        - None → 返回全默认 ChannelConfig
        - 合法 JSON → 按模型校验并填充
        - 非法 JSON → 返回全默认 ChannelConfig（静默降级）
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
