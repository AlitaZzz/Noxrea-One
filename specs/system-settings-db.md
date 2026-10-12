# System Settings DB

状态：已确认（用户 2026-10-12 确认）

## 目标

把当前只能通过 `.env` / 环境变量调整的**运行期业务参数**迁入数据库，由统一的「设置注册表」管理：启动时逐项判断库中是否已有值，没有就写入初始值，之后以数据库为准。本期**不做后台维护界面**，但数据结构、读取方式和键命名需为后续管理端预留。

## 范围

- 新增 `system_settings` 表与服务端「设置注册表 + 启动播种 + 内存快照」。
- 梳理现有全部 env 配置项，划分「落库」与「保留 env」，并给出重命名建议（见下表）。
- 迁移所有受影响的内部调用方（`getConfig().X` → 新设置读取入口），不保留 env 回退读取分支。
- 同步清理 `.env.example`、`docker-entrypoint.sh`、`README.md`、`.github/workflows/ci.yml` 中已迁走的变量。

## 非目标

- 不做管理端 UI / 写接口 / 审计日志 / 运行期热更新（本期改库后需重启生效）。
- 不迁移用户级配置（ModelProvider 等已在库中）。
- 不改动 `server/resources` 下的 JSON 资源（模型配置等）及其热更新机制。

## 现状盘点（已验证事实）

- 所有 env 由 [server/core/config/index.ts](server/core/config/index.ts) 的 zod schema 一次性解析为单例，`getConfig()` 为**同步**读取；全部消费方在调用时读取，唯一的模块加载期读取是 `logger`（`LOG_LEVEL`）和 `storage/backends/local.ts`（`UPLOAD_DIR`）。
- 启动顺序（[server/core/bootstrap.ts](server/core/bootstrap.ts)）：`loadConfig` → `applyPragmas` → `initGateway` → GC 调度；Prisma 连接依赖 `DATABASE_URL`，数据库层自己直接读 `LOG_LEVEL`。
- 前端侧有三处直接读 env，不经后端：`web/next.config.ts`（`APP_NAME`、`SERVER_URL`、`UPLOAD_BATCH_MAX_MB` → `proxyClientMaxBodySize`）、`web/src/proxy.ts`（`AUTH_GATE_MODE`）、Dockerfile 构建参数 `APP_NAME`。
- 现有 env 与代码默认值存在漂移：`.env.example` 中 `WORKER_STUCK_TIMEOUT=5`，代码默认与 entrypoint 为 `15`；`GC_GRACE_HOURS`、`GC_DRY_RUN`、`HTTP_BODY_IDLE_TIMEOUT`、`DOWNLOAD_TOTAL_TIMEOUT` 未在 `.env.example` 中出现。迁移后默认值只在注册表定义一处，该漂移自然消除。
- `HTTP_TIMEOUT_ASYNC` 已核实为死配置：全仓（server / web / 脚本）仅 `services/agent/completion.ts` 使用 `scene: "async"`，且同时传入显式 `timeoutMs`；`fetchWithTimeout` 中 `timeoutMs ?? sceneTimeout`，显式值优先，场景值永不被取用。

## 分类结论

### A. 落库（运行期读取、与进程引导无关；「现 env 名」列仅作迁移对照，迁移后该 env 变量被移除）

