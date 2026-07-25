"""
__init__.py - app.services.storage 包的对外入口。

依赖方向（单向链路，不跨层）：
    service.py ──► download.py ──► persist.py

- persist.py   : 底层 save_upload_bytes（落盘 + SHA256 去重 + 写 file_objects）
- download.py  : download_and_save（CDN 下载 + 落盘）、save_bytes（直接存 bytes）
- service.py   : StorageService 编排层（下载/批量下载/直接存 bytes），供 worker 调用

本文件再导出 save_upload_bytes，保持 `from app.services.storage import save_upload_bytes` 可用。
"""

from .persist import save_upload_bytes

__all__ = ["save_upload_bytes"]
