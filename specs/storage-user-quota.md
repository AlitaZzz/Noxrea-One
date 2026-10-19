# Per-User 存储配额（Storage User Quota）

状态：已确认（2026-10-19，用户「全按推荐（必须符合行业内成熟方案）」确认全部待确认事项；「已实现」待全部验收标准通过且实现提交后设置）
上游 Spec：[storage-s3-backend.md](storage-s3-backend.md)（已实现）——本 Spec 补齐其非目标中点名的「per-user 存储配额与计费」之配额半边；计费/计划层仍为后续。

## 已确认决策（2026-10-19，用户「全按推荐（必须符合行业内成熟方案）」逐条确认）

1. **计量口径**：仅主对象行实占——用量为 `file_objects` 按用户 `SUM(size)` 聚合（不落库），派生产物与 staging 不计。
2. **默认值语义**：`storage.quota.default_mb`（int MB）默认 `0` = 不限量，生产按需设值启用。
3. **可见性**：扩展 `/api/auth/me`——GET 与 PUT 为同一资源的两份表示，**两处理器均组合** storage 摘要，响应增 `storage: { usedBytes, quotaBytes }`；`quotaBytes: number | null`，`null` = 不限量；配置键哨兵 `0` 不出配置域，由 API 序列化单点转译为 `null`（对齐 Google Drive `storageQuota.limit` 缺席即不限量的契约惯例）。
4. **超限语义**：409 Conflict + `upload.quota_exceeded`（上传通道）/ `generate.quota_exceeded`（生成任务提交）/ `media.quota_exceeded`（媒体编辑提交），同族并列、前端映射同一提示，响应携带用量上下文。（错误码命名经实现期核对按仓库错误族事实订正：同步 SSE 族为 `generation.*`，生成任务同步接口族为 `generate.*`，媒体编辑族为 `media.*`——见当前状态实现期记录。）
5. **per-user 覆盖**：仅预留 `users.quota_bytes BIGINT NULL` 级联形状（`COALESCE(user, global)`），本期不实现、零迁移。

## 目标

为多用户公网部署补上存储占用的运营底座：每用户可占用存储有上限，超限拒绝**增量写入**、不影响既有内容读取，防止开放注册后单个用户无限灌盘导致存储成本失控。机制与项目现状（内容寻址、per-user 对象行、引用 GC）直接衔接，不引入独立计量系统。

## 背景与现状（已验证事实）

- `file_objects` 行为 per-`(userId, hash)`，携带 `size`（BigInt），PK 前导列为 `user_id`——按用户聚合 `SUM(size)` 可走 PK 前缀，无需新索引。内容 key 由 `buildStorageKey` 构造为 `${userId}/${hash2}/${hash}${ext}`（service.ts:88-95），物理对象按用户隔离——行计量即物理计量，无跨用户去重分摊歧义。
- 全部落库收敛于 `persistFileObject` 单点（中转上传、直传 complete、AI 结果下载三条路径共用）；派生产物（`_cache/_posters/_sprite/_proxy`）与 staging 对象**不在** `file_objects` 中——按行聚合天然不计派生与 staging。
- 秒传为 per-user 行级判定（`userId_hash` 查得即幂等返回），跨用户不共享行——每个新行都是净增占用，计量不存在跨用户分摊问题。
- 引用删除 → GC 回收 → 行删除：用量随聚合**自愈回落**，无需任何释放扣账逻辑。
- 设置注册表（system-settings-db）已有 `int` 助手（纯数字文本 + 范围校验）；`upload.max_file_mb`（单文件限额）已存在且与本 Spec 正交。
- 管理端设置 UI / 写接口为后续阶段（storage-s3-backend 非目标）——本期全局默认值按既有节奏改库 + 重启生效。

## 范围

1. 计量口径与用量推导（DB 聚合，不落计数器）。
2. 配额值承载：`system_settings` 新键 `storage.quota.default_mb`（全局默认，0 = 不限量）；per-user 覆盖列仅预留形状不实现。
3. 写入执行点：直传双点（ticket 预检 + complete 真实字节复检）、中转逐文件去重感知预检（哈希算出后携带 dedupeHash）、AI/派生编辑结果二元门槛 + 落库计入；秒传/幂等不预检。
4. 超限语义与并发立场。
5. 用户侧可见性：`/api/auth/me`（GET/PUT）响应扩展用量字段。

