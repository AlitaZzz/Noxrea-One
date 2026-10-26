# 任务队列 Redis + BullMQ 化（Task Queue BullMQ Migration）

状态：已确认（2026-10-20，用户确认；「已确认」= 方案获批、可以开始实现。v5 定稿：v4 → v5 自审修正：① 提交前中断接管补 retryCount 预算约束（否则崩溃循环下无限重试，且对齐现行 cleanupZombieTasks 预算语义）；② 取消矩阵区分轮询段 delayed job；③ max_retries 设置行与规则 1 口径统一；④ 待确认事项按行业成熟形态转设计规则（残余风险处置入规则 3），待确认清零。v4 依据参考项目 open-ai-canvas-main 实读证据引入的提交闸门与轮询 tick 化保留。v1 审查 P0/P1/P2 修订全项保留）

## 目标

把生成任务的派发层从 DB 轮询替换为 Redis + BullMQ，行业成熟形态：**DB 是任务状态的唯一真源，Redis 只承担派发与进程死亡检测**；tasks 表即 outbox（`pending` 行 + 对账清扫 = 轻量 relay）。前端零改动，无向后兼容包袱（旧路径直接删除，不留双轨）。

## 现状（已验证事实，语义基准）

- 任务状态机 `generation_tasks`：`pending → processing → completed | failed | cancelled`；`retryCount`、`errorCode`、`upstreamTaskId`（上游受理标记）。
- 防重复计费不变量组（迁移中语义保持）：
  1. `upstreamTaskId` 非空 ⇒ 只恢复轮询、绝不重提上游；
  2. 同步任务被中断且无法确认上游是否受理 ⇒ 保守判失败不重发；
  3. 轮询预算耗尽 ⇒ 重置 pending 恢复轮询（`worker.max_retries` 封顶，语义 = **异步轮询预算**，非通用队列重试次数）；
  4. 终态写入经 `startedAt` 所有权令牌守卫；
  5. 取消是独立 `cancelled` 终态，pending 亦可取消。
- **已知风险窗口（现状即存在）**：上游提交请求发出后、`upstreamTaskId` 落库前存在窗口；现状单实例以「进程已死」消解。现状无「提交在途」持久化标记——**未发出的**中断（如死在 SSRF 校验阶段）与**可能已发出**的中断同样被保守判失败（`generation.interrupted_no_resubmit`），前者本可安全重试。
- 前端契约：`/api/generate/tasks/batch-status` 轮询 + cancel 路由，不变。

## 参考证据（open-ai-canvas-main 后端，实读）

以下为本 Spec 行业形态判断的实证来源（已验证事实）：

1. **提交闸门**（`model_router_attempts.go`）：上游提交以持久化的 DispatchState 状态机治理——attempt 行先以 `not_sent` 落库（提交决策的持久记录）；发送请求**前**执行条件更新 CAS（`WHERE dispatch_state='not_sent'` → `submission_unknown`，`MarkRouteAttemptDispatching`，repository 层校验 RowsAffected），CAS 失败 = 已有执行者占据闸门 ⇒ 终止且不发请求（原文注释："A stale worker must not dispatch the same selected attempt a second time"）；结果分类三态：`accepted`（上游已受理）/ `rejected_no_job`（上游明确拒绝 401/403/404/429 等，可安全换路重试）/ `submission_unknown`（网络类模糊失败，**绝不自动重发**）。恢复入口对 `submission_unknown` 且无上游任务 ID 的处置 = 硬停止（"上一次提交结果不明确，为避免重复扣费已停止自动重发"）。
2. **提交前租约复查 + 提交后结果写守卫**（`task_worker.go`）：提交点前有租约守卫的条件更新（失败 ⇒ "任务暂未调用上游"）；领取后重读终态防取消窄窗口；租约失效信号在**保存上游结果与结算前**复查（"旧 worker 可能在新 worker 接管后继续结算或写入终态"）。
3. **轮询 tick 化**（`repository_tasks.go` / `task_worker.go`）：异步等待不占执行租约——`DeferRunningTaskForProviderPoll` 释放租约并写 `next_poll_at = now + 15s`；领取查询把「到期 tick」并入（`next_poll_at <= now`），每次领取 = 一次有界轮询尝试，轮询间隔期不持有任何租约、无需心跳。
4. **执行租约 + 续租**：执行段持有 45s 租约、15s 续租；续租 context 独立于执行时限（其注释记录了一次真实事故：续租随父 context 取消被误判租约失效，一次上游调用被重跑成三次）。
5. **队列本体无 Redis**：领取 = DB 事务 CAS（`queued` 或租约过期的 `running` 直接可领取）+ 2s ticker + 唤醒通道加速；Redis 仅用于分布式路由熔断状态（带本地降级）。**DB 唯一真源 + 扫描兜底**的架构方向与本 Spec 一致；Redis/BullMQ 在本项目中承担的是其「扫描兜底」之上的派发加速与进程死亡检测层。
6. **账务不确定显式化**：模糊提交后果对应 `MarkBillingUncertain`（仅未发出的预扣可退）；人工恢复/对账运维路径（独立恢复租约 + 全程审计）。本项目暂无计费系统，对应物 = 任务失败时区分确定性拒绝与提交不确定的 errorCode + 日志留痕。

