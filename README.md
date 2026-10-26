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
| 数据库 | Prisma、PostgreSQL | 用户、项目、任务、模型、素材与 Agent 数据；开发与部署统一使用外置 PostgreSQL |
| 模型网关 | Hono Services | 能力路由、协议适配、参数映射与任务执行 |
| 媒体处理 | FFmpeg、Sharp | 视频抽帧、音频分离与图像处理 |
| 部署 | Docker、Node.js 22.12+ | 单容器运行前端与后端（数据库外置 PostgreSQL），`/data` 持久化数据 |

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
├── data/                 # 本地运行时数据（已 gitignore）
│   └── uploads/          # 本地上传文件
├── Dockerfile            # 构建单容器镜像
├── docker-entrypoint.sh  # 容器初始化入口
└── docker-compose.nas.yml # NAS 部署示例
```

## 快速开始

### 本地开发

1. 准备环境

   - Node.js 22.12+（Vite 7 的下限；部署镜像同为 node:22-slim）
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

   编辑 `.env`，设置数据库连接串与 JWT 密钥：

   ```env
   DATABASE_URL=postgres://用户:密码@主机:5432/库名
   JWT_SECRET_KEY=替换为随机长密钥
   ```

   `DATABASE_URL` 必填，仅支持外置 PostgreSQL（`postgres://` / `postgresql://`）；缺失或非法时启动失败。首次使用先执行 `npm run db:migrate:deploy` 建表（`npm run dev` 的 `predev` 钩子也会自动执行）。

   任务队列（BullMQ 派发）与分布式限流共用的 Redis（连接串 `REDIS_URL` 必填；Redis 不可达时应用启动失败）。本地可临时用 Docker 起一个带密码的 Redis 7：

   ```bash
   docker run -d --name noxrea-dev-redis -p 6379:6379 redis:7-alpine redis-server --requirepass devredis --appendonly yes --maxmemory 256mb --maxmemory-policy noeviction
   ```

   生成密钥示例：

   ```bash
   openssl rand -hex 32
   ```

4. 启动开发服务

   启动前由 `predev` 钩子执行 `db:migrate:deploy` 应用 `prisma/migrations`（幂等），无需手动初始化数据库。

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
| `npm run db:migrate:new -- <name>` | 修改 `prisma/schema.prisma` 后生成新迁移（`prisma migrate diff`，只读 `SHADOW_DATABASE_URL`，不触碰 `DATABASE_URL`；审阅 SQL 后执行 `db:migrate:deploy`） |
| `npm run db:migrate:deploy` | 应用未执行的迁移（`prisma migrate deploy`；开发机由 `predev` 自动执行） |
| `npm run prisma:generate` | 生成 Prisma Client |

## 环境变量

完整模板见 `.env.example`，变量按读取方分为后端、前后端共用、前端（`WEB_` 前缀）三区。以下是最常用配置：

