# Noxrea AI Canvas

无限画布 AI 创作工具，支持节点式画布编辑、图片/文字/视频生成，以及 3D 导演模式。

## 目录

- [核心功能](#核心功能)
- [系统架构](#系统架构)
- [目录结构](#目录结构)
- [核心链路详解](#核心链路详解)
  - [链路一：AI 生成（图片/视频/音频/LLM）](#链路一ai-生成图片视频音频llm)
  - [链路二：模型参数系统](#链路二模型参数系统)
  - [链路三：画布保存与还原](#链路三画布保存与还原)
  - [链路四：SSE 实时推送](#链路四sse-实时推送)
  - [链路五：渠道配置与自定义请求体](#链路五渠道配置与自定义请求体)
  - [链路六：AI 代理与模型列表](#链路六ai-代理与模型列表)
- [技术栈](#技术栈)
- [本地开发](#本地开发)
- [文档与规范](#文档与规范)

## 核心功能

| 功能 | 说明 |
|------|------|
| **无限画布** | 基于 React Flow 的节点式编辑器，支持拖拽、缩放、连线 |
| **AI 图片生成** | 支持文生图、图生图，可配置比例/清晰度/画质/数量 |
| **AI 视频生成** | 支持文生视频、图生视频，可配比例/清晰度/时长/音频 |
| **AI 文字对话** | 通过 LLM 节点与模型对话 |
| **3D 导演模式** | 纯 TS 3D 引擎，支持角色/道具/摄像机/人群编辑 |
| **多厂商接入** | 通过渠道（Channel）配置支持 OpenAI / Gemini / Ark 等多厂商 |
| **资源管理** | 上传图片/音频、文件夹归类、标签系统 |
| **实时事件推送** | EventBus 发布/订阅 + SSE，任务状态变更即时推送前端 |
| **撤销/重做** | 完整的画布操作历史 |

## 系统架构

```
┌─────────────────────────────────────────────────────────────┐
│                     Web (Next.js)                            │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌───────────────┐  │
│  │ 画布组件  │ │ 生成面板  │ │ 资源管理  │ │ Directer(3D) │  │
│  │ Canvas    │ │ GenPanel  │ │ Assets    │ │ Engine(纯TS) │  │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘ └───────┬───────┘  │
│       │             │             │               │          │
│  ┌────┴─────────────┴─────────────┴───────────────┴───────┐  │
│  │              Zustand Stores (状态管理)                  │  │
│  │  canvas-store / model-store / assets-store / ...       │  │
│  └────────────────────────┬───────────────────────────────┘  │
│                           │  HTTP / SSE                      │
└───────────────────────────┼──────────────────────────────────┘
                            │
┌───────────────────────────┼──────────────────────────────────┐
│                     Backend (FastAPI)                         │
│                           │                                   │
│  ┌────────────────────────┴──────────────────────────────┐   │
│  │                    API Routers                         │   │
│  │  auth / canvas / generate / ai_proxy / files / ...    │   │
│  └──────────────┬──────────────────────┬─────────────────┘   │
│                 │                      │                      │
│  ┌──────────────┴──────┐  ┌───────────┴───────────────┐     │
│  │   Worker Loop       │  │   EventBus + SSE           │     │
│  │   轮询领取任务        │  │   发布/订阅广播任务事件      │     │
│  └──────────┬──────────┘  └───────────────────────────┘     │
│             │                                                 │
│  ┌──────────┴──────────────────────────────────────────┐     │
│  │                  AI Gateway 管线                      │     │
│  │  CapabilityRouter → CapabilityService                │     │
│  │       → request_builder (transforms/mapping/patch)   │     │
│  │       → Protocol (OpenAI/Gemini/Ark)                 │     │
│  │       → TaskManager (同步/异步轮询)                  │     │
│  └──────────────────────────────────────────────────────┘     │
│             │                                                 │
│             ▼                                                 │
│  ┌──────────────────────────────────────────────────────┐     │
│  │              Storage (下载 → 本地落盘)                 │     │
│  └──────────────────────────────────────────────────────┘     │
└──────────────────────────────────────────────────────────────┘
```

## 目录结构

```
Noxrea-AI-Canvas/
├── web/                         # Next.js 前端
│   └── src/
│       ├── app/                 # App Router 页面
│       │   ├── canvas/          # 画布主页
│       │   ├── login/           # 登录页
│       │   └── project/         # 项目管理页
│       ├── components/
│       │   ├── canvas/          # 画布核心（InfiniteCanvas, 生成面板等）
│       │   │   └── nodes/       # 节点组件（Text/Image/Video/Group/Director）
│       │   ├── assets/          # 资源管理（侧栏/网格/卡片/文件夹）
│       │   ├── director/        # 3D 引擎 React UI 容器
│       │   ├── common/          # 通用 UI（ConfirmModal, NavButton）
│       │   └── auth/            # 认证组件
│       ├── stores/              # Zustand 状态管理（9 个 store）
│       ├── lib/                 # 工具层（api, types, save-manager 等）
│       ├── hooks/               # 自定义 hooks
│       ├── director/            # 3D 引擎纯 TS 逻辑（core/entities/util）
│       └── __tests__/           # 单元测试
│
├── backend/                     # FastAPI 后端
│   └── app/
│       ├── main.py              # 应用入口、CORS、lifespan
│       ├── config.py            # pydantic-settings 配置
│       ├── database.py          # 异步 SQLAlchemy 引擎
│       ├── deps.py              # 依赖注入（get_current_user）
│       ├── crud/                # 数据库 CRUD 操作
│       ├── models/              # SQLAlchemy ORM 模型
│       ├── routers/             # API 路由（9 个模块）
│       ├── schemas/             # Pydantic 请求/响应模型
│       └── services/            # 业务逻辑
│           ├── capabilities/    # 能力服务（image/video/audio/llm）
│           ├── request_builder/ # 请求构建管线（transforms/mapping/patch）
│           ├── protocols/       # 厂商协议（openai/gemini/ark）
│           ├── tasks/           # 任务管理器（同步/异步轮询）
│           ├── worker/          # 后台 Worker（轮询/执行）
│           ├── gateway/         # 网关路由分发
│           ├── storage/         # 存储服务
│           ├── events/          # 事件总线
│           ├── resolvers/       # 参考图解析
│           └── inference/       # 推理服务（背景移除）
│
├── inference_service/           # 独立推理服务（背景移除）
├── docs/                        # 项目文档
├── start.bat / start.ps1        # 一键启动脚本
└── CLAUDE.md                    # AI 协作指南
```

## 核心链路详解

### 链路一：AI 生成（图片/视频/音频/LLM）

这是项目最核心的链路，完整说明从用户点击生成到拿到结果的每一步。

```
用户点生成
  │
  ▼
┌─ 前端 ─────────────────────────────────────────────────────────┐
│ 1. ImageGenerationPanel / VideoGenerationPanel                 │
│    组装请求体 → POST /api/generate/task                        │
│    {                                                           │
│      type: "image",                                            │
│      prompt: "一只猫",                                          │
│      model: "gpt-image-2",                                     │
│      channelId: 1,         ← 渠道 ID                           │
│      ratio: "1:1",         ← 业务参数（纯语义，无厂商字段）       │
│      resolution: "1K",                                         │
│      quality: "auto",                                          │
│      n: 1,                                                     │
│      ref_images: [...],                                        │
│      nodeId: "node_xxx"                                        │
│    }                                                           │
│                                                                │
│ 2. 收到 response → 拿到 taskId → 写入 node.data.taskBinding     │
│    → 前端通过 SSE 监听任务状态变化                                │
└────────────────────────────────────────────────────────────────┘
  │
  ▼
┌─ 后端 generate.py ─────────────────────────────────────────────┐
│ 3. POST /api/generate/task                                     │
│    验证 channelId → 查 channel 配置 → 组装 task.config          │
│    → 创建 GenerationTask 记录（status=pending）                 │
│    → 返回 { task_id: "a1b2c3d4" }                              │
└────────────────────────────────────────────────────────────────┘
  │
  ▼
┌─ 后端 Worker Loop ─────────────────────────────────────────────┐
│ 4. worker_loop() 轮询 pending 任务                               │
│    → claim_pending_tasks()  原子领取（update + returning）       │
│    → 并发派发给 executor.process_task() (Semaphore 限流)        │
└──────────────────────────────┬─────────────────────────────────┘
                               │
                               ▼
┌─ 后端 executor.py ─────────────────────────────────────────────┐
│ 5. process_task()                                              │
│    ├── 解析 channel (baseUrl, apiKey, protocol, ChannelConfig) │
│    ├── SSRF 校验 baseUrl                                       │
│    ├── extract_execution_params()  提取纯业务参数               │
│    ├── resolve_refs()  参考图解析（同源读盘/白名单fetch/透传）    │
│    └── CapabilityRouter.dispatch() → 进入网关管线               │
└──────────────────────────────┬─────────────────────────────────┘
                               │
                               ▼
┌─ 后端 Gateway 管线 ─────────────────────────────────────────────┐
│ 6. CapabilityRouter.dispatch("image", ...)                      │
│    → CapabilityRegistry.get("image")                            │
│    → ImageService.execute()                                     │
│                                                                 │
│    6a. 构建 Internal Request（纯业务语义）                        │
│        ImageRequest(model, prompt, resolution, ratio, quality)  │
│                                                                 │
│    6b. request_builder.engine.build()  四步管线：                │
│        ┌─────────────┐                                          │
│        │ transforms  │ ratio+resolution → "1024x1024" (查表)    │
│        ├─────────────┤                                          │
│        │ auto-clean  │ 删内部字段、None 值、已消费字段            │
│        ├─────────────┤                                          │
│        │ mapping     │ 字段改名/移动到嵌套路径                   │
│        ├─────────────┤                                          │
│        │ patch       │ 注入固定参数 (deep merge)                 │
│        └─────────────┘                                          │
│                                                                 │
│    6c. Protocol.build_request()                                 │
│        构造 HTTP 请求 (endpoint + headers + body)               │
│                                                                 │
│    6d. TaskManager.submit_and_wait()                            │
│        提交 → 尝试同步提取结果 → 失败则异步轮询                    │
└──────────────────────────────┬─────────────────────────────────┘
                               │
                               ▼
┌─ 后端 Storage ─────────────────────────────────────────────────┐
│ 7. _finalize_result()  统一结果处理                              │
│    ├── 取消检查 _check_cancelled() (被取消则跳过下载)              │
│    ├── CDN URL -> download_and_save() 下载落本地                 │
│    ├── base64 data URL -> save_bytes() 解码存盘                  │
│    ├── raw bytes -> save_bytes() 直接落盘                        │
│    ├── LLM 文本 -> 直接写入 result_text (不下载)               │
│    └── update_and_emit() 更新 DB + publish 事件到 EventBus       │
│        completed -> TASK_COMPLETED  failed -> TASK_FAILED       │
└────────────────────────────────────────────────────────────────┘
  │
  ▼
┌─ 前端 SSE ─────────────────────────────────────────────────────┐
│ 8. GET /api/generate/task/{id}/stream (SSE)                   │
│    ensure_queue() 先建订阅队列（防竞态）-> 查 DB 当前状态          │
│    -> wait_event() 5s 超时轮询 EventBus 事件                     │
│    -> 收到 TASK_COMPLETED -> 取 resultUrls -> 更新节点            │
│    -> 生成 image/video node 展示结果                              │
└────────────────────────────────────────────────────────────────┘
```

### 链路二：模型参数系统

控制前端生成面板（图片/视频）的参数选项、默认值、控件显隐。

```
┌─ 后端 model_params.json ───────────────────────────────────┐
│ 匹配优先级：精确名 > 通配符(fnmatch) > _default 兜底          │
│                                                              │
│ {                                                            │
│   "_default": {         ← 所有模型兜底                        │
│     "image": {                                               │
│       "params": ["quality","resolution","ratio","n"],        │
│       "defaults": {...},                                     │
│       "constraints": { "ratio": ["1:1","16:9",...] }        │
│       // 注意：transforms 不传前端                             │
│     }                                                        │
│   },                                                         │
│   "*gpt-image*": {      ← 通配符匹配 gpt-image-1/2 等        │
│     "image": {                                               │
│       "params": ["quality","resolution","ratio","n"],        │
│       "transforms": {   ← 仅后端使用                          │
│         "ratio": { "type":"lookup",                          │
│           "composite":["ratio","resolution"],                 │
│           "table": {"1:1|1K":"1024x1024", ...} }            │
│       }                                                      │
│     }                                                        │
│   },                                                         │
│   "*nano-banana*": {    ← 无 resolution 参数                  │
│     "image": { "params": ["quality","ratio","n"] }           │
│   }                                                          │
│ }                                                            │
└──────────────────────┬──────────────────────────────────────┘
                       │ GET /api/model-params (仅返回公开字段)
                       ▼
┌─ 前端 model-store.ts ──────────────────────────────────────┐
│ modelParamsCache = {...}  初始化时拉取                        │
│                                                              │
│ findModelParams(modelName, capability):                      │
│   1. 精确匹配 cache["gpt-image-2"]["image"]                  │
│   2. 通配符 "*gpt-image*" → caps["image"]                   │
│   3. _default 兜底 → cache["_default"]["image"]             │
│   4. 都不匹配 → 返回 null                                     │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─ 前端 ImageGenerationPanel ─────────────────────────────────┐
│ const modelParams = findModelParams(modelName, "image");     │
│                                                              │
│ // 选项列表从后端 constraints 取，null 时 fallback 硬编码      │
│ const ratioOptions = modelParams?.constraints?.ratio          │
│   ?? ["1:1","1:2","2:1",...];                               │
│                                                              │
│ // 控件显隐由 params 数组决定                                  │
│ const showResolution = !modelParams                           │
│   || modelParams.params.includes("resolution");              │
│                                                              │
│ // 如 nano-banana 模型：params 无 "resolution"               │
│ // → showResolution = false → 清晰度控件不显示                │
└──────────────────────────────────────────────────────────────┘
```

**关键设计**：
- `model_params.json` 支持热更新（检测文件 mtime 自动重载）
- `transforms` 字段仅供后端 engine 使用，不传给前端
- 前端硬编码的 `??` fallback 只在连 `_default` 都没匹配到时触发（理论防线）

### 链路三：画布保存与还原

```
┌─ 前端操作 ─────────────────────────────────────────────────┐
│ 用户拖拽/编辑/生成 → canvas-store 状态变更                    │
│                                                              │
│ markDirty() / markDirtyImmediate()                           │
│   → SaveManager.markDirty()  设置 dirty=true                 │
│   → trailing save: 2 秒无新操作后触发保存 (100ms 立即保存)     │
│                                                              │
│ SaveManager._doSave():                                       │
│   1. takeCanvasSnapshot()  采集当前 nodes/edges/viewport     │
│   2. stripRuntimeFields()  去掉 selected/dragging 等运行时字段 │
│   3. _collectCanvasHashes() 收集引用的文件 hash               │
│   4. PUT /api/canvas/projects/{id}                           │
│      body: { name, canvas_data: { nodes, edges, viewport } } │
│                                                              │
│ 防重机制：                                                    │
│   - fingerprint: 对比 nodes/edges + file hashes 是否变化      │
│   - 内容未变 → 跳过保存，节省带宽                               │
│                                                              │
│ 生命周期兜底：                                                │
│   - flushOnUnload(): 页面卸载时 keepalive 保存                │
│   - flushAndWait(): 项目切换时等待保存完成                     │
└──────────────────────────────────────────────────────────────┘
  │
  ▼
┌─ 后端 canvas.py ───────────────────────────────────────────┐
│ PUT /api/canvas/projects/{id}                                │
│   → 验证所有权 → 更新 canvas_data (JSON) → 更新 updated_at    │
│                                                              │
│ GET /api/canvas/projects/{id}                                │
│   → 加载画布 → 前端还原 nodes/edges/viewport                 │
└──────────────────────────────────────────────────────────────┘
```

### 链路四：SSE 实时推送

基于 EventBus（asyncio.Queue 发布/订阅）的实时事件推送，取代旧的 DB 轮询。

**事件类型**：

| EventType | 触发位置 | 说明 |
|-----------|---------|------|
| `TASK_COMPLETED` | executor `update_and_emit("completed")` | 任务完成，含 result_urls/result_text |
| `TASK_FAILED` | executor `update_and_emit("failed")` / `cancel_task()` | 任务失败或被取消 |

```
┌─ 事件发布（后端 executor / generate.py）──────────────────────┐
│                                                                 │
│ update_and_emit(task, "completed", result_urls=[...])          │
│   -> update_task_status() 更新 DB                               │
│   -> event_bus.publish(TaskEvent(                               │
│        event_type=TASK_COMPLETED,                               │
│        task_id="a1b2", result_urls=[...] ))                     │
│                                                                 │
│ cancel_task():                                                  │
│   -> DB 标记 status=failed, error="Cancelled"                   │
│   -> event_bus.publish(TaskEvent(                               │
│        event_type=TASK_FAILED, error="Cancelled" ))             │
└───────────────────────────┬─────────────────────────────────────┘
                            │ publish 广播到所有订阅者队列
                            ▼
┌─ EventBus（bus.py）──────────────────────────────────────────┐
│                                                              │
│ _subscribers: { task_id: [Queue, Queue, ...] }              │
│                                                              │
│ ensure_queue(task_id):  先建队列再查 DB（防竞态丢事件）        │
│ publish(event):         广播到该 task_id 的所有订阅者         │
│ wait_event(queue, 5s):  等待事件，超时返回 None（检测断开）     │
│ send_end(task_id):      发送 None 哨兵结束迭代                │
│ unsubscribe(task_id,q): 移除队列，无订阅者时自动清理           │
└───────────────────────────┬──────────────────────────────────┘
                            │
                            ▼
┌─ SSE 端点 stream_task() ─────────────────────────────────────┐
│                                                              │
│ 1. ensure_queue(task_id)    ← 先建队列                        │
│ 2. 查 DB 当前 status         ← 防止漏掉已完成的任务           │
│ 3. yield 初始状态 SSE 事件                                    │
│ 4. 循环: wait_event(queue, timeout=5s)                      │
│      ├── 收到事件 -> yield SSE event                         │
│      ├── 超时 None -> 检测客户端是否断开 -> 续传 keepalive     │
│      └── 收到 None 哨兵 -> 任务结束 -> 退出循环                │
│ 5. unsubscribe(task_id, queue)  清理                          │
└───────────────────────────┬──────────────────────────────────┘
                            │
                            ▼
┌─ 前端 InfiniteCanvas ───────────────────────────────────────┐
│                                                              │
│ 提交任务拿到 taskId 后                                        │
│   -> new EventSource("/api/generate/task/{id}/stream")       │
│                                                              │
│ onmessage:                                                   │
│   { status:"completed", result_urls:[...] }                 │
│   -> 更新节点数据 / 创建结果节点                               │
│   -> eventSource.close()                                     │
│                                                              │
│   { status:"failed", error:"..." }                          │
│   -> 显示错误 / 节点标记失败                                  │
│   -> eventSource.close()                                     │
└──────────────────────────────────────────────────────────────┘
```

**关键设计**：
- `ensure_queue` 在查 DB 之前调用，防止事件在订阅建立前丢失（竞态保护）
- 同一 task_id 支持多订阅者（多标签页同时监听），publish 广播到所有队列
- `wait_event` 5s 超时返回 None，SSE 端点借此周期性检测客户端是否已断开
- 取消传播：前端 cancel -> DB 标记 + EventBus 推送 TASK_FAILED -> SSE 即时通知 + Worker 多级检查（领取前/轮询中/finalize 前）

### 链路五：渠道配置与自定义请求体

渠道（Channel）是连接外部 AI 厂商的配置单元，支持高级自定义。

```
┌─ 渠道数据结构 ──────────────────────────────────────────────┐
│ ModelChannel {                                               │
│   id, name, baseUrl, apiKey                                  │
│   protocol: "openai" | "gemini" | "ark"                     │
│   config: {   ← 可选高级配置（JSON）                          │
│     "request": {                                             │
│       "mapping": { "ref_images": "extra_body.image" },      │
│       "body_patch": { "response_format": "url" },           │
│       "model_overrides": {                                  │
│         "gpt-image-*": {                                    │
│           "mapping": { "ratio": "size" },                   │
│           "param_ref": "gpt-image-2"  ← 用哪个模型的 params │
│         }                                                    │
│       }                                                      │
│     },                                                       │
│     "protocol": {                                            │
│       "endpoints": { "image.generate": "/custom/path" },    │
│       "unwrap": true                                         │
│     }                                                        │
│   }                                                          │
│ }                                                            │
└──────────────────────────────────────────────────────────────┘

request_builder 管线执行顺序（不可变更）:

  输入: { ratio:"1:1", resolution:"1K", quality:"auto", prompt:"..." }

  1. transforms  → ratio → lookup("1:1|1K") → "1024x1024"
                   删除 resolution（被 composite 消费）

  2. auto-clean  → 删 capability、None 值字段

  3. mapping     → ratio 重命名为 size（由 model_overrides 定义）
                   ref_images → extra_body.image

  4. patch       → { response_format: "url" } deep merge

  输出: { size:"1024x1024", quality:"auto", prompt:"...",
          extra_body:{ image:[...] }, response_format:"url" }
```

**关键概念**：
- `mapping`：字段改名 + 移到嵌套路径（支持 `images[].image_url` 数组展开语法）
- `body_patch`：固定参数注入（deep merge，不覆盖已有嵌套）
- `model_overrides`：按模型通配符覆盖 mapping/body_patch/param_ref
- `param_ref`：指定用哪个模型名去查 `model_params.json`（如 ABC 模型伪装成 gpt-image-2）

### 链路六：AI 代理与模型列表

```
┌─ 前端 ───────────────────────────┐  ┌─ 后端 ai_proxy.py ──────┐
│                                   │  │                         │
│ 设置 → 渠道管理                   │  │ POST /api/models/list    │
│ 添加渠道 (baseUrl+apiKey)         │  │ → 取 channel 配置        │
│ → 拉取模型列表                    │──│ → SSRF 校验              │
│                                   │  │ → 转发 GET /models      │
│ 返回模型名 + 推断能力              │  │ → 能力推断 (本地匹配)    │
│ (image/video/audio/text)         │  │                         │
│                                   │  │ POST /api/chat/          │
│ 用户勾选能力 → 保存到后端          │  │   completions            │
│                                   │  │ → 转发到厂商 /chat/      │
│                                   │  │   completions            │
└───────────────────────────────────┘  └─────────────────────────┘
```

## 技术栈

| 层级 | 技术 | 版本 |
|------|------|------|
| 前端框架 | Next.js (App Router) | ^16.2 |
| 前端 UI | React + Tailwind CSS | ^19 / ^4 |
| 画布引擎 | @xyflow/react (React Flow) | ^12.11 |
| 状态管理 | Zustand | ^5 |
| UI 组件库 | Ant Design | ^6.5 |
| 请求/缓存 | @tanstack/react-query | ^5 |
| 后端运行时 | Node.js 18+ / TypeScript 5+ | — |
| ORM | Prisma | ^6 |
| 数据库 | SQLite（开发）/ PostgreSQL（生产） | — |
| 鉴权 | JWT (jose) + bcryptjs | ^5.9 |
| 校验 | Zod | ^3.24 |
| HTTP 客户端 | Node 内置 fetch + undici | — |
| 日志 | pino + pino-pretty | ^9.5 |
| 图像处理 | sharp | ^0.33 |
| 进程管理 | tsx（worker）/ concurrently（dev） | — |

## 本地开发

### 前置条件

- Node.js >= 18
- （可选）Python >= 3.11（仅 inference_service 需要）

### 一键启动

```bash
# Windows
start.bat          # 或 start.ps1
```

### 手动启动

```bash
# 1. 安装依赖
npm install                    # 根目录（自动处理 workspace + prisma generate）

# 2. 初始化数据库
cp .env.example .env           # 编辑 .env，设置 JWT_SECRET_KEY 和 ADMIN_PASSWORD
npx prisma migrate dev --name init
npm run prisma:seed            # 创建管理员账号

# 3. 启动（Next.js + Worker 同时启动）
npm run dev                    # 前端 http://localhost:3000，API 同源

# 或分别启动
npm run dev:next               # 仅前端
npm run worker                 # 仅 Worker
```

### 关键配置

| 配置项 | 说明 |
|--------|------|
| `DATABASE_URL` | SQLite `file:./prisma/dev.db` 或 PG 连接串 |
| `JWT_SECRET_KEY` | JWT 签名密钥（必填，占位符拒绝启动） |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | 初始管理员账号（必填） |
| `PUBLIC_URL` | 文件公开访问 URL，默认 `http://localhost:3000` |
| `UPLOAD_DIR` | 文件上传目录，默认仓库根 `uploads/` |
| `MOCK_IMAGE_GENERATE` | 开发模式：mock 图片生成 |
| `ALLOW_INSECURE_SECRETS` | 开发逃生开关（跳过密钥占位符校验） |

### 项目初始化

首次启动：
1. `prisma migrate dev` 建表
2. `prisma:seed` 创建管理员账号
3. 启动时自动执行 `PRAGMA journal_mode=WAL`（SQLite）
4. 启动时自动初始化 Gateway 注册中心（注册所有 Capability/Protocol）

## 文档与规范

- [架构笔记](docs/architecture-notes.md) — 画布保存、生命周期兜底、SSRF 实现
- [协作规则](docs/collaboration-rules.md) — 先出方案再动手、验证步骤、风险告知
- [Git 工作流](docs/git-workflow.md) — 不自动提交、中文 commit message、拆分 commit
- [CLAUDE.md](CLAUDE.md) — AI 协作快速参考
