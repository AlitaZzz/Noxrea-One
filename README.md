# Noxrea One

Noxrea One 是一个面向创意生产流程的 AI Canvas 应用。你可以在画布中组织文本、图片、音频与视频素材，通过可配置的模型服务发起生成任务，并使用 Agent 技能把脚本、分镜、广告文案等创作过程沉淀在同一个项目空间里。

## 产品能力

### 画布工作台

- 以项目为单位组织创作内容，支持节点编辑、参数配置与结果回填。
- 上传或引用图片、音频、视频，并将素材作为参考输入交给生成任务。
- 通过节点画布串联 Prompt、参考素材、生成参数与输出结果。

### AI 生成

- 支持 LLM、图像、音频、视频四类能力。
- 生成任务由后端 Worker 管理，具备并发控制、超时、重试、取消与断线恢复机制。
- 前端通过 SSE 获取任务进度，避免长请求阻塞界面。

### 模型与供应商配置

- 可在后端保存多个模型供应商、基础地址、协议、模型与能力配置。
- API Key 只通过专有接口按需读取，前端界面与后端参数构建共享同一份模型 UI 配置。
- 内置 OpenAI 协议适配结构，参数映射通过 JSON 配置驱动。

### 素材与文件

- 素材支持分组、标签、媒体类型、尺寸与扩展信息。
- 文件按用户与内容哈希去重，并通过引用计数管理生命周期。
- 上传、视频抽帧、音频分离、视频代理与帧预览等媒体处理能力由后端统一提供。

### Agent

- 每个画布项目可以维护独立的 Agent 会话。
- Agent 可通过工具直接操纵画布：创建/更新/删除节点、连线、整理布局与视口控制等。

## 技术架构

| 层级 | 技术 | 说明 |
| --- | --- | --- |
| 前端 | Next.js、React、TypeScript | 画布、项目管理、设置中心与登录界面 |
| 后端 | Hono、TypeScript | REST API、SSE、文件与媒体处理 |
| 数据库 | Prisma、PostgreSQL | 用户、项目、任务、模型、素材与 Agent 数据；本地开发用进程内 PGlite（零安装），部署用外置 PostgreSQL |
| 模型网关 | Hono Services | 能力路由、协议适配、参数映射与任务执行 |
| 媒体处理 | FFmpeg、Sharp | 视频抽帧、音频分离与图像处理 |
| 部署 | Docker、Node.js 20 | 单容器运行前端与后端（数据库外置 PostgreSQL），`/data` 持久化数据 |

Next.js 将 `/api/*` 请求透明转发到 Hono 服务。本地单容器部署中，前端端口为 `3000`，后端端口为 `4000`；容器只对外暴露 `3000`。

## 目录结构

```text
.
├── web/                  # Next.js 前端
├── server/               # Hono 后端、能力服务与协议适配
│   ├── http/routes/      # API 路由
│   ├── services/         # 模型网关、任务 Worker、存储与 Agent 服务
│   └── resources/        # 模型 UI、供应商预设、Prompt 与技能配置
├── prisma/               # Prisma schema 与迁移
├── data/                 # 本地模式 PGlite 数据目录（首次启动自动创建）
├── uploads/              # 本地上传文件
├── Dockerfile            # 构建单容器镜像
├── docker-entrypoint.sh  # 容器初始化入口
└── docker-compose.nas.yml # NAS 部署示例
```

## 快速开始

### 本地开发

1. 准备环境

   - Node.js 20 或更高版本
   - npm
   - FFmpeg 完整发行包（包含 `ffmpeg` 和 `ffprobe`）；默认在项目根目录的 `bin` 下查找这两个可执行文件，Windows 使用 `.exe` 后缀

2. 安装依赖

   ```bash
   npm install
   ```

   安装阶段会自动执行 `prisma generate`，并为前端依赖补齐必要的兼容处理。

3. 配置环境变量

   ```bash
   cp .env.example .env
   ```

   编辑 `.env`，设置 JWT 密钥即可：

   ```env
   JWT_SECRET_KEY=替换为随机长密钥
   ```

   不设置 `DATABASE_URL` 即为本地模式：进程内 PGlite，零安装，数据存于 `data/pglite`（自动创建）。需要连接已有 PostgreSQL 时再设置 `DATABASE_URL`（见下方环境变量表）。

   生成密钥示例：

   ```bash
   openssl rand -hex 32
   ```

