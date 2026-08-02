# Noxrea AI Canvas

无限画布 AI 创作工具，支持节点式画布编辑、图片/文字/视频生成，以及 3D 导演模式。

## 系统架构

```
┌─────────────────────────────────────────────────────────────┐
│                     Web (Next.js App Router)                  │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌───────────────┐  │
│  │ 画布组件  │ │ 生成面板  │ │ 资源管理  │ │ Director(3D)  │  │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘ └───────┬───────┘  │
│       │              │            │               │          │
│  ┌────┴──────────────┴────────────┴───────────────┴───────┐  │
│  │             Zustand Stores (状态管理)                    │  │
│  └────────────────────────┬───────────────────────────────┘  │
│                           │  /api/* (rewrites 透明代理)       │
└───────────────────────────┼──────────────────────────────────┘
                            │
┌───────────────────────────┼──────────────────────────────────┐
│              Server (Hono + Node.js + Prisma)                 │
│                           │                                   │
│  ┌────────────────────────┴──────────────────────────────┐   │
│  │            Hono Route Handlers (server/http/)          │   │
│  └──────────────┬──────────────────────┬─────────────────┘   │
│                 │                      │                      │
│  ┌──────────────┴──────┐  ┌───────────┴───────────────┐     │
│  │   Worker Loop       │  │  SSE (TaskWatcher)         │     │
│  │   (同进程异步循环)    │  │  (同进程事件推送)            │     │
│  └──────────┬──────────┘  └───────────────────────────┘     │
│             │                                                 │
│  ┌──────────┴──────────────────────────────────────────┐     │
│  │                  AI Gateway 管线                      │     │
│  │  CapabilityRouter -> CapabilityService                │     │
│  │       -> request-builder (transforms/mapping/patch)   │     │
│  │       -> Protocol (OpenAI/Gemini/Ark)                 │     │
│  │       -> TaskManager (同步/异步轮询)                  │     │
│  └──────────────────────────────────────────────────────┘     │
│             │                                                 │
│             ▼                                                 │
│  ┌──────────────────────────────────────────────────────┐     │
│  │            Storage (下载 -> 本地落盘 / S3)              │     │
│  └──────────────────────────────────────────────────────┘     │
└──────────────────────────────────────────────────────────────┘
```

## 目录结构

```
Noxrea-AI-Canvas/
├── web/                         # Next.js 纯前端
│   └── src/
│       ├── app/                 # App Router 页面（API 已迁移至 server）
│       │   ├── canvas/          # 画布主页
│       │   ├── login/           # 登录页
│       │   └── project/         # 项目管理页
│       ├── components/          # React 组件
│       │   ├── canvas/          # 画布核心（InfiniteCanvas, 生成面板等）
│       │   │   └── nodes/       # 节点组件（Text/Image/Video/Group/Director）
│       │   ├── assets/          # 资源管理（侧栏/网格/卡片/文件夹）
│       │   ├── director/        # 3D 引擎 React UI 容器
│       │   ├── common/          # 通用 UI
│       │   └── auth/            # 认证组件
│       ├── stores/              # Zustand 状态管理
│       ├── lib/                 # 工具层（api, types, save-manager 等）
│       ├── hooks/               # 自定义 hooks
│       ├── director/            # 3D 引擎纯 TS 逻辑（core/entities/util）
│       └── __tests__/           # 单元测试
│
├── server/                      # Node.js 后端（HTTP + Worker 同进程）
│   ├── index.ts                 # 服务入口（启动 Hono HTTP + Worker 循环）
│   ├── http/                    # Hono 路由层
│   │   ├── app.ts               # Hono 实例 + 路由注册
│   │   ├── server.ts            # @hono/node-server 启停
│   │   └── routes/              # 路由模块（auth/canvas/assets/generate/files 等）
│   ├── core/                    # 基础设施（config/auth/database/logger/http/ssrf/events）
│   ├── crud/                    # 数据访问层
│   ├── schemas/                 # Zod schema + snake_case 映射
│   ├── services/                # 业务逻辑
│   │   ├── capabilities/        # 能力服务（image/video/llm/audio/bg-removal）
│   │   ├── protocols/           # 协议适配（openai/gemini/ark）
│   │   ├── request-builder/     # 请求构建管线
│   │   ├── gateway/             # Gateway 注册中心 + 路由
│   │   ├── tasks/               # 异步轮询管理器
│   │   ├── worker/              # Worker 循环 + 任务执行器
│   │   ├── storage/             # 存储后端抽象 + 本地/S3 + 媒体处理
│   │   ├── resolvers/           # 参考图解析
│   │   ├── inference/           # 推理服务调用
│   │   └── model-config/        # 预设/参数加载
│   └── resources/               # JSON 数据文件（presets/model_params）
│
├── prisma/                      # 数据建模
│   ├── schema.prisma            # Prisma schema
│   └── migrations/              # 数据库迁移历史（已纳入版本控制）
│
├── inference_service/           # 独立推理服务（背景移除）
├── docs/                        # 项目文档
├── start.bat / start.ps1        # 一键启动脚本
└── CLAUDE.md                    # AI 协作指南
```

