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
│                           │  HTTP / SSE                      │
└───────────────────────────┼──────────────────────────────────┘
                            │
┌───────────────────────────┼──────────────────────────────────┐
│                    Server (Node.js + Prisma)                  │
│                           │                                   │
│  ┌────────────────────────┴──────────────────────────────┐   │
│  │              API Route Handlers (web/src/app/api/)     │   │
│  └──────────────┬──────────────────────┬─────────────────┘   │
│                 │                      │                      │
│  ┌──────────────┴──────┐  ┌───────────┴───────────────┐     │
│  │   Worker Loop       │  │  TaskWatcher + SSE         │     │
│  │   轮询领取任务        │  │  跨进程事件推送              │     │
│  └──────────┬──────────┘  └───────────────────────────┘     │
│             │                                                 │
│  ┌──────────┴──────────────────────────────────────────┐     │
│  │                  AI Gateway 管线                      │     │
│  │  CapabilityRouter → CapabilityService                │     │
│  │       → request-builder (transforms/mapping/patch)   │     │
│  │       → Protocol (OpenAI/Gemini/Ark)                 │     │
│  │       → TaskManager (同步/异步轮询)                  │     │
│  └──────────────────────────────────────────────────────┘     │
│             │                                                 │
│             ▼                                                 │
│  ┌──────────────────────────────────────────────────────┐     │
│  │            Storage (下载 → 本地落盘 / S3)              │     │
│  └──────────────────────────────────────────────────────┘     │
└──────────────────────────────────────────────────────────────┘
```

## 目录结构

```
Noxrea-AI-Canvas/
├── web/                         # Next.js 前端
│   └── src/
│       ├── app/                 # App Router 页面 + API Route Handlers
│       │   ├── api/             # 后端 API 端点（controller 层）
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
├── server/                      # Node.js 后端业务层
│   ├── index.ts                 # Worker 独立进程入口
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
用户点生成 → 前端组装请求 → POST /api/generate/task → 创建任务(pending)
  → Worker 轮询领取 → Executor 执行
    → Gateway 管线 (transforms → mapping → patch → Protocol)
    → 调用厂商 API → Storage 下载落盘
  → TaskWatcher 跨进程推送 → SSE 通知前端
  → 前端更新节点展示结果
```

### 链路二：画布保存与还原

```
前端 SaveManager: dirty 标记 → 2s trailing save → 指纹对比去重
  → PUT /api/canvas/projects/{id} → 更新 canvas_data (JSON)
  → 页面卸载时 keepalive 兜底保存
```

### 链路三：SSE 实时推送

```
Worker 进程: 任务完成 → 写 DB → TaskWatcher 轮询检测
  → SSE 端点 GET /api/generate/task/{id}/stream
  → 前端 EventSource 接收 → 更新节点 / 显示错误
```

## 技术栈

| 层级 | 技术 | 版本 |
|------|------|------|
| 前端框架 | Next.js (App Router) | ^16 |
| 前端 UI | React + Tailwind CSS | ^19 / ^4 |
| 画布引擎 | @xyflow/react (React Flow) | ^12 |
| 状态管理 | Zustand | ^5 |
| UI 组件库 | Ant Design | ^6 |
| 后端运行时 | Node.js 18+ / TypeScript 5+ | — |
| ORM | Prisma | ^6 |
| 数据库 | SQLite（开发）/ PostgreSQL（生产） | — |
| 鉴权 | JWT (jose) + bcryptjs | ^5 / ^2 |
| 校验 | Zod | ^3 |
| 日志 | pino + pino-pretty | ^9 |
| 图像处理 | sharp | ^0.33 |
| 进程管理 | tsx（worker）/ concurrently（dev） | — |

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

# 启动（Next.js + Worker 同时启动）
npm run dev
# 前端 http://localhost:3000，API 同源
#
# 首次使用：通过页面注册账号（需 .env 中 ALLOW_REGISTRATION=true）
```

### 关键配置

| 配置项 | 说明 |
|--------|------|
| `DATABASE_URL` | SQLite `file:./prisma/dev.db` 或 PG 连接串 |
| `JWT_SECRET_KEY` | JWT 签名密钥（必填） |
| `ALLOW_REGISTRATION` | 是否开放页面注册，默认 `true` |
| `FFMPEG_PATH` | ffmpeg 路径，默认 `bin/ffmpeg`（视频截帧） |
| `ALLOW_INSECURE_SECRETS` | 开发逃生开关（跳过密钥占位符校验） |

## 文档

- [架构笔记](docs/architecture-notes.md) — 画布保存、SSRF 实现等
- [CLAUDE.md](CLAUDE.md) — AI 协作快速参考
