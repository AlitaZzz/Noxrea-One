---
name: ai-provider-gateway-refactor
overview: 将现有 AI 服务架构重构为可长期扩展的 Provider Gateway：按 Provider 维度重写 Adapter（openai/gemini/ark），通过 override_json 机制消除兼容接口适配器，统一 Worker/Capability/Storage 边界，删除协议自动猜测。
todos:
  - id: db-schema-migration
    content: 数据库 Schema 变更：ModelChannel 新增 protocol/parameter_mapping/endpoint_mapping 字段，更新 model 和 schema 定义，创建数据库迁移脚本
    status: pending
  - id: new-adapter-architecture
    content: 重构 Adapter 层：创建 openai.py/gemini.py/ark.py/mapping.py 四个新文件，实现按 Provider 维度的参数转换和 override_json 机制；删除旧的 9 个 adapter 文件
    status: pending
  - id: capability-unification
    content: Capability 层统一化：补全 VideoRequest/AudioRequest/LLMRequest 模型，Audio/LLM Service 改为走 TaskManager，迁移 BgRemoval 到 capabilities/bg_removal/，迁移 Mock 到 capabilities/mock/，所有 Service 移除存储下载调用
    status: pending
    dependencies:
      - new-adapter-architecture
  - id: worker-gateway-slimdown
    content: Worker 瘦身 + Gateway 重构：executor 移除 resolve_refs/protocol 回退/重复下载，统一由 _finalize_result 处理存储；Gateway 层接管 resolve_refs 和 parameter_mapping/endpoint_mapping 注入；删除 protocol_detector.py
    status: pending
    dependencies:
      - capability-unification
      - db-schema-migration
  - id: router-and-cleanup
    content: Generate Router 改造 + 遗留清理：generate.py 改为读取 channel.protocol 替代 detect_protocol；model_capabilities.py 删除 infer_protocol 函数；protocols 层清理 _use_edit_endpoint 魔法字段
    status: pending
    dependencies:
      - db-schema-migration
      - new-adapter-architecture
  - id: registry-tests-cleanup
    content: 更新 Registry 注册逻辑和全量测试：init_gateway() 改为注册新的 3 个 Adapter + 6 个 Capability；更新所有受影响的测试文件以适配新架构
    status: pending
    dependencies:
      - worker-gateway-slimdown
      - router-and-cleanup
---

## 产品概述

将现有 AI 生成后端重构为一个可长期扩展的 AI Provider Gateway。核心目标是：接入 100 个 AI Provider 时不需要新增大量 adapter 文件，通过数据库配置 + override_json 机制解决大多数兼容性差异。

## 核心功能

- Worker 职责收缩：仅负责任务调度和生命周期编排，不涉及业务逻辑和协议细节
- Adapter 按 Provider 维度设计（openai/gemini/ark），不再按 image/video/audio 拆分
- 数据库驱动协议选择：用户创建渠道时手动选择 protocol，不再依赖运行时自动猜测
- override_json 机制：OpenAI 兼容的上游通过 JSON 配置覆盖字段差异，无需新建 adapter 文件
- 所有 Capability Service 统一走 TaskManager 发送 HTTP 请求和轮询
- 存储下载逻辑统一收敛到 executor 层，Capability Service 只返回原始结果（urls/files）
- BG Removal 和 Mock 作为独立 Capability Service，不混杂在 Worker 中

## 技术栈

- 后端框架：Python + FastAPI + SQLAlchemy (Async)
- 数据库：SQLite / PostgreSQL（通过 SQLAlchemy 抽象）
- HTTP 客户端：httpx (Async)
- 数据校验：Pydantic v2

## 实现方案

### 一、核心架构调整

#### 1. Adapter 层重设计（按 Provider 拆分）

**新目录结构**：

```
services/adapters/
├── base.py          # AdapterRegistry + 统一请求/响应数据类
├── openai.py        # OpenAIAdapter: 处理所有能力（image/video/llm/audio）的 OpenAI 参数转换
├── gemini.py        # GeminiAdapter: Gemini 原生协议的参数转换
├── ark.py           # ArkAdapter: 火山方舟协议的参数转换
└── mapping.py       # FieldMapping: 基于数据库 parameter_mapping/override_json 做字段改写
```

**关键设计**：

- 每个 Adapter 处理该 Provider 的 **所有能力**（image/video/llm/audio），内部按 capability 分发
- `OpenAIAdapter.adapt(internal_request, capability)` → 将业务参数转为 OpenAI 格式请求体
- `GeminiAdapter.adapt(internal_request, capability)` → 转为 Gemini 格式
- `ArkAdapter.adapt(internal_request, capability)` → 转为 Ark 格式
- `FieldMapping.apply(body, parameter_mapping)` → 根据渠道配置覆盖字段路径

**override_json 机制**：

- channel 的 `parameter_mapping` 字段存储字段路径映射，如 `{"ref_urls": "extra_body.image"}`
- `FieldMapping` 读取 mapping，将内部字段值移到目标路径，并清理原字段
- `endpoint_mapping` 存储端点覆盖，如 `{"image.generate": "/images/edits"}`
- 优先级：内置 Adapter 基础转换 → FieldMapping 覆盖 → 最终请求体

