# Env Config Layout

状态：已确认（用户 2026-10-12 确认命名与不做兼容读取）

## 目标

让 `.env` 一眼分清「后端 / 前端 / 前后端共用」三类变量，消除 `SERVER_*` 命名歧义，并让前端代理目标默认随后端端口推导，避免只改端口导致前端转发失败。

## 范围

- 重命名并按归属分区整理引导期 env 变量（接续 [system-settings-db.md](system-settings-db.md)，其中 B 类变量即本 Spec 的对象）。
- `.env.example`、`docker-entrypoint.sh`、`Dockerfile`、README、本地 `.env` 同步。
- 前端 `next.config.ts` / `proxy.ts`（含对应测试）与后端 config 同步改名。

## 非目标

- 不改变任何运行语义（默认值、校验、行为），不涉及数据库设置项。
- 不重命名 `UPLOAD_BATCH_MAX_MB`（已由 [asset-batch-upload.md](asset-batch-upload.md) 确认并广泛引用；其 MB 实为 MiB 的历史命名保留）。
- 不改 Docker 对外端口（web `3000`）。

## 现状问题（已验证事实）

- `SERVER_HOST` / `SERVER_PORT` 是后端 Hono 的监听地址，`SERVER_URL` 却是前端 Next 的代理目标；「SERVER」同时可指 Next 与 Hono，且三者互相关联却分散在不同分区。
- `SERVER_URL` 默认值硬编码为 `http://localhost:4000`：同机部署下只改 `SERVER_PORT` 会让前端仍转发到 4000。
- `APP_NAME` 在后端 config 中被解析但**无任何使用方**（仅前端构建期读取并映射为 `NEXT_PUBLIC_APP_NAME`），属后端死配置。
- `.env` 与 `.env.example` 没有标明变量由前端还是后端读取；前端 `next.config.ts` 与后端同读根目录 `.env`。

## 命名与归属

| 归属 | 现名 | 新名 | 说明 |
| --- | --- | --- | --- |
| 后端 | `SERVER_HOST` | `API_HOST` | Hono 监听地址 |
| 后端 | `SERVER_PORT` | `API_PORT` | Hono 监听端口，默认 `4000` |
| 前端 | `SERVER_URL` | `WEB_API_ORIGIN` | Next 把 `/api/*` 转发到的后端源地址；**默认 `http://localhost:${API_PORT}`**，仅分开部署时需显式设置 |
| 前端 | `AUTH_GATE_MODE` | `WEB_AUTH_GATE_MODE` | 路由门在后端不可达时的放行策略 |
| 前端 | `APP_NAME` | `WEB_APP_NAME` | 浏览器端应用名（构建期固化，映射为 `NEXT_PUBLIC_APP_NAME`）；从后端 config 中删除 |
| 共用 | `UPLOAD_BATCH_MAX_MB` | 不变 | 后端批次校验与前端代理请求体上限共用同一来源 |
| 后端 | 其余（`DATABASE_URL`、`DB_TIMEOUT`、`JWT_SECRET_KEY`、`JWT_ALGORITHM`、`ALLOW_INSECURE_SECRETS`、`LOG_LEVEL`、`UPLOAD_DIR`、`FFMPEG_PATH`、`RESOURCES_DIR`） | 不变 | 仅重新归入「后端」分区 |
| 后端 | `REDIS_URL`（task-queue-bullmq.md 新增） | — | BullMQ 专用 Redis 连接串（必填，启动探测失败即启动失败）；归属「后端」分区，通用外部约定名不另起前缀 |

命名规则：后端监听用 `API_*`（它就是 API 服务）；前端 Next 进程读取的变量统一 `WEB_*` 前缀，变量名即表明由哪个进程读取；`DATABASE_URL` 等通用/外部约定名保持不变。

## 业务规则

1. `.env.example`（及 entrypoint 生成的 `/data/.env`、本地 `.env`）按「共用 / 后端 / 前端」三个分区排列，每个分区头注明读取方。
2. `WEB_API_ORIGIN` 未设置时取 `http://localhost:${API_PORT}`，`API_PORT` 未设置时取 `4000`；设置后原样使用（去除末尾 `/`）。
3. 模板与 entrypoint 生成的 `.env` 默认**不再写出** `WEB_API_ORIGIN`，仅在说明中注明「分开部署时设置」。
4. Dockerfile 构建参数 `SERVER_URL` 改为 `WEB_API_ORIGIN`（默认空，走 `API_PORT` 推导）、`APP_NAME` 改为 `WEB_APP_NAME`；构建期写入 `.env` 供 `next.config.ts` 读取。代理目标与应用名均在 `next build` 时固化（已核对 `routes-manifest.json`），容器运行期修改 `/data/.env` 中这两项无效。
5. 不保留旧名读取（已确认不需要向后兼容）：旧名变量被忽略。已有 `/data/.env` 的部署需手工改名（见异常与边界）。
6. Docker 镜像内后端固定监听 `0.0.0.0:4000`（entrypoint 强制设置，不读取 `API_HOST` / `API_PORT`），与构建期固化的前端代理目标一致，避免「改了运行期端口但代理目标仍是旧值」。

