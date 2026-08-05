# Noxrea AI Canvas

无限画布 AI 创作工具。基于节点式画布编辑，集成图片、文字、视频生成与 3D 导演模式，提供从创意到成品的完整工作流。

## 功能特性

- **无限画布** - 基于 React Flow 的节点式编辑，支持拖拽、缩放、分组、对齐
- **多模态生成** - 图片、视频、文本、音频一键生成，结果直接落回画布
- **3D 导演模式** - Three.js 驱动的 3D 场景编辑，支持模型导入与多视角预览
- **AI 对话** - 画布内聊天面板，支持 Mention 引用节点、技能调用
- **资源管理** - 内置素材库，支持文件夹组织与网格浏览
- **实时推送** - SSE 长连接，任务进度即时反馈
- **多协议适配** - OpenAI / Gemini / Ark 等主流 AI 厂商协议统一接入
- **国际化** - 中 / 英双语，运行时切换

## 技术栈

| 层级 | 技术 |
|------|------|
| 前端框架 | Next.js (App Router) + React 19 |
| 画布引擎 | @xyflow/react (React Flow) 12 |
| 状态管理 | Zustand 5 |
| UI 组件 | Ant Design 6 + Tailwind CSS 4 |
| 3D 引擎 | three.js |
| 后端框架 | Hono 4 + @hono/node-server |
| ORM | Prisma 6 |
| 数据库 | SQLite（开发）/ PostgreSQL（生产） |
| 鉴权 | JWT (jose) + bcryptjs |
| 校验 | Zod |
| 日志 | pino + pino-pretty |
| 图像处理 | sharp |

## 架构概览

```
Web (Next.js)                    Server (Hono + Node.js)
┌────────────┐                  ┌─────────────────────────┐
│  画布组件   │  /api/* rewrites │    Hono 路由层           │
│  生成面板   │ ──────────────> │         │                 │
│  资源管理   │  SSE (EventSource)│    Service -> CRUD -> Prisma│
│  3D 导演   │ <────────────── │         │                 │
│  Zustand   │                  │    Worker (同进程)        │
└────────────┘                  │         │                 │
                                │    AI Gateway 管线        │
                                │    CapabilityRouter       │
                                │      -> Protocol 适配       │
                                │      -> Storage 落盘       │
                                └─────────────────────────┘
```

前端通过 `next.config.ts` 的 rewrites 将 `/api/*` 透明代理到后端，无 CORS。Worker 与 HTTP 同进程运行，任务完成后经 SSE 实时推送。

## 快速开始

### 前置条件

- Node.js >= 18

### 安装

```bash
# 1. 克隆仓库
git clone <repo-url>
cd Noxrea-AI-Canvas

# 2. 安装依赖（npm workspaces，根目录执行一次即可）
npm install

# 3. 配置环境变量
cp .env.example .env
# 编辑 .env，至少设置 JWT_SECRET_KEY

# 4. 初始化数据库
npx prisma migrate deploy

# 5. 启动开发服务（Web + Server 同时启动）
npm run dev
```

访问 http://localhost:3000 即可使用。首次需注册账号（`ALLOW_REGISTRATION=true` 时开放）。

### 单独启动

```bash
npm run dev:web       # 仅前端 (localhost:3000)
npm run dev:server    # 仅后端 (localhost:4000)
```

### 生产部署

```bash
npm run build    # 构建前端
npm run start    # 启动 Web + Server 生产进程
```

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `DATABASE_URL` | 数据库连接串 | `file:./prisma/dev.db` |
| `JWT_SECRET_KEY` | JWT 签名密钥（**必填**） | - |
| `ALLOW_REGISTRATION` | 是否开放注册 | `true` |
| `SERVER_PORT` | 后端端口 | `4000` |
| `SERVER_HOST` | 后端监听地址 | `0.0.0.0` |
| `UPLOAD_DIR` | 上传文件根目录 | `uploads` |
| `MAX_UPLOAD_SIZE_MB` | 上传大小上限 (MB) | `30` |
| `WORKER_MAX_CONCURRENCY` | Worker 并发数 | `10` |
| `USE_SYSTEM_PROXY` | 是否使用代理访问上游 API | `false` |
| `PROXY_URL` | 代理地址 | - |
| `FFMPEG_PATH` | ffmpeg 所在目录 | `bin` |

完整配置见 `.env.example`。

## 项目结构

```
Noxrea-AI-Canvas/
├── web/                # Next.js 前端 (npm workspace 子包)
│   └── src/
│       ├── app/            # App Router 页面
│       ├── components/     # React 组件（canvas/panels/chat/nodes 等）
│       ├── stores/         # Zustand 状态管理
│       ├── hooks/          # 自定义 hooks
│       ├── lib/            # 纯工具层（零 store/component 依赖）
│       ├── director/       # 3D 引擎逻辑 (纯 TS)
│       └── i18n/           # 国际化资源
├── server/            # Node.js 后端 (HTTP + Worker 同进程)
│   ├── http/              # Hono 路由层
│   ├── core/              # 基础设施 (config/auth/database/logger/ssrf)
│   ├── crud/              # 数据访问层
│   ├── schemas/           # Zod schema + snake_case 映射
│   └── services/          # 业务逻辑
│       ├── capabilities/     # 能力服务 (image/video/llm/audio)
│       ├── protocols/        # 协议适配 (openai/gemini/ark)
│       ├── gateway/          # Gateway 注册中心
│       ├── worker/           # Worker 循环 + 任务执行
│       ├── tasks/            # 异步轮询管理器
│       └── storage/          # 存储后端 (本地/S3)
├── prisma/            # Prisma schema + 迁移
├── docs/              # 项目文档
└── package.json       # 根配置 (workspaces + 统一脚本)
```

## License

Private
