"""Worker 后台任务包。

职责边界：
  - loop.py     纯后台调度（轮询领取 / 并发派发 / 僵尸清理）
  - executor.py 单任务生命周期执行（channel 解析 / SSRF / gateway 分发 / bg_removal / 结果存储）
  - context.py  ExecutionContext 数据容器

向后兼容：`from app.services.worker import worker_loop`（main.py 等入口零改动）。
"""

from app.services.worker.loop import worker_loop

__all__ = ["worker_loop"]
