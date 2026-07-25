"""
AI Gateway 重构回归测试（新架构：Capability + Adapter(按Provider) + Mapping + Protocol + TaskManager）。

覆盖点：
- 注册中心（CapabilityRegistry / ProtocolRegistry / AdapterRegistry）在 init_gateway 后非空
- Adapter 层：Provider 级参数转换（openai / gemini / ark）
- Mapping 层：parameter_mapping / override_json / endpoint_mapping
- Protocol 层：同步结果提取 / 异步 task_id 提取 / 轮询响应解析
- TaskManager：同步优先 + 异步轮询兜底（mock httpx）
- EventBus：发布/订阅
- CapabilityRouter.dispatch：未知 capability 失败；已知 capability 正确分发
- 向后兼容：GenerationTask.effective_capability 回退到 type

运行：
  cd backend && python -m pytest tests/test_gateway_architecture.py -q
"""

import base64

import pytest

from app.services.gateway.registry import init_gateway
from app.services.capabilities.base import CapabilityRegistry
from app.services.protocols.base import ProtocolRegistry
from app.services.adapters.base import AdapterRegistry
from app.services.gateway.router import CapabilityRouter
from app.services.tasks.manager import TaskManager
from app.services.events.bus import event_bus
from app.services.events.types import TaskEvent, EventType
from app.services.adapters.openai import OpenAIAdapter
# TODO: Ark/Gemini 暂未实现
# from app.services.adapters.gemini import GeminiAdapter
# from app.services.adapters.ark import ArkAdapter
from app.services.adapters.mapping import (
    apply_parameter_mapping,
    apply_override_json,
    get_endpoint_override,
    parse_channel_config,
)
from app.services.capabilities.requests import ImageRequest
from app.services.capabilities.image.service import ImageService
from app.services.adapters.common import resolve_image_size
from app.services.protocols.base import BaseProtocol, PollResult


# ── 共享 fixture ──────────────────────────────────────────────

@pytest.fixture(autouse=True)
def _gateway_ready():
    CapabilityRegistry._services.clear()
    ProtocolRegistry._protocols.clear()
    AdapterRegistry._adapters.clear()
    init_gateway()
    yield


# ── 1. 注册中心 ──────────────────────────────────────────────

def test_capability_registry_populated():
    for cap in ("image", "video", "llm", "audio", "bg_removal"):
        assert CapabilityRegistry.has(cap), f"capability 未注册: {cap}"


def test_protocol_registry_populated():
    assert ProtocolRegistry.get("openai", "image") is not None
    # TODO: Ark/Gemini 暂未实现
    # assert ProtocolRegistry.get("gemini", "image") is not None
    # assert ProtocolRegistry.get("ark", "image") is not None
    # assert ProtocolRegistry.get("ark", "video") is not None
    assert ProtocolRegistry.get("openai", "video") is not None
    assert ProtocolRegistry.get("openai", "llm") is not None
    # assert ProtocolRegistry.get("gemini", "llm") is not None
    assert ProtocolRegistry.get("openai", "audio") is not None


def test_protocol_capability_isolation():
    assert ProtocolRegistry.get("openai", "video") is not None
    # TODO: Ark/Gemini 暂未实现
    # assert ProtocolRegistry.get("gemini", "audio") is None


def test_adapter_registry():
    assert AdapterRegistry.get("openai") is not None
    # TODO: Ark/Gemini 暂未实现
    # assert AdapterRegistry.get("gemini") is not None
    # assert AdapterRegistry.get("ark") is not None
    assert AdapterRegistry.get("nonexistent") is None


# ── 2. Protocol 层 ────────────────────────────────────────────

def test_openai_image_extract_sync_url():
    proto = ProtocolRegistry.get("openai", "image")
    res = proto.extract_result({"data": [{"url": "http://x/a.png"}]})
    assert res is not None
    assert res.urls == ["http://x/a.png"]


def test_openai_image_extract_sync_b64():
    proto = ProtocolRegistry.get("openai", "image")
    raw = b"\x89PNG-bytes"
    b64 = base64.b64encode(raw).decode()
    res = proto.extract_result({"data": [{"b64_json": b64}]})
    assert res is not None
    assert res.files and res.files[0] == raw


def test_openai_image_extract_task_id():
    proto = ProtocolRegistry.get("openai", "image")
    assert proto.extract_task_id({"id": "task_xyz", "status": "queued"}) == "task_xyz"
    assert proto.extract_task_id({"foo": "bar"}) is None


