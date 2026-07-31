# Noxrea AI Canvas

无限画布 AI 创作工具，支持节点式画布编辑、图片/文字/视频生成。

## 技术栈

| 层级 | 技术 | 版本 |
|---|---|---|
| 前端框架 | Next.js (App Router) | ^16.2.10 |
| 前端 UI | React + Tailwind CSS | ^19.2.4 / ^4 |
| 画布引擎 | @xyflow/react (React Flow) | ^12.11.2 |
| 状态管理 | Zustand | ^5.0.14 |
| UI 组件库 | Ant Design | ^6.5.0 |
| 请求/缓存 | @tanstack/react-query | ^5.101.2 |
| 图标 | lucide-react | ^1.24.0 |
| 后端运行时 | Node.js 18+ / TypeScript 5+ | — |
| ORM | Prisma | ^6.0.0 |
| 数据库 | SQLite（开发）/ PostgreSQL（生产） | — |
| 鉴权 | JWT (jose) + bcryptjs | ^5.9.0 / ^2.4.3 |
| 校验 | Zod | ^3.24.0 |
| HTTP 客户端 | Node 内置 fetch + undici | — |
| 日志 | pino + pino-pretty | ^9.5.0 |
| 图像处理 | sharp | ^0.33.0 |
| 进程管理 | tsx（worker）/ concurrently（dev） | — |

## 目录结构

```
Noxrea-AI-Canvas/               # Monorepo 根
├── package.json                # 唯一 Node 项目入口，workspaces=["web"]
├── tsconfig.base.json          # 共享 TS 配置，paths @server/*
├── tsconfig.json               # 根 TS 配置（server/ + prisma/）
├── .env                        # 环境变量
├── .env.example                # 环境变量样例
│
├── prisma/
│   ├── schema.prisma           # 数据建模（9张表，camelCase+@map）
│   ├── migrations/             # 迁移文件
│   └── seed.ts                 # 管理员账号初始化
│
├── server/                     # Node.js 后端业务层（纯 Node，无 Next/React 依赖）
│   ├── index.ts                # Worker 独立进程入口
│   ├── core/                   # 基础设施
│   │   ├── config/             # Zod 配置解析
│   │   ├── database/           # PrismaClient 单例 + PRAGMA
│   │   ├── auth/               # JWT / bcrypt / withAuth
│   │   ├── logger/             # pino 日志 + logEvent/summarizeBody
│   │   ├── response/           # UnifiedResponse + ok/fail
│   │   ├── http/               # 场景化超时预设
│   │   ├── ssrf/               # SSRF 防护 + DNS pinning
│   │   ├── events/             # EventBus（进程内）+ TaskWatcher（跨进程）
│   │   └── ratelimit/          # 内存限流
│   ├── crud/                   # 数据访问层（task/user/model-config/canvas/asset/file）
│   ├── schemas/                # Zod schema + toXxxOut() mapper（唯一 snake_case 转换点）
│   ├── services/               # 业务逻辑
│   │   ├── capabilities/       # 能力服务（image/video/llm/audio/bg-removal）
│   │   ├── protocols/          # 协议适配（openai/gemini/ark）
│   │   ├── request-builder/    # 请求构建管线（transforms/mapping/patch）
│   │   ├── gateway/            # Gateway 注册中心 + 路由
│   │   ├── tasks/              # 异步轮询管理器
│   │   ├── worker/             # Worker 循环 + 任务执行器
│   │   ├── storage/            # 存储后端抽象 + 本地/S3 + 下载/哈希/媒体处理
│   │   ├── resolvers/          # 参考图解析
│   │   ├── inference/          # 推理服务调用
│   │   └── model-config/       # 预设/参数/白名单加载
│   └── resources/              # JSON 数据文件（presets/model_params/whitelist）
│
├── web/
│   ├── package.json            # 唯一的 workspace package，只含前端依赖
│   ├── tsconfig.json           # extends ../tsconfig.base.json
│   ├── next.config.ts          # monorepo 配置
│   ├── eslint.config.mjs       # server/** no-restricted-imports 规则
│   └── src/
│       ├── app/                # Next.js App Router 页面
│       │   ├── api/            # Route Handlers（controller 层）
│       │   ├── canvas/         # 画布主页面
│       │   ├── login/          # 登录页
│       │   └── project/        # 项目管理页
│       ├── components/         # React 组件
│       ├── hooks/              # 自定义 hooks
│       ├── lib/                # 工具层（api.ts BASE 为空字符串，同源请求）
│       ├── providers/          # React context providers
│       ├── stores/             # Zustand 状态管理
│       ├── director/           # 3D 引擎逻辑（纯 TS，无 React）
│       └── __tests__/          # 单元测试
│
├── inference_service/          # 独立推理服务（背景移除等），保持不动
├── backend/                    # [待删除] 原 Python FastAPI 后端（迁移参考源）
├── docs/                       # 项目文档
├── CLAUDE.md                   # 本文件
├── README.md                   # 项目说明
├── start.bat                   # Windows 一键启动
└── start.ps1                   # PowerShell 一键启动
```

