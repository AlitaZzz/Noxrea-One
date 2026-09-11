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
- 内置 OpenAI、Gemini、Ark 等协议适配结构，参数映射通过 JSON 配置驱动。

### 素材与文件

- 素材支持分组、标签、媒体类型、尺寸与扩展信息。
- 文件按用户与内容哈希去重，并通过引用计数管理生命周期。
- 上传、视频抽帧、音频分离、视频代理与帧预览等媒体处理能力由后端统一提供。

### Agent 与技能

- 每个画布项目可以维护独立的 Agent 会话。
- 支持自定义技能，例如分镜策划、脚本创作、广告文案和美术资产设计。
- 技能文件存放在 `server/resources/skills`，使用 front matter 描述名称、分类、说明和适用范围。

## 技术架构

| 层级 | 技术 | 说明 |
| --- | --- | --- |
| 前端 | Next.js、React、TypeScript | 画布、项目管理、设置中心与登录界面 |
| 后端 | Hono、TypeScript | REST API、SSE、文件与媒体处理 |
| 数据库 | Prisma、SQLite | 用户、项目、任务、模型、素材与 Agent 数据 |
| 模型网关 | Hono Services | 能力路由、协议适配、参数映射与任务执行 |
| 媒体处理 | FFmpeg、Sharp | 视频抽帧、音频分离与图像处理 |
| 部署 | Docker、Node.js 20 | 单容器运行前端与后端，`/data` 持久化数据 |

Next.js 将 `/api/*` 请求透明转发到 Hono 服务。本地单容器部署中，前端端口为 `3000`，后端端口为 `4000`；容器只对外暴露 `3000`。

## 目录结构