| 现 env 名 | 建议设置键 | 类型 / 单位 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `ALLOW_REGISTRATION` | `auth.registration_enabled` | boolean | `true` | 重命名：语义是开关，不是「允许」动作 |
| `JWT_EXPIRE_MINUTES` | `auth.token_ttl_minutes` | int 分钟 | `1440` | 重命名：表达 token 有效期 |
| `TRUSTED_PROXY_CIDRS` | `network.trusted_proxy_cidrs` | string(CSV IP/CIDR) | `""` | 安全敏感，见待确认 2 |
| `ALLOWED_INTERNAL_HOSTS` | `network.ssrf_allowed_internal_hosts` | string(CSV) | `""` | 重命名：点明用途为 SSRF 白名单；安全敏感 |
| `USE_SYSTEM_PROXY` | `network.outbound_proxy_enabled` | boolean | `false` | 重命名：原名「系统代理」与实际行为（使用 `PROXY_URL`）不符 |
| `PROXY_URL` | `network.outbound_proxy_url` | string(留空或 http(s) URL) | `""` | URL 可能含凭据，明文存库（与 `model_providers.api_key` 同级处理） |
| `PUBLIC_URL` | `network.public_base_url` | string(留空或 http(s) URL) | `""` | 去除末尾 `/` 的规范化沿用现有消费方逻辑 |
| `MAX_UPLOAD_SIZE_MB` | `upload.max_file_mb` | int MB | `100` | 重命名：点明是单文件上限 |
| `UPLOAD_BATCH_MAX_FILES` | `upload.batch_max_files` | int | `20` | |
| `UPLOAD_BATCH_MAX_CONCURRENT` | `upload.batch_max_concurrent` | int | `1` | |
| `UPLOAD_BATCH_MAX_PENDING` | `upload.batch_max_pending` | int | `10` | |
| `WORKER_POLL_INTERVAL` | `worker.poll_interval_seconds` | int 秒 | `1` | 重命名：键名带单位 |
| `WORKER_MAX_CONCURRENCY` | `worker.max_concurrency` | int | `10` | |
| `WORKER_API_TIMEOUT` | `worker.api_timeout_seconds` | int 秒 | `240` | 同步生成 / Agent 补全的总超时 |
| `WORKER_STUCK_TIMEOUT` | `worker.stuck_timeout_minutes` | int 分钟 | `15` | 单位与其他 Worker 项不同（分钟），键名显式带单位 |
| `WORKER_ZOMBIE_INTERVAL` | `worker.zombie_scan_interval_seconds` | int 秒 | `60` | |
| `WORKER_MAX_RETRIES` | `worker.max_retries` | int ≥0 | `2` | |
| `WORKER_DRAIN_TIMEOUT` | `worker.drain_timeout_seconds` | int 秒 | `15` | |
| `WORKER_POLL_CHECK_INTERVAL` | `worker.poll_check_interval_ms` | int 毫秒 | `200` | 现单位为毫秒（`loop.ts` 直接传入） |
| `WORKER_ASYNC_POLL_INTERVAL` | `worker.async_poll_interval_seconds` | number 秒 | `3.0` | |
| `WORKER_ASYNC_POLL_MAX_ATTEMPTS` | `worker.async_poll_max_attempts` | int | `120` | |
| `WORKER_ASYNC_POLL_INITIAL_DELAY` | `worker.async_poll_initial_delay_seconds` | number 秒 | `0.5` | |
| `HTTP_TIMEOUT_DL` | `http.download_timeout_seconds` | number 秒 | `45` | |
| `HTTP_TIMEOUT_POLL` | `http.poll_timeout_seconds` | number 秒 | `15` | |
| `HTTP_TIMEOUT_API` | `http.api_timeout_seconds` | number 秒 | `120` | |
| `HTTP_TIMEOUT_ASYNC` | （删除，不落库） | | | 死配置，随本次一并清理：移除 `HttpTimeoutScene` 的 `"async"` 成员、`getSceneTimeout` 对应分支及 `completion.ts` 中多余的 `scene: "async"` |
| `HTTP_BODY_IDLE_TIMEOUT` | `http.body_idle_timeout_seconds` | number 秒 | `60` | |
| `DOWNLOAD_TOTAL_TIMEOUT` | `http.download_total_timeout_seconds` | number 秒 | `600` | |
| `GC_GRACE_HOURS` | `storage.gc_grace_hours` | int 小时 | `48` | |
| `GC_DRY_RUN` | `storage.gc_dry_run` | boolean | `true` | |

### B. 保留在 env（引导期 / 部署拓扑 / 密钥 / 前端构建运行时）

