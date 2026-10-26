# 可观测性基线（Observability Baseline）

状态：已确认（2026-10-26 起草，同日用户确认方案；实现已提交 `1bff028d`，Prometheus 抓取与编排探针验收待执行）

上游与关联：

- [task-queue-bullmq.md](task-queue-bullmq.md)（已实现）：`/api/health` 的 `redis` / `worker` / `queueDepth` 口径与告警建议。
- [storage-provider-portability.md](storage-provider-portability.md)（已确认）：启动探测的能力摘要进入健康检查与指标。
- [auth-request-verification.md](auth-request-verification.md)（已确认）：快照命中/回源/失效失败需要指标。
- [storage-signed-direct-delivery.md](storage-signed-direct-delivery.md)（已确认）：描述接口与派生缓存的观测点。

## 目标

1. **能用指标回答「哪里降级了」**：请求量/错误率/延迟、鉴权回源、描述接口形态分布、派生缓存命中、预签名失败、媒体池拒绝、队列与存储探测状态。
2. **区分存活与就绪**：依赖故障不能让编排层重启进程（那是故障放大），但必须让负载均衡摘流。
3. **指标基数可控**：标签只来自有界集合，不以用户 id、存储 key、文件名、错误文本作为标签。
4. **零外部依赖**：拉模型（Prometheus 文本格式），不需要 collector/agent 先就位。

## 范围

1. 健康检查拆分为 `/api/health/live`（存活）与 `/api/health/ready`（就绪），删除现有 `/api/health`。
2. 新增 `/metrics`（Prometheus 文本），默认关闭，启用需 `METRICS_ENABLED=true` 且配置 `METRICS_TOKEN`（Bearer 校验）。
3. 指标定义集中在 `server/core/metrics/`，各子系统只调用具名 helper，不自行拼标签。
4. 每个请求一条结构化访问日志（status / duration / route 模板 / requestId），复用现有 `requestId` 上下文。
5. 就绪检查的依赖口径与超时固定。

## 非目标

- 分布式追踪（OpenTelemetry traces）、日志聚合栈、告警规则托管、APM 厂商接入。
- 前端指标 / RUM、业务分析（用户行为、转化）。
- 请求体/响应体裁剪与采样策略（日志量由 `LOG_LEVEL` 控制）。
- 指标长期存储（Prometheus 侧责任）。

## 背景与现状（已验证事实）

- 现有健康检查（[server/http/app.ts:52-55](../server/http/app.ts)）：`GET /api/health` 返回 `{ status: "ok", redis, worker, queueDepth }`，其中 `redis=false` 时 `queueDepth=null`；README（第 239–241 行）把它当作运行期 readiness 与告警口径。
- 现有日志：pino（`server/core/logger`），请求 ID 由 [request-id.ts](../server/http/middleware/request-id.ts) 注入异步上下文并写响应头；**没有**每请求的访问日志行，也没有任何指标（全仓无 `prom-client` / OpenTelemetry 依赖）。
- 关键链路的降级信号目前只存在于日志文本里（媒体池过载、预签名失败、派生失败、Redis 回源），无法聚合或告警。
- 存储后端已有启动探测（`probe()`），但结果只进日志；运行期无法从外部判断「浏览器直连是否可用」。
- 同一健康检查同时承担存活与就绪两种语义：`redis=false` 时返回 200 且 `status: "ok"`——若把它配成容器存活探针，Redis 抖动会触发全量重启，把一次可自愈的降级放大成整站不可用。

## 规则

### 1. 健康检查分层

1.1 `/api/health/live`：**只证明进程在跑**。不检查数据库、Redis、存储、队列；无条件 200 `{ status: "ok" }`。事件循环被阻塞到无法响应时自然超时，这才是存活探针要抓的故障。

1.2 `/api/health/ready`：依赖就绪。检查项与超时：

| 检查 | 判定 | 超时 |
| --- | --- | --- |
| 数据库 | `SELECT 1` | 2s |
| Redis | `PING`（请求路径连接） | 1s |
| 队列 worker | `isTaskWorkerRunning()`（布尔，不阻塞） | — |
| 存储 | s3 后端的启动探测能力摘要存在（`browserCors` 不参与就绪判定） | — |

1.3 就绪语义：全部通过 → 200 `{ status: "ready", checks: {...} }`；任一致命项失败 → 503 `{ status: "not_ready", checks: {...} }`。`checks` 只含布尔与数值，不含错误文本、端点、桶名。

1.4 `queueDepth` 仍由就绪响应提供（`waiting + delayed + active`）；Redis 不可达时为 `null`（沿用现有语义，避免用 0 冒充「无积压」）。

1.5 删除 `/api/health`。README 的部署与监控章节同步改为两个端点。

### 2. 指标端点

2.1 `/metrics`：Prometheus 文本格式（`@prometheus-io/client` 默认注册表 + 显式注册）。