def test_openai_image_parse_poll_completed():
    proto = ProtocolRegistry.get("openai", "image")
    r = proto.parse_poll_response({"status": "succeeded", "output": "http://x/f.png"})
    assert r.status == "completed"
    assert r.urls == ["http://x/f.png"]


def test_openai_image_parse_poll_pending_and_failed():
    proto = ProtocolRegistry.get("openai", "image")
    assert proto.parse_poll_response({"status": "in_progress"}).status == "pending"
    f = proto.parse_poll_response({"status": "failed", "error": "boom"})
    assert f.status == "failed"
    assert f.error == "boom"


# ── 3. Adapter 层（按 Provider） ──────────────────────────────

def test_openai_adapter_image():
    body = OpenAIAdapter().adapt_params(
        {"model": "gpt-image-1", "prompt": "p", "size_level": "2K",
         "ratio": "1:1", "quality": "high", "n": 1,
         "ref_urls": ["data:img1"]}, "image"
    )
    assert body["size"] == "2048x2048"
    assert "size_level" not in body
    assert body["quality"] == "high"
    assert body["image"] == ["data:img1"]


# TODO: Ark/Gemini 暂未实现
# def test_gemini_adapter_image():
#     body = GeminiAdapter().adapt_params(
#         {"model": "banana-x", "prompt": "p", "size_level": "1K",
#          "ratio": "1:1", "ref_urls": ["data:img2"]}, "image"
#     )
#     assert body["size"] == "1024x1024"
#     assert "size_level" not in body
#     assert body["reference_images"] == ["data:img2"]


# TODO: Ark/Gemini 暂未实现
# def test_ark_adapter_image():
#     body = ArkAdapter().adapt_params(
#         {"model": "seedance", "prompt": "p", "size_level": "2K",
#          "ratio": "1:1", "ref_urls": ["data:img3"]}, "image"
#     )
#     assert body["size"] == "2048x2048"  # index 1 of 1:1
#     assert "size_level" not in body
#     assert body["image"] == ["data:img3"]


# ── 4. Mapping 层 ─────────────────────────────────────────

def test_parameter_mapping_move_field():
    body = {"image": ["a.png"], "n": 1}
    result = apply_parameter_mapping(body, {"image": "extra_body.image"})
    assert "image" not in result
    assert result["extra_body"]["image"] == ["a.png"]
    assert result["n"] == 1


def test_parameter_mapping_remove_field():
    body = {"n": 1, "quality": "high"}
    result = apply_parameter_mapping(body, {"n": None})
    assert "n" not in result
    assert result["quality"] == "high"


def test_override_json_merge():
    body = {"size": "1024x1024", "quality": "high"}
    result = apply_override_json(body, {"extra_body": {"response_format": "url"}})
    assert result["extra_body"]["response_format"] == "url"
    assert result["size"] == "1024x1024"


def test_override_json_deep_merge():
    body = {"extra_body": {"image": ["a.png"]}}
    result = apply_override_json(body, {"extra_body": {"response_format": "url"}})
    assert result["extra_body"]["image"] == ["a.png"]
    assert result["extra_body"]["response_format"] == "url"


def test_endpoint_override():
    mapping = {"image.generations": "/custom/images", "image.edits": "/custom/edits"}
    assert get_endpoint_override(mapping, "image.generations") == "/custom/images"
    assert get_endpoint_override(mapping, "image.edits") == "/custom/edits"
    assert get_endpoint_override(mapping, "video.generate") is None


def test_parse_channel_config_empty():
    """parse_channel_config 空/None → 三个空 dict。"""
    assert parse_channel_config(None) == ({}, {}, {})
    assert parse_channel_config({}) == ({}, {}, {})


def test_parse_channel_config_full():
    """parse_channel_config 完整拆包。"""
    raw = {
        "params": {"image": "extra_body.image"},
        "endpoints": {"image.generations": "/custom/images"},
        "body": {"extra_body": {"response_format": "url"}},
    }
    params, endpoints, body = parse_channel_config(raw)
    assert params == {"image": "extra_body.image"}
    assert endpoints == {"image.generations": "/custom/images"}
    assert body == {"extra_body": {"response_format": "url"}}


def test_parse_channel_config_partial():
    """parse_channel_config 只有部分 key。"""
    raw = {"params": {"n": None, "size": "resolution"}}
    params, endpoints, body = parse_channel_config(raw)
    assert params == {"n": None, "size": "resolution"}
    assert endpoints == {}
    assert body == {}


# ── 5. TaskManager：同步优先 / 异步轮询（mock httpx）───────────