## 非目标

- 计费、计划层（free/pro）、订阅体系——上游 Spec 点名的「计费」半边另行 Spec。
- per-user 配额覆盖的管理端 UI / 写接口（管理端为后续阶段；本期如需个别调整走改库）。
- 派生产物 / staging 的体积治理新机制（已有 TTL 清扫与删除联动；计量口径见已确认决策 1）。
- 跨用户内容去重的共享计量（按行计量，见规则 1）。

## 业务规则

1. **计量口径（已确认决策 1）**：用量 = `SELECT COALESCE(SUM(size),0) FROM file_objects WHERE user_id = ?`——主对象行实占，每用户为自己的引用付费；派生产物与 staging 不计（派生可再生、体积由 TTL/联动机制治理；staging 在途短命）。用量**不落库**：单一事实来源是 `file_objects`，杜绝计数器漂移；GC 宽限期内行未删、对象在桶，计入用量（语义自洽）。
2. **配额值承载（已确认决策 2）**：新设置键 `storage.quota.default_mb`（int MB，默认 `0` = 不限量）——默认不限量保证功能上线对现有用户零影响，生产按需设值；`0` 是一等语义而非缺省漏配；MB 与同族 `upload.max_file_mb` 同口径，读取时换算为字节参与比较（配置单位与契约单位分离）。per-user 覆盖列（`users.quota_bytes BIGINT NULL`，NULL = 跟随全局，级联 `COALESCE(user, global)`）**仅在本 Spec 预留形状**，实现与写入口随管理端阶段交付。
3. **执行点（大小已知的通道预检，未知通道二元门槛 + 落库计入）**：
   - **直传（双点执行，与单文件限额 `max_file_mb` 同构）**：ticket 在签发预签名前以申报 size 预检（快速路径：超限即拒绝，staging 票据不产生、预签名不签发，省用户上传带宽）；complete 在提升前以 staging 真实字节数（`stat.size`，与拉流复验同源）**权威复检**，超限拒绝并清走 staging——申报值仅用于提前拒绝，真实字节数是唯一执行依据，客户端失真申报无法绕过；复检点与既有 `upload.max_file_mb` 的 complete 真实 size 检查（upload-direct.ts:146-150）完全同址扩展；
   - **中转**：批次内逐文件在内容哈希算出后做**去重感知预检**（`processFile` 内 `computeBufferHash` 之后、落盘之前；`findQuotaViolation` 携带 `dedupeHash`——同 hash 既有行即幂等重添加跳过判定，与直传秒传豁免同口径；净增内容按 multipart 解析的 `file.size` 即真实接收字节数判定，单点即权威，无需直传式双点），超限文件失败（错误码 `upload.quota_exceeded`，已确认决策 4；批次以 200 信封逐条返回 itemError，HTTP 409 为直传端点专属语义）、批次其余文件不受牵连（`itemError` 结构性隔离）；批内按 3 路分块并发（`FILE_PROCESS_CONCURRENCY`），跨块顺序推进——先前块的落库增量计入后续块预检，块内并发共享用量快照的竞态由规则 4 容忍立场覆盖；
   - **AI 生成结果 / 派生编辑结果（二元门槛 + 落库计入）**：产出大小不可预知（编辑另存与生成结果同口径，均经 `persistFileObject` 单点落库），无法按大小预检；任务**提交时**做二元判定（同一聚合，无需大小）——**配额已启用（`quota > 0`）且已达或超限（`used ≥ quota`）即拒绝发起新生成**（409 + `generate.quota_exceeded`；媒体编辑提交为 `media.quota_exceeded`，同族并列、前端映射同一提示；关闭「超限用户无上限继续生成」的无界增长向量；行业锚点：Drive 配额满时阻断包括 Docs 创建在内的一切新建）；不限量（配置 `0`）下门槛永不触发。提交时未超限、完成时越过 → 结果照常落库（在途容忍立场一致，单次越过有界），落库后计入后续判定。编辑功能的**输入**上传经中转通道照常预检；同 hash 既有内容走幂等返回，不重复计费；
   - **秒传 / 幂等完成**：查得既有行即返回，不产生新占用，不做预检（用户访问自己已有的内容永远可行）。中转通道经 `dedupeHash` 感知同口径豁免（见上方中转项）。
