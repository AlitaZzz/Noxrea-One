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
| 后端框架 | Hono + @hono/node-server | ^4 |
| 后端运行时 | Node.js 18+ / TypeScript 5+ | - |
| ORM | Prisma | ^6.0.0 |
| 数据库 | SQLite（开发）/ PostgreSQL（生产） | - |
| 鉴权 | JWT (jose) + bcryptjs | ^5.9.0 / ^2.4.3 |
| 校验 | Zod | ^3.24.0 |
| HTTP 客户端 | Node 内置 fetch + undici | - |
| 日志 | pino + pino-pretty | ^9.5.0 |
| 图像处理 | sharp | ^0.33.0 |
| 进程管理 | tsx（server）/ concurrently（dev） | - |

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
│   └── migrations/             # 迁移历史（已纳入版本控制）
│
├── server/                     # Node.js 后端（HTTP + Worker 同进程）
│   ├── index.ts                # 服务入口（启动 Hono HTTP + Worker 循环）
│   ├── http/                   # Hono 路由层
│   │   ├── app.ts              # Hono 实例 + 路由注册
│   │   ├── server.ts           # @hono/node-server 启停
│   │   └── routes/             # 路由模块（auth/canvas/assets/generate/files 等）
│   ├── core/                   # 基础设施
│   │   ├── config/             # Zod 配置解析
│   │   ├── database/           # PrismaClient 单例 + PRAGMA
│   │   ├── auth/               # JWT / bcrypt / authenticateRequest
│   │   ├── logger/             # pino 日志 + logEvent/summarizeBody
│   │   ├── response/           # UnifiedResponse + ok/fail
│   │   ├── http/               # 场景化超时预设
│   │   ├── ssrf/               # SSRF 防护 + DNS pinning
│   │   ├── events/             # EventBus + TaskWatcher（同进程）
│   │   └── ratelimit/          # 内存限流
│   ├── crud/                   # 数据访问层（task/user/model-config/canvas/asset/file）
│   ├── schemas/                # Zod schema + toXxxOut() mapper（唯一 snake_case 转换点）
│   ├── services/               # 业务逻辑
│   │   ├── capabilities/       # 能力服务（image/video/llm/audio）
│   │   ├── protocols/          # 协议适配（openai/gemini/ark）
│   │   ├── request-builder/    # 请求构建管线（transforms/mapping/patch）
│   │   ├── gateway/            # Gateway 注册中心 + 路由
│   │   ├── tasks/              # 异步轮询管理器
│   │   ├── worker/             # Worker 循环 + 任务执行器
│   │   ├── storage/            # 存储后端抽象 + 本地/S3 + 下载/哈希/媒体处理
│   │   ├── resolvers/          # 参考图解析
│   │   └── model-config/       # 预设/参数加载
│   └── resources/              # JSON 数据文件（presets/model_params）
│
├── web/
│   ├── package.json            # 唯一的 workspace package，只含前端依赖
│   ├── tsconfig.json           # extends ../tsconfig.base.json
│   ├── next.config.ts          # monorepo 配置 + rewrites /api/* -> localhost:4000
│   ├── eslint.config.mjs       # 前端 ESLint 规则
│   └── src/
│       ├── app/                # Next.js App Router 页面（纯前端，无 API 路由）
│       │   ├── (app)/          # 已认证路由组（layout.tsx 做鉴权守卫）
│       │   │   ├── canvas/     # 画布主页面
│       │   │   ├── project/    # 项目管理页
│       │   │   └── layout.tsx
│       │   ├── login/          # 登录页（无需鉴权，直接根下）
│       │   ├── layout.tsx      # 根布局
│       │   └── page.tsx        # 首页（重定向）
│       ├── components/         # React 组件
│       │   ├── canvas/         # 画布核心（按功能子目录组织）
│       │   │   ├── controls/   # 画布控制（对齐/右键/缩放/工具栏/边删除）
│       │   │   ├── panels/     # 生成面板（图片/视频/文本/API设置）
│       │   │   ├── chat/       # 聊天交互（ChatPanel/Mention/SkillPanel）
│       │   │   ├── editing/    # 编辑工具（裁剪/标注/光照/多角度）
│       │   │   ├── sidebar/    # 侧边栏（CanvasSidebar/NodeInspector）
│       │   │   ├── gen/        # 生成面板共享（RatioIcon/ModelOption）
│       │   │   ├── nodes/      # 节点组件（Text/Image/Video/Audio/Group/Director）
│       │   │   └── InfiniteCanvas.tsx  # 主画布入口
│       │   ├── common/         # 通用 UI（AppModal/ConfirmModal/VirtualList 等）
│       │   ├── assets/         # 资源管理（侧栏/网格/卡片/文件夹）
│       │   ├── director/       # 3D 引擎 React UI 容器
│       │   ├── auth/           # 认证组件
│       │   ├── layout/         # 布局组件
│       │   └── overlays/       # 覆盖层（LayerModal 等）
│       ├── contexts/           # React Context（edge-highlight-context）
│       ├── hooks/              # 自定义 hooks（含 index.ts barrel export）
│       ├── i18n/               # 国际化资源（zh-CN.json / en-US.json + 加载器）
│       ├── lib/                # 纯工具层（零 stores/components 依赖）
│       │   ├── types/          # 领域类型（canvas/nodes/models/assets/project）
│       │   ├── types.ts        # Barrel re-export（向后兼容）
│       │   ├── api.ts          # API 调用（引用 lib/global-message）
│       │   ├── global-message.ts  # 全局消息 API（antd message 代理）
│       │   ├── constants.ts    # 全局常量 + EventNames + NODE_TYPE_COLOR
│       │   ├── image-utils.ts  # 图片工具（依赖注入 CanvasStoreApi）
│       │   ├── add-asset.ts    # 资产->节点（纯函数，依赖注入）
│       │   ├── agent-tools.ts  # Agent 工具（依赖注入 addNodes/findFreePosition）
│       │   ├── node-defaults.ts
│       │   └── slash-command.ts
│       ├── providers/          # React context providers
│       ├── stores/             # Zustand 状态管理（含 index.ts barrel export）
│       │   ├── canvas-store.ts
│       │   ├── save-manager.ts # 画布保存管理器（从 lib/ 迁入）
│       │   ├── context-menu-store.ts  # 右键菜单状态（从组件提取）
│       │   ├── i18n-store.ts   # i18n 状态（翻译文本在 i18n/ 目录）
│       │   └── ...
│       ├── director/           # 3D 引擎逻辑（纯 TS，无 React）
│       └── __tests__/          # 单元测试
│
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
| React 组件 `*.tsx`（`components/**`） | PascalCase | `CanvasContextMenu.tsx`、`AppModal.tsx` |
| 其余 `*.ts` / 非组件 `*.tsx` | kebab-case | `use-canvas-events.ts`、`global-message.ts` |
| 测试 `*.test.ts`（集中 `src/__tests__/`） | kebab-case | `canvas-events.test.ts` |
| 目录名 | 全小写 | `components/`、`director/`、`controls/` |