| 变量 | 说明 |
| --- | --- |
| `JWT_SECRET_KEY` | JWT 签名密钥，必填 |
| `REDIS_URL` | 任务队列（BullMQ）与分布式限流共用的 Redis 连接串，必填；Redis 不可达时启动失败，队列瞬断由 stalled 重跑与对账清扫自愈（specs/task-queue-bullmq.md），限流命令失败 fail-open |
| `DATABASE_URL` | 外置 PostgreSQL 连接串（必填，`postgres://` / `postgresql://`）；应用启动不自动迁移，需先执行 `npm run db:migrate:deploy` |
| `DATABASE_POOL_MAX` | 每个进程的 PostgreSQL 连接池上限，默认 `10`；多副本按 `副本数 × 该值 + 余量 ≤ PostgreSQL max_connections` 规划 |
| `RUN_MIGRATIONS` | Docker 容器启动时是否执行 `prisma migrate deploy`，默认 `1`，只接受 `0` / `1`；多副本部署设为 `0`，由独立迁移 Job 执行一次 |
| `API_HOST` / `API_PORT` | 后端（Hono）监听地址与端口，默认 `0.0.0.0:4000` |
| `WEB_API_ORIGIN` | 前端（Next）转发 `/api/*` 的后端地址；默认 `http://localhost:${API_PORT}`，仅前后端分开部署时设置（`next build` 时固化） |
| `WEB_AUTH_GATE_MODE` | 前端路由门在后端不可达时的策略：`fail-open`（默认，可用性优先）/ `fail-closed`（安全优先） |
| `WEB_APP_NAME` | 浏览器端显示的应用名（构建期固化） |
| `UPLOAD_DIR` | 上传文件目录，默认 `data/uploads` |
| `UPLOAD_BATCH_MAX_MB` | 单次批量上传总大小上限，默认 `128` MiB（配置键沿用 MB 命名；Next 代理层共用，故保留在 env；修改后需重新构建 Next 镜像并重启后端） |
| `FFMPEG_PATH` | `ffmpeg` 和 `ffprobe` 所在目录，默认 `bin` |
| `RESOURCES_DIR` | 模型配置、Prompt 与技能资源目录 |
| `LOG_LEVEL` | 日志级别，可选 `DEBUG`、`INFO`、`WARN`、`ERROR` |
| `METRICS_ENABLED` | 是否暴露 `GET /metrics`，默认 `false`（关闭时返回 404）；只接受 `true` / `false` / `1` / `0` |
| `METRICS_TOKEN` | `/metrics` 的 Bearer token；`METRICS_ENABLED` 开启时必填，否则启动失败 |
| `ALLOW_INSECURE_SECRETS` | 是否允许占位密钥启动，仅建议本地开发使用 |

生产环境务必使用随机 `JWT_SECRET_KEY`，不要开启 `ALLOW_INSECURE_SECRETS`。

真实数据库测试使用 `TEST_DATABASE_URL`（专用测试库，库名必须包含 `test`，且不得与 `DATABASE_URL` 同库）；未设置时本地跳过这些用例，CI 环境（`CI=true` 或 `CI=1`）未设置则测试失败。`db:migrate:new` 必需 `SHADOW_DATABASE_URL`（可丢弃的 shadow 库，不得与 `DATABASE_URL` 相同）；迁移授权只在该库回放迁移并生成 SQL。真 Redis 集成测试使用 `TEST_REDIS_URL`（应指向专用 DB index，如 `/15`；测试只清理自己的前缀键）；未设置时这些用例整体跳过。

### 系统设置

运行期业务参数不再通过环境变量配置，而是存放在数据库 `system_settings` 表。服务首次启动时会把缺失的键以默认值写入，之后以数据库为准；修改数据库中的值后重启服务生效（多副本部署需全部副本重启；暂无后台管理界面：可用 `psql` 执行 SQL）。键、校验规则与默认值见 [`server/core/settings/registry.ts`](server/core/settings/registry.ts)，分组如下：

| 前缀 | 内容 |
| --- | --- |
| `auth.*` | 注册开关 `registration_enabled`、登录态有效期 `token_ttl_minutes` |
| `rate_limit.*` | 登录/注册按 IP、生成/媒体编辑按用户的请求额度与窗口；计数存 Redis，多副本共享 |
| `network.*` | 可信代理网段、SSRF 内网白名单、出网代理、对外访问地址 `public_base_url` |
| `upload.*` | 单文件大小、单批文件数、单用户并发批次数与排队深度 |
| `worker.*` | 生成任务 Worker 的并发、超时、重试与异步轮询节奏等 |
| `http.*` | 下载、轮询、API 请求超时，响应体空闲与下载总时长 |
| `storage.*` | 存储后端选择与 S3 连接配置（`storage.backend` / `storage.s3.*`）、读取分发与上游引用策略、GC 周期/批量/宽限期/试运行、派生产物与 staging 保留时长 |

限流计数使用 `REDIS_URL` 指向的 Redis（与 BullMQ 同实例，键前缀 `noxrea:ratelimit:`）。启动时 Redis 不可达会直接启动失败；运行期 Redis 命令失败按 fail-open 放行并记录错误，避免 Redis 抖动放大为全站登录/生成不可用。