4. **超限语义与并发立场**：超限只封**增量写入**，既有内容读取 / 派生 / 删除 / GC 全部不受影响；删除与 GC 回收后占用自动回落、无需解锁动作。并发上传的「预检-落库」窗口存在小幅超限可能——**容忍**（配额是运营策略而非记账不变量，行业通行立场；per-user 锁会串行化上传，代价不成比例）；超限幅度有界（在途上传票据 × 单文件上限 + 在途生成结果体积），`storage:audit` 对账天然可见真实用量。
5. **可见性（已确认决策 3）**：me（GET/PUT）响应扩展 `storage: { usedBytes, quotaBytes }`——`quotaBytes` 为 `number | null`，`null` = 不限量；配置键 `0` 哨兵仅在配置域，序列化单点转译为 `null`，前端不感知配置哨兵；storage 摘要组合于 me 的 GET 与 PUT 两处理器（同资源表示一致；`toPublicUser` 保持同步、登录/注册响应不扩展），摘要形状单点在 quota.ts（me 响应与 409 上下文同源）；前端仅做展示性消费，无配额管理 UI；可基于 me 的 storage 摘要做上传前软预检（UX 优化，非正确性依赖——服务端 409 为唯一执行权威）。
6. **配额变更生效**：设置重启生效（storage.* 同族口径）；生效即时反映在预检与可见性，存量超限用户不被踢、只封增量。

## 技术影响

- 新增：`server/services/storage/quota.ts`（单点：`getUserUsage`（prisma aggregate）、`getQuotaBytes`（读 `storage.quota.default_mb` + MB→字节换算；级联抽象待覆盖列阶段引入，不为未来形态预支接口）、`findQuotaViolation`（大小已知通道判定，返回超限上下文或 null）、`findQuotaGateViolation`（大小未知通道二元门槛判定）、`getStorageSummary`（me 响应 storage 摘要组合））。判定与上下文构造单点在 quota.ts，错误**包装**由各通道原生完成（UploadDirectError / itemError / failCode）——assert* 抛通道专属错误会引入反向依赖，判定/包装分离保持依赖方向干净（实现期命名订正，见当前状态）。
- 修改：`core/settings/registry.ts`（+`storage.quota.default_mb`）；`upload-direct.ts`（ticket 预检 + complete 真实字节复检，与 `max_file_mb` 同址双点）；中转去重感知预检点（upload.ts `processFile`，`computeBufferHash` 之后、落盘之前）；生成 / 编辑任务提交点（二元门槛）；`/api/auth/me` 的 GET/PUT 两处理器组合 storage 摘要（`toPublicUser` 保持同步，登录/注册响应不扩展）；错误码双端落点：`core/errors/codes` 联合 + 前端 i18n（zh-CN/en-US；+`upload.quota_exceeded` / `generate.quota_exceeded` / `media.quota_exceeded`，前端三码映射同一提示）。
- 数据库：**零迁移**（用量聚合推导、覆盖列不实现）。
- 前端：me 数据类型扩展 + 配额展示（最小消费，无新页面）。
- 测试：quota 单点（聚合口径 / 0=不限量 / 边界相等放行）；ticket 超限拒绝且无 staging 产物；complete 真实字节复检（含申报失真绕票用例）；中转批次超限文件隔离；秒传不重计；生成/编辑提交二元门槛（超限拒发、未超限在途完成落库）与结果计入；me 字段契约（GET/PUT 表示一致）。

## 异常与边界

- **聚合与真实桶占用**：`file_objects` 行聚合 ≠ bucket 物理占用（派生 / staging / 崩溃残留不计）——口径即为「逻辑主对象占用」；物理对账由 `storage:audit` 承担，两者职责分离。
- **DB 不可用**：预检依赖聚合查询，DB 故障时上传链路本身不可用（persist 也要 DB）——无额外降级路径，不静默放行。
- **BigInt 边界**：size 为 BigInt 列、聚合结果转 Number 需防越界——比较在 Number 域内完成；`default_mb` 为 MB 值，换算后字节值须落在 Number 安全域（`default_mb ≤ MAX_SAFE_INTEGER / 1024²` = 8589934591 ≈ 8.6×10⁹ MB，运营上不可触及），registry 注册时以此设上限。
- **超限用户体验**：错误响应携带 `{ usedBytes, quotaBytes }` 上下文（与 me 字段同源，前端可准确提示）；超限路径配额必然已设置，此上下文中 `quotaBytes` 恒为数值，无 `null` 分支。
- **在途预签名票据**：预检通过后签发的预签名 PUT 在其 TTL 内有效且无法撤销（S3 预签名固有属性，业界无撤销机制）——配额收紧或并发下，已签发票据的 complete 可能进一步推高占用；未完成票据由 staging 超龄清扫兜底回收。在途生成/编辑任务同理：提交时未超限、完成落库时越过（结果体积不受 `max_file_mb` 约束，由模型输出特性界定）。与规则 4 的容忍立场一致，超限幅度有界（在途票据 × 单文件上限 + 在途生成结果体积）。
- **不踢存量**：配额收紧后已超限用户仅无法新增，不触发自动删除（删除永远由引用 GC 驱动）。