## 范围

1. **队列层**：`loop.ts` 删除（进程全局 StopSignal 无留存消费方，随长驻循环一并删除；停机中止改为 worker 层 per-job AbortController，drain 超时后触发）；**`poll-loop.ts` 与 `resume-polling.ts` 的长驻轮询循环删除**，改为「单次轮询尝试 + defer 下一次 tick」形态；新增 BullMQ queue/worker 适配、对账清扫（含重激活原语）、提交闸门与 per-job abort；`claimPendingTasks` 改为单任务 CAS 认领；executor / finalize / TaskManager 按本 Spec 改造（相关测试同步调整）。
2. **Schema**：`generation_tasks` 新增列——`submissionState`（`not_sent` 默认 / `in_flight`，提交闸门标记）与轮询调度列（下次 tick 时间 + 当轮预算计数，命名实现期定）。 additive 迁移，无数据回填（存量 processing 行按迁移完成时刻的租约清扫收口）。
3. **设置**：`worker.max_concurrency` / `stuck_timeout_minutes` / `max_retries` / `zombie_scan_interval_seconds` / `drain_timeout_seconds` / `async_poll_*` 保留并按规则 5 映射；**删除 `worker.poll_interval_seconds` / `worker.poll_check_interval_ms`**（DB 轮询专用，迁移后无消费方，不留死配置）。
4. **部署与运维**：`docker-compose.nas.yml` 增 Redis 7 服务；生产部署物按同一形态在 cutover Spec 交付时落 compose（本期以部署文档记录要求）；健康端点扩展上报 `{ redis, worker, queueDepth }`（2026-10-26 订正：该端点后由 [observability-baseline.md](observability-baseline.md) 规则 1 拆为 `/api/health/live` 与 `/api/health/ready`，旧 `/api/health` 已删除；本 Spec 的字段要求落在 ready 端点）。
5. **测试**：真实 Redis 集成测试，首选一次性容器（testcontainers 形态），备选专用 prefix + 专用 DB index（实现期按环境落定）；**禁止对共享实例 flushdb**。

## 非目标

- 前端任何改动；客户端请求幂等键（另案——参考项目以 `CreationSubmissionID uniqueIndex` 在 schema 层实现重复提交返回既有任务，属创建 API 契约变更，与队列正确性正交，维持另案）。
- per-user 创建侧限流（另案）。多实例部署本身（能力解锁，不做形态变更）。Redis HA（哨兵/集群另议）。
- bull-board 面板（可选后续）。media-processing 第三阶段迁移。运行镜像 Node 版本调整（node:22 满足 engines ≥ 18）。
- 计费/预扣系统（不存在）；多供应商路由切换（参考项目 DispatchState 中的 `rejected_no_job` 换路语义在本项目无消费方，不引入）。

## 业务规则

### 1. 单一真源与 handler 状态分派

Redis job 载荷仅 `{ taskId }`。handler 每次执行从 DB 加载任务：