例如关闭注册：

```sql
UPDATE system_settings SET value = 'false' WHERE key = 'auth.registration_enabled';
```

## Docker 部署

镜像将前端与后端封装在同一容器中，配置与上传文件统一持久化到 `/data`；数据库为外置 PostgreSQL（compose 示例内置 postgres 服务，也可指向自备实例），entrypoint 会等待数据库就绪并自动执行 `prisma migrate deploy`。任务队列与分布式限流使用 compose 示例内置的 Redis 7 服务（AOF 持久化 + noeviction，本应用专用实例），entrypoint 同样等待其就绪。

1. 准备 `docker-compose.nas.yml`

   默认 compose 文件使用以下配置：

   - 镜像：`ghcr.io/alitazzz/noxrea-one:latest`
   - 端口：宿主机 `3000` → 容器 `3000`；Redis 宿主机 `9835` → 容器 `6379`（内网开发/运维与集成测试直达，compose 注释为基准；收紧部署可删除该映射，仅容器网络内互通）
   - 数据目录：`/share/Container/noxreaone` → 容器 `/data`（含 PG 数据与 Redis AOF 子目录）
   - 网络：外部网络 `mihomo_shared_network`
   - 首次启动前需在同目录 `.env` 写入 `POSTGRES_PASSWORD=...` 与 `REDIS_PASSWORD=...`（`DATABASE_URL` / `REDIS_URL` 由 compose 注入容器）

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

### 健康检查、指标与告警（Redis）

存活与就绪分开暴露（specs/observability-baseline.md）：

- `GET /api/health/live`：进程存活，无条件 200；编排的 **liveness** 探针指向这里。
- `GET /api/health/ready`：依赖就绪，`checks` 含 `database` / `redis` / `worker` / `queueDepth` / `storage`；数据库、Redis 或存储探测任一失败返回 503（摘流，不重启）；编排的 **readiness** 探针指向这里。

`GET /metrics`（Prometheus 文本）默认 404；设置 `METRICS_ENABLED=true` 时必须同时配置 `METRICS_TOKEN`，否则启动失败。该端点要求 `Authorization: Bearer <METRICS_TOKEN>`，自身不参与限流与请求统计。

任务队列（BullMQ）依赖 Redis 派发；`/api/health/ready` 的 `redis` 字段为运行期就绪，`queueDepth` 为 waiting + delayed + active 总深度（Redis 不可达时为 `null`）。建议的外部监控口径：

- **`/api/health/ready` 返回 `checks.redis: false`** ⇒ 运行期 Redis 不可达，立即告警。此时任务仍落库 pending、恢复后由对账清扫自动排水，但创建侧体验降级，不应长时间持续。
- **`metrics` 的 `queue_depth` 持续增长、`worker_up` 为 0** ⇒ 消费能力不足或 worker 停摆；两者均由抓取时读数给出（Redis 不可达时保持上一个值，不冒充 0）。
- **`queueDepth` 持续增长不回落** ⇒ 消费能力不足或 Redis 写入后 worker 停摆；正常水位应随提交量波动并在分钟级回落。
- **Redis `used_memory` 逼近 `maxmemory`（256mb）** ⇒ 告警并复核容量；策略为 noeviction，写满后队列写入将报错（自愈路径依赖清扫，但应扩容根除）。限流键按窗口 TTL 自动过期，但大量不同来源 IP 会在窗口内推高键数量（每个键一个 ZSET）；此类增长应结合 `noxrea:ratelimit:*` 键数量一并观察。
- **failed 计数**（基础设施级瞬断重试耗尽）用 `redis-cli` 查看：

  ```bash
  docker exec <redis 容器名> redis-cli -a "$REDIS_PASSWORD" --no-auth-warning zcard noxrea:queue:generation-tasks:failed
  ```

  持续增长说明存在反复崩溃的任务（毒任务），结合后端日志 `task_row_missing` / `submission_uncertain` 事件定位。

## 数据与持久化