- import 排序：`simple-import-sort` 分组为 external -> `@/` 绝对路径 -> 相对路径
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

- **调用链**：`Hono Route -> Service -> CRUD -> Prisma`；`Worker Loop -> Executor -> Gateway -> Capability -> Protocol`
- **Service 禁止直接调用 Prisma**，必须经过 CRUD 层
- **server/ 纯 Node.js 边界**：不导入 `next/*`、`react/*`（web 已无 `@server` 引用）
- **同进程 SSE**：Worker 同进程写 DB -> TaskWatcher 读 DB -> SSE 推送
- **前端代理**：next.config.ts rewrites `/api/*` -> `localhost:4000`，无 CORS
- **前端分层单向依赖**：`app -> components -> hooks/stores -> lib`，禁止反向依赖
  - `lib/` 层零 `@/stores/` 和 `@/components/` 引用（纯工具 + 依赖注入）
  - `hooks/` 层零 `@/components/` 引用（纯逻辑）
  - `lib/` 中需要操作 store 的函数，通过参数注入 `CanvasStoreApi` 接口（见 `image-utils.ts`、`agent-tools.ts`、`add-asset.ts`）
- **类型就近定义**：领域类型在 `lib/types/` 下按领域拆分，`lib/types.ts` 为 barrel re-export
- **i18n 资源外置**：翻译文本在 `i18n/zh-CN.json` 和 `i18n/en-US.json`，`stores/i18n-store.ts` 仅管理状态
- 画布保存机制、SSRF 防护实现等详见 [docs/architecture-notes.md](docs/architecture-notes.md)

## 配置与运行

- 复制 `.env.example` 为 `.env`，设置 `JWT_SECRET_KEY`（必填），`ALLOW_REGISTRATION` 控制是否开放注册
- 安装依赖：`npm install`（根目录，自动处理 workspace + postinstall prisma generate）
- 初始化数据库：`npx prisma migrate deploy`（应用迁移、创建表结构；开发期可用 `npx prisma migrate dev`）
- 启动开发：`npm run dev`（同时启动 Web + Server）
- 单独启动 Server：`npm run dev:server`
- 生产启动：`npm run start`（同时启动 Web + Server 生产进程）
- 类型检查：`npm run typecheck`

## 协作规则

见 [docs/collaboration-rules.md](docs/collaboration-rules.md)。核心原则：
- 方案选型或改动范围较大时，先出方案等确认，再动手改代码
- 改完主动给验证/测试步骤，不能只说"改完了"
- 安全相关改动主动列风险点，不等用户追问
- 新增依赖先确认，不擅自安装
- 顺手发现的无关 bug 先告知，不擅自改动

## Git 提交规则

- **不自动提交**，等用户确认后才 `git add + commit`
- Commit message 用简洁中文，说明改了啥、为啥改
- 不相关的改动拆成多个 commit