## 核心链路

### 链路一：AI 生成

```
用户点生成 -> 前端组装请求 -> POST /api/generate/task -> 创建任务(pending)
  -> Worker 同进程领取 -> Executor 执行
    -> Gateway 管线 (transforms -> mapping -> patch -> Protocol)
    -> 调用厂商 API -> Storage 下载落盘
  -> TaskWatcher 同进程推送 -> SSE 通知前端
  -> 前端更新节点展示结果
```

### 链路二：画布保存与还原

```
前端 SaveManager: dirty 标记 -> 2s trailing save -> 指纹对比去重
  -> PUT /api/canvas/projects/{id} -> 更新 canvas_data (JSON)
  -> 页面卸载时 keepalive 兜底保存
```

### 链路三：SSE 实时推送

```
同进程 Worker: 任务完成 -> 写 DB -> TaskWatcher 轮询检测
  -> SSE 端点 GET /api/generate/task/{id}/stream
  -> 前端 EventSource 接收 -> 更新节点 / 显示错误
```

## 技术栈

| 层级 | 技术 | 版本 |
|------|------|------|
| 前端框架 | Next.js (App Router) | ^16 |
| 前端 UI | React + Tailwind CSS | ^19 / ^4 |
| 画布引擎 | @xyflow/react (React Flow) | ^12 |
| 状态管理 | Zustand | ^5 |
| UI 组件库 | Ant Design | ^6 |
| 请求/缓存 | @tanstack/react-query | ^5 |
| 3D 引擎 | three.js | ^0.185 |
| 图标 | lucide-react | ^1 |
| 后端框架 | Hono + @hono/node-server | ^4 |
| 后端运行时 | Node.js 18+ / TypeScript 5+ | - |
| ORM | Prisma | ^6 |
| 数据库 | SQLite（开发）/ PostgreSQL（生产） | - |
| 鉴权 | JWT (jose) + bcryptjs | ^5 / ^2 |
| 校验 | Zod | ^3 |
| HTTP 客户端 | Node 内置 fetch + undici | ^7 |
| 并发控制 | p-limit | ^6 |
| 日志 | pino + pino-pretty | ^9 |
| 图像处理 | sharp | ^0.33 |
| 进程管理 | tsx（server）/ concurrently（dev） | - |

## 本地开发

### 前置条件

- Node.js >= 18

### 快速启动

```bash
# 安装依赖
npm install

# 配置环境变量
cp .env.example .env
# 编辑 .env，设置 JWT_SECRET_KEY（必填）

# 初始化数据库（应用迁移、创建表结构）
npx prisma migrate deploy
# 开发期如需重新生成迁移可用：npx prisma migrate dev

# 启动（Web + Server 同时启动）
npm run dev
# 前端 http://localhost:3000，API 通过 rewrites 代理到 localhost:4000
#
# 首次使用：通过页面注册账号（需 .env 中 ALLOW_REGISTRATION=true）
```

### 关键配置

| 配置项 | 说明 |
|--------|------|
| `DATABASE_URL` | SQLite `file:./prisma/dev.db` 或 PG 连接串 |
| `JWT_SECRET_KEY` | JWT 签名密钥（必填） |
| `ALLOW_REGISTRATION` | 是否开放页面注册，默认 `true` |
| `SERVER_PORT` | 后端 HTTP 端口，默认 `4000` |
| `SERVER_HOST` | 后端监听地址，默认 `0.0.0.0` |
| `UPLOAD_DIR` | 上传文件根目录，默认 `uploads`（相对项目根或绝对路径） |
| `MAX_UPLOAD_SIZE_MB` | 上传文件大小上限（MB），默认 `30`；Next.js proxy body 限制自动跟随此值 +5mb |
| `FFMPEG_PATH` | ffmpeg 所在目录，默认 `bin`（代码自动拼接 `ffmpeg`/`ffmpeg.exe`） |
| `HTTP_TIMEOUT_DL` | 下载/CDN 超时（秒），默认 `45` |
| `HTTP_TIMEOUT_POLL` | 异步轮询超时（秒），默认 `15` |
| `HTTP_TIMEOUT_API` | 同步普通接口超时（秒），默认 `120` |
| `HTTP_TIMEOUT_ASYNC` | 异步任务创建超时（秒），默认 `30` |
| `WORKER_MAX_CONCURRENCY` | Worker 并发数，默认 `10` |
| `INFERENCE_SERVICE_URL` | 推理服务地址（背景移除等），默认 `http://localhost:8100` |
| `USE_SYSTEM_PROXY` | 是否使用代理访问上游 API，默认 `false` |
| `PROXY_URL` | 代理地址，如 `http://127.0.0.1:7890` |
| `ALLOW_INSECURE_SECRETS` | 开发逃生开关（跳过密钥占位符校验），默认 `false` |

## 文档

- [架构笔记](docs/architecture-notes.md) - 画布保存、SSRF 实现等
- [CLAUDE.md](CLAUDE.md) - AI 协作快速参考