Docker 环境推荐只挂载 `/data`，入口脚本会使用容器默认值初始化以下路径：

| 容器路径 | 内容 |
| --- | --- |
| `/data/.env` | 运行配置 |
| `/data/uploads` | 上传与生成结果 |
| `/data/resources` | 模型配置、Prompt 模板与技能文件 |

数据库在外置 PostgreSQL 中（compose 示例使用独立数据卷），不落在 `/data` 卷内。Redis 数据（AOF）落在数据卷的 `redisdata` 子目录。

升级镜像前建议先备份整个数据目录。

## 对象存储（S3 兼容后端）

存储后端按 `system_settings` 的 `storage.backend` 二选一（`local` 本地盘 / `s3` 兼容对象存储，重启生效，不支持热切换）。读取形态由后端类型决定、不可配置：`s3` 走**签名直连**——浏览器先向 `POST /api/files/access` 换取预签名 URL，再直连 bucket 取字节（应用不转发字节、无 302）；`local` 由应用流式返回。上传走预签名直传。连接参数同样存放在 `system_settings`（键定义见 [`server/core/settings/registry.ts`](server/core/settings/registry.ts)）：

| 设置键 | 默认 | 说明 |
| --- | --- | --- |
| `storage.s3.endpoint` / `bucket` / `region` | 空 | 连接三要素；`backend=s3` 时必填，缺失则启动失败并指明键名 |
| `storage.s3.access_key_id` / `secret_access_key` | 空 | 访问凭据；`backend=s3` 时必填 |
| `storage.s3.provider` | `generic` | 提供方 profile：`minio \| aws \| r2 \| oss \| cos \| generic`。决定寻址风格与能力基线（见下方对照表）；`generic` 由启动探测决定寻址 |
| `storage.s3.prefix` | 空 | 对象 key 统一前缀（bucket 复用） |
| `storage.upstream_ref_delivery` | `signed-url` | 上游 AI 拉取引用媒体的唯一开关：`signed-url`（签名 URL；签发不能成立——S3 签名故障 / local 未配 `public_base_url` / 签名操作故障——明确失败）/ `base64`（读盘转 data URL） |

浏览器读路径的签名 TTL（4 小时）与签名窗口（1 小时）是代码常量，不可配置（`server/services/storage/signing.ts`）：签名时间对齐到窗口的 epoch 绝对边界，窗口内同一 key 签出字节一致的 URL；**URL 寿命 = TTL**，窗口只决定稳定期（缓存寿命取 TTL，即 `expiresAt - issuedAt`），实际剩余有效期落在 `[TTL - 窗口, TTL]`。描述接口同时给出 `expiresAt` 与 `refreshAt`（寿命 80% 处），前端据此刷新。

`backend=s3` 时启动即做六项能力探测（连通 `HeadBucket` → 写 → 回读字节一致 → `stat` → 预签名 GET 回读 → `response-*` 覆盖头；另有 CORS 与时钟偏差），致命项失败直接终止启动（不静默降级到本地盘）。探测摘要以一条结构化日志输出，能力位进 `/metrics`（`storage_probe_ok` / `storage_probe_clock_skew_seconds`），`/api/health/ready` 的 `checks.storage` 只报告探测是否成功。

### 提供方对照表（`storage.s3.provider`）