2.2 默认关闭：`METRICS_ENABLED` 未开启时返回 404（不暴露端点存在性）。

2.3 开启后要求 `Authorization: Bearer <METRICS_TOKEN>`，常量时间比较；未配置 `METRICS_TOKEN` 时启动失败（不允许「开了指标但没鉴权」）。公网部署下该端点不得匿名开放。

2.4 `/metrics` 不参与限流，不记录到 `http_requests_total`（避免抓取自污染）。

### 3. 指标集合

3.1 HTTP 层（一个中间件产出）：

- `http_requests_total{method, route, status}`
- `http_request_duration_seconds{method, route}`（直方图，桶按 5ms–10s 分布）

3.2 `route` 一律使用**路由模板**（`/api/files/*`、`/api/assets/*`），不使用原始路径；无法匹配到模板的请求记为 `other`。

3.3 鉴权与分发（对应各 Spec 的观测点）：

- `auth_snapshot_total{result}`，读路径 `result ∈ {hit, miss, db_fallback, error}`，写路径（改密 / 禁用后的失效）`result ∈ {invalidated, invalidated_fallback, invalidate_error}`。读写路径共用 `error` 会让写路径失败在指标上不可见，故两套取值同属一个有界联合类型
- `auth_verify_duration_seconds`（直方图）
- `file_access_describe_total{delivery, result}`，`delivery ∈ {signed, stream}`，`result ∈ {ok, error}`
- `file_access_batch_size`（直方图）
- `presign_total{result}`，`result ∈ {ok, failed}`

3.4 存储：

- `derived_artifact_total{tier, result}`，`result ∈ {hit, generated, failed, skipped}`；`skipped` 表示按设计不生成（如 APNG 退回原图），不计入失败率——它与 `failed` 是两种语义，混用会让失败率失真。`failed` 只记生成故障：请求取消（`AbortError`）与媒体池过载拒绝不计入——取消是请求生命周期结束，过载由 `media_busy_rejected_total` 在分类点单点计数，重复计入会让失败率被用户取消与容量波动放大
- `storage_probe_info` 的数值形态：`storage_probe_ok{addressing, response_overrides, browser_cors}`（启动时写一次，值 1）
- `storage_probe_clock_skew_seconds`（gauge）

3.5 队列与媒体池：

- `queue_depth`（gauge，抓取时读取）
- `worker_up`（gauge，0/1）
- `media_busy_rejected_total`

3.6 进程默认指标（`@prometheus-io/client` 的 `collectDefaultMetrics`，无标签）：`process_cpu_*`、`process_resident_memory_bytes`、`nodejs_eventloop_lag_*`、`nodejs_gc_*` 等。零维护成本，是排障第一现场（事件循环阻塞 / 内存增长 / GC 压力）；不进本 Spec 的标签纪律范围（无标签可爆基数），也不参与验收断言。

3.7 存储 GC / 迁移（沿用既有日志事件）：

- `storage_gc_runs_total{result}`，`result ∈ {ok, partial, failed}`：单周期内四个阶段（引用回收 / staging 清扫 / 派生清扫 / 探测残留清扫）独立成败，`partial` 表示部分阶段失败——它是可告警的终态，若把部分失败并入 `ok`，持续失败的阶段按指标告警会完全漏报
- `storage_gc_reclaimed_bytes_total`（counter）

3.8 标签纪律（硬约束）：

- 禁止把用户 id、存储 key、文件名、URL、错误消息、请求 ID 放进标签。
- 每个指标的标签集合在 `server/core/metrics/` 内声明为**有界联合类型**，子系统的调用只允许传声明过的值（类型层面约束；取值无需另立运行期常量，没有运行期消费方）。
- 新增标签需要同时更新本 Spec 的指标表（评审点：基数估算）。

3.9 指标注册是进程级单例：模块加载即注册，测试环境重复导入不得抛「already registered」（用 `registry` 复用或按 `globalThis` 缓存，与数据库客户端同一手法）。

### 4. 访问日志

4.1 每个请求一条结构化日志：`{ requestId, method, route, status, durationMs }`。`route` 同样用模板。

  例外：`/metrics` 自身既不记指标也不记访问日志（与 2.4 同一条规则）。抓取是机器流量、按固定间隔发生，记进来只会淹没真实请求的日志，且它对排障没有增量信息（抓取失败由 Prometheus 侧告警）。

4.2 不记录查询串（可能含签名参数与文件名）、不记录请求头（可能含 cookie）。

4.3 日志级别：2xx/3xx → `info`；4xx → `warn`；5xx → `error`。与现有 `onError` 的 `error` 日志不重复记录异常栈（访问日志只记结果，异常栈仍由错误处理单点记录）。

### 5. 依赖与库

