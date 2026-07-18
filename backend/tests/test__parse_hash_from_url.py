"""
test__parse_hash_from_url — 后端 CAS URL hash 解析安全网测试。

覆盖两个实现（现在行为一致，均返回 str | None）：
  - crud/asset.py  _parse_hash_from_url
  - crud/canvas.py _parse_hash_from_url

它们都是纯函数，无数据库依赖，可直接导入测试。
"""

import pytest

from app.crud.asset import _parse_hash_from_url as asset_parse
from app.crud.canvas import _parse_hash_from_url as canvas_parse


# ── 测试用例 ────────────────────────────────────────────────────────────

SHA256_HASH = "a" * 64
SHA256_HASH2 = "b" * 64


class TestAssetParseHash:
    """crud/asset.py _parse_hash_from_url — 返回 str | None（仅 hash）"""

    def test_standard_url(self):
        url = f"http://test/api/files/123/{SHA256_HASH[:2]}/{SHA256_HASH}.png"
        assert asset_parse(url) == SHA256_HASH

    def test_no_extension(self):
        url = f"http://test/api/files/456/{SHA256_HASH[:2]}/{SHA256_HASH}"
        assert asset_parse(url) == SHA256_HASH

    def test_different_host(self):
        url = f"https://cdn.example.com/api/files/7/{SHA256_HASH[:2]}/{SHA256_HASH}.jpg"
        assert asset_parse(url) == SHA256_HASH

    def test_multiple_dot_extensions_not_supported(self):
        """tar.gz 等：rfind('.') 取最后一个点 → {hash}.tar 68 字符 ≠ 64 → None"""
        url = f"http://test/api/files/1/{SHA256_HASH[:2]}/{SHA256_HASH}.tar.gz"
        assert asset_parse(url) is None

    def test_hash_too_short_returns_none(self):
        url = "http://test/api/files/1/ab/short.png"
        assert asset_parse(url) is None

    def test_no_api_files_prefix_returns_none(self):
        url = "http://example.com/file.png"
        assert asset_parse(url) is None

    def test_wrong_path_parts_returns_none(self):
        url = f"http://test/api/files/1/ab/{SHA256_HASH}.png/extra"
        assert asset_parse(url) is None

    def test_empty_url_returns_none(self):
        assert asset_parse("") is None

    def test_none_url_returns_none(self):
        assert asset_parse(None) is None

    def test_invalid_user_id_still_works(self):
        """asset 版本不再解析 user_id，无效 user_id 不影响 hash 提取"""
        url = f"http://test/api/files/not_a_number/{SHA256_HASH[:2]}/{SHA256_HASH}.png"
        assert asset_parse(url) == SHA256_HASH

    def test_url_with_extra_path_after_filename(self):
        url = f"http://test/api/files/1.5/{SHA256_HASH[:2]}/{SHA256_HASH}.png"
        assert asset_parse(url) == SHA256_HASH

    def test_dot_at_start_of_filename(self):
        """rfind('.') 找最后一个点 → hash 部分 71 字符 ≠ 64 → None"""
        url = f"http://test/api/files/1/{SHA256_HASH[:2]}/{SHA256_HASH}.hidden.png"
        assert asset_parse(url) is None

    def test_user_id_zero(self):
        url = f"http://test/api/files/0/{SHA256_HASH[:2]}/{SHA256_HASH}.png"
        assert asset_parse(url) == SHA256_HASH

    def test_very_large_user_id(self):
        url = f"http://test/api/files/9999999999/{SHA256_HASH[:2]}/{SHA256_HASH}.png"
        assert asset_parse(url) == SHA256_HASH


class TestCanvasParseHash:
    """crud/canvas.py _parse_hash_from_url — 返回 str | None（仅 hash）"""

    def test_standard_url(self):
        url = f"http://test/api/files/123/{SHA256_HASH[:2]}/{SHA256_HASH}.png"
        assert canvas_parse(url) == SHA256_HASH

    def test_no_extension(self):
        url = f"http://test/api/files/456/{SHA256_HASH[:2]}/{SHA256_HASH}"
        assert canvas_parse(url) == SHA256_HASH

    def test_different_host(self):
        url = f"https://cdn.example.com/api/files/7/{SHA256_HASH[:2]}/{SHA256_HASH}.jpg"
        assert canvas_parse(url) == SHA256_HASH

    def test_multiple_dot_extensions_not_supported(self):
        """tar.gz 等：rfind('.') 取最后一个点 → {hash}.tar 68 字符 ≠ 64 → None"""
        url = f"http://test/api/files/1/{SHA256_HASH[:2]}/{SHA256_HASH}.tar.gz"
        assert canvas_parse(url) is None

    def test_hash_too_short_returns_none(self):
        url = "http://test/api/files/1/ab/short.png"
        assert canvas_parse(url) is None

    def test_no_api_files_prefix_returns_none(self):
        url = "http://example.com/file.png"
        assert canvas_parse(url) is None

    def test_wrong_path_parts_returns_none(self):
        url = f"http://test/api/files/1/ab/{SHA256_HASH}.png/extra"
        assert canvas_parse(url) is None

    def test_empty_url_returns_none(self):
        assert canvas_parse("") is None

    def test_none_url_returns_none(self):
        assert canvas_parse(None) is None

    def test_invalid_user_id_still_works(self):
        url = f"http://test/api/files/not_a_number/{SHA256_HASH[:2]}/{SHA256_HASH}.png"
        assert canvas_parse(url) == SHA256_HASH

    def test_very_large_user_id(self):
        url = f"http://test/api/files/9999999999/{SHA256_HASH[:2]}/{SHA256_HASH}.png"
        assert canvas_parse(url) == SHA256_HASH


class TestParseHashConsistency:
    """两个实现现在行为一致，均返回 str | None"""

    def test_same_result_for_all_urls(self):
        """多组 URL 两个版本返回相同结果"""
        urls = [
            f"http://test/api/files/42/{SHA256_HASH[:2]}/{SHA256_HASH}.png",
            f"http://test/api/files/99/{SHA256_HASH[:2]}/{SHA256_HASH}",
            f"http://test/api/files/1/{SHA256_HASH2[:2]}/{SHA256_HASH2}.jpg",
            "http://test/api/files/1/ab/short.png",
            "http://example.com/file.png",
            "",
            None,
            f"http://test/api/files/invalid/{SHA256_HASH[:2]}/{SHA256_HASH}.png",
            f"http://test/api/files/1/{SHA256_HASH[:2]}/{SHA256_HASH}.tar.gz",
        ]
        for url in urls:
            assert asset_parse(url) == canvas_parse(url), f"Mismatch for URL: {url}"

    def test_both_correctly_parse_hash(self):
        url = f"http://test/api/files/42/{SHA256_HASH[:2]}/{SHA256_HASH}.png"
        assert asset_parse(url) == SHA256_HASH
        assert canvas_parse(url) == SHA256_HASH

    def test_both_return_none_for_short_hash(self):
        url = "http://test/api/files/1/ab/short.png"
        assert asset_parse(url) is None
        assert canvas_parse(url) is None