## 技术影响

- 后端：`server/core/config/index.ts`（改名、删除 `APP_NAME`）、`server/http/server.ts`、`server/index.ts` 注释。
- 前端：`web/next.config.ts`（读取新名、默认推导）、`web/src/proxy.ts`、`web/src/__tests__/lib/{next-config,proxy}.test.ts`。
- 部署：`Dockerfile`、`docker-entrypoint.sh`、`.env.example`、README、本地 `.env`。`docker-publish.yml` 与 `docker-compose.nas.yml` 未引用这些变量，无需改动（已核对）。

## 异常与边界

- 已部署实例的 `/data/.env` 在容器首次生成后不会被覆盖；升级后旧名（`SERVER_HOST`、`SERVER_PORT`、`SERVER_URL`、`AUTH_GATE_MODE`、`APP_NAME`）将被忽略并回落默认值。常见默认部署（端口 4000、应用名默认值）不受影响；自定义过这些值的实例需手工改名。
- 前端 `next.config.ts` 在构建与运行期均会读取根 `.env`，`WEB_API_ORIGIN` 的推导需保证在 `next start` 运行期也生效（沿用现有 `envValue` 优先级：进程环境变量优先于根 `.env`）。

## 验收标准

- `.env.example` 分区清晰，且仅含上表中的新名；全仓无旧名残留（含 Dockerfile、entrypoint、README、测试）。
- 只设置 `API_PORT=4001` 时，前端代理目标为 `http://localhost:4001`；显式设置 `WEB_API_ORIGIN` 时以其为准。
- 后端 config 不含 `APP_NAME`；前端浏览器端应用名行为不变。
- 服务端、前端测试与类型检查、lint 通过（串行）。

## 待确认事项

无。

## 当前状态

已实现（2026-10-12，随代码审查修正 Docker 端口为固定值）：后端 `API_HOST` / `API_PORT`（并删除后端死配置 `APP_NAME`）、前端 `WEB_API_ORIGIN`（默认随 `API_PORT` 推导）/ `WEB_AUTH_GATE_MODE` / `WEB_APP_NAME`，`.env.example`、`docker-entrypoint.sh`、`Dockerfile`、README、本地 `.env` 与对应前端测试同步。已有部署的 `/data/.env` 需手工改名。

增量（2026-10-20，随 task-queue-bullmq.md 实现）：`REDIS_URL` 归入「后端」分区（BullMQ 专用 Redis 连接串，必填——docker-entrypoint.sh 启动校验缺失即退出，`.env.example` 与 NAS compose 同步注入）。

增量（2026-10-20，env 注入点收敛）：

- 移除 `server/core/config/index.ts` 模块级的 `process.loadEnvFile(".env")` 兜底加载——它是隐式的全局副作用：谁先加载 config 谁就改写共享 `process.env`，单 worker 测试进程内环境内容随模块加载顺序漂移（曾致 `video-frames` 用例的门控在全量 / 单文件两种执行模式下行为不同：全量跑时其他文件先加载 config 注入 `FFMPEG_PATH=bin` 使门控开启，单文件跑时读到默认值而整体跳过）。缺失必填项由 config schema 校验在首次读取时大声失败。
- 各进程入口的 env 供给（本需求未新增或修改任何 script）：`dev` / `start` / `storage:*` 的 `tsx --env-file=.env` 为 HEAD 既有；`prisma:generate` / `db:migrate:new` 无 `--env-file` 且不读 env，无功能缺口；容器经 entrypoint `source /app/.env`，compose 经 `-e`。
- 测试树注入点：`vitest.config.ts` 主进程求值期 `process.loadEnvFile` 一次，worker 继承；仅容忍 .env 不存在（ENOENT），其余错误原样抛出——与生产 script 的 `tsx --env-file=.env` 对坏 .env 的大声失败对称；需要 env 的用例由 schema 报缺。测试 script 此前从未携带 `--env-file`，全仓测试的 env 实际一直依赖 config 模块的兜底加载，该收敛使这一点显式化。
- 测试侧收口：新增 `server/__tests__/helpers/ffmpeg.ts` 统一 ffmpeg 目录供给（`FFMPEG_TEST_DIR` 缺省仓库 `bin/`，`ffmpegAvailable` 整体跳过），video-frames / media-pool-concurrency 的门控不再读生产进程 env（仅测试变量 FFMPEG_TEST_DIR）。
- 验证：全量服务端 932/932（`npm run test:server` 干净 shell 直跑）、web 934/934、typecheck、lint。