5.1 使用 `@prometheus-io/client`（Prometheus 官方 npm 包，`prom-client` 的继任者；API 同形、无外部依赖、拉模型）。不引入 OpenTelemetry SDK：本项目没有 collector，OTel 的默认导出器需要额外基础设施，收益（trace）不在本期目标内。

5.2 若将来引入分布式追踪，指标层可保留（Prometheus 仍是主流消费方式），并以其 Spec 为准。

## 技术影响

### 服务端

- 新增 `server/core/metrics/`：注册表、指标声明、helper、`METRICS_*` 配置读取。
- [server/core/config](../server/core/config)：新增 `METRICS_ENABLED`、`METRICS_TOKEN`（后者在启用时必填）。
- 新增 `server/http/middleware/observability.ts`：访问日志 + HTTP 指标（在 `requestId` 之后、路由之前挂载，`next()` 之后读取响应状态；未捕获异常经 `onError` 后同样按 500 记录）。
- [server/http/app.ts](../server/http/app.ts)：`/metrics` 路由、`/api/health/live` 与 `/api/health/ready`，删除 `/api/health`。
- 各子系统在既有降级点调用具名 helper：`server/core/auth/snapshot.ts`、`server/http/routes/files.ts`、`server/services/storage/artifact.ts` / `resize-cache.ts`、`server/http/media-busy.ts`、`server/services/storage/gc.ts`。
- [server/core/bootstrap.ts](../server/core/bootstrap.ts)：写入 `storage_probe_*`。

### 前端

- 无变化。

### 数据与持久化

- 无数据库结构变更；无新增持久化。

### 部署

- 反向代理：`/metrics` 默认不应对外暴露（即使开启也需 token）。
- 编排：存活探针用 `/api/health/live`（间隔 10s、失败阈值 3），就绪探针用 `/api/health/ready`（间隔 10s、失败阈值 3）。README 写明「不要把就绪端点配成存活探针」的原因。
- Prometheus 抓取目标：`/metrics` + Bearer token。

## 异常与边界

- **Redis 宕机**：`/api/health/live` 仍 200；`/api/health/ready` 503（`redis:false`）。编排层摘流但不重启；恢复后自动回到就绪。
- **数据库宕机**：就绪 503；请求本身已失败，语义一致。
- **`/metrics` 抓取超时**：不影响业务请求（无锁、无 IO，读取内存注册表）。
- **指标端点被匿名访问**：默认 404；开启后无 token 401。
- **标签爆炸**：由 3.8 的类型约束 + 指标声明集中化阻止；测试断言「不同 key 不产生新序列」。
- **多实例**：每个实例各自暴露 `/metrics`，由 Prometheus 侧按 instance 区分；不需要聚合。
- **测试环境**：指标注册不得因模块重复加载抛错（3.9）；指标写入不得依赖 URL/文件系统。

## 验收标准

### 静态检查与测试

- 默认配置下 `GET /metrics` → 404；`METRICS_ENABLED=true` 且未配置 token → 启动失败；配置 token 后无 `Authorization` → 401，带正确 token → 200 且响应为 Prometheus 文本。
- `/api/health/live` 在 Redis 不可用时仍 200；`/api/health/ready` 返回 503 且 `checks.redis = false`。
- `/api/health/ready` 在全部依赖正常时 200，`checks` 字段只含布尔/数值。
- 访问日志：一个请求产生一条日志，含 `requestId`/`method`/`route`/`status`/`durationMs`；带签名的文件请求不出现查询串。
- 指标标签：请求 `/api/files/9/ab/xxx.png` 记录的 `route` 为 `/api/files/*`；不存在原始路径标签。
- 基数：对 100 个不同存储 key 的请求，`file_access_describe_total` 序列数不增长（标签不含 key）。
- 测试重复导入指标模块不抛错。
- 类型检查、lint、相关测试串行通过（Vitest 单 worker）。

### 实机走查

- 服务器模式：Prometheus（或 `curl`）抓取 `/metrics`，能看到全部声明指标；画布加载后 `file_access_describe_total`、`derived_artifact_total`、`auth_snapshot_total` 有增量。
- 停 Redis：就绪 503、存活 200；恢复后就绪回到 200。
- 触发一次媒体池过载（并发媒体编辑），`media_busy_rejected_total` 增长。

## 实施顺序（确认后）

1. `server/core/metrics/` + 配置项 + `/metrics` 路由（含鉴权）。
2. 健康检查拆分（live / ready）与 README 同步。
3. 访问日志与 HTTP 指标中间件。
4. 子系统指标接线（鉴权、描述、派生、预签名、媒体池、GC、存储探测）。
5. 实机走查与抓取验证。

## 已确认决策（用户反馈）

- 2026-10-26：用户同意把可观测性纳入本轮改进方向（「按建议做」），并强调以业内成熟前沿方案为准——因此选 Prometheus 拉模型 + `prom-client`，不引入需要 collector 的追踪栈。具体规则待确认。

