"""技能基类 — 所有推理技能继承此类，框架负责 HTTP 层，技能只关心算法。"""

from abc import ABC, abstractmethod
from typing import Any, Callable


class SkillError(Exception):
    """用户侧错误 → HTTP 400"""
    pass


class SkillProcessingError(Exception):
    """服务端处理失败 → HTTP 500"""
    pass


class BaseSkill(ABC):
    """推理技能抽象基类。

    子类只需定义类属性 + 实现 process() 方法，
    框架自动处理路由注册、鉴权、文件校验、并发控制、错误转换。

    模型通过 _get_model(key) 懒加载获取，不在启动时占用显存。
    """

    # ── 子类必须覆盖 ──
    name: str = ""                          # URL 安全的唯一标识，如 "bg-removal"
    required_models: list[str] = []          # 需要的模型 key 列表

    # ── 子类可选覆盖 ──
    display_name: str = ""                   # 人类可读名称
    accepted_content_types: list[str] = ["image/"]  # 接受的 MIME 前缀
    returns_content_type: str = "image/png"

    def __init__(self) -> None:
        self._get_model: Callable[[str], Any] | None = None

    # ── 框架调用 ──

    def bind_loader(self, get_model: Callable[[str], Any]) -> None:
        """框架在技能发现后调用，传入模型获取函数。

        get_model(key) → 返回模型实例（首次调用时懒加载到显存）。
        线程安全，支持 LRU 自动淘汰。
        """
        self._get_model = get_model

    def validate(self, content_type: str | None, file_size: int) -> None:
        """输入校验。默认检查 content-type 和文件非空。子类可覆盖。"""
        if not content_type:
            raise SkillError("Content-Type header is required")
        if not any(content_type.startswith(prefix) for prefix in self.accepted_content_types):
            raise SkillError(
                f"Unsupported content type '{content_type}'. "
                f"Accepted: {', '.join(self.accepted_content_types)}"
            )
        if file_size == 0:
            raise SkillError("Empty file")

    # ── 子类必须实现 ──

    @abstractmethod
    def process(self, input_bytes: bytes, **kwargs) -> bytes:
        """同步处理逻辑。框架负责放到线程池执行。

        参数：
            input_bytes: 输入图片的原始字节
            **kwargs: 所有额外的表单字段
        返回：
            处理后的图片字节
        """
        ...