## 验收标准

1. 直传双点：ticket 超限（申报 size）返回超限错误（携带用量上下文），无 staging 对象、无预签名 URL；申报失真但 staging 真实字节数超限时 complete 拒绝且 staging 清走；限额内正常。
2. 中转批次：超限文件失败且错误码正确，同批其余文件正常落库。
3. 秒传 / 幂等完成不重复计费、不做预检（用户既有内容永远可访问）。
4. 用量聚合：上传 / 删除 / GC 回收后 `SUM(size)` 语义正确（含 BigInt 大值用例）。
5. `storage.quota.default_mb=0` 回归：现有全部测试绿（默认不限量零影响）。
6. `GET` 与 `PUT /api/auth/me` 表示一致，均返回 `storage.usedBytes/quotaBytes`，与预检同源同值；不限量（配置 `0`）序列化为 `quotaBytes: null`。
7. 生成/编辑任务提交二元门槛：配额已启用且已达/超限的用户被拒（`generate.quota_exceeded`；媒体编辑提交为 `media.quota_exceeded`）；不限量（配置 `0`）永不触发；未超限提交、完成时越过的结果照常落库；结果计入后续判定。
8. typecheck / lint / 全量测试串行通过。

## 待确认事项（2026-10-19 提请确认；同日用户「全按推荐（必须符合行业内成熟方案）」逐条确认，1–5 对应上方已确认决策）

1. **计量口径**：推荐仅主对象行实占（SUM 聚合、零迁移、自愈回落）；备选计入派生产物估算体积（口径更接近物理占用，但派生无 DB 行，需估算模型或补记账，复杂度显著上升）。〔已确认〕
2. **默认值语义**：推荐 `storage.quota.default_bytes` 默认 `0` = 不限量（功能上线零影响，生产设值启用）；备选默认直接给限量值（如 5 GB，需同时处置现有 dev 数据可能已超限的问题）。〔已确认；键名后经第三轮审核更名 `storage.quota.default_mb`，见待确认补充 1〕
3. **可见性形态**：推荐扩展 `GET /api/users/me`（复用序列化单点、前端一次请求）；备选独立 `GET /api/storage/quota` 端点（职责更窄但多一请求）。〔已确认；端点后经第三轮审核订正为 `/api/auth/me`（GET/PUT），见当前状态第三轮记录〕
4. **超限 HTTP 语义**：推荐 **409 Conflict + 错误码 `upload.quota_exceeded`**——行业现行锚点：Dropbox API v2 对空间不足返回 409 + `insufficient_space` 结构化错误码（v1 的 507 已是遗留用法），Google Drive 用 403 + `storageQuotaExceeded`；409 与本仓上传错误族既有先例（`upload.direct_unavailable`）同码，4xx 不触发客户端 SDK 对 5xx 的自动重试放大。备选 403（Drive 锚点，语义偏向授权拒绝）。已否决：507（Dropbox v1 遗留 + 5xx 自动重试风险）；复用 413（语义为载荷过大，配额是账户状态，与单文件超限混淆）。〔已确认〕
5. **per-user 覆盖**：推荐本 Spec 仅预留 `users.quota_bytes` 级联形状、不实现（写入口依赖管理端阶段）；备选随本期一并实现列 + 改库生效（无 UI，纯手工）。〔已确认〕

## 待确认补充（2026-10-19 第三/四/六轮审核提出；同日用户均按推荐确认）