## 已确认事项（2026-10-26 用户确认）

2026-10-26 用户确认本 Spec 方案通过，原待确认五项按当前实现口径定案：

- `/api/health` 直接删除、不保留别名；README 只记录新端点（`live` / `ready`，编排探针指向此处），外部监控指向旧路径时须在部署升级时改配，不做兼容路由。
- `/metrics` 以 `METRICS_ENABLED` + 强制 token 开启，不开独立监听端口。
- 访问日志全量记录（便于按路由算错误率），`/metrics` 抓取流量不进日志也不进指标。
- 就绪响应保留 `queueDepth`（布尔/数值口径），不只走指标。
- 直方图桶沿用 5ms–10s 通用分布，出现业务需要时再调。

## 当前状态

已按用户指示实现，代码于 2026-10-26 随 `1bff028d` 提交并推送（此前记录中的「工作区（未提交）」已过时）：`/api/health/live` 与 `/api/health/ready`（旧 `/api/health` 删除）、`@prometheus-io/client` 指标层（globalThis 单例）、`METRICS_ENABLED` / `METRICS_TOKEN` 与启动期 token 必填校验、Bearer 常量时间比较、访问日志与 HTTP 指标中间件。

实现口径（与规则对照）：健康响应为扁平 JSON 而非全站 `ok()` 信封（消费方是编排探针）；致命项 = 数据库 / Redis / 存储探测，worker 只报告不参与就绪；队列读数带 1s 上限；`/metrics` 自身既不进访问日志也不进指标；未匹配路由统一记为 `other`。

测试（2026-10-26，串行、`--maxWorkers=1`）：`http/routes/observability.test.ts` 15 个用例（live/ready 矩阵、指标 404/401/200、访问日志字段与查询串不落盘、标签基数、单例）与 `core/config.test.ts` 4 个用例通过；server 全量通过。

2026-10-26 复审订正（双轴代码审查后）：

- 指标表补齐三处与实现的偏差：`derived_artifact_total` 的 `result` 增加 `skipped`（3.4）；新增 3.6「进程默认指标」（`collectDefaultMetrics`，无标签，不进标签纪律范围）；原 3.6–3.8 顺延为 3.7–3.9（正文与代码注释的外链编号同步）。
- 4.1 补 `/metrics` 的访问日志例外（与 2.4 同一条规则：抓取流量不进指标也不进日志）。
- `server/core/metrics/index.ts` 的三个运行期元组常量（`FILE_ACCESS_DELIVERIES` / `DERIVED_TIERS` / `AUTH_SNAPSHOT_RESULTS`）删除：取值只用于类型约束，无运行期消费方。3.8 的「标签集合声明为常量」据此按「类型层面的有界集合」理解，正文已改述。
- `auth_snapshot_total` 的 `result` 增加写路径三种取值（`invalidated` / `invalidated_fallback` / `invalidate_error`，3.3）：读写共用 `error` 会让写路径失败在指标上不可见，而失效失败正是陈旧上界的唯一来源。
- `storage_gc_runs_total` 的 `result` 增加 `partial`（3.7）：单周期四个阶段独立成败，部分失败若并入 `ok`，持续失败的阶段按指标告警会完全漏报（失败只落日志，日志不聚合）。
- 依赖从已被 npm 弃用（「has been replaced by @prometheus-io/client」）的 `prom-client` 迁到其继任者 `@prometheus-io/client@0.16.1`：导出与 CJS 形态同形，正文技术引用同步改名。该包声明 `engines: node ^22 || ^24 || >=26`，而当时 Dockerfile 仍是 `node:20-slim`——2026-10-26 用户确认把部署基线升到 Node 22：Dockerfile 两阶段改 `node:22-slim`，root/shared/web 三个 `engines` 收敛为 `>=22.12.0`，`@types/node` 升 `^22`（CI 已是 22）。迁移后串行验证：server 1143 通过（含 `/metrics` 渲染与鉴权用例）/ web 1123 通过，typecheck / lint 通过。

2026-10-26 判断项修复：`derived_artifact_total{result="failed"}` 不再计入请求取消（`AbortError`）与媒体池过载（`MediaPoolBusyError`）——过载已由 HTTP 分类点的 `media_busy_rejected_total` 单点计数，取消不是生成故障；3.4 正文已补口径。GC 指标阶段数随第四条「探测残留清扫」阶段更新为四（3.7）；三阶段全败的 `failed` 阈值同步改为四阶段全败。测试：artifact 指标分类回归用例、gc 四阶段终态聚合用例。

尚未验证：Prometheus 实际抓取与编排探针配置；真实部署下的指标连续性。状态已由用户于 2026-10-26 设为「已确认」；「已实现」待上述部署验收后设置。
