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
| `storage.*` | 存储后端选择与 S3 连接配置（`storage.backend` / `storage.s3.*`）、读取分发与上游引用策略、存储引用 GC 宽限期与试运行开关 |

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

## 对象存储（S3 兼容后端）

存储后端按 `system_settings` 的 `storage.backend` 二选一（`local` 本地盘 / `s3` 兼容对象存储，重启生效，不支持热切换）。S3 模式下文件字节默认不经过应用服务器：读取 302 重定向到预签名 URL、上传走预签名直传；连接参数与分发策略同样存放在 `system_settings`（键定义见 [`server/core/settings/registry.ts`](server/core/settings/registry.ts)）：

| 设置键 | 默认 | 说明 |
| --- | --- | --- |
| `storage.s3.endpoint` / `bucket` / `region` | 空 | 连接三要素；`backend=s3` 时必填，缺失则启动失败并指明键名 |
| `storage.s3.access_key_id` / `secret_access_key` | 空 | 访问凭据；`backend=s3` 时必填 |
| `storage.s3.path_style` | `true` | path-style 寻址（MinIO 等自建为 true） |
| `storage.s3.prefix` | 空 | 对象 key 统一前缀（bucket 复用） |
| `storage.s3.signed_url_ttl_seconds` | `3600` | 预签名有效期 |
| `storage.s3.delivery` | `redirect` | `redirect`（302 预签名）/ `proxy`（服务器流式转发，预签名 URL 不可达时兜底） |
| `storage.upstream_ref_delivery` | `signed-url` | 上游 AI 拉取引用媒体的方式：`signed-url` / `base64` |

`backend=s3` 时启动即对 bucket 做 HeadBucket 探测，连通性或凭据失败会直接终止启动（不静默降级到本地盘）。

### Bucket 初始化清单（切换前必配）

1. **CORS 规则（必配，redirect 读与直传写共同依赖）**：
   - `AllowedOrigins`：生产域名 + 本地开发来源（如 `http://localhost:9898`）；
   - `AllowedMethods`：`GET`（读取 / 解码 / 抓帧 / Range 请求）与 `PUT`（预签名直传）；
   - `AllowedHeaders`：`Range`、`Content-Type`（PUT 只签/只发 Content-Type；Range 不参与签名，但浏览器跨源发送需在 CORS 放行）；
   - `ExposeHeaders`：`Content-Length`、`Content-Range`、`Content-Type`（浏览器侧不消费 ETag：客户端哈希本地计算，复验以服务端重算为准）；
   - `MaxAgeSeconds`：86400。
   - 配置入口：MinIO 用 `mc cors set` / 控制台，R2 与各云 S3 网关用各自仪表盘 / API。
2. **lifecycle 规则（可选）**：可按前缀自动过期替代 `_sprite` / `_proxy` 的代码内 30 天 TTL 清扫；**禁止**对主对象前缀配置 lifecycle（主对象删除只能由引用计数 GC 驱动）。
3. **服务端加密**：bucket 不得启用 SSE-KMS / SSE-C（MinIO/R2 默认关闭）；启用会使 ETag≠MD5，迁移校验自动降级为 size 比对 + 重读哈希并告警（直传复验以服务端重算 SHA256 为准，不受影响）。

### 对账与维护

低频维护命令：`npm run storage:audit` 对 bucket 与 `file_objects` 全量对账（孤儿 / 缺失 / 超龄 staging / 未知对象清单，只读不修改，发现异常退出码 1）；`npm run storage:gc` 手动触发一轮 GC（与进程内定时任务共用同一周期实现，受 `storage.gc_dry_run` 护栏约束）。

### 数据迁移（local ↔ s3）

`npm run storage:migrate` 双向全量搬迁 + 校验：内容对象以 ETag==本地 MD5 为主校验（ETag 形态不符时自动降级为重读哈希比对并告警）、派生产物按字节数核对（可再生，失败跳过记清单）、支持 dry-run 盘点与断点续跑、**不删除任何一侧数据**。使用场景：存量 local 数据上 S3，或 S3 异常时反向补迁回滚（流程见 [`specs/storage-s3-backend.md`](specs/storage-s3-backend.md)「切换与回滚流程」）。

### 生产切换核对单（specs/storage-s3-production-cutover.md）

生产部署流程规格见 [`specs/storage-s3-production-cutover.md`](specs/storage-s3-production-cutover.md)（已确认：自建 MinIO 同机部署、反向代理统一终止 TLS、生产空桶冷启动、72 小时观察期）。切换执行前逐项核对，任一缺省即不得切换：

**前置**

- [ ] 反向代理统一终止 https：应用与 bucket 两个地址经同一代理出 https（消除 mixed-content）；代理**原样透传 `Host` 头**（SigV4 预签名校验依赖）；`storage.s3.endpoint` 填代理后公网地址
- [ ] 生产凭据全新签发：专用最小权限用户（仅本 bucket 读写），与任何演练值（用户名 / 密钥 / 端点 / 桶名）零关联
- [ ] CORS 按生产域名配置（上一节清单）；lifecycle 仅限派生前缀、主对象前缀禁配；bucket 未启用 SSE-KMS / SSE-C
- [ ] bucket endpoint 自浏览器与上游 AI 网络均可达；不可达链路分别以 `delivery=proxy` / `upstream_ref_delivery=base64` 兜底并记录决策

**冷启动切换**

- [ ] 确认生产空桶冷启动（开发 / 演练数据不进生产，无存量迁移）
- [ ] 生产值写入 `system_settings`（`storage.backend=s3` + `storage.s3.*`），重启生效
- [ ] 启动探测通过（HeadBucket 失败即启动失败属设计行为：修正前置，或临时改回 `local` 恢复服务）

**验收（全部通过并留痕，任一失败即停止切换、保持或回退 local）**

- [ ] 直传全流程（ticket → 预签名 PUT → complete 提升）与秒传命中
- [ ] redirect 读：302 → https 预签名 URL 字节一致、Range/206、`?download`、`?w=` 档位派生与命中
- [ ] 视频抓帧 / 封面正常（crossOrigin × 生产 CORS 联合回归点）
- [ ] 上游 AI 签名 URL 拉取成功、过期后失效
- [ ] 删除联动四根派生 + GC 三阶段实跑 + `storage:audit` 对账一致

**收尾**

- [ ] 回滚演练：改回 `backend=local` 重启即恢复（冷启动场景本地无历史包袱；`storage:migrate s3-to-local` 保留为运行期回滚路径）
- [ ] 72 小时观察期（GC 每日周期至少三轮）后判定切换完成；全量 `storage:audit` 基线留档

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
- `upload` / `files` / `assets`：文件上传（本地中转或 S3 预签名直传）、文件访问（会话或签名 URL 凭据）与素材管理
- `model-config`、`models`、`model-params`：供应商、模型、能力与参数配置
- `generate`：生成任务创建、状态查询、取消与 SSE 订阅
- `agent`：Agent 会话、消息、技能与工具结果
- `capture-frame`、`detach-audio`、`video-proxy`、`frame-sprite`：媒体处理能力

接口需要 JWT 认证；注册开放策略由系统设置 `auth.registration_enabled` 控制。files 读取额外接受短期签名 URL 凭据，供上游 AI 等免会话消费方使用。

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