1. **配置单位**：推荐 `storage.quota.default_bytes` 改为 **`storage.quota.default_mb`**（int MB，`0` = 不限量语义不变）——同族既有先例 `upload.max_file_mb` 即 MB 口径（upload-direct.ts / upload.ts 实读 MB），行业管理面同样以 MB/GB 为人读单位（GitLab 仓库限额 MB、Nextcloud 管理界面 GB）；本期无设置 UI、纯改库运维，13 位字节串手改极易错。API 契约侧 `usedBytes`/`quotaBytes` 维持字节不变（配置单位与契约单位分离，即 `max_file_mb` 同款模式）。备选维持 bytes（无换算，但与同族单位割裂、手改易错）。〔已确认〕

2. **me 资源表示一致性**（2026-10-19 第四轮审核提出）：推荐 storage 摘要同时组合于 **GET 与 PUT `/api/auth/me`**——两者是同一资源的两份表示（PUT 现返回 `toPublicUser(fresh)`，auth.ts:217），GET 独占字段违背同资源表示一致（REST 统一接口），且前端以 PUT 响应整体替换用户状态时会丢失 storage 字段；PUT 频率低（画像/密码修改），多一次聚合查询代价可忽略。备选仅 GET（前端须以合并而非替换语义消费 PUT 响应，契约约束靠约定维持）。〔已确认〕

3. **生成/编辑通道二元门槛 + `getQuotaBytes` 命名**（2026-10-19 第六轮审核提出，用户「不用考虑向后兼容」白纸设计标准）：规则 3 生成/编辑结果条目升级为「提交时二元判定（已达/超限拒发，409 + `generation.quota_exceeded`，与 upload 同族并列、前端映射同一提示）+ 落库计入」——关闭「超限用户无上限继续生成」的无界增长向量（Drive 配额满阻断包括 Docs 创建在内一切新建的锚点）；quota.ts 以 `getQuotaBytes` 命名（YAGNI，级联抽象待覆盖列阶段引入）。〔已确认；错误码命名经实现期核对订正为 `generate.quota_exceeded` / `media.quota_exceeded`，见当前状态实现期记录〕

## 当前状态

已确认（2026-10-19）。全部待确认事项按推荐项确认；方案均为行业成熟形态（SUM 聚合计量不落计数器、`0`=不限量哨兵、准入预检 + complete 权威复检双点、409 + 结构化错误码、按用户物理隔离计量）。调查证据：schema.prisma（FileObject/User 模型）、persist.ts（落库单点）、registry.ts（int 助手）、upload-direct.ts（ticket/complete 落点）；秒传与派生 / staging 的计量边界均经代码核实。未修改任何业务代码；实现须待用户明确放行，提交/推送须用户确认（AGENTS 六.4/十二.4）。

2026-10-19 行业成熟度审核后修订：①超限语义推荐项由 507 改为 409 + `upload.quota_exceeded`（Dropbox API v2 `insufficient_space`=409、Drive `storageQuotaExceeded`=403 锚点；507 为 Dropbox v1 遗留且有 5xx 自动重试风险）；②直传执行点升级为 ticket + complete 双点——complete 以 staging 真实字节数权威复检（与既有 `max_file_mb` 的 complete 检查同址，upload-direct.ts:146-150），关断「失真申报绕过票面预检」向量；③异常与边界补在途预签名票据（不可撤销、最坏幅度有界）；④背景补内容 key 含 userId 段（buildStorageKey，service.ts:88-95）——物理对象按用户隔离，行计量即物理计量。

2026-10-19 第二轮行业成熟度审核（用户逐项决策）：①决策 3 字段形状修订为 `quotaBytes: number | null`（用户按推荐确认）——`null` = 不限量，配置键 `0` 哨兵仅在配置域内由序列化单点转译（Drive `storageQuota.limit` 缺席即不限量锚点）；409 错误上下文中 `quotaBytes` 恒为数值；②执行点通道枚举补全派生编辑（与 AI 结果同口径落库计入）+ 中转批内增量计入性质（对已确认原则的忠实补全，无契约变更）。另核实并修正第一轮锚点表述：Nextcloud 配额为传播维护的缓存根体积 + 数分钟 TTL（维护型聚合），非按请求 SUM——不改变本 Spec 选点：per-user 扁平表 + PK 前缀使「每次精确 SUM」成为无需维护聚合、零漂移的正确选点（行业共同原则：用量可从事实来源推导，存储聚合必须配对账）。