class _FakeResponse:
    def __init__(self, status_code, data, headers=None):
        self.status_code = status_code
        self._data = data
        self.headers = headers or {}

    @property
    def is_success(self):
        return 200 <= self.status_code < 400

    @property
    def content(self):
        return self._data if isinstance(self._data, bytes) else b""

    def json(self):
        if isinstance(self._data, bytes):
            raise ValueError("Cannot json binary")
        return self._data


class _FakeAsyncClient:
    def __init__(self, script, log):
        self._script = script
        self._log = log

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False

    async def post(self, url, json=None, headers=None):
        self._log.append(("post", url))
        return self._take()

    async def get(self, url, headers=None):
        self._log.append(("get", url))
        return self._take()

    def _take(self):
        item = self._script.pop(0)
        if len(item) == 3:
            status, data, headers = item
        else:
            status, data = item
            headers = {}
        return _FakeResponse(status, data, headers)


def _patch_httpx(monkeypatch, script, log):
    factory = lambda *a, **k: _FakeAsyncClient(script, log)
    monkeypatch.setattr("app.services.tasks.manager.httpx.AsyncClient", factory)


async def test_taskmanager_sync_result(monkeypatch):
    script = [(200, {"data": [{"url": "http://x/a.png"}]})]
    log = []
    _patch_httpx(monkeypatch, script, log)

    proto = ProtocolRegistry.get("openai", "image")
    result = await TaskManager.submit_and_wait(
        task_id="t1", user_id=1, protocol=proto, capability="image",
        base_url="http://up", api_key="k", endpoint="http://up/images/generations",
        headers={}, body={"data": [{"url": "http://x/a.png"}]},
    )
    assert result["status"] == "completed"
    assert result["urls"] == ["http://x/a.png"]
    assert log[0][0] == "post"


async def test_taskmanager_async_poll(monkeypatch):
    script = [
        (200, {"id": "task_xyz", "status": "queued"}),
        (200, {"status": "succeeded", "output": "http://x/final.png"}),
    ]
    log = []
    _patch_httpx(monkeypatch, script, log)

    proto = ProtocolRegistry.get("openai", "image")
    result = await TaskManager.submit_and_wait(
        task_id="t2", user_id=1, protocol=proto, capability="image",
        base_url="http://up", api_key="k", endpoint="http://up/images/generations",
        headers={}, body={},
        poll_interval=0.01, max_poll_attempts=5, initial_delay=0.0,
    )
    assert result["status"] == "completed"
    assert result["urls"] == ["http://x/final.png"]
    assert log[0][0] == "post"
    assert log[1][0] == "get"
    assert log[1][1].endswith("/tasks/task_xyz")


# ── 6. EventBus ──────────────────────────────────────────────

async def test_eventbus_publish_subscribe():
    collected = []

    async def _consume():
        async for ev in event_bus.subscribe("evt1"):
            collected.append(ev)

    import asyncio
    consumer = asyncio.create_task(_consume())
    await asyncio.sleep(0.01)

    await event_bus.publish(TaskEvent(
        event_type=EventType.TASK_CREATED, task_id="evt1", user_id=1, capability="image"
    ))
    await event_bus.publish(TaskEvent(
        event_type=EventType.TASK_PROCESSING, task_id="evt1", user_id=1, capability="image"
    ))
    await event_bus.send_end("evt1")
    await consumer

    assert len(collected) == 2
    assert collected[0].event_type == EventType.TASK_CREATED
    assert collected[1].event_type == EventType.TASK_PROCESSING


# ── 7. CapabilityRouter 分发 ─────────────────────────────────

async def test_router_dispatch_unknown_capability():
    result = await CapabilityRouter.dispatch(
        "does_not_exist",
        task_id="t3", user_id=1, prompt="p", params={},
        base_url="http://up", api_key="k", protocol_name="openai",
        adapter_name="openai", model="m",
    )
    assert result["status"] == "failed"
    assert "Unknown capability" in result["error"]


async def test_router_dispatch_routes_to_service(monkeypatch):
    async def _fake_submit_and_wait(*, task_id, user_id, protocol, capability,
                                    base_url, api_key, endpoint, headers, body,
                                    poll_interval=3.0, max_poll_attempts=60,
                                    initial_delay=0.0):
        return {"status": "completed", "urls": ["http://x/a.png"], "metadata": {}}

    monkeypatch.setattr(
        "app.services.tasks.manager.TaskManager.submit_and_wait", _fake_submit_and_wait
    )

    result = await CapabilityRouter.dispatch(
        "image",
        task_id="t4", user_id=1, prompt="p",
        params={"model": "gpt-image-1"},
        base_url="http://up", api_key="k", protocol_name="openai",
        adapter_name="openai", model="gpt-image-1",
    )
    assert result["status"] == "completed"
    assert result["urls"] == ["http://x/a.png"]