- `pending` → CAS 认领（`updateMany where id & status=pending → processing, startedAt=now`）→ 执行段（提交闸门位于上游提交点内，见规则 3）：执行段内先按 `upstreamTaskId` 分派——已有（轮询预算重入队恢复的会话）→ 轮询尝试路径；未有 → 上游提交路径。同步路径直接产出终态；异步路径在上游受理后持久化 `upstreamTaskId`、写入首个 `nextPollAt` 并**将当前 job 原位 `moveToDelayed` 至该时刻后退出**（DelayedError 收尾，规则 2）——不在 handler 内长驻轮询；
- `processing && upstreamTaskId` → **单次轮询尝试**：一次 `pollUpstreamTask`——completed → finalize + 终态写入；failed → 终态写入；仍在生成 → 写 `nextPollAt = now + 间隔（含退避）`、预算计数 +1 并将当前 job 原位 `moveToDelayed` 至 `nextPollAt`；预算/超时耗尽 → 沿用 `requeueProcessingAsyncTask` 语义（重置 pending、`retryCount+1` 对 `worker.max_retries`）并原位 `moveToDelayed(now)` 立即重跑（新会话首轮由 handler 按 pending+upstreamTaskId 分派，绝不重提上游）。轮询尝试不持有租约（对上游是只读 GET，无计费副作用；终态写入沿用 startedAt 守卫，重复 tick 由守卫收口）；
- `processing && !upstreamTaskId`（stalled 重跑或清扫重激活的 job 进入）：
  - `submissionState=in_flight` 且租约过期 ⇒ 判失败 `generation.submission_uncertain`（提交在途中断——可能已发出，绝不重发）；
  - `submissionState=not_sent` 且租约过期 ⇒ 先查中断重试预算（`retryCount >= worker.max_retries` ⇒ 判失败「中断重试预算耗尽」，不重提上游）；预算内 ⇒ 执行**接管 CAS**（`where status=processing & submissionState=not_sent & 租约过期 → startedAt=now, retryCount+1`）：成功则进入执行段（闸门未占，可安全提交）；失败则本轮跳过；
  - 租约未过期 ⇒ 本轮跳过——不凭一次读到的状态写他实例的任务；
- 终态 → job no-op 完成。

handler 对业务失败**一律自行写 DB 终态并正常完成 job**，不依赖 BullMQ 重试。失败分类按**性质**定义并泛化：上游明确拒绝 = 拿到了上游明确应答的失败（4xx 且非 408/425——参考项目 safe-rejection 集合 401/403/404/429 为其子集），沿用现行失败 errorCode；网络类模糊失败（超时/连接中断/进程死亡，含 408/425/5xx——无法排除上游已受理）且闸门已过 ⇒ `generation.submission_uncertain`（取代现行 `generation.interrupted_no_resubmit`，语义更精确：从「处理中断」收窄为「提交结果不确定」）。泛化依据：两类失败均**绝不自动重发**，误分类影响面仅止于对外文案与错误码统计，不触及提交安全性。

### 2. job 生命周期与重入队

- **jobId = taskId** 仅用于并发双重入队去重（waiting/delayed/active 语义）。
- **重入队唯一原语 = 重激活流程**：`getJob(taskId)` → 无 job ⇒ `add`；waiting/delayed/active ⇒ 不动作；completed/failed ⇒ `remove()` 后 `add`。普通 `add` 的隐式幂等不作为重入队依据（removeOnComplete 的 remove 是惰性的，终态 job 在保留窗口内仍占 jobId）。
- **Processor 内自调度原语 = 原位延迟（与重激活原语并列，规则 2 回写）**：jobId = taskId 的 job 在自身 processor 内查 `getJob` 必为 active——重激活原语对它恒 skipped，且同 jobId `add` 被去重忽略。因此轮询 tick 的三处自调度（首 tick / 下一 tick / 预算重入队后立即重跑）一律走 `moveToDelayed(ts, token)` 原位延迟 + 抛 `DelayedError`（BullMQ 文档形态：worker 对该错误跳过 finalize，job 停留 delayed 态由定时器提升后重跑）；token 为 processor 收到的 job 锁令牌，(job, token) 由 worker → handler → 执行段/轮询段下传。原位延迟失败（锁丢失/Redis 抖动）不致命：调度目标行（nextPollAt 或 pending 重置）已落库，job 走完成终态，tick 逾期后清扫重激活自愈。
- **有界保留**（工程常量）：`removeOnComplete: { age: 3600, count: 1000 }`、`removeOnFail: { age: 86400, count: 1000 }`——调试与 QueueEvents 保留窗口有界；正确性与保留期解耦（重激活流程覆盖一切终态残留）；保留常量随轮询 tick 体量复核（规则 8 容量监控项）。
- 消费重激活原语的入口（均为 job 外部视角）：创建侧入队（路由，规则 7）、对账清扫（规则 4）。轮询 tick 的三处自调度（首 tick / 下一 tick / 预算重入队后立即重跑）**不经本原语**——processor 内自引用走原位延迟原语（见上）。接管 CAS（规则 1）**不经队列**——接管成功在进程内重进执行段，不构成重入队入口。