2026-10-19 第三轮行业成熟度审核（代码实证）：①**事实修正**——当前用户端点实为 `GET /api/auth/me`（auth.ts:148，`toPublicUser` 序列化），原 `/api/users/me` 为调查期误记，全文订正；storage 摘要改在 me 路由组合，`toPublicUser` 保持同步（登录/注册响应不扩展），摘要形状单点归 quota.ts（me 响应与 409 上下文同源）。②中转链路实证——`processFile` 入口已有 `max_file_mb` 同址检查、`file.size` 即真实接收字节数（单点即权威，无需双点）；`itemError` 结构性保证逐文件隔离；批内 3 路分块并发语义（`FILE_PROCESS_CONCURRENCY`）补入规则 3：跨块增量计入、块内竞态归容忍立场（修订第二轮的过强表述）。③错误码双端落点实证：`core/errors/codes` 联合 + 前端 i18n（zh-CN/en-US）。④配置单位决策：`default_bytes` → `default_mb`（同族单位先例 + 改库人性化），同日用户按推荐确认，决策 2 / 规则 2 / 验收标准 5 键名随之更新。

2026-10-19 第四轮行业成熟度审核：①精度回写——中转批次错误信封语义（200 信封逐条 itemError，HTTP 409 为直传端点专属）、编辑功能双子流显式化（输入上传经中转照常预检，编辑结果产出落库计入）、前端软预检定位（UX 优化非正确性依赖）；②me 资源表示一致性（待确认补充 2，同日用户按推荐确认）：storage 摘要组合于 GET 与 PUT 两处理器——决策 3 / 规则 5 / 验收标准 6 / 技术影响随之更新。

2026-10-19 第五轮审核（全文件新鲜通读，专查多轮编辑积累的内部不一致）：**无新的行业实践问题**；一致性修订——业务规则标题去「草案」；范围 2/3/5 与最终决策对齐（键名、双点执行、GET/PUT、秒传不预检）；非目标中 stale 指针改指已确认决策 1；BigInt 边界随 `default_mb` 单位更名改写（换算后字节值须在 Number 安全域，`default_mb ≤ MAX_SAFE_INTEGER / 1024²` ≈ 3.3×10⁹ MB，registry 以此设上限）；测试清单补 complete 复检与 GET/PUT 契约用例；待确认事项 1–5 补〔已确认〕标注，其历史文本中的旧键名 / 旧端点加订正指针。

2026-10-19 第六轮审核（按用户「不用考虑向后兼容」指令以白纸设计标准重审）：①规则 3 生成/编辑结果条目升级为**提交时二元门槛 + 落库计入**——关闭「超限用户无上限继续生成」的无界增长向量（Drive 配额满阻断包括 Docs 创建在内一切新建的锚点）；错误码族增 `generation.quota_exceeded`（与 upload 同族并列、前端映射同一提示）；范围 3 / 规则 3 标题 / 技术影响 / 测试 / 验收标准 7 随之更新。②`getEffectiveQuota` 命名按 YAGNI 改为 `getQuotaBytes`，级联抽象推迟到覆盖列阶段（AGENTS 一.4）。③复核确认 restart-only 设置口径、中转 200 信封逐条 itemError、409 同码、并发容忍立场、双点执行均为架构一致性选择而非兼容妥协，维持不变。同日用户按推荐确认 ①②（待确认补充 3）。

2026-10-19 第七轮审核（对第六轮新增内容的对抗复查）：①**门槛守卫修正**——二元判定补「配额已启用（`quota > 0`）」前提：原表述「已达或超限即拒绝」在默认不限量（`0`）下条件恒真、将阻断全部生成，属第六轮引入的逻辑缺陷、与决策 2 意图相悖，即行修正（规则 3 / 验收标准 7）；②容忍幅度表述随生成门槛扩展——在途生成结果体积不受 `max_file_mb` 约束（由模型输出特性界定），超限有界表述改为「在途票据 × 单文件上限 + 在途生成结果体积」（规则 4 / 异常与边界）。均为同日确认意图的忠实修正，无新决策事项。