```text
.
├── web/                  # Next.js 前端
├── server/               # Hono 后端、能力服务与协议适配
│   ├── http/routes/      # API 路由
│   ├── services/         # 模型网关、任务 Worker、存储与 Agent 服务
│   └── resources/        # 模型 UI、供应商预设、Prompt 与技能配置
├── prisma/               # Prisma schema 与本地 SQLite 数据
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
   - FFmpeg；默认在项目根目录的 `bin` 下查找 `ffmpeg` 或 `ffmpeg.exe`

2. 安装依赖

   ```bash
   npm install
   ```

   安装阶段会自动执行 `prisma generate`，并为前端依赖补齐必要的兼容处理。

3. 配置环境变量

   ```bash
   cp .env.example .env
   ```

   编辑 `.env`，至少设置以下变量：

   ```env
   JWT_SECRET_KEY=替换为随机长密钥
   DATABASE_URL=file:./prisma/dev.db
   ```

   生成密钥示例：

   ```bash
   openssl rand -hex 32
   ```

4. 初始化数据库

   ```bash
   npm run prisma:migrate
   ```

5. 启动开发服务

   ```bash
   npm run dev
   ```

   访问地址：

   - Web：<http://localhost:3000>
   - API：<http://localhost:4000>

首次使用时在登录页注册账号。如果需要关闭注册，将 `.env` 中的 `ALLOW_REGISTRATION` 设置为 `false` 后重启服务。

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
| `npm test` | 运行前端 Vitest 测试 |
| `npm run test:watch` | 以监听模式运行 Vitest |
| `npm run prisma:migrate` | 创建或应用开发数据库迁移 |
| `npm run prisma:generate` | 生成 Prisma Client |
| `npm run prisma:studio` | 打开 Prisma Studio |

## 环境变量

完整模板见 `.env.example`。以下是最常用配置：

| 变量 | 说明 |
| --- | --- |
| `JWT_SECRET_KEY` | JWT 签名密钥，必填 |
| `DATABASE_URL` | SQLite 连接串，默认 `file:./prisma/dev.db` |
| `SERVER_HOST` / `SERVER_PORT` | Hono 服务监听地址与端口，默认 `0.0.0.0:4000` |
| `SERVER_URL` | Next.js 转发 `/api/*` 的目标地址，默认 `http://localhost:4000` |
| `ALLOW_REGISTRATION` | 是否允许新用户注册，默认 `true` |
| `UPLOAD_DIR` | 上传文件目录，默认 `uploads` |
| `PUBLIC_URL` | 对外访问地址；设置后参考素材可以上游可访问的 URL 提供给模型 |
| `FFMPEG_PATH` | FFmpeg 所在目录，默认 `bin` |
| `RESOURCES_DIR` | 模型配置、Prompt 与技能资源目录 |
| `MAX_UPLOAD_SIZE_MB` | 单个上传文件大小上限，默认 `30` |
| `LOG_LEVEL` | 日志级别，可选 `DEBUG`、`INFO`、`WARN`、`ERROR` |
| `ALLOW_INSECURE_SECRETS` | 是否允许占位密钥启动，仅建议本地开发使用 |
| `WORKER_*` | 生成任务 Worker 的轮询、并发、超时、重试等参数 |
| `HTTP_TIMEOUT_*` | 下载、轮询、API 与异步请求超时 |
| `ALLOWED_INTERNAL_HOSTS` | 允许访问的内网主机；默认禁止访问内网 |
| `USE_SYSTEM_PROXY` / `PROXY_URL` | 访问上游模型 API 时的出网代理 |

生产环境务必使用随机 `JWT_SECRET_KEY`，不要开启 `ALLOW_INSECURE_SECRETS`。

## Docker 部署

镜像将前端与后端封装在同一容器中，SQLite 数据库、配置与上传文件统一持久化到 `/data`。

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

## 数据与持久化

Docker 环境推荐只挂载 `/data`，入口脚本会使用容器默认值初始化以下路径：

| 容器路径 | 内容 |
| --- | --- |
| `/data/noxrea.db` | SQLite 数据库 |
| `/data/.env` | 运行配置 |
| `/data/uploads` | 上传与生成结果 |
| `/data/resources` | 模型配置、Prompt 模板与技能文件 |

升级镜像前建议先备份整个数据目录。

## 资源与模型配置

后端运行期读取以下资源：

| 文件或目录 | 用途 |
| --- | --- |
| `server/resources/model-ui.json` | 定义各能力可编辑的参数、默认值、选项和请求字段映射 |
| `server/resources/provider-presets.json` | 保存常用供应商预设 |
| `server/resources/prompt-template.json` | 管理 Prompt 模板 |
| `server/resources/skills/<skill>/skill.md` | Agent 技能定义与提示词 |

模型供应商和模型能力主要通过 Web 设置中心配置；JSON 资源适合维护参数结构、预设与技能。`RESOURCES_DIR` 指向的 JSON 配置支持按文件修改时间热更新。

## API 概览

所有 API 都以 `/api` 为前缀，主要分组包括：

- `auth`：注册、登录与会话
- `canvas`：画布项目与节点数据
- `upload` / `files` / `assets`：文件上传、访问与素材管理
- `model-config`、`models`、`model-params`：供应商、模型、能力与参数配置
- `generate`：生成任务创建、状态查询、取消与 SSE 订阅
- `agent`：Agent 会话、消息、技能与工具结果
- `capture-frame`、`detach-audio`、`video-proxy`、`frame-sprite`：媒体处理能力

接口需要 JWT 认证；注册开放策略由 `ALLOW_REGISTRATION` 控制。

## 开发约定

- 使用根目录工作区命令统一运行检查，而不是分别进入 `web` 执行重复命令。
- 后端路由位于 `server/http/routes`，业务能力放在 `server/services`，请求校验放在 `server/schemas`。
- 前端按 `features` 组织业务模块，通用组件放在 `web/src/components`。
- 新增数据模型时同步更新 `prisma/schema.prisma` 与迁移。
- 新增模型参数时优先通过 `model-ui.json` 定义字段与映射，避免在界面和后端重复硬编码。

## 贡献流程

1. Fork 或创建功能分支。
2. 提交前运行 `npm run lint`、`npm run typecheck` 和 `npm test`。
3. 用清晰的说明描述行为变化、配置变更与迁移影响。
4. 不要提交 `.env`、数据库文件、上传文件或私有 API Key。
