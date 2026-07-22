# 实施计划：providers 包重构 + 管道清理 + exellome + 链路优化

## 总览

分阶段、独立 commit。C1 拆包 -> C1.5 理管道 -> C2 exellome -> C4 安全治理 -> C5 可选。每步独立可验证、可回滚。

| Commit | 内容 | 风险 | 涉及 |
|---|---|---|---|
| C1 | providers 包拆分（纯重构，零逻辑变更） | 低 | providers/*，删 providers.py |
| C1.5 | 理管道：抽 `build_endpoint` + b64 抽取收进 provider + 本地图判定改用 `PUBLIC_URL` | 低 | base.py / worker.py |
| C2 | exellome provider + 图生图端点选择（复用 build_endpoint） | 低 | base.py / exellome_provider.py / __init__.py / worker.py |
| C4 | apiKey 治理（改传 channelId，不再落库/回传） | 中（跨前后端） | generate.py / worker.py / GenerationPanel.tsx |
| C5 | 可选：批领 / 重试 / n>1 / SSE 延迟 | 各异 | worker.py 等 |

> 原 C3（b64 import 修复）并入 C1.5：b64 抽取逻辑挪进 provider 后，`import base64` 自然落到 base.py 模块级，bug 顺手修掉。

---

## C1：providers 包拆分（纯重构）

**目标**：单文件 `providers.py` 拆成包，逻辑零变更，`worker.py` import 不破。

**结构**：
```
backend/app/services/providers/
├── __init__.py            # re-export + PROVIDERS 注册表 + detect_provider
├── base.py                # ProviderConfig + SIZE_INDEX/GENERIC_SIZES/_resolve_size + is_async_provider + download_and_save
├── openai_provider.py     # OpenAIProvider
├── agnes_provider.py      # AgnesProvider + AGNES_SIZES/VIDEO_DIMS/_get_video_dims（Agnes 专属）
├── nanobanana_provider.py # NanoBananaProvider
└── gpt_image_provider.py  # GPTImageProvider
```

**`__init__.py` 再导出**（worker.py 的 `from app.services.providers import detect_provider, is_async_provider, download_and_save` 不改一行）：
```python
from .base import ProviderConfig, is_async_provider, download_and_save
from .openai_provider import OpenAIProvider
from .agnes_provider import AgnesProvider
from .nanobanana_provider import NanoBananaProvider
from .gpt_image_provider import GPTImageProvider

PROVIDERS = [OpenAIProvider(), AgnesProvider(), NanoBananaProvider(), GPTImageProvider()]

def detect_provider(base_url: str) -> ProviderConfig:
    for p in PROVIDERS:
        if p.matches(base_url):
            return p
    return PROVIDERS[0]
```
各 provider 文件 `from .base import ProviderConfig, _resolve_size`。删除旧 `providers.py`。

**验证**：后端重启无报错；跑一次现有 provider 文生图，日志 `[worker] image request` 正常，无回归。

---

## C1.5：理管道（干掉重复 + 收拢职责 + 修脆弱启发式）

三处独立小重构，合一个 commit。

### (a) 抽 `build_endpoint` helper（干掉 /v1 去重重复）
- 现状：`_process_image` (worker.py:203-208) 与 `_process_video` (worker.py:261-266) 各写一遍一模一样的 `/v1` 去重 + 拼接。
- 改：`base.py` 加模块函数：
```python
def build_endpoint(api_base: str, suffix: str) -> str:
    base = api_base.rstrip("/")
    if base.endswith("/v1") and suffix.startswith("/v1"):
        suffix = suffix[len("/v1"):]
    return base + suffix
```
- worker 两处改调 `build_endpoint(api_base, provider.image_endpoint)` / `build_endpoint(api_base, provider.video_endpoint)`。

### (b) b64 抽取收进 provider（顺带修 NameError）
- 现状：`extract_image_url`（provider）只取 `data[0].url`；b64_json 兜底写在 worker.py:221-239，且 `import base64` 是 `_resolve_refs` 内局部 import -> b64 路径 `NameError`（休眠 bug）。
- 改：`ProviderConfig` 新增默认方法，url/b64 一起处理：
```python
import base64  # base.py 模块级，bug 顺手修
...
def extract_image(self, data: dict) -> tuple[str | None, bytes | None]:
    """返回 (url, raw_bytes)。优先 url，其次 b64_json。"""
    for item in (data.get("data") or []):
        if item.get("url"):
            return item["url"], None
        b64 = item.get("b64_json")
        if b64:
            return None, base64.b64decode(b64)
    return None, None
```
- worker `_process_image` 改为：
```python
url, raw = provider.extract_image(data)
if url:
    return url                       # 交给外层 download_and_save
if raw:
    # 直接上传 bytes（原来的 b64 分支逻辑，但数据来自 provider）
    ...upload raw -> local_url...
    return local_url
```
- 各 provider 的 `extract_image_url` 可保留兼容或删除（统一走 `extract_image`）。
- 删 `_resolve_refs` 内局部 `import base64`。

### (c) 本地图判定改用 `PUBLIC_URL`
- 现状：`_resolve_refs` (worker.py:115) 用 `("localhost","127.0.0.1",":8000")` 硬编码判本服务 URL。上域名/换端口就漏判 -> 图生图本地图不转 base64 -> 外部 provider 拉不到图。
- 改：比对 `settings.PUBLIC_URL`：
```python
from urllib.parse import urlparse
def _is_local_url(url: str) -> bool:
    if any(x in url for x in ("localhost", "127.0.0.1")):
        return True
    pub = settings.PUBLIC_URL
    if pub:
        return urlparse(url).hostname == urlparse(pub).hostname
    return False
```
`_resolve_refs` 里用 `_is_local_url(url)` 替换原启发式。

**验证**：
- 文生图/图生图各跑一次，日志正常。
- 故意配一个返 b64_json 的 provider（或 mock），确认不再 `NameError`、能正确落地。
- `PUBLIC_URL` 改成域名重测图生图，确认本地图仍被转 base64。

---

## C2：exellome provider

**目标**：`exellome.online` 文生图 `/images/generations`，图生图 `/images/edits` + `image` 数组；`size`=比例、`resolution`=档位。

**(a) `base.py` `ProviderConfig.__init__` 加字段**（向后兼容）：
```python
image_edit_endpoint: str = "",   # 有参考图时走这个；空则复用 image_endpoint
...
self.image_edit_endpoint = image_edit_endpoint
```

**(b) 新增 `providers/exellome_provider.py`**：
```python
from typing import Any
from .base import ProviderConfig

class ExellomeProvider(ProviderConfig):
    def __init__(self):
        super().__init__(
            "exellome", "/images/generations", "",
            image_edit_endpoint="/images/edits",
        )

    def build_image_body(self, model, prompt, n, ratio, size, quality="auto", refs=None):
        body: dict[str, Any] = {
            "model": model, "prompt": prompt, "n": n,
            "size": ratio,                          # exellome size = 比例
            "resolution": (size or "1K").lower(),   # 1K -> 1k
        }
        if quality and quality != "auto":
            body["quality"] = quality
        if refs:
            body["image"] = refs                    # 图生图：image 数组
        return body

    def extract_image_url(self, data):
        return (data.get("data") or [None])[0].get("url") if data.get("data") else None
```

**(c) `__init__.py` 注册**（OpenAI 之后）：
```python
PROVIDERS = [OpenAIProvider(), ExellomeProvider(), AgnesProvider(), NanoBananaProvider(), GPTImageProvider()]
```

**(d) `worker.py` `_process_image` 端点选择**（复用 C1.5 的 `build_endpoint`）：
```python
body = provider.build_image_body(model, task.prompt, n, ratio, size, quality, refs or None)
suffix = (
    provider.image_edit_endpoint
    if (refs and provider.image_edit_endpoint)
    else provider.image_endpoint
)
endpoint = build_endpoint(base_url, suffix)
```

**待确认假设**（实现时按此走，联调验证）：
1. `/images/edits` 是 JSON + `image` 数组（非 multipart）。若实际要 multipart，worker 改 `files=`/`data=`。
2. `resolution` 小写（`1K`->`1k`）。

**验证**：
- 文生图：日志 `endpoint=.../images/generations`，body `size`=比例、`resolution`=档位
- 图生图：日志 `endpoint=.../images/edits`，body 含 `image` 数组

---

## C4：apiKey 治理（安全，单独 commit）

**问题**：apiKey 前端传 -> 存 `generation_tasks.config` 永久留存 -> SSE 回传 config（前端没用）。channels 表本就按 user 存了 apiKey。

**方案**：前端传 `channelId`，后端存 `channel_id`，worker 处理时按 channel_id+user_id 查 baseUrl/apiKey。apiKey 不进 task 表、不经 SSE。

**(a) 前端 `GenerationPanel.tsx` `submitTask`**（L146-158）：去 baseUrl/apiKey，改传 channelId：
```ts
body: JSON.stringify({
  type, prompt: p.trim(),
  model: entry.modelName,
  channelId: entry.channelId,   // 代替 baseUrl + apiKey
  quality: q === "auto" ? undefined : q,
  size: gs, ratio: r, n: num,
  refUrls: refs.length > 0 ? refs : undefined,
  nodeId,
}),
```
（`entry.channelId` 已存在，见 GenerationPanel.tsx:34）

**(b) 后端 `generate.py` `create_task`**（L23-67）：
- 接收 `channelId`，校验非空
- `channel = await crud_model_config.get_channel(db, int(channel_id), user.id)`，不存在则 400
- `config = {channel_id, model, quality, size, ratio, n}`（**不含 baseUrl/apiKey**）

**(c) `worker.py` `_process_task`**（L133-152）：
- 从 config 读 `channel_id`
- 开 session 查 channel：
```python
from app.crud import model_config as crud_mc
async with _async_session() as db:
    channel = await crud_mc.get_channel(db, int(config["channel_id"]), task.user_id)
if not channel:
    await _update_task_status(task.id, "failed", error="Channel not found")
    return
base_url, api_key = channel.base_url, channel.api_key
```
- channel 被删则任务 failed 报明确错误。

**(d) SSE `stream_task`**：config 现只含 channel_id 等，回传安全（可不改）。

**未覆盖（后续可选）**：`list_channels` 仍返 apiKey（`model_config.py:21`），因前端 `fetchModels` 拉模型列表要用。彻底移除需把 `/api/models/list` 也改 channelId，作单独后续项。

**验证**：
- 生成正常完成
- `SELECT config FROM generation_tasks` 不含 `apiKey`
- Network 看 `/api/generate/task` 请求体、SSE 事件均无 apiKey
- 删某 channel 后，其历史 pending 任务应 failed 报 "Channel not found"

---

## C5：可选优化（按需挑，各自独立 commit）

**1. 任务批领** - `worker.py` `_claim_task`/`_claim_tasks`（L50-100）
- 现状：每条 SELECT+UPDATE+flush+re-SELECT，10 条≈40 次往返/2s
- 改：`UPDATE ... WHERE id IN (SELECT id ... WHERE status='pending' ORDER BY created_at LIMIT N) RETURNING *`

**2. provider 瞬时错误重试** - `worker.py` `_process_image`（L212）
- 现状：429/5xx/超时直接 failed
- 改：1-2 次指数退避重试（仅 429/5xx/连接错误，不对 4xx 业务错误）

**3. n>1 多图** - extract + worker + SSE
- 现状：`extract_image_url` 只取 `data[0]`，n>1 按 n 计费只出 1 张
- 两条路：(简) 前端禁用 n>1；(繁) extract 返全部 -> worker 存多结果 -> SSE 触发多节点（跨层改动大）

**4. SSE 完成延迟** - `generate.py:134` + `use-sse-task-monitor.ts:153`
- 现状：worker 2s + SSE 3s + 前端 3s 扫，最多 ~5s
- 改：SSE 轮询缩到 1s（SQLite 无 LISTEN/NOTIFY）；或进程内事件总线主动推（较繁）

---

## 执行顺序与建议

1. **C1** 拆包跑通 -> **C1.5** 理管道（让 C2 更干净）-> **C2** exellome。这三步紧密相关，建议连续做。
2. **C4** apiKey 治理跨前后端，单独 commit，不与上面混。
3. **C5** 你挑要哪些，每条独立 commit。
4. exellome 两个假设（JSON/multipart、resolution 大小写）实现时按假设走，联调用日志验证。
