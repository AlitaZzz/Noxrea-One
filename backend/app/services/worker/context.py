"""单任务执行上下文。"""

from dataclasses import dataclass, field

from app.models.task import GenerationTask


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
    adapter: str | None = None
    capability: str | None = None
    parameter_mapping: dict | None = None
    endpoint_mapping: dict | None = None
    override_json: dict | None = None