4. 启动开发服务

   首次启动会自动应用 `prisma/migrations` 建表（本地模式由内置迁移 runner 完成），无需手动初始化数据库。

   ```bash
   npm run dev
   ```

   访问地址：

   - Web：<http://localhost:3000>
   - API：<http://localhost:4000>

首次使用时在登录页注册账号。如果需要关闭注册，将数据库 `system_settings` 表中 `auth.registration_enabled` 的值改为 `false` 后重启服务（见下方「系统设置」）。

## 常用命令

| 命令 | 说明 |
| --- | --- |
| `npm run dev` | 同时启动 Web 与后端开发服务 |
| `npm run dev:web` | 只启动前端 |
| `npm run dev:server` | 只启动后端 |
| `npm run build` | 构建前端 |
| `npm start` | 启动构建后的 Web 与后端 |
| `npm run lint` | 运行前端与后端 ESLint |
| `npm run typecheck` | 运行根目录与前端 TypeScript 检查 |
| `npm test` | 运行后端与前端 Vitest 测试 |
| `npm run test:watch` | 以监听模式运行 Vitest |
| `npm run db:migrate:new -- <name>` | 修改 `prisma/schema.prisma` 后生成新迁移（本地模式下次启动自动应用） |
| `npm run prisma:generate` | 生成 Prisma Client |

## 环境变量

完整模板见 `.env.example`，变量按读取方分为后端、前后端共用、前端（`WEB_` 前缀）三区。以下是最常用配置：

| 变量 | 说明 |
| --- | --- |
| `JWT_SECRET_KEY` | JWT 签名密钥，必填 |
| `DATABASE_URL` | 数据库连接串（双模式）：不设置即本地模式（进程内 PGlite，数据在 `data/pglite`）；设为 `postgres://` 连接串即服务器模式（外置 PostgreSQL，迁移由部署侧 `prisma migrate deploy` 负责） |
| `API_HOST` / `API_PORT` | 后端（Hono）监听地址与端口，默认 `0.0.0.0:4000` |
| `WEB_API_ORIGIN` | 前端（Next）转发 `/api/*` 的后端地址；默认 `http://localhost:${API_PORT}`，仅前后端分开部署时设置（`next build` 时固化） |
| `WEB_AUTH_GATE_MODE` | 前端路由门在后端不可达时的策略：`fail-open`（默认，可用性优先）/ `fail-closed`（安全优先） |
| `WEB_APP_NAME` | 浏览器端显示的应用名（构建期固化） |
| `UPLOAD_DIR` | 上传文件目录，默认 `uploads` |
| `UPLOAD_BATCH_MAX_MB` | 单次批量上传总大小上限，默认 `128` MiB（配置键沿用 MB 命名；Next 代理层共用，故保留在 env） |
| `FFMPEG_PATH` | `ffmpeg` 和 `ffprobe` 所在目录，默认 `bin` |
| `RESOURCES_DIR` | 模型配置、Prompt 与技能资源目录 |
| `LOG_LEVEL` | 日志级别，可选 `DEBUG`、`INFO`、`WARN`、`ERROR` |
| `ALLOW_INSECURE_SECRETS` | 是否允许占位密钥启动，仅建议本地开发使用 |

生产环境务必使用随机 `JWT_SECRET_KEY`，不要开启 `ALLOW_INSECURE_SECRETS`。

### 系统设置

运行期业务参数不再通过环境变量配置，而是存放在数据库 `system_settings` 表。服务首次启动时会把缺失的键以默认值写入，之后以数据库为准；修改数据库中的值后重启服务生效（暂无后台管理界面：服务器模式可用 `psql` 执行 SQL，本地模式可用一次性脚本经 PGlite 执行同样的 SQL）。键、校验规则与默认值见 [`server/core/settings/registry.ts`](server/core/settings/registry.ts)，分组如下：

| 前缀 | 内容 |
| --- | --- |
| `auth.*` | 注册开关 `registration_enabled`、登录态有效期 `token_ttl_minutes` |
| `network.*` | 可信代理网段、SSRF 内网白名单、出网代理、对外访问地址 `public_base_url` |
| `upload.*` | 单文件大小、单批文件数、单用户并发批次数与排队深度 |
| `worker.*` | 生成任务 Worker 的轮询、并发、超时、重试等 |
| `http.*` | 下载、轮询、API 请求超时，响应体空闲与下载总时长 |
| `storage.*` | 存储引用 GC 宽限期与试运行开关 |

例如关闭注册：

```sql
UPDATE system_settings SET value = 'false' WHERE key = 'auth.registration_enabled';
```