2026-10-19 用户放行实现（「放行，按 spec 开始实现，以根因并符合行业标准的方式来实施。不用考虑向后兼容」）。实现期三项事实性订正：①**错误码命名空间**——spec 原记 `generation.quota_exceeded`，经 codes.ts 错误族核对订正为 `generate.quota_exceeded`（生成任务同步接口族，与 generate.task_not_found 等同族）+ `media.quota_exceeded`（媒体编辑族，与 media.user_busy 等同族）：`generation.*` 实为同步 SSE 推送族，原命名混淆了两者；决策 4 / 规则 3 / 技术影响 / 验收标准 7 / 待确认补充 3 随之更新，前端三码映射同一提示。②**BigInt 边界算术修正**——`MAX_SAFE_INTEGER / 1024²` = 8589934591 ≈ 8.6×10⁹ MB，原「≈ 3.3×10⁹ MB」为计算错误；值不影响结论（运营上不可触及）。③**quota.ts 判定接口命名**——以 `findQuotaViolation` / `findQuotaGateViolation` / `getStorageSummary` 落地（find* 返回超限上下文或 null，错误包装由各通道原生完成：UploadDirectError / itemError / failCode），替代 spec 原拟 assert* 命名；assert* 抛通道专属错误会引入反向依赖，判定/包装分离保持依赖方向干净（技术影响已更新）。服务端执行点（quota.ts / registry / codes / upload-direct / upload / generate / media-edit / auth）与前端（MeResponse 契约、store 会话内存 storage 切片 + refreshStorage、设置弹窗展示、三码 i18n）均已实现；测试与串行验证进行中，状态保持「已确认」。

2026-10-19 代码审查（code-review 双轴：Standards + Spec）后处置：①auth.ts GET/PUT 的 me 表示组合收敛为 `meRepresentation` 单点——「同资源表示一致」（规则 5）由结构保证替代两处理器各自书写，无契约变化；②前端 `MeResponse.storage` 由可选收紧为必有（服务端两处理器恒组合；无需向后兼容，契约如实反映服务端行为）；③savePreference 中重复的第二处死代码 `assertCurrent` 删除（保留 await 后首处合法调用；删除对象为本变更集自身引入的缺陷，净效果与 HEAD 一致，diff 不显示增删行）；④验收标准 4 补 BigInt 大值用例（`MAX_SAFE_INTEGER` 量级精确换算 + registry 上限 8589934591 MB 处边界相等放行）。**「结果计入 / 未超限在途完成落库」处置**：该不变量由 persist 落库单点 + SUM 聚合单点组合保证（persist.test / finalize.test / quota.test 各有既有用例），独立端到端用例无新增可检缺陷向量——测试清单「与结果计入」以组合口径视为满足，不设独立端到端（行业标准为按单点测试组合不变量，而非为结构性保证重复搭建端到端骨架）。其余 standards 轴判断题（quota.ts 两 find* 形状、i18n 三码同文案、`formatBytes(...) || "0 B"` 调用点补偿、refreshStorage 空 catch）逐条有 spec/结构依据，评估后维持现状。

2026-10-19 第三轮代码审查处置（同日用户维持既定指令：根因修复、行业成熟方案、无需向后兼容、可按成熟度修订 spec）：①**拒绝路径 staging 清理收敛**——complete 直传的 413 单文件限额与 409 配额两拒绝路径统一改用既有 `cleanupStaging` 助手（裸 delete 失败会异常冒泡、把 409/413 掩盖为 500；拒绝路径的清理是收尾而非正确性步骤，失败留痕、超龄清扫兜底；预存的 file_too_large 分支同款问题一并根因修复），补「清理失败不掩盖 409」回归用例；②**中转通道预检升级为去重感知**——原受理点预检把「重复添加既有内容」误计为净增占用（超限用户经中转重复添加自己已有内容会被拒，而直传秒传豁免——同一规则在两通道不一态，且与 SUM 计量口径自相矛盾：重复添加不改变 SUM 却被拒绝）；`findQuotaViolation` 增 `dedupeHash` 可选参（命中既有行跳过判定、不触聚合查询），中转在 `computeBufferHash` 后携带，与直传秒传豁免同口径（规则 3 中转条 / 末条、写入执行点 3、技术影响随之更新）；中转配额判定随迁入 try 块，其 DB 故障由 itemError(upload_failed) 逐文件隔离，批次语义与既有错误映射一致；③`me`/`updateMe` 未被调用方使用的泛型默认参数内联为具体返回类型（Speculative Generality 清理，无契约变化）；④审查误报澄清——本轮 spec 轴称「登记 ③ 与 diff 实况不符、删除未落盘」，实为删除对象是本变更集自身引入的重复行，修复后净效果与 HEAD 一致故 diff 不显示增删行；store.ts 现存唯一 `assertCurrent`（await 后首处）为合法调用，登记 ③ 措辞已加防误读说明；⑤refreshStorage 快速关-开弹窗的无序响应竞态为纯展示层（两次 GET 载荷同源、间隔微秒），序列化守卫属投机复杂度，评估后维持现状；⑥测试增补：quota.test 豁免两用例（命中既有行放行且不触聚合 / 未命中正常判定）、upload.test 超限用户重复添加既有内容放行用例 + findUnique mock、upload-direct.test 清理失败不掩盖 409 用例。状态保持「已确认」。