| provider | 典型端点 | 寻址风格 | `region` | 已知限制 |
| --- | --- | --- | --- | --- |
| `minio` | 自建 `http(s)://host:port` | path-style | 任意（常用 `us-east-1`，MinIO 不校验） | 自建端点无通配 DNS/证书时只能 path-style；CORS 需显式配置 |
| `aws` | `https://s3.<region>.amazonaws.com` | virtual-hosted | 桶所在区域 | 启用 SSE-KMS/SSE-C 会使 ETag≠MD5（迁移校验自动降级为 size + 重读哈希） |
| `r2` | `https://<account>.r2.cloudflarestorage.com` | virtual-hosted（两种皆可） | `auto` | 无对象 ACL；ETag 语义与 AWS 不同 |
| `oss` | `https://s3.oss-<region>.aliyuncs.com` 或自定义域名 | 仅 virtual-hosted | 区域串，以厂商文档为准 | **不支持 path-style**；ACL 语义与 AWS 不同；原生能力（`x-oss-process`、样式、归档类型）不接入 |
| `cos` | `https://cos.<region>.myqcloud.com` | 仅 virtual-hosted（2024-01-01 后新建桶强制） | 区域串，以厂商文档为准 | 同 OSS：不支持 path-style，仅使用 S3 兼容子集 |
| `generic` | 任意 | 启动探测决定（先 virtual-hosted，失败退 path-style） | 端点要求的值 | 两种寻址都失败时启动失败，错误信息包含各自 URL 形态与 HTTP 状态 |

所需权限（最小集）：`s3:HeadBucket`、`s3:PutObject`、`s3:GetObject`、`s3:DeleteObject`、`s3:ListBucket`（GC、派生删除联动、迁移与审计依赖列举）。

### OSS / COS：只使用 S3 兼容子集

阿里云 OSS 与腾讯云 COS 都提供 S3 兼容接口，本项目只用其 S3 子集，以下能力**不接入**（配了也不生效，或会以错误信息与本项无关的形态失败）：

| 能力 | OSS / COS 原生形态 | 本项目的行为 |
| --- | --- | --- |
| 原生 ACL 语义 | 桶/对象级 ACL、`x-oss-acl` 等 | 不使用；访问控制只靠桶策略与凭据（与 AWS/R2 同一口径） |
| 图片处理 / 媒体处理 | OSS `x-oss-process`、COS 数据万象（`imageMogr2` 等） | 不使用；缩放、抽帧、雪碧图全部由应用侧（sharp / ffmpeg）产出并落 `_cache`/`_posters`/`_sprite`/`_proxy` |
| 样式 / 图片样式名 | OSS 图片样式、COS 样式 | 不使用 |
| 存储类型与归档 | OSS 归档/冷归档/低频，COS 归档/深度归档 | 不使用；对象必须可即时 GET（读取路径不做解冻等待） |
| Bucket 版本控制 | OSS/COS 版本控制 | 不使用；删除语义按「删当前版本即删」设计（派生删除联动、GC、迁移都按此假设） |
| 静态网站 / 自定义域名 | 各自控制台配置 | 不使用；浏览器直连走预签名 URL，域名只用于 CORS 与 TLS |
| 对象标签 / 元数据检索 | OSS 对象标签、COS 标签 | 不使用；对象身份由内容寻址 key（sha256）决定 |

`response-*` 覆盖与 CORS 是**必须**验证的两项：前者决定下载走签名直连还是应用流（`storage_provider` 探测会给出 `responseOverrides` 能力位），后者决定浏览器能否直连读图（`browserCors` 能力位）。两者在 OSS/COS 上均有实现，但须以 `npm run storage:provider-check` 在真实桶上确认——官方文档与实测不一致时以探测结果为准。

能力位（provider + 探测得出，业务代码只读能力位）：`addressing`（实际寻址）、`responseOverrides`（端点是否遵守 `response-*`；为 `false` 时下载降级为应用流）、`browserCors`（浏览器跨源是否放行；未放行只告警，但 s3 部署验收要求为 `true`）。预签名回读是探测致命项（不通过即启动失败），因此不是能力位。校验和策略固定为 `WHEN_REQUIRED`（请求与响应两向），不按厂商分叉；单测断言预签名 PUT 的查询串不含任何 `x-amz-checksum-*`。

`browserCors` 的探测用 `network.public_base_url` 的 scheme+host 作为 `Origin`——CORS 按来源白名单放行，只有拿真实站点来源去问才能得到有意义的结果。未配置该设置时退回固定探测源，此时只有通配放行能通过，启动日志会输出说明。

接入新厂商或厂商升级后回归：`npm run storage:provider-check`——用真实凭据执行探测六项 + 256KB 往返，逐项输出结果，致命项失败退出码 1（检查对象全部落在 `_probe/` 命名空间并尽力删除）。

