"""
P0: get_file 路径穿越拦截。

get_file 是公开接口（无鉴权），原实现 os.path.join(UPLOAD_DIR, filepath) 无穿越校验，
../../etc/passwd 可逃出 uploads/ 读任意文件。修复后用 realpath 守卫，越界统一 404。

正常路径读取由 test_supplement_2_file_resize.py::test_get_file_returns_content 覆盖，
此处只验证穿越拦截与「合法相对路径不被误伤」。
"""

import pytest
from fastapi import HTTPException

from app.routers.files import get_file

# 真含 .. 的穿越路径：realpath 解析后会逃出 UPLOAD_DIR
TRAVERSAL_PATHS = [
    "../../etc/passwd",
    "../../../Windows/win.ini",
    "../../../" + "etc/shadow",
    "sub/../../etc/passwd",
    "../" * 8 + "secret.txt",
]


@pytest.mark.asyncio
@pytest.mark.parametrize("evil", TRAVERSAL_PATHS)
async def test_get_file_rejects_traversal(evil):
    """穿越路径解析后逃出 UPLOAD_DIR，应统一返回 404（不暴露存在性）。"""
    with pytest.raises(HTTPException) as exc:
        await get_file(evil, w=None)
    assert exc.value.status_code == 404


@pytest.mark.asyncio
async def test_get_file_missing_inside_upload_dir_not_misjudged():
    """合法相对路径（无 ..）即使文件不存在，也走正常 404，不被守卫误判为穿越。"""
    with pytest.raises(HTTPException) as exc:
        await get_file("1/ab/ab0123456789abcdef_nonexistent.png", w=None)
    assert exc.value.status_code == 404
