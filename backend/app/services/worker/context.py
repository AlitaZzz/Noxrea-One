"""单任务执行上下文。

重构后使用 ChannelConfig 对象替代裸 dict 三元组。
"""

from dataclasses import dataclass, field

from app.models.task import GenerationTask
from app.schemas.channel_config import ChannelConfig


@dataclass
class ExecutionContext:
    """单任务执行上下文（纯数据容器）。

    Worker 从数据库读取 channel 配置后填入此结构，
    executor 透传给 gateway，不包含资源句柄。
    """

    task: GenerationTask
    config: dict
    model: str
    base_url: str
    api_key: str
    protocol: str | None = None
    capability: str | None = None
    channel_config: ChannelConfig = field(default_factory=ChannelConfig)