存储后端的契约测试：`server/__tests__/services/storage/s3.integration.test.ts` 在 `TEST_S3_*` 环境变量齐备时对真桶执行（缺省整组跳过，与 Redis 集成测试同口径）；`TEST_S3_PROVIDER` 指定 profile，`TEST_S3_PREFIX` 指定隔离前缀（缺省 `it-probe`，结束即删）。**禁止指向生产桶**——探测会写入并删除对象。

本机无真桶时用容器矩阵跑同一套契约测试：`docker compose -f docker-compose.test.yml up -d` 起一个只绑回环的 MinIO（`minio-init` 负责建桶），再 `npm run test:storage:minio`——该脚本用 `vitest.minio.config.ts` 注入 `TEST_S3_*`（MinIO 地址 + `provider=minio`），跑完 `docker compose -f docker-compose.test.yml down -v`。注入用 `??=`：shell 或 `.env` 里已有的 `TEST_S3_*` 优先，所以同一命令也可直接对演练桶跑。

> **开发 / 演练环境**：`signed-url` 交付（默认）要求签发结果对上游可拉取。`backend=local` 未配 `network.public_base_url` 时，参考生成在**签发环节即明确失败**并提示配置动作——补配置或显式设 `storage.upstream_ref_delivery=base64`（无自动兜底）。`backend=s3` 若 endpoint 对上游不可达（如内网 MinIO），签发仍会成功、失败在**上游拉取时**才暴露（生成环节无信号）——部署期按生产切换核对单做可达性核对，或显式设 `storage.upstream_ref_delivery=base64`。

### Bucket 初始化清单（切换前必配）

1. **CORS 规则（必配：直传写 + 签名直连读）**：
   - `AllowedOrigins`：生产域名 + 本地开发来源（如 `http://localhost:9898`）；生产域名须与 `network.public_base_url` 的 scheme+host 一致——启动探测正是拿它当 `Origin` 判定 `browserCors`；
   - `AllowedMethods`：`GET`（读取 / 解码 / 抓帧 / Range 请求）与 `PUT`（预签名直传）；
   - `AllowedHeaders`：`Range`、`Content-Type`（PUT 只签名 host，`Content-Type` 由浏览器原样发送、不参与签名；`Range` 同样不参与签名，但两者都需在 CORS 放行）；
   - `ExposeHeaders`：`Content-Length`、`Content-Range`、`Content-Type`（浏览器侧不消费 ETag：客户端哈希本地计算，复验以服务端重算为准）；
   - `MaxAgeSeconds`：86400。
   - 配置入口：MinIO 用 `mc cors set` / 控制台，R2 与各云 S3 网关用各自仪表盘 / API。
2. **lifecycle 规则（可选）**：可按前缀自动过期替代 `_sprite` / `_proxy` 的代码内 30 天 TTL 清扫；**禁止**对主对象前缀配置 lifecycle（主对象删除只能由引用计数 GC 驱动）。
3. **服务端加密**：bucket 不得启用 SSE-KMS / SSE-C（MinIO/R2 默认关闭）；启用会使 ETag≠MD5，迁移校验自动降级为 size 比对 + 重读哈希并告警（直传复验以服务端重算 SHA256 为准，不受影响）。

### 对账与维护

低频维护命令：`npm run storage:provider-check` 验证对象存储提供方连通性、写读一致性与 `response-*`/CORS 能力（只写 `_probe/` 并删除）；`npm run storage:audit` 对 bucket 与 `file_objects` 全量对账（孤儿 / 缺失 / 超龄 staging / 未知对象清单，只读不修改，发现异常退出码 1）；`npm run storage:gc` 手动触发一轮 GC（与进程内定时任务共用同一周期实现，受 `storage.gc_dry_run` 护栏约束）。