### 3. 所有权、提交闸门与心跳覆盖

- **认领即租约**：CAS 认领写入的 `startedAt` 是所有权令牌；`updatedAt`（30s 心跳推进）是**执行段**租约新鲜度。
- **提交闸门（唯一位置 = 上游提交点内、请求发出前）**：执行一次条件更新——`where id & status=processing & startedAt=令牌 & submissionState='not_sent' → submissionState='in_flight'`（touch updatedAt）。失败 ⇒ 已失权或闸门已被占，终止且不提交上游（能力层抛闸门错误，executor 静默收口、不写任何终态）。该 CAS 同时回答两个问题：我是否仍是所有者、本次提交是否已被派发——**双提交被结构性排除**（第二个执行者不可能通过同一闸门），而非仅压缩窗口。参考项目实证：同构 CAS（`MarkRouteAttemptDispatching`）+ 失败即停。闸门覆盖**所有**上游提交：轮询型路径（image/video）落在 `TaskManager.submitAndWait` 的 fetch 前，文本路径（LLM，直连 fetch 不经 submitAndWait）落在其 fetch 前——同一语义位置（每条提交路径的发送点前各一），引用解析/管线构建等前置 await 全部退到闸门前，`in_flight` 之后的窗口仅剩同步代码。文本无 `upstreamTaskId`，流式成功即直接写终态。
- **残余风险处置（行业边界，设计定案）**：闸门通过后、上游响应前的失权在途提交 = **单次**孤儿提交计费（双提交已被闸门结构性排除）。处置沿用参考项目同构形态：失败终态区分「上游明确拒绝」与 `generation.submission_uncertain`（模糊失败）并留痕可查、**绝不自动重发**；计费系统上线后对应账务「不确定」显式态（参考项目 `MarkBillingUncertain`，仅未发出的预扣可退）。上游接口无幂等键 ⇒ 该残余为行业边界，任何提交方系统均无法消除，非本 Spec 待决事项。
- **提交结果落库**：`markTaskProcessing` 的 startedAt 守卫 + 重试保留；守卫拒绝时执行者退出、结果丢弃。
- **心跳覆盖不变量（收窄至执行段）**：执行段内所有阶段（上游提交 / 同步结果等待 / 结果下载 finalize）心跳周期必须 ≪ 租约阈值（提交段由 `api_timeout(240s) ≪ stuck_timeout(15min)` 界定）；轮询段**不持有租约、无心跳**（tick 调度即存活信号，`nextPollAt` 未到期 = 正常等待；到期 + 无 live job = 清扫重激活）。新增**执行段**阶段必须满足同一不变量。
- 终态写入：既有 startedAt 守卫不变（旧执行者迟到写入天然被拒）。

### 4. 对账清扫与恢复

- **废止启动期全局恢复扫描**（`recoverProcessingTasks` 语义删除）：进程死亡恢复由 BullMQ stalled 按 job 粒度完成（重跑 → 规则 1 分派）。
- **对账清扫**（周期 = `worker.zombie_scan_interval_seconds`）只做两类事（每类都以「Redis 无 live job」为前置，job 存活 ⇒ 跳过）：
  1. `pending` 且停留超阈值 ⇒ 重激活；
  2. `processing` 且（执行段租约过期（`updatedAt < stuck 阈值`，未持 `upstreamTaskId` 的行）**或**（已持 `upstreamTaskId` 的行）`nextPollAt <= now`（tick 逾期））⇒ 重激活——后续处置由 handler 按规则 1 分派（闸门分类 / 轮询续 tick）。**不触碰新鲜行**——执行段活跃行每 30s 心跳、轮询等待行 `nextPollAt` 未到期，永不被误判。
- 切换瞬间：新 Era 在途任务由 stalled 重跑收口；**旧 Era 遗留 `processing` 行（Redis 无对应 job）由清扫收口**：已持 `upstreamTaskId` 的最坏延迟 ≤ 轮询间隔 + 扫描周期；未持的最坏延迟 ≤ `stuck_timeout_minutes`。无数据迁移。

### 5. 设置映射

