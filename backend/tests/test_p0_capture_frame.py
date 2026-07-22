"""
P0: capture_frame 成功路径 NameError。

files.py 的 capture_frame 在抽帧成功后执行：
    logger.info(f"... time={time}s ...")
但模块未 import time，局部变量实为 seek_time。修复前成功路径必崩 500（帧已落盘却拿不到 url）。
"""

import os

import pytest

import app.routers.files as files_mod


@pytest.mark.asyncio
async def test_capture_frame_returns_200(async_client, monkeypatch):
    """抽帧成功应返回 200 + url，而非 500 NameError。"""
    # 1. 上传一段 mp4 拿到合法 video url（validate_user_file 需要路径在用户目录下）
    video_bytes = b"\x00\x00\x00\x20ftypmp42"
    r_up = await async_client.post(
        "/api/files/upload?category=videos",
        files={"file": ("clip.mp4", video_bytes, "video/mp4")},
    )
    assert r_up.status_code == 200, r_up.text
    video_url = r_up.json()["data"]["url"]

    # 2. mock extract_video_frame，免依赖 ffmpeg，返回一个有效路径字符串
    def fake_extract(video_path, timestamp, output_dir, timeout=30):
        return os.path.join(output_dir, "frame.png")

    monkeypatch.setattr(files_mod, "extract_video_frame", fake_extract)

    # 3. 调 capture-frame：修复前此处置 500（NameError: name 'time' is not defined）
    r = await async_client.post(
        "/api/files/capture-frame",
        json={"url": video_url, "time": 1.5},
    )
    assert r.status_code == 200, f"expected 200, got {r.status_code}: {r.text}"
    assert "url" in r.json()["data"]