`npm run storage:purge-legacy-cache` 是一次性迁移，不是日常维护：删除 `_cache/` 下旧的无版本档位目录（v1 的 8 档），只用于 [`specs/canvas-media-resolution-lod.md`](specs/canvas-media-resolution-lod.md) 的 `_cache v2` 升级。**破坏性操作**，执行前需确认服务端已全量升级到 v2；幂等可重试，不触碰 `_cache/v2/`、`_posters/`、`_sprite/`、`_proxy/`、`_tmp/` 与源文件。任一枚举失败或存在删除失败的键时退出码 1，可重试。

### 数据迁移（local ↔ s3）

`npm run storage:migrate` 双向全量搬迁 + 校验：内容对象以 ETag==本地 MD5 为主校验（ETag 形态不符时自动降级为重读哈希比对并告警）、派生产物按字节数核对（可再生，失败跳过记清单）、支持 dry-run 盘点与断点续跑、**不删除任何一侧数据**。使用场景：存量 local 数据上 S3，或 S3 异常时反向补迁回滚（流程见 [`specs/storage-s3-backend.md`](specs/storage-s3-backend.md)「切换与回滚流程」）。

### 生产切换核对单（specs/storage-s3-production-cutover.md）

生产部署流程规格见 [`specs/storage-s3-production-cutover.md`](specs/storage-s3-production-cutover.md)（已确认：自建 MinIO 同机部署、反向代理统一终止 TLS、生产空桶冷启动、72 小时观察期）。切换执行前逐项核对，任一缺省即不得切换：

**前置**

- [ ] 反向代理统一终止 https：应用与 bucket 两个地址经同一代理出 https（消除 mixed-content）；代理**原样透传 `Host` 头**（SigV4 预签名校验依赖）；`storage.s3.endpoint` 填代理后公网地址
- [ ] 生产凭据全新签发：专用最小权限用户（仅本 bucket 读写），与任何演练值（用户名 / 密钥 / 端点 / 桶名）零关联
- [ ] CORS 按生产域名配置（上一节清单）；lifecycle 仅限派生前缀、主对象前缀禁配；bucket 未启用 SSE-KMS / SSE-C
- [ ] bucket endpoint 自浏览器与上游 AI 网络均可达：浏览器读路径始终直连 bucket（签名直连，CORS 必需），上游引用在 `signed-url` 模式下同样需要可达。上游不可达时显式改配 `upstream_ref_delivery=base64` 并记录决策——两种模式均为显式设置，无自动兜底

**冷启动切换**

- [ ] 确认生产空桶冷启动（开发 / 演练数据不进生产，无存量迁移）
- [ ] 生产值写入 `system_settings`（`storage.backend=s3` + `storage.s3.*`），重启生效
- [ ] 启动探测通过（HeadBucket 失败即启动失败属设计行为：修正前置，或临时改回 `local` 恢复服务）

**验收（全部通过并留痕，任一失败即停止切换、保持或回退 local）**

- [ ] 直传全流程（ticket → 预签名 PUT → complete 提升）与秒传命中
- [ ] 读链路自测：`POST /api/files/access` 返回签名直连 URL → 浏览器直连 bucket 取字节（`w` 派生与命中、下载 disposition、视频 Range/206）；`backend=local` 时同接口返回流式 URL，由应用返回 200/206
- [ ] 视频抓帧 / 封面正常（crossOrigin × 生产 CORS 联合回归点）
- [ ] 上游 AI 签名 URL 拉取成功、过期后失效
- [ ] 删除联动四根派生 + GC 四阶段实跑 + `storage:audit` 对账一致

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
- 新增数据模型时同步更新 `prisma/schema.prisma`，并用 `npm run db:migrate:new -- <name>` 生成迁移，审阅 SQL 后执行 `npm run db:migrate:deploy` 应用。
- 新增模型参数时优先通过 `model-ui.json` 定义字段与映射，避免在界面和后端重复硬编码。

## 贡献流程

1. Fork 或创建功能分支。
2. 提交前运行 `npm run lint`、`npm run typecheck` 和 `npm test`。
3. 用清晰的说明描述行为变化、配置变更与迁移影响。
4. 不要提交 `.env`、数据库文件、上传文件或私有 API Key。