2026-10-19 第四轮代码审查处置：两轴零硬违规、spec 轴全部满足无 scope creep。Standards 判断题 4 项处置：①generate/media-edit 两行门槛调用同形——判定逻辑已单点于 `findQuotaGateViolation`，重复的只是通道原生错误包装（spec 明文「错误包装归通道」），抽取即 Middle Man（AGENTS 三.5），维持现状；②refreshStorage 非空静默 catch——同文件 initialize/logout/readCachedUser 三处同款先例（静默 + 注释背书），web 层无日志设施，加 debug 留痕会引入全仓新约定、按 AGENTS 三.3 须同步三处先例，属跨切面决策须用户确认，维持现状；③refreshStorage 无 in-flight 去重——**已根因修复**：复用同文件 initialize 的 `authInitInFlight` 既有模式（AGENTS 三.2），弹窗快速关-开与 StrictMode 双触发 effect 不再双发 /me（此前 StrictMode 下每次打开弹窗即双发），会话变化时随 authInitInFlight 一并解除在途引用；此为对上轮 ⑤ 无序响应竞态处置的深化——非序列化守卫，而是复用既有去重模式使重复触发共享同一请求；store.test 补并发共享单次拉取与失败保留现值两用例；④StorageSummary server/web 双写——仓库无 web↔server 契约类型层（shared/ 仅工具函数），为 2 字段接口引入契约层属过度设计（AGENTS 一.4），维持现状。验证：typecheck ✓ / lint 0 错误 ✓ / web 930 用例（+2）仅已知 flaky 集满载抖动、隔离 22/22 全绿 ✓（server 侧本轮无变更，沿用上轮 874/874 结果）。状态保持「已确认」。

2026-10-19 第五轮代码审查处置：两轴零硬违规，spec 轴确认五轮登记与代码实况逐条相符、无缺失无 scope creep。判断题 3 项均维持现状：①generate/media-edit 门槛两行同形——复核无新据，维持前轮裁定；②store.ts `me?.storage` 可选链（refreshStorage/savePreference）——`me` 为 `MeResponse | null`（空响应体返回 null 属契约内），`?.` 即 null 判定本体，同时防止契约违例载荷把 undefined 写入 `storage: StorageSummary | null` 不变量，收窄为 `if (me)` 反引入运行时退化向量，非 Speculative Generality；③两通道门槛在处理器内位置不对称（media-edit 与限流同块内聚、generate 于 createTask 前）——均为提交时判定，语义等价，代理自评可辩护。本轮零代码变更，验证结果沿用第四轮（typecheck / lint / server 874/874 / web 930 隔离全绿）。状态保持「已确认」。

2026-10-19 第六轮代码审查处置（新鲜视角深挖轮）：两轴零硬违规、零新判断题、(a)(b)(c) 三类 spec 发现均为空。新挖掘面均构成反证：①complete 复检未携带 dedupeHash 之疑——既有幂等完成检查先于配额复检返回，结构上已豁免，无口径缺口；②persistFileObject 全仓写入路径穷举（中转/直传 complete/编辑另存/AI 结果四处）与 SUM 口径自洽，无漏网增量写入；③i18n 三码两键逐键核对无多余无缺失；④registry 逐字段核对（默认值/上限/重启语义）与 spec 一致；⑤极端值与测试清单映射逐条真实。两条非偏差备注：media-edit 409 未断言 ctx（与 generate 共享 findQuotaGateViolation 单点、后者已断言）；验收标准 4「删除/GC 后用量回落」无独立用例——SUM 每请求现算无计数器，属结构性保证（与第二轮「结果计入」组合口径处置同类）。本轮零代码变更，验证沿用第四轮结果。审查连续三轮零硬违规、零实质发现，判定收敛。状态保持「已确认」。