| env 名 | 保留原因 |
| --- | --- |
| `DATABASE_URL`、`DB_TIMEOUT` | 打开数据库本身所需，无法从库中读取 |
| `JWT_SECRET_KEY`、`ALLOW_INSECURE_SECRETS` | 密钥不与它所保护的数据存放在同一处；占位密钥校验发生在启动最早期 |
| `JWT_ALGORITHM` | 与密钥类型强绑定，修改会使全部登录态失效，且只有 HS256 有意义；不作为可调参数 |
| `LOG_LEVEL` | logger 与数据库层在加载期就读取，早于数据库可用 |
| `API_HOST`、`API_PORT`（原 `SERVER_HOST`、`SERVER_PORT`） | 监听地址，属部署拓扑；Docker 镜像内固定为 `0.0.0.0:4000`，不读取 |
| `UPLOAD_DIR`、`FFMPEG_PATH`、`RESOURCES_DIR` | 与数据卷 / 镜像路径绑定；`UPLOAD_DIR` 在模块加载期解析；落库后一旦与实际挂载不一致会导致已存文件不可定位 |
| `UPLOAD_BATCH_MAX_MB` | 同时被 Next 代理层（`proxyClientMaxBodySize`，启动期固化）和 Hono 校验使用，必须保持单一来源；落库会出现两处不一致，故保留 env |
| `WEB_APP_NAME`、`WEB_API_ORIGIN`、`WEB_AUTH_GATE_MODE`（原 `APP_NAME`、`SERVER_URL`、`AUTH_GATE_MODE`） | 由前端构建 / Next 运行时直接读取，前端不访问后端数据库；命名见 [env-config-layout.md](env-config-layout.md) |
| `NODE_ENV` | 运行环境标识 |

## 业务规则

1. **设置注册表**是唯一权威定义：每项含 `key`、zod 校验规则、默认值。键集合、类型与默认值只在注册表中定义一次。
2. **播种规则**：启动时对注册表的每一项，若库中无该 `key` 的记录则写入注册表默认值；已有记录绝不覆盖。写入使用「冲突忽略」语义，保证重复启动 / 并发启动幂等。
3. **env 不参与**：已迁移的变量从 env 体系中彻底移除，播种只用注册表默认值，不读取旧 env，也不做 env 与库不一致的提示（已确认：不需要向后兼容）。现有部署升级后，原先在 `.env` 里的自定义值需手工写入库中。
4. **读取**：启动播种完成后，把全部设置读入进程内**不可变快照**，通过同步入口读取（保持现有调用方同步形态，不引入 async 传染）。运行期不再回库，也不回退读 env。
5. **校验**：库中存储值按注册表规则解析；值非法一律启动失败并指明键名，不静默回退默认值。数值只接受规范化十进制文本（整数 `^\d+$`、小数 `^\d+(\.\d+)?$`），空串 / 空白 / `Infinity` / 科学计数法 / 负数均视为非法；布尔值只接受 `true` / `false`；两个 URL 设置（出网代理、对外访问地址）留空或必须是 http(s) URL，以便在启动期而非首次出站请求时暴露错误。
6. **存储形式**：`value` 统一存规范化文本，由注册表按类型解析；不在表内存类型元信息。
7. **生效时机**：本期修改库值需重启进程生效；管理端阶段再引入写入 + 快照刷新。

## 技术影响

- **数据库结构变更**：新增 Prisma 模型 `SystemSetting`（表 `system_settings`：`key` 主键字符串、`value` 文本、`createdAt`、`updatedAt`）。随本次变更，用户要求把历史 13 个迁移合并为单个 baseline `20261012100000_baseline`（已用 `migrate diff` 验证新旧迁移链与 `schema.prisma` 均无差异）；早于该版本创建的数据库需一次性重置迁移历史并补建 `system_settings` 表（旧迁移链从未创建过它，只标记 baseline 已应用会导致启动失败，已用 HEAD 旧迁移链在临时库复现并验证修正后的三步流程），步骤见 README「升级旧版数据库」，入口脚本不做自动兼容。
- **服务端**：新增 `server/core/settings/`（注册表、播种、快照读取）；`getConfig()` 收缩为仅含 B 类引导配置；`bootstrap()` 在 `applyPragmas` 之后、`initGateway` 之前执行 `initSettings()`。
- **迁移调用方**（均为调用时读取，已核对）：`http/routes/auth.ts`、`http/middleware/auth.ts`、`core/auth/jwt.ts`（仅 `JWT_EXPIRE_MINUTES`）、`core/ssrf`、`core/http-client`、`services/worker/{loop,resume-polling}`、`services/tasks/manager`、`services/storage/{download,gc,upload,upload-limits}`、`http/routes/upload.ts`、`services/resolvers/reference.ts`、`server/index.ts`（`WORKER_DRAIN_TIMEOUT`）。
- **测试**：现有 mock `getConfig` 的测试需按新入口调整；新增设置服务的单元测试（使用临时 SQLite，参照 `server/__tests__/crud/user.test.ts` 的做法）。
- **部署**：`docker-entrypoint.sh` 生成的 `/data/.env` 不再包含已迁移变量；`.env.example` / README 同步精简并说明「首次启动播种，之后以数据库为准」。
- **前端**：无直接影响（`/api` 上传限制端点已由后端返回，无需前端读 env）。

