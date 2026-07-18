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
| 后端框架 | FastAPI + Uvicorn | >=0.115.0 |
| 数据库 | SQLAlchemy (async) + aiosqlite | >=2.0.30 |
| 鉴权 | JWT (python-jose) + bcrypt | >=3.3.0 |
| 迁移 | Alembic | >=1.13.0 |
| HTTP 客户端 | httpx | >=0.27.0 |

## 目录结构

```
frontend/src/
├── app/              # Next.js App Router 页面
│   ├── canvas/       # 画布主页面
│   ├── login/        # 登录页
│   └── project/      # 项目管理页
├── components/
│   ├── assets/       # 资源管理（AssetSidebar, AssetGrid 等）
│   ├── auth/         # 认证相关（SettingsModal, AvatarCropModal）
│   ├── canvas/       # 画布核心（InfiniteCanvas, NodeToolbar 等）
│   │   └── nodes/    # 节点组件（Text/Image/Video/Group/ImageGroup）
│   ├── common/       # 通用 UI（ConfirmModal, NavButton, WheelGuard）
│   └── layout/       # AppShell
├── hooks/            # 自定义 hooks（use-canvas-keyboard）
├── lib/              # 工具层（save-manager, api, types, constants, image-utils）
├── providers/        # React context providers（AppProviders）
└── stores/           # Zustand 状态管理
    ├── canvas-store.ts       # 画布节点/边/视口状态
    ├── project-store.ts      # 项目管理
    ├── history-store.ts      # 撤销/重做
    ├── selection-store.ts    # 选择/剪贴板
    ├── assets-store.ts       # 资源库
    ├── auth-store.ts         # 登录鉴权
    ├── model-store.ts        # AI 模型配置
    └── i18n-store.ts         # 国际化

backend/
├── app/
│   ├── main.py       # FastAPI 应用入口、CORS、路由注册
│   ├── config.py     # pydantic-settings 配置
│   ├── database.py   # 异步 SQLAlchemy 引擎与会话
│   ├── deps.py       # 依赖注入（get_current_user）
│   ├── crud/         # CRUD 操作
│   ├── models/       # SQLAlchemy ORM 模型
│   ├── routers/      # API 路由（auth, canvas, files, model_config, assets, generate, ai_proxy）
│   ├── schemas/      # Pydantic 请求/响应模型
│   └── services/     # 业务逻辑（auth, providers, worker）
└── alembic/          # 数据库迁移版本
```

## 关键架构约定

画布保存机制（SaveManager 触发规则）、生命周期兜底、常见 Bug 模式（useEffect cleanup 陷阱、闭包捕获过期数据）、SSRF 防护实现、代码规范，详见 [docs/architecture-notes.md](docs/architecture-notes.md)。

**改动画布保存逻辑、节点数据持久化、或新增网络请求转发功能之前，务必先看这份文档**——这些是本项目反复踩过坑的地方。

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
- 提交前检查是否有遗留的调试代码

## Token 使用规则

见 [docs/claude-code-workflow.md](docs/claude-code-workflow.md)。核心原则：
- 大文件先用 Grep 定位，再用 `offset`/`limit` 只读片段
- 长输出命令默认追加 `head`/`tail`/`grep` 过滤

## 配置与运行

- 前端 `frontend/`：`.env.local` 配置 API 地址，`npm run dev` 启动
- 后端 `backend/`：`.env` 配置数据库/JWT/管理员账号，`uvicorn app.main:app` 启动
- CORS 默认允许 `localhost:3000` 和 `localhost:5173`，通过 `CORS_ORIGINS` 配置