#### 2. Worker 职责收缩

**executor.py 简化后的流程**：

```
process_task(task):
  1. 解析 channel → base_url, api_key, protocol, parameter_mapping, endpoint_mapping
  2. SSRF 校验 base_url
  3. 根据 capability 分发：
     - bg_removal → CapabilityRouter.dispatch("bg_removal", ...) → 返回 (local_url, error)
     - 其他 → CapabilityRouter.dispatch(capability, ...) → 返回 {status, urls, error}
  4. _finalize_result(task, result) → 统一下载 + 更新任务状态
```

**移除的内容**：

- `resolve_refs()` 调用 → 移到 Gateway 层，由 CapabilityRouter 内部处理
- `detect_protocol()` 回退 → 协议由数据库配置决定，Worker 只读取
- `download_and_save()` 在 `_process_via_gateway` 中的重复调用 → 合并到 `_finalize_result`

#### 3. Capability Service 统一化

**变更**：

- `AudioService` 和 `LLMService` 从直接使用 `httpx.AsyncClient` 改为统一走 `TaskManager.submit_and_wait()`
- 所有 Capability Service 不再调用 `save_bytes()` 或 `download_and_save()`
- 新增 `BgRemovalService`（从 `services/inference/bg_removal.py` 迁移），只返回 `(local_url, error)`
- 新增 `MockImageService`（从 `services/worker/mock.py` 迁移），开发测试能力

**Capability 层只负责**：

- 参数校验和规范化（构建 InternalRequest）
- 通过注册表获取 Adapter 和 Protocol
- 组装请求并发起（通过 TaskManager）
- 返回原始结果（urls/files），不做存储

#### 4. 存储下载统一收敛

**唯一下载入口**：`executor._finalize_result()`

```python
async def _finalize_result(task, result):
    # result 统一格式：{"status", "urls": [...], "files": [...], "error"}
    # 1. 处理 urls（远程 URL → 本地下载）
    # 2. 处理 files（bytes → 本地存储）
    # 3. 更新任务状态
```

Capability Service 返回原始 `urls`（可能是远程 CDN URL）和 `files`（可能是 bytes），executor 统一处理下载和存储。

### 二、数据库变更

**ModelChannel 新增字段**：

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `protocol` | String(30) | `"openai"` | 协议名：openai / gemini / ark |
| `parameter_mapping` | JSON | `{}` | 字段重映射，如 `{"ref_urls":"extra_body.image"}` |
| `endpoint_mapping` | JSON | `{}` | 端点覆盖，如 `{"image.generate":"/images/edits"}` |


**不新增** `adapter_id` 字段（用户明确要求）。

### 三、新旧调用链对比

**新调用链**：

```
POST /api/generate/task
  └─ 读取 channel.protocol（数据库配置，不猜测）
  └─ create_task(protocol=channel.protocol)

Worker executor.process_task():
  ├─ 解析 channel → base_url, api_key, protocol, parameter_mapping, endpoint_mapping
  ├─ SSRF validate
  └─ CapabilityRouter.dispatch(capability, protocol, params, mappings, ...)
       ├─ CapabilityRegistry.get(capability) → Service
       │    └─ ImageRequest(size_level, ratio, quality, n, ref_urls)
       ├─ resolve_refs(ref_urls)  ← 在 Gateway 层处理
       ├─ AdapterRegistry.get(protocol) → OpenAIAdapter/GeminiAdapter/ArkAdapter
       │    └─ adapter.adapt(internal_request, capability)
       ├─ FieldMapping.apply(channel.parameter_mapping, body)  ← override
       ├─ ProtocolRegistry.get(protocol, capability) → Protocol
       │    └─ build_request() → (endpoint, headers, body)
       │    └─ endpoint 可由 channel.endpoint_mapping 覆盖
       └─ TaskManager.submit_and_wait() → HTTP+轮询

  └─ _finalize_result(task, result)
       ├─ 处理 urls → download_and_save
       ├─ 处理 files → save_bytes
       └─ update_task_status(completed/failed)
```

## 实现注意事项

### 性能

- Adapter 查找从 O(n) 遍历 9 个匹配变为 O(1) 通过 protocol 直接定位
- 下载逻辑统一后避免了 ImageService 和 executor 的重复下载

### 向后兼容

- 历史任务 protocol 字段可能为空，executor 在读取 protocol 时做空值兜底（默认 "openai"）
- 删除 `protocol_detector.py` 后，旧任务如无 protocol 字段则回退到 "openai"

### 日志

- 复用现有 `logging.getLogger(__name__)` 模式
- 关键节点（adapter 选择、mapping 应用、endpoint 覆盖）添加 info 级别日志

### 安全

- SSRF 校验保持不变，仍在 executor 中对 base_url 进行 DNS 解析和 IP 校验
- parameter_mapping 支持嵌套路径（如 `extra_body.image`），使用安全的 dict 操作，防止注入

## 使用的 Agent 扩展

### SubAgent

- **code-explorer**
- 用途：在实现阶段深入探索被修改文件的依赖关系和调用链，确保重构不遗漏任何引用
- 预期结果：完整列出所有受影响的 import 语句、调用点和测试文件