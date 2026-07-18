"""
test_service_media — services/media.py 单元测试。

通过 mock 避免真实调用 PIL 和 ffmpeg/子进程。
"""

import os
import pytest
import tempfile
from unittest.mock import patch, MagicMock, mock_open
from pathlib import Path

from app.services.media import (
    UPLOAD_DIR,
    resize_and_cache_image,
    extract_video_frame,
    validate_user_file,
    get_ffmpeg_path,
)


class TestGetFfmpegPath:
    def test_returns_string(self):
        path = get_ffmpeg_path()
        assert isinstance(path, str)
        assert "ffmpeg" in path.lower() or "ffmpeg".lower() in path.lower()


class TestValidateUserFile:
    def setup_method(self):
        self.tmpdir = tempfile.mkdtemp()
        # Create files in uploads/{user_id}/ structure
        self.user_id = 42
        self.user_dir = os.path.join(self.tmpdir, str(self.user_id))
        os.makedirs(self.user_dir, exist_ok=True)
        self.test_file = os.path.join(self.user_dir, "test.png")
        with open(self.test_file, "wb") as f:
            f.write(b"fake-png-data")

    def test_valid_file(self):
        with patch("app.services.media.UPLOAD_DIR", self.tmpdir):
            rel = f"{self.user_id}/test.png"
            result = validate_user_file(rel, self.user_id)
            assert os.path.normpath(result) == os.path.normpath(self.test_file)

    def test_file_not_found(self):
        with patch("app.services.media.UPLOAD_DIR", self.tmpdir):
            with pytest.raises(FileNotFoundError):
                validate_user_file("42/nonexistent.png", 42)

    def test_permission_denied(self):
        with patch("app.services.media.UPLOAD_DIR", self.tmpdir):
            with pytest.raises(PermissionError):
                # File belongs to user 42, but requesting as user 99
                validate_user_file("42/test.png", 99)


class TestResizeAndCacheImage:
    def setup_method(self):
        self.tmpdir = tempfile.mkdtemp()
        self.src_path = os.path.join(self.tmpdir, "source.png")
        # Create a minimal valid PNG (1x1 red pixel)
        self._create_minimal_png(self.src_path)
        self.cache_dir = os.path.join(self.tmpdir, "_cache")

    def _create_minimal_png(self, path):
        """Create a minimal valid PNG for PIL to open."""
        import struct, zlib

        def _chunk(ctype, data):
            c = ctype + data
            return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c) & 0xFFFFFFFF)

        sig = b"\x89PNG\r\n\x1a\n"
        ihdr = _chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0))
        raw = zlib.compress(b"\x00\xff\x00\x00")
        idat = _chunk(b"IDAT", raw)
        iend = _chunk(b"IEND", b"")
        with open(path, "wb") as f:
            f.write(sig + ihdr + idat + iend)

    def test_normal_resize(self):
        with patch("app.services.media.UPLOAD_DIR", self.tmpdir):
            result = resize_and_cache_image(self.src_path, 100, self.cache_dir)
        assert result is not None
        assert os.path.isfile(result)
        assert result.endswith(".webp")

    def test_cache_hit(self):
        with patch("app.services.media.UPLOAD_DIR", self.tmpdir):
            # First call generates cache
            result1 = resize_and_cache_image(self.src_path, 50, self.cache_dir)
            # Second call should hit cache
            result2 = resize_and_cache_image(self.src_path, 50, self.cache_dir)
            assert result1 == result2
            assert os.path.isfile(result1)

    def test_non_image_ext_returns_none(self):
        path = os.path.join(self.tmpdir, "document.pdf")
        with open(path, "w") as f:
            f.write("not an image")
        result = resize_and_cache_image(path, 100, self.cache_dir)
        assert result is None

    def test_pil_error_returns_none(self):
        # Corrupt file — PIL will raise on open
        bad_path = os.path.join(self.tmpdir, "corrupt.png")
        with open(bad_path, "wb") as f:
            f.write(b"not-a-real-png-file-at-all")
        with patch("app.services.media.UPLOAD_DIR", self.tmpdir):
            # Should log warning and return None, not raise
            result = resize_and_cache_image(bad_path, 100, self.cache_dir)
        assert result is None

    def test_multiple_widths_generate_separate_cache(self):
        with patch("app.services.media.UPLOAD_DIR", self.tmpdir):
            w100 = resize_and_cache_image(self.src_path, 100, self.cache_dir)
            w200 = resize_and_cache_image(self.src_path, 200, self.cache_dir)
        assert w100 != w200
        assert os.path.isfile(w100)
        assert os.path.isfile(w200)


class TestExtractVideoFrame:
    def setup_method(self):
        self.tmpdir = tempfile.mkdtemp()
        self.video_path = os.path.join(self.tmpdir, "test.mp4")
        with open(self.video_path, "wb") as f:
            f.write(b"fake-video-data")
        self.out_dir = os.path.join(self.tmpdir, "frames")
        self.ffmpeg = "/tmp/test_ffmpeg"  # won't exist, patched below

    @patch("subprocess.run")
    @patch("app.services.media.os.path.isfile", return_value=True)
    def test_normal_extraction(self, mock_isfile, mock_run):
        mock_run.return_value = MagicMock()
        result = extract_video_frame(self.video_path, 10.5, self.out_dir, ffmpeg_bin=self.ffmpeg)
        assert result is not None
        assert os.path.dirname(result) == self.out_dir
        assert result.endswith(".png")
        mock_run.assert_called_once()
        args = mock_run.call_args[0][0]
        assert "-ss" in args
        assert "10.5" in args
        assert "-vframes" in args

    @patch("subprocess.run")
    @patch("app.services.media.os.path.isfile", return_value=True)
    def test_timeout_raises(self, mock_isfile, mock_run):
        import subprocess as _sp
        mock_run.side_effect = _sp.TimeoutExpired(cmd="ffmpeg", timeout=30)
        with pytest.raises(_sp.TimeoutExpired):
            extract_video_frame(self.video_path, 5, self.out_dir, ffmpeg_bin=self.ffmpeg, timeout=30)

    @patch("subprocess.run")
    @patch("app.services.media.os.path.isfile", return_value=True)
    def test_ffmpeg_failure_raises(self, mock_isfile, mock_run):
        import subprocess as _sp
        mock_run.side_effect = _sp.CalledProcessError(
            returncode=1, cmd="ffmpeg", stderr=b"Decoder not found"
        )
        with pytest.raises(RuntimeError, match="Decoder not found"):
            extract_video_frame(self.video_path, 5, self.out_dir, ffmpeg_bin=self.ffmpeg)

    def test_ffmpeg_not_found_raises(self):
        with pytest.raises(FileNotFoundError, match="ffmpeg not found"):
            extract_video_frame(
                self.video_path, 5, self.out_dir,
                ffmpeg_bin="/nonexistent/ffmpeg",
            )

    @patch("subprocess.run")
    @patch("app.services.media.os.path.isfile", return_value=True)
    @patch("app.services.media.get_ffmpeg_path", return_value="/usr/local/bin/ffmpeg")
    def test_auto_ffmpeg_path(self, mock_get_path, mock_isfile, mock_run):
        """Without passing ffmpeg_bin, it should auto-detect."""
        mock_run.return_value = MagicMock()
        result = extract_video_frame(self.video_path, 0, self.out_dir)
        assert result is not None
        mock_get_path.assert_called_once()
