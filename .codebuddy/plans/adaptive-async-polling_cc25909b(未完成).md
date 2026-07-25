---
name: adaptive-async-polling
overview: 移除 worker.py 中的 is_async_provider 硬性门控，在 base.py 的 ProviderConfig 基类中添加通用的异步轮询兜底方法，实现「同步优先、异步兜底」的自适应生图策略。无论 provider 声明同步还是异步，都能在同步提取不到图片时自动尝试异步轮询。
todos:
  - id: base-generic-fallback
    content: 在 base.py 的 ProviderConfig 中实现三个通用兜底方法：extract_image_task_id（多路径检测 task_id 和带 status 的 id）、build_image_poll_url（{base_url}/tasks/{task_id}）、extract_image_poll_result（状态判断 + 多路径 URL 提取）
    status: pending
  - id: worker-adaptive-poll
    content: 修改 worker.py 的 _process_image：移除 is_async_provider 门控，无条件调用 extract_image_task_id；实现自适应轮询参数（max_attempts 和 poll_interval_ms）
    status: pending
    dependencies:
      - base-generic-fallback
---

## 用户需求

上游中转 API 未知是同步生图还是异步生图，需要自适应处理——无论 provider 声明同步还是异步，都应先尝试同步提取图片 URL/b64，提取不到时再尝试提取异步 task_id 进入轮询。

用户特别要求详细解释各逻辑，尤其是 task_id 提取逻辑。

## 核心功能

- 移除 worker.py 中对 `is_async_provider` 的硬性门控，无条件调用 `extract_image_task_id`
- 在 ProviderConfig 基类中添加通用兜底的 `extract_image_task_id`、`build_image_poll_url`、`extract_image_poll_result` 实现
- 自适应轮询参数：provider 专属配置优先，否则使用全局 `WORKER_ASYNC_POLL_*` 配置
- 保持现有 provider（ApimartProvider、AgnesProvider 等）行为不变

## 技术栈

- 语言：Python 3
- 框架：FastAPI（后端）、httpx（HTTP 客户端）
- 修改范围：2 个文件（base.py、worker.py）

## 实现方案

### 核心策略：「同步优先、异步兜底」

不改变 provider 的静态属性（`max_poll_attempts` 仍保留为 0），而是在运行时自适应检测响应内容：

```
POST 生图接口
  → extract_image(data) 同步提取
    → 有 urls 或 b64 → 直接返回
    → 无 → extract_image_task_id(data) 异步提取
      → 有 task_id → 自适应轮询
      → 无 → "provider 未返回图片结果"
```

### 各逻辑详解

#### 1. task_id 提取逻辑（base.py - extract_image_task_id）

提取策略按优先级从高到低排列，越具体的路径越优先，避免误判：

**第一优先：明确的 `task_id` 字段（无论在哪一层）**

```python
# 情况 A：顶层 task_id
{"task_id": "abc123"} → "abc123"

# 情况 B：嵌套 data.task_id
{"data": {"task_id": "abc123"}} → "abc123"

# 情况 C：数组 data[0].task_id（如 Apimart 响应）
{"data": [{"status": "submitted", "task_id": "abc123"}]} → "abc123"
```

`task_id` 是最明确的信号，出现在任何位置都直接返回。

**第二优先：带 status 的 id 字段（减少误判）**

```python
# 情况 D：data.status=submitted + data.id
{"data": {"status": "pending", "id": "abc123"}} → "abc123"

# 情况 E：data[0].status=processing + data[0].id
{"data": [{"status": "processing", "id": "abc123"}]} → "abc123"

# 情况 F：顶层 status + 顶层 id
{"status": "queued", "id": "abc123"} → "abc123"
```

`id` 字段很常见（如请求 ID、用户 ID），**必须配合 `status` 字段**一起出现才认为是异步任务 ID，否则忽略。这避免了将同步响应中的 `{"data": [{"url": "..."}], "id": "req_456"}` 误判为异步任务。

**不会提取的情况：**

```python
# G：只有 id，无 status → 不提取（可能是请求 ID）
{"id": "req_789", "data": [{"url": "..."}]} → None

# H：有 status 但 status 为空/已完成的同步响应 → 不提取
{"status": "completed", "data": [{"url": "..."}]} → None
# 注意：这种情况 extract_image(data) 已在上一步返回了 url，不会走到这里
```