## 前端命名规范

`web/src/` 下的文件名约定由 ESLint 规则 `check-file/filename-naming-convention` 强制（已设为 `error`），`simple-import-sort` 强制导入顺序：

| 类型 | 规则 | 示例 |
|---|---|---|
| React 组件 `*.tsx`（`components/**`） | PascalCase | `CanvasContextMenu.tsx` |
| 其余 `*.ts` / 非组件 `*.tsx` | kebab-case | `use-canvas-events.ts`、`app-modal.tsx` |
| 测试 `*.test.ts`（集中 `src/__tests__/`） | kebab-case | `canvas-events.test.ts` |
| 目录名 | 全小写 | `components/`、`director/` |

- import 排序：`simple-import-sort` 分组为 external → `@/` / `@server/` 绝对路径 → 相对路径
- 测试集中放在 `src/__tests__/`

## 命名边界

| 边界 | 规则 |
|---|---|
| Prisma model | 字段 camelCase + `@map("snake_case")`，表 `@@map` |
| CRUD | 入参/返回使用 Prisma camelCase 对象 + 已解析 JSON |
| Service / Worker / Gateway | 全 camelCase |
| Route 出口 | 由 `schemas/*.ts` 的 `toXxxOut()` mapper 统一转回 snake_case JSON |
| Protocol | 第三方参数保持官方原格式 |
| API 响应 | 成功 `{ code, data, msg }`，错误 `{ detail }` |

## 关键架构约定

- **调用链**：`API Route -> Service -> CRUD -> Prisma`；`Worker -> Executor -> Gateway -> Capability -> Protocol`
- **Service 禁止直接调用 Prisma**，必须经过 CRUD 层
- **server/ 纯 Node.js 边界**：禁止导入 `next/*`、`react/*`、`@/*`（由 ESLint 规则强制）
- **跨进程 SSE**：Worker 进程写 DB → TaskWatcher 读 DB → SSE 推送（非进程内 EventBus）
- 画布保存机制、SSRF 防护实现等详见 [docs/architecture-notes.md](docs/architecture-notes.md)

## 配置与运行

- 复制 `.env.example` 为 `.env`，设置 `JWT_SECRET_KEY` 和 `ADMIN_PASSWORD`
- 安装依赖：`npm install`（根目录，自动处理 workspace + postinstall prisma generate）
- 初始化数据库：`npx prisma migrate dev --name init` → `npm run prisma:seed`
- 启动开发：`npm run dev`（同时启动 Next.js + Worker）
- 单独启动 Worker：`npm run worker`
- 类型检查：`npm run typecheck`

## 协作规则

见 [docs/collaboration-rules.md](docs/collaboration-rules.md)。核心原则：
- 方案选型或改动范围较大时，先出方案等确认，再动手改代码
- 改完主动给验证/测试步骤，不能只说"改完了"
- 安全相关改动主动列风险点，不等用户追问
- 新增依赖先确认，不擅自安装
- 顺手发现的无关 bug 先告知，不擅自改动

## Git 提交规则

见 [docs/git-workflow.md](docs/git-workflow.md)。核心原则：
- **不自动提交**，等用户确认后才 `git add + commit + push`
- Commit message 用简洁中文，说明改了啥、为啥改
- 不相关的改动拆成多个 commit