| 键 | 语义 |
| --- | --- |
| `worker.max_concurrency` | BullMQ Worker concurrency（执行段与轮询 tick 同受约束） |
| `worker.stuck_timeout_minutes` | 执行段 DB 租约过期阈值（第二道防线；必须 ≫ lockDuration，使 stalled 先行） |
| `worker.max_retries` | DB 侧**中断重试预算**（单一 `retryCount` 计数，现行语义：轮询预算耗尽重入队与提交前中断接管共用）；不映射 BullMQ attempts |
| `worker.zombie_scan_interval_seconds` | 对账清扫周期 |
| `worker.drain_timeout_seconds` | 优雅停机窗口 |
| `worker.async_poll_*` | 不变（间隔/退避/预算在 tick 调度中逐次生效） |
| ~~`worker.poll_interval_seconds` / `poll_check_interval_ms`~~ | **删除** |

BullMQ 侧参数（工程常量）：`lockDuration=30s`（自动续约 15s）、`stalledInterval=30s`、`maxStalledCount=2`、`attempts=3`（仅覆盖 stalled 重跑与基础设施级瞬断；业务失败不触发——规则 1）。执行段 DB 心跳 30s 不变；轮询段无心跳。`GenerationAsyncDispatchedError` 路径（实现期更名，语义同原 `GenerationRequeuedError`；携带已落库的 `nextPollAt` 作为首 tick 延迟单源）：executor 经原位延迟原语推进首 tick 后抛 `DelayedError` 结束本次执行（job 进入 delayed，不被 finalize），与 BullMQ 重试无叠加。

### 6. 取消与 remove 矩阵

DB-first 取消不变（`cancelTask` 先行）。队列侧：

| 任务状态 | 队列动作 |
| --- | --- |
| pending（job waiting） | `job.remove()` 尽力而为；失败仅记日志，handler 终态 no-op 兜底 |
| processing 执行段（job active） | **不 remove**（active remove 语义不可靠）；靠执行段取消检查退出 |
| processing 轮询段（job delayed） | `job.remove()` 尽力而为（delayed job 可干净移除）；handler 读到终态 no-op、不再续 tick 兜底 |
| 重置 pending（轮询预算） | 规则 2 重激活 |

清扫只扫 `pending`/`processing` 非 `cancelled` 行——终态天然不被重入队；remove 与 DB 取消的竞态由「DB-first + handler 终态 no-op」收口，无复活路径。

### 7. 创建语义与 outbox 边界

- 创建 = DB 事务落行（`pending`，`submissionState='not_sent'`）+ 提交后 enqueue；**enqueue 失败不回滚、不 503**——行留 DB，对账清扫重激活。创建成功语义 = 「已受理落库」，派发最终一致（正常 < 1s，清扫兜底 ≤ 扫描周期）。
- **运行期 Redis 宕机**：不 503——任务持续落库 pending（队列作为缓冲），`/api/health/ready` 上报降级 + 告警；Redis 恢复后清扫自动排水。活跃 job 连接异常按 stalled 治理（规则 3 租约保证不误杀存活执行者）。Redis 宕机期间轮询 tick 调度失败：job 丢失由清扫按「tick 逾期 + 无 live job」自愈（最坏延迟 = 轮询间隔 + 扫描周期）。
- **启动探测**：bootstrap PING 失败即启动失败（无队列无法服务）。

### 8. Redis 运维口径

- Redis 7.x；AOF everysec；`maxmemory` 初值 256mb + `noeviction`（队列数据不可淘汰，容量随队列深度复核）；AOF rewrite 与磁盘占用纳入运维监控项。
- 安全：`requirepass`（凭据与 PG 同级落 env）；仅内网监听；生产 TLS 经反向代理（与存储决策同构）；**本应用专用实例**（不与其他系统共享；BullMQ `prefix: "noxrea:queue:"`；2026-10-21 起分布式限流共用该实例，使用独立 `noxrea:ratelimit:` 前缀）。
- 健康与告警：`/api/health/ready` 扩展（启动探测管生死，ready 管运行期 readiness 供 LB/人工核查）；queue depth / failed 计数 / redis 内存告警阈值列为部署文档项。

### 9. 停机