## Docker 部署

镜像将前端与后端封装在同一容器中，配置与上传文件统一持久化到 `/data`；数据库为外置 PostgreSQL（compose 示例内置 postgres 服务，也可指向自备实例），entrypoint 会等待数据库就绪并自动执行 `prisma migrate deploy`。

1. 准备 `docker-compose.nas.yml`

   默认 compose 文件使用以下配置：

   - 镜像：`ghcr.io/alitazzz/noxrea-one:latest`
   - 端口：宿主机 `3000` → 容器 `3000`
   - 数据目录：`/share/Container/noxreaone` → 容器 `/data`
   - 网络：外部网络 `mihomo_shared_network`

   如果不需要连接已有共享网络，请将 `networks` 部分调整为你的实际 Docker 网络。

2. 启动服务

   ```bash
   docker compose -f docker-compose.nas.yml up -d
   ```

3. 首次启动后修改配置

   容器首次启动会在持久化目录中生成：

   ```text
   /share/Container/noxreaone/.env
   ```

   文件包含自动生成的 `JWT_SECRET_KEY` 和容器内路径配置。修改配置后重启容器：

   ```bash
   docker compose -f docker-compose.nas.yml restart
   ```

需要自行构建镜像时执行：

```bash
docker build -t noxrea-one .
```

如需替换 NAS compose 中的镜像名，可将 `image` 字段改为本地构建的镜像名称。

容器内后端固定监听 `0.0.0.0:4000`，与构建期固化的前端 `/api` 代理目标一致，不读取 `API_HOST` / `API_PORT`。前后端分开部署时，用构建参数 `--build-arg WEB_API_ORIGIN=http://backend-host:4000` 指定后端地址；应用名用 `--build-arg WEB_APP_NAME=...`。

## 数据与持久化

Docker 环境推荐只挂载 `/data`，入口脚本会使用容器默认值初始化以下路径：

| 容器路径 | 内容 |
| --- | --- |
| `/data/.env` | 运行配置 |
| `/data/uploads` | 上传与生成结果 |
| `/data/resources` | 模型配置、Prompt 模板与技能文件 |

数据库在外置 PostgreSQL 中（compose 示例使用独立数据卷），不落在 `/data` 卷内。

升级镜像前建议先备份整个数据目录。

## 资源与模型配置

后端运行期读取以下资源：

| 文件或目录 | 用途 |
| --- | --- |
| `server/resources/model-ui.json` | 定义各能力可编辑的参数、默认值、选项和请求字段映射 |
| `server/resources/provider-presets.json` | 保存常用供应商预设 |
| `server/resources/prompt-template.json` | 管理 Prompt 模板 |

模型供应商和模型能力主要通过 Web 设置中心配置；JSON 资源适合维护参数结构、预设与 Prompt 模板。`RESOURCES_DIR` 指向的 JSON 配置支持按文件修改时间热更新。

## API 概览

所有 API 都以 `/api` 为前缀，主要分组包括：

- `auth`：注册、登录与会话
- `canvas`：画布项目与节点数据
- `upload` / `files` / `assets`：文件上传、访问与素材管理
- `model-config`、`models`、`model-params`：供应商、模型、能力与参数配置
- `generate`：生成任务创建、状态查询、取消与 SSE 订阅
- `agent`：Agent 会话、消息、技能与工具结果
- `capture-frame`、`detach-audio`、`video-proxy`、`frame-sprite`：媒体处理能力

接口需要 JWT 认证；注册开放策略由系统设置 `auth.registration_enabled` 控制。

## 开发约定

- 使用根目录工作区命令统一运行检查，而不是分别进入 `web` 执行重复命令。
- 后端路由位于 `server/http/routes`，业务能力放在 `server/services`，请求校验放在 `server/schemas`。
- 前端按 `features` 组织业务模块，通用组件放在 `web/src/components`。
- 新增数据模型时同步更新 `prisma/schema.prisma`，并用 `npm run db:migrate:new -- <name>` 生成迁移（本地模式启动时由内置 runner 自动应用）。
- 新增模型参数时优先通过 `model-ui.json` 定义字段与映射，避免在界面和后端重复硬编码。

## 贡献流程

1. Fork 或创建功能分支。
2. 提交前运行 `npm run lint`、`npm run typecheck` 和 `npm test`。
3. 用清晰的说明描述行为变化、配置变更与迁移影响。
4. 不要提交 `.env`、数据库文件、上传文件或私有 API Key。