## 异常与边界

- 首次启动 / 全新数据库：先执行 migration（`prisma migrate deploy` 已在 entrypoint），再播种；本地开发需先 `prisma migrate dev`。
- 播种中途失败：每项独立幂等，重启后补齐剩余项；不要求事务整体原子。
- 多进程同时启动：当前为单进程（Hono + Worker 同进程），冲突忽略写入已覆盖偶发并发。
- 库中出现注册表未定义的 `key`：忽略，不报错也不删除。
- 现有部署升级：首次升级启动时按默认值播种，`.env` 中已迁移变量不再有任何效果；有自定义值的部署需在升级后手工改库（本期无管理端）。
- 依赖关系：`worker.stuck_timeout_minutes` 需远大于代码内心跳间隔（`crud/task.ts`）；本期不新增跨项联合校验，沿用现状（各项独立校验）。

## 验收标准

- 全新库启动后，A 类全部键存在于 `system_settings`，值等于注册表默认值，且不受 env 中同名旧变量影响。
- 重复启动不覆盖已存在的值，不产生重复记录；手工改库后重启，新值生效。
- 非法库值（含空串、空白、`Infinity`、科学计数法、负数）导致启动失败，错误信息含键名。
- `getConfig()` 不再包含 A 类变量；全仓无残留对已迁移 env 名的读取（含 Dockerfile / entrypoint / README / CI）。
- B 类变量行为不变；上传批次总大小上限仍由 `UPLOAD_BATCH_MAX_MB` 单一来源控制。
- 服务端类型检查、lint、相关测试通过（串行执行）。

## 已确认决策

- 命名方案按 A 类表格中的点分层级 + 单位后缀（用户已确认）。
- 不需要向后兼容：播种仅用注册表默认值，不读取旧 env，不保留 env 回退读取，不提示 env 与库的差异。

- `UPLOAD_BATCH_MAX_MB` 保留 env（Next 代理层与 Hono 共用单一来源）。
- `TRUSTED_PROXY_CIDRS`、`ALLOWED_INTERNAL_HOSTS`、`PROXY_URL` 本期即落库；后续做管理端时必须限定 admin 角色并写审计。
- 表结构采用键值表，类型由注册表约束。
- `HTTP_TIMEOUT_ASYNC` 经核实为死配置，直接删除，不落库。
- `JWT_ALGORITHM` 保留 env，视为非可调参数。
- 新部署的初始化由服务端启动流程完成：env 只保留 B 类变量，A 类设置在启动时自动按注册表默认值写入数据库，无需部署侧提供任何设置值。非默认值待后续管理端维护；管理端上线前如需修改，直接改库后重启（例如首个管理员注册后关闭 `auth.registration_enabled`）。

## 待确认事项

无。

## 当前状态

已实现（2026-10-12）：`system_settings` 模型与 migration、`server/core/settings/`（注册表、播种与快照、`proxy.ts` 派生判定）、全部调用方迁移、`getConfig()` 收缩为 B 类、文档与 entrypoint 清理、`HTTP_TIMEOUT_ASYNC` 及 `"async"` 场景删除。

实现中的两处细化（均未改变已确认规则）：

- `isProxyRoutingEnabled()` 随配置迁出到 `core/settings/proxy.ts`。
- 上传 body-limit 中间件改为每次请求读取批次上限（此前在路由模块加载期固化，早于设置初始化）。

baseline 已在临时库验证可应用；开发库 `prisma/dev.db` 因升级前已应用 `add_system_settings`，只需重置迁移历史并标记 baseline（已完成）。早于 `system_settings` 的旧库还需 `prisma db push` 补建该表（README 已写明）。