`worker.close()` 顺序：停止接新 job → 等待活跃 job 排空（窗口 = `drain_timeout_seconds`）→ 超时对活跃 job 触发 per-job abort（在途上游请求/下载中止，同现状「先礼后兵」）→ 有界等待落定 → 仍未落定者**放弃等待 close 结局**（BullMQ close 幂等：closing 期间重复调用返回同一 Promise，force 参数首调后不可达，不存在可靠的二次强制关闭），连接断开由进程退出兜底，残留 job 由 stalled 机制在新进程恢复。轮询段 job 均为秒级短任务，排空窗口内自然完成。

## 技术影响

- 依赖：`bullmq@^6` + `ioredis@^6`（实现期安装当前主版本 bullmq 6.3.17 / ioredis 6.0.0；engines：Node ≥ 18；运行镜像 node:22 满足，实现期以测试实测为准）。
- 代码：`server/services/worker/` 重构（loop.ts / poll-loop.ts / resume-polling.ts 删除；shutdown.ts / queue 适配 / 清扫 / tick 调度新增；executor / finalize / TaskManager 改造）；`server/crud/task.ts`：删除 `recoverProcessingTasks` / `cleanupZombieTasks`（职责由 stalled 重跑 + 对账清扫 + handler 分派承接），增单任务 CAS 认领、提交闸门、接管 CAS 与 defer 原语；`server/core/config` 增 `REDIS_URL`；bootstrap 增探测；`/api/health/ready` 扩展；prisma schema **新增 `submissionState` 与轮询调度列**（additive 迁移）。
- 文档：README/env-config-layout 增 `REDIS_URL` 与 Redis 运维项；部署文档记录生产 compose 形态。

## 异常与边界

- Redis 宕机：启动期 → 启动失败；运行期 → pending 堆积 + `/api/health/ready` 告警 + 恢复自动排水（规则 7）。
- 毒任务：`maxStalledCount=2` 封顶置 failed + DB 租约清扫兜底（两道防线阈值量级分离，不互相误杀）。
- 轮询段 Redis 丢失（flush/宕机）：tick 逾期行由清扫重激活自愈；极端并发下重复轮询尝试对上游为只读 GET，无计费副作用，终态写入由 startedAt 守卫收口；finalize 并发重复为幂等内容寻址写入 + 终态守卫，最多浪费一次下载。
- 回滚：不留兼容层；回退部署 + 摘除 REDIS_URL；DB 状态机列均为 additive，回退后闲置无害，无数据迁移。
- 残余风险（规则 3 设计定案）：闸门通过后、上游响应前的失权在途提交 = 单次孤儿提交计费；双提交已被闸门结构性排除。

## 验收标准

1. 行为等价：状态机、轮询预算、取消矩阵（规则 6）、恢复轮询不重提上游、终态守卫全语义一致；中断失败语义按规则 1 收窄（`submission_uncertain` 仅覆盖提交不确定场景，未发出的中断可安全重试）。
2. 提交闸门测试：失权执行者在闸门被拦截，不发上游请求；闸门通过后失权的在途提交 ⇒ 恰好一次上游提交、任务终态 `submission_uncertain`、无第二次提交（结构性排除双计费的回归测试）；提交前中断接管受 `retryCount` 预算约束，超限判失败且不无限重试。
3. 崩溃恢复注入测试：强杀 worker → stalled 重跑后同步/异步终态符合不变量；闸门前崩溃（`not_sent`）⇒ 接管后安全重提；重激活流程覆盖「终态 job 仍存在」场景（回归 P0.1）。
4. enqueue 丢失窗口：清空 Redis job + DB pending 行 → 清扫重激活且并发双清扫不重复执行；轮询 tick job 丢失 → 清扫按逾期重激活续跑。
5. Redis 停机演练：启动探测失败即失败；运行期创建不失败、pending 堆积、`/api/health/ready` 上报降级、恢复后排水。
6. 前端零改动；既有 server 测试（含轮询 tick 化改造更新部分）全绿；web 测试不回归；删除的两个设置键无残留消费方。
7. 并发槽：`max_concurrency` 全局生效，执行段与轮询 tick 同受约束。
8. 交付物：NAS compose 含 Redis 7 + AOF 卷；env 样例含 `REDIS_URL`；`/api/health/ready` 上报 redis/worker/queueDepth；README/env-config-layout 同步；生产 compose 形态写入部署文档。

## 待确认事项