**子类覆写优先：** ApimartProvider、ExellomeProvider 等如果覆写了此方法，调用时会进入子类逻辑，不受基类通用逻辑影响。

#### 2. 轮询 URL 构建逻辑（base.py - build_image_poll_url）

通用兜底：`{base_url}/tasks/{task_id}`，这是最常见的异步轮询路径模式。

```python
# base_url = "https://api.example.com/v1"
# task_id = "abc123"
# → "https://api.example.com/v1/tasks/abc123"
```

ApimartProvider 已覆写此方法，仍使用其专属路径，不受基类影响。

#### 3. 轮询结果提取逻辑（base.py - extract_image_poll_result）

按以下顺序检测：

**3a. 状态判断**

```python
# 从 data.status 或顶层 status 读取状态值（大写）
_PAILED = {"FAILED", "ERROR", "CANCELED", "CANCELLED"}
_PENDING = {"PENDING", "PROCESSING", "SUBMITTED", "QUEUED", "RUNNING", "STARTED"}
_SUCCESS = {"SUCCESS", "SUCCEEDED", "COMPLETED", "DONE"}

# pending → 返回 None（继续等）
# failed → 返回 "__FAILED__"
# success → 继续提取 URL
```

**3b. 图片 URL 提取（按常见路径逐一尝试）**

```python
# 路径 1：data.images[].url 或顶层 images[].url
# 覆盖如 {"data": {"images": [{"url": "http://..."}]}}

# 路径 2：data.output[] 或顶层 output[]
# 覆盖如 {"output": ["http://..."]}

# 路径 3：data.result.images[].url 或顶层 result.images[].url
# 覆盖如 {"data": {"status": "SUCCESS", "result": {"images": [{"url": "http://..."}]}}}

# 路径 4：data[].url（数组格式）
# 覆盖如 {"data": [{"url": "http://..."}]}
```

**3c. 返回值约定：**

```
返回 list[str] → 图片 URL 列表（成功）
返回 None → 仍在处理中，继续轮询
返回 "__FAILED__" → 上游任务失败，停止轮询
```

#### 4. 自适应轮询参数（worker.py 修改）

当 provider 的 `max_poll_attempts == 0` 时，使用全局配置作为后备：

```python
max_attempts = provider.max_poll_attempts or settings.WORKER_ASYNC_POLL_MAX_ATTEMPTS
poll_interval_ms = provider.poll_interval if provider.max_poll_attempts > 0 else int(settings.WORKER_ASYNC_POLL_INTERVAL * 1000)
```

| 场景 | max_attempts 来源 | poll_interval_ms 来源 |
| --- | --- | --- |
| ApimartProvider（专属异步） | provider.max_poll_attempts=60 | provider.poll_interval=3000ms |
| AgnesProvider（专属异步） | provider.max_poll_attempts=72 | provider.poll_interval=5000ms |
| OpenAI 中转 API 返回 task_id | settings.WORKER_ASYNC_POLL_MAX_ATTEMPTS=60 | settings.WORKER_ASYNC_POLL_INTERVAL*1000=3000ms |
| GPTImage 中转 API 返回 task_id | 同上 | 同上 |


### 影响评估

| Provider | 变更前 | 变更后 |
| --- | --- | --- |
| ApimartProvider | 异步（专属逻辑），正常 | 不变，子类覆写优先 |
| AgnesProvider | is_async_provider=True 但基类返回 None，永远不轮询 | 图片走同步；若中转返回 task_id 则基类通用逻辑兜底轮询 |
| OpenAIProvider | 同步 only | 同步优先；若中转返回 task_id 则自适应轮询 |
| GPTImageProvider | 同步 only | 同上 |
| NanoBananaProvider | 同步 only | 同上 |
| ExellomeProvider | 同步 only | 同上 |


**安全边际：**

- `extract_image_task_id` 仅在 `extract_image` 返回空后才被调用，避免正常同步响应被误判
- 只检测 `task_id` 或「带 status 的 id」，不检测裸 `id`，误判概率极低
- 即使误判进入轮询，轮询会在超时后返回明确错误（"异步生图超时（task_id=xxx）"），不会数据损坏
- 日志会记录 `data_keys`（427 行），便于排查上游 API 的实际响应格式

### 目录结构

```
backend/
└── app/
    └── services/
        └── providers/
            └── base.py    # [MODIFY] 三个方法添加通用兜底实现
        └── worker.py      # [MODIFY] 移除 is_async_provider 门控，自适应轮询参数
```