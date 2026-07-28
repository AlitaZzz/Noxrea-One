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
| **撤销/重做** | 完整的画布操作历史 |

## 系统架构

```
┌─────────────────────────────────────────────────────────────┐
│                     Frontend (Next.js)                       │
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
│  │   Worker Loop       │  │   SSE / EventBus           │     │
│  │   轮询领取任务        │  │   实时推送任务状态          │     │
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
├── frontend/                    # Next.js 前端
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
│       ├── stores/              # Zustand 状态管理（8 个 store）
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
│    ├── CDN URL → download_and_save() 下载落本地                 │
│    ├── base64 data URL → save_bytes() 解码存盘                  │
│    ├── raw bytes → save_bytes() 直接落盘                        │
│    └── update_task_status() 更新 DB (completed / failed)        │
└────────────────────────────────────────────────────────────────┘
  │
  ▼
┌─ 前端 SSE ─────────────────────────────────────────────────────┐
│ 8. GET /api/generate/task/{id}/stream                          │
│    轮询任务状态 → completed → 取 resultUrls → 更新节点           │
│    → 生成 image/video node 展示结果                              │
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

任务状态变更的实时通知机制。

```
┌─ 后端 TaskManager ───────────┐  ┌─ 前端 InfiniteCanvas ──────┐
│                               │  │                            │
│ submit_and_wait()             │  │ 提交任务拿到 taskId 后      │
│   ↓                           │  │   → 建立 EventSource       │
│ 提取结果 / 轮询                │  │   → GET /api/generate/     │
│   ↓                           │  │     task/{id}/stream       │
│ event_bus.publish(            │  │                            │
│   TaskEvent(                  │  │                            │
│     event_type=COMPLETED,     │  │  读 SSE 事件:              │
│     task_id="a1b2",           │  │  { type:"status",          │
│     result_urls=[...]         │  │    status:"completed",     │
│   )                           │  │    result_urls:[...] }     │
│ )                             │  │  → 更新节点数据             │
│   ↓                           │  │  → 创建结果节点             │
│ event_bus.send_end("a1b2")    │──│  → 断开 SSE 连接           │
└───────────────────────────────┘  └────────────────────────────┘

generate.py stream_task():
  每个 task 一个 asyncio.Queue
  → 轮询 DB status 变化 → yield SSE event
  → completed/failed → 发送结束哨兵 → 断开连接
```

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
| 后端框架 | FastAPI + Uvicorn | >=0.115 |
| 数据库 | SQLAlchemy (async) + aiosqlite | >=2 |
| 鉴权 | JWT (python-jose) + bcrypt | >=3.3 |
| 迁移 | Alembic | >=1.13 |
| HTTP 客户端 | httpx | >=0.27 |

## 本地开发

### 前置条件

- Node.js >= 18
- Python >= 3.11

### 一键启动

```bash
# Windows
start.bat          # 或 start.ps1
```

### 手动启动

**后端**：
```bash
cd backend
cp .env.example .env   # 编辑 .env 配置
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

**前端**：
```bash
cd frontend
cp .env.example .env.local   # 配置 API 地址
npm install
npm run dev                   # 默认 http://localhost:3000
```

### 关键配置

| 配置项 | 说明 |
|--------|------|
| `DATABASE_URL` | sqlite+aiosqlite 连接串 |
| `JWT_SECRET_KEY` | JWT 签名密钥 |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | 初始管理员账号 |
| `CORS_ORIGINS` | 允许的前端域名 |
| `UPLOAD_DIR` | 文件上传目录 |
| `MOCK_IMAGE_GENERATE` | 开发模式：mock 图片生成 |

### 项目初始化

首次启动后端会自动：
1. 建表（`create_all`）
2. 执行 schema 补齐（`ensure_schema_migrations`）
3. 创建管理员账号（`ensure_admin_exists`）
4. 初始化 Gateway 注册中心（注册所有 Capability/Protocol）
5. SQLite 开启 WAL 模式

## 文档与规范

- [架构笔记](docs/architecture-notes.md) — 画布保存、生命周期兜底、SSRF 实现
- [协作规则](docs/collaboration-rules.md) — 先出方案再动手、验证步骤、风险告知
- [Git 工作流](docs/git-workflow.md) — 不自动提交、中文 commit message、拆分 commit
- [CLAUDE.md](CLAUDE.md) — AI 协作快速参考