无。原「残余风险接受」事项已按行业成熟形态转设计规则（规则 3「残余风险处置」：提交闸门结构性排除双提交；残余 = 单次孤儿在途提交，处置为「上游明确拒绝 / 提交不确定」失败分类留痕 + 绝不自动重发——参考项目 `submission_unknown` 不自动重发 + 账务不确定态的同构实证）。全部决策均有行业成熟形态依据，无开放歧义项；Spec 整体提请确认（「已确认」由用户设置）。

## 当前状态

已确认（2026-10-20，用户确认）。方案演进：v1 审查 P0/P1/P2 全项修订；v2 自审将无争议事项降为设计；v4 依据参考项目（open-ai-canvas-main）实读证据引入提交闸门（DispatchState 同构 CAS，双提交结构性排除）与轮询 tick 化（`DeferRunningTaskForProviderPoll`/`next_poll_at` 同构，长驻轮询循环与轮询段心跳删除）；v5 自审修正三处缺陷（接管无预算约束、取消矩阵轮询段口径、max_retries 行与规则 1 不一致）并将残余风险处置按行业成熟形态转设计规则。

实现完成（2026-10-20，未提交）：schema additive 迁移（submissionState / nextPollAt / asyncPollAttempts）已对 dev 服务器库 `migrate deploy` 应用；新增 worker 层 queue.ts（重激活原语/取消路由/健康上报/启动探测）、handler.ts（规则 1 分派）、poll-attempt.ts（单次轮询尝试 + defer/预算重入队）、worker.ts（BullMQ Worker + per-job abort + 规则 9 停机时序）、reconcile.ts（对账清扫）；executor 改提交段（闸门 + 异步受理调度首 tick）、manager 改提交边界（submission_uncertain 分类 + acceptUpstreamTask 落库）、poll-loop 改单次轮询、crud 增 CAS 原语并删 zombie/recover；路由创建侧 best-effort 入队 + 取消侧队列移除；/api/health 扩展 redis/worker/queueDepth；设置删 `poll_interval_seconds`/`poll_check_interval_ms`（连带删除无消费方的 `timerMillis` 类型）；NAS compose 增 Redis 7（AOF + noeviction + 9835 映射）与 REDIS_URL 注入，entrypoint 增必填校验与就绪等待；.env(.example)/README 同步。两处实现期偏离已回写上文：依赖取当前主版本（bullmq/ioredis ^6）；StopSignal 随长驻循环整体删除（无迁出消费者）。

验证结果：typecheck（根 + web）、lint（0 error）、server Vitest 913 全绿（单 worker 串行）、web Vitest 934 全绿（零回归）。运行期实机冒烟（2026-10-20，NAS Redis 7.4.11 @9835，256MB/noeviction/AOF 实测生效）：启动探测 PING 通过（bootstrap queue_ready）、Worker concurrency=10 挂载、对账清扫 60s 周期挂载、/api/health 上报 `{redis:true, worker:true, queueDepth:0}`、规则 9 停机段实机演练通过（无在途 job 时 drain 29ms 秒级关闭，连接干净收口，进程正常退出）。尚未实机验证：SIGINT 信号接线（本机 shell 无法向原生 node 投递信号，停机段已由脚本直接驱动验证）；真实生成任务的全链路派发（创建→入队→handler→tick，需经 UI 携真实供应商账号，验收走查时覆盖）；Redis 故障注入演练（停机排水/降级恢复）。提交/推送须用户另行明确授权（AGENTS 六.4）。

审查修订（2026-10-20，双轴 code-review 后）：① worker.ts 停机收尾废除 `close(force)` 二次强关（BullMQ close 幂等：closing 期间重复调用返回同一 Promise，force 首调后不可达）——改为有界弃等（drain → abort → 有界等待 → 放弃等待 close 结局），残留 job 由 stalled 在新进程恢复，与规则 9 语义一致并已回写；`startTaskWorker` 增停机中防重入守卫。② 调度失败自愈语义单源化：新增 `reactivateBestEffort`（失败记 warn 返 null），三处重复 try/catch（异步受理首 tick、tick 重调度、预算重入队重激活）收敛至此。③ 租约截止换算单源化：`stuckLeaseCutoff` 落 crud 层，handler 与清扫共用，禁止各自换算。④ in_flight 过期判失败**不增写时复查**（有界论证：闸门写入后提交 ≤ api_timeout 240s、下载 ≤ 600s 带 30s 心跳，存活执行者最后写入必然落在 15min stuck 窗口内，能呈现过期 in_flight 的只可能是死亡执行者；且 failTask 为无重提交风险的终态判定，与接管 CAS 风险等级不同）——论证注释落 handler.ts。⑤ 新增真 Redis 集成测试（`TEST_REDIS_URL` 环境门控，专用 DB index 键隔离，仅删本前缀键，禁 flushdb 共享实例），覆盖重激活状态机/取消矩阵/健康上报/终态残留。⑥ Spec 修订：规则 1 失败分类按性质泛化（4xx 非 408/425 = 明确拒绝，参考项目集合为其子集）；规则 2 四入口清单修正（创建侧入队属原语消费方，接管 CAS 不经队列）。