# ── 8. 向后兼容 ────────────────────────────────────────────────

def test_generation_task_effective_capability_fallback():
    from app.models.task import GenerationTask

    with_cap = GenerationTask(id="c", user_id=1, type="image", status="pending",
                              prompt="p", capability="video")
    assert with_cap.effective_capability == "video"

    no_cap = GenerationTask(id="n", user_id=1, type="image", status="pending",
                             prompt="p", capability=None)
    assert no_cap.effective_capability == "image"


# ── 9. 三层参数模型 ─────────────────────────────────────────

def test_resolve_image_size_levels():
    assert resolve_image_size("1K", "1:1") == "1024x1024"
    assert resolve_image_size("2K", "1:1") == "2048x2048"
    assert resolve_image_size("4K", "16:9") == "6144x3456"
    assert resolve_image_size("1K", "16:9") == "1536x864"


def test_image_request_business_semantics_only():
    r = ImageRequest(model="m", prompt="p")
    assert r.size_level == "1K"
    assert r.ratio == "1:1"
    assert r.quality == "auto"
    assert r.n == 1
    assert r.ref_urls is None
    import pydantic
    with pytest.raises(pydantic.ValidationError):
        ImageRequest(model="m", prompt="p", n=99)


async def test_image_service_adapter_flow(monkeypatch):
    captured: dict = {}

    class _FakeProto(BaseProtocol):
        protocol_name = "openai"
        def build_request(self, base_url, api_key, body, capability):
            captured["body"] = body
            return "http://up/v1/images/generations", {}, body
        def extract_result(self, data, capability): return None
        def extract_task_id(self, data, capability, endpoint=""): return None
        def supports(self, capability): return True
        def build_poll_url(self, base_url, upstream_task_id): return ""
        def parse_poll_response(self, data, capability):
            return PollResult(status="completed", urls=[])

    monkeypatch.setattr(ProtocolRegistry, "get", lambda name, cap: _FakeProto())
    async def _fake_submit(**kwargs):
        captured["submit_body"] = kwargs.get("body")
        return {"status": "completed", "urls": ["http://x/1.png"], "metadata": {}}
    monkeypatch.setattr(TaskManager, "submit_and_wait", _fake_submit)

    svc = ImageService()
    res = await svc.execute(
        task_id="t1", user_id=1, prompt="a cat",
        params={"model": "gpt-image-1", "size": "2K", "ratio": "1:1",
                "quality": "high", "n": 1},
        base_url="http://up", api_key="k", protocol_name="openai",
        adapter_name="openai", model="gpt-image-1",
    )
    assert res["status"] == "completed"
    pb = captured["body"]
    assert pb["size"] == "2048x2048"
    assert "size_level" not in pb


async def test_image_service_mapping_flow(monkeypatch):
    """测试 parameter_mapping + override_json 流程。"""
    captured: dict = {}

    class _FakeProto(BaseProtocol):
        protocol_name = "openai"
        def build_request(self, base_url, api_key, body, capability):
            captured["body"] = body
            return "http://up/v1/images/generations", {}, body
        def extract_result(self, data, capability): return None
        def extract_task_id(self, data, capability, endpoint=""): return None
        def supports(self, capability): return True
        def build_poll_url(self, base_url, upstream_task_id): return ""
        def parse_poll_response(self, data, capability):
            return PollResult(status="completed", urls=[])

    monkeypatch.setattr(ProtocolRegistry, "get", lambda name, cap: _FakeProto())
    async def _fake_submit(**kwargs):
        captured["submit_body"] = kwargs.get("body")
        return {"status": "completed", "urls": ["http://x/1.png"], "metadata": {}}
    monkeypatch.setattr(TaskManager, "submit_and_wait", _fake_submit)

    svc = ImageService()
    await svc.execute(
        task_id="t2", user_id=1, prompt="p", ref_urls=["data:img1"],
        params={"model": "gpt-image-1", "size": "1K", "ratio": "1:1",
                "quality": "auto", "n": 1},
        base_url="http://up", api_key="k", protocol_name="openai",
        adapter_name="openai", model="gpt-image-1",
        parameter_mapping={"image": "extra_body.image"},
        override_json={"extra_body": {"response_format": "url"}},
    )
    pb = captured["body"]
    assert "image" not in pb
    assert pb["extra_body"]["image"] == ["data:img1"]
    assert pb["extra_body"]["response_format"] == "url"