二轮审查修订（2026-10-20，双轴 code-review 后，两项架构修正经用户放行）：① **Processor 内自调度机制修复（本轮最严重发现）**：原实现经重激活原语调度 tick，但 jobId = taskId 的 job 在自身 processor 内必为 active——原语恒 skipped，延迟 tick 从未被创建，轮询节奏实际退化为清扫周期（`async_poll_*` 全部失真）。单测 mock 队列层 + 集成测试未覆盖 active 态自调度，故未被测出。根因修复 = 引入原位延迟原语 `deferActiveTickOrThrow`（`moveToDelayed(ts, token)` + 抛 `DelayedError`，BullMQ 文档形态，参考项目 `DeferRunningTaskForProviderPoll` 同构），覆盖三处 processor 内自调度（首 tick / 下一 tick / 预算重入队后立即重跑）；(job, token) 由 worker → handler → 执行段/轮询段下传；首 tick 延迟单源 = `GenerationAsyncDispatchedError` 携带已落库的 `nextPollAt`（`asyncNextPollAt`）。规则 1/2/5 已回写。② **闸门下沉到上游提交点**：原实现闸门在 executor 的 routeGenerate 之前，注释称其后到 fetch 为「纯同步」不实（LLM 路径的引用解析等 await 在闸门与 fetch 之间），窗口内崩溃会把未发出的提交误判为 submission_uncertain。修复 = 闸门移至每条提交路径的 fetch 前（轮询型路径在 `submitAndWait` 内、LLM 路径在其 fetch 前，同一语义位置），拒绝经 `GenerationGateRejectedError` 由 executor 静默收口；结构防双提交语义不变。规则 3 已回写。③ 创建侧入队改调 `reactivateBestEffort`（与自愈单源收敛）。④ 集成测试补两用例：processor 内 moveToDelayed + DelayedError 自延迟至完成（真 Redis 上 active→delayed→重跑→completed）、强杀 worker（连接即断锁残留）→ stalled 接管重跑完成——验收 3 的机制层覆盖（DB 终态分类仍由 handler 单测覆盖）。验证：typecheck、lint 0 error、server Vitest 922 全绿（单 worker 串行）、真 Redis 集成 9/9 全绿。仍待实机：SIGINT 接线、真实生成全链路（UI 携真实供应商账号）、Redis 故障注入排水演练。

三轮审查修订（2026-10-20，双轴 code-review 后，经用户放行）：① 删除重激活原语遗留的 `delayMs`/`"poll-tick"`/`"rescheduled"` 死分支（moveToDelayed 自调度落地后生产零调用方——唯一消费入口为创建侧 `reactivateBestEffort` 与对账清扫，均不传 opts；Speculative Generality）：签名收窄为 `reactivateTask(taskId)`、`ReactivationResult` 收敛为 added/skipped 两值、job 名合并为单一 `"dispatch"`，`reactivateBestEffort` 同步收窄；集成测试 delayed 造数改用队列原生 `add`（被测对象是重激活/取消对 delayed 的语义本身，delayed 入队已无生产入口）。② README 与 compose 的 Redis `9835` 端口发布口径统一（compose 注释为基准：内网开发/运维与集成测试直达，收紧部署可删映射）。其余 finding 处置为不改并留痕：闸门「取闸门否则抛」包裹形状两处（位置按规则 3 必须分落在两条提交路径，3 行抽取反增间接）；`submissionState` 字符串字面量（schema 为 String 列，Prisma enum 化须 DB 迁移，两取值收益不成比例）；`reactivateBestEffort` 命名（调用处注释已点明创建语义）。审查轴声称的 poll 预算 off-by-one（每会话 121 次）经复算不成立：poll 先执行、`attempt = asyncPollAttempts + 1` 后判 `>= maxAttempts`，每会话恰 `maxAttempts` 次。
