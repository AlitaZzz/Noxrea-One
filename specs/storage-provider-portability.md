# S3 兼容提供方可移植性（Storage Provider Portability）

状态：已确认（2026-10-26 起草，同日用户确认方案；实现已提交 `023f6489`，OSS/COS 真实桶验证待执行）

上游与关联：

- [storage-s3-backend.md](storage-s3-backend.md)（已实现）：后端接口、双凭据、上传直传、迁移、GC、bucket CORS 清单。
- [storage-signed-direct-delivery.md](storage-signed-direct-delivery.md)（已确认，2026-10-26 修订）：浏览器读路径依赖 `presignGet` 的 `response-*` 覆盖能力；本 Spec 为其提供能力探测与降级。
- [storage-s3-production-cutover.md](storage-s3-production-cutover.md)（已确认）：生产部署演练。
- [observability-baseline.md](observability-baseline.md)（已确认）：探测摘要进入健康检查与指标。
- 参考实现（只读调查，2026-10-26）：`H:\infinite-canvas\open-ai-canvas-main` 的 `backend/internal/storage/s3.go`（按端点形态决定寻址风格、path-style 自动探测）。

## 目标

1. **同一套后端代码服务多家 S3 兼容实现**（MinIO、AWS S3、Cloudflare R2、阿里云 OSS、腾讯云 COS、其他兼容网关），业务代码不出现按厂商分叉的分支。
2. **厂商差异只表达一次**：在装配层（provider profile + 启动探测）收敛为能力位，此后由能力位驱动行为。
3. **配置错误在启动期暴露**，不在用户打开画布时才裂图。
4. **复用成熟实现**：继续用 `@aws-sdk/client-s3` + SigV4 预签名，不引入自研对象存储客户端，也不引入各厂商原生 SDK。

## 范围

1. 新增设置键 `storage.s3.provider`（`minio | aws | r2 | oss | cos | generic`），由它决定寻址风格基线与已知能力基线。
2. 删除设置键 `storage.s3.path_style`：寻址风格由 profile 决定（已知 profile 固定，`generic` 启动探测），不再暴露一个「配错就整条链路不可用」的独立开关。
3. S3 客户端校验和策略固定为 `WHEN_REQUIRED`（请求与响应两向）。
4. 启动探测从 HeadBucket 扩展为六项（连通、写、读、预签名回读、覆盖头、时钟/跨域），失败语义与探测结果口径固定。
5. `presignGet` 的 `response-*` 覆盖按能力位使用；不支持时的降级路径明确（下载改走 `stream`）。
6. 契约测试：现有存储后端测试矩阵在 MinIO 容器上跑；另提供针对真实凭据的手工一致性检查脚本。
7. 文档：README 增设「厂商 → profile → 端点/寻址/权限/已知限制」对照表。

## 非目标

- Azure Blob、Google Cloud Storage 原生协议（不兼容 S3；要支持须另立后端实现，本 Spec 不预留抽象）。
- CDN、边缘缓存、独立资产域名（另立 Spec）。
- 厂商原生 SDK 接入（OSS/COS 均支持 SigV4 预签名；改成原生 SDK 会变成两套签名、两套 URL、两套错误模型，收益低于成本）。
- bucket 侧治理：生命周期、版本控制、对象锁、跨区域复制、存储类型转换。
- 分片上传的分片大小与并行度调优（沿用 SDK 默认；实测不足时另立）。
- OSS 原生能力（`x-oss-process` 图片处理、样式、归档类型）。
- 多 provider 同时在线（一个进程仍只服务一个 bucket；跨 bucket 由部署形态决定）。

## 背景与现状（已验证事实）

- 装配：`server/services/storage/service.ts` 按 `storage.backend` 构建设置驱动的进程级单例；S3 后端读取 `storage.s3.endpoint` / `bucket` / `region` / `access_key_id` / `secret_access_key` / `path_style` / `prefix`（[registry.ts:225-235](../server/core/settings/registry.ts)）。
- 启动探测只有 `HeadBucket`（[s3.ts:299-309](../server/services/storage/backends/s3.ts)）：只证明端点与凭据可用，**不证明**写权限、预签名 URL 浏览器可用、`response-*` 覆盖被遵守、时钟偏差在 SigV4 容差内。
- `storage.s3.path_style` 目前是布尔开关、缺省 `true`（MinIO 友好）。该缺省对 OSS/COS（仅虚拟主机寻址）直接错误，对 R2/自建端点可能两种皆可；配错时表现为启动 HeadBucket 失败或运行期 403/404，错误信息里没有「寻址风格」线索。
- AWS SDK JS v3 自 3.729 起把 flexible checksums 的缺省从 `WHEN_REQUIRED` 改为 `WHEN_SUPPORTED`；本仓库安装 3.1152，已核实 `node_modules/@aws-sdk/checksums` 中 `DEFAULT_REQUEST_CHECKSUM_CALCULATION = "WHEN_SUPPORTED"`，即 PutObject/CopyObject 会附加 `x-amz-checksum-crc32` 与 `x-amz-sdk-checksum-algorithm`。MinIO 与部分兼容实现对这类参数不容忍。
- `S3Client` 配置类型在本版本已包含 `requestChecksumCalculation` / `responseChecksumValidation`（`@aws-sdk/client-s3` 的 `runtimeConfig.d.ts`），可直接在构造时固定。
- 对象身份一律是本地 `sha256`（[hash.ts](../server/services/storage/hash.ts)），不依赖 ETag。
- 迁移校验已按「ETag 语义因厂商而异」做了降级矩阵（[migration.ts](../server/services/storage/migration.ts) 规则 11：`etag-md5` → `readback-sha256` → `sha256-key` → `size`）；该知识目前只存在于迁移模块内。
- 厂商能力（官方文档核实，2026-10-26）：
  - 阿里云 OSS 的 S3 兼容接口：**只支持虚拟主机寻址**，不支持 path-style；预签名使用 `AWS4-HMAC-SHA256`（Host 参与签名，支持 `x-amz-security-token`）；ACL 仅部分支持；对象级 ACL/桶 ACL 语义与 AWS 不同。
  - 腾讯云 COS 的 S3 兼容接口：2024-01-01 之后创建的桶强制虚拟主机寻址。
  - Cloudflare R2：两种寻址均支持，无对象 ACL，ETag 语义与 AWS 不同。
  - MinIO：path-style 与虚拟主机皆可，自建部署通常只有 path-style 可用（无通配 DNS/证书）。
- 预签名 URL 的**浏览器可用性**还依赖 bucket CORS（见 [storage-s3-backend.md](storage-s3-backend.md)「Bucket 初始化清单」）；CORS 缺失时的表现是浏览器侧失败，服务端探测不到，除非主动发预检。

## 规则

### 1. Provider profile

1.1 新增设置键 `storage.s3.provider`，枚举 `minio | aws | r2 | oss | cos | generic`，缺省 `generic`。

1.2 profile 只决定三件事：寻址风格基线、已知能力基线、启动探测要额外验证的项。**业务代码不得读取 profile**（只读能力位）。

1.3 寻址风格表：

| provider | 寻址风格 | 依据 |
| --- | --- | --- |
| `minio` | path-style | 自建端点通常无通配 DNS/证书 |
| `aws` | virtual-hosted | 官方推荐形态 |
| `r2` | virtual-hosted | 两种皆可，取推荐形态 |
| `oss` | virtual-hosted | OSS S3 兼容不支持 path-style |
| `cos` | virtual-hosted | 2024-01-01 后新建桶强制 |
| `generic` | 启动探测决定 | 先 virtual-hosted；只要 `HeadBucket` 报错（连接/DNS/TLS/403/404 等）就改试 path-style |

1.4 寻址风格一律通过 `forcePathStyle` **显式设置**，不依赖 SDK 对自定义端点的推断；单测断言生成 URL 的形态（virtual-hosted = `https://<bucket>.<host>/<key>`，path-style = `https://<host>/<bucket>/<key>`）。

1.5 删除 `storage.s3.path_style`。旧行留在设置表中不读取、不迁移（用户已明确不需要向后兼容）；原先手工设为 `path_style=false` 的部署在缺省 `generic` 下会经探测得到 virtual-hosted，行为不变。

1.6 `generic` 的探测结论（寻址风格）写入能力位并在启动日志输出一次。寻址回退**只以 `HeadBucket` 失败为触发条件**：连通性确认后（寻址正确、端点可达、桶存在），写入/回读/预签名/覆盖头失败属于权限或配置问题，直接启动失败，不再改试另一种寻址——换寻址不会修复权限，只会把真实原因埋进第二个错误里（`s3.ts:505-520`）。两种寻址的 `HeadBucket` 都失败即启动失败，错误信息必须包含**两种寻址各自尝试的 URL 形态与 HTTP 状态**，否则故障现场无法定位。

### 2. 校验和

2.1 S3 客户端固定 `requestChecksumCalculation: "WHEN_REQUIRED"` 与 `responseChecksumValidation: "WHEN_REQUIRED"`，**不按 provider 分叉**。

2.2 理由：缺省 `WHEN_SUPPORTED` 会给 PutObject/CopyObject 附加厂商不一定实现的 checksum 头（以及流式上传的 trailer），失败形态是 400/签名不一致，错误信息与「校验和」无关；而本项目从不消费 SDK 的完整性校验结果（对象身份由本地 sha256 决定，迁移校验有自己的降级矩阵）。

2.3 若某 provider 明确要求校验和才接受上传，在该 provider 的能力位里显式加参数，不改全局缺省。

2.4 上传直传（浏览器直接 PUT 预签名 URL）不经过 SDK：签名参数集必须被测试固定断言——**不得出现 `x-amz-checksum-*` 或 `x-amz-sdk-checksum-algorithm`**，否则浏览器不会计算校验和，签名与实际请求不一致。

### 3. 启动探测（capability probe）

3.1 探测顺序固定，任一致命项失败即启动失败：`HeadBucket` → 小对象写入 → 回读字节一致 → `stat` → 预签名 GET 回读 → 覆盖头验证 → 删除对象。

3.2 探测对象路径 `_probe/<uuid>.txt`（1KB）。探测结束尽力删除；删除失败只记 warning（该命名空间不在可读键域内，不会出现在 UI、引用账本或派生逻辑里）。残留由存储 GC 的独立按龄清扫兜底：`_probe/` 前缀、固定 24 小时、与其余清扫同受 `storage.gc_dry_run` 约束、独立成败（`GcCycleResult.probeSwept` / `probeSweepError`，CLI 退出码可见）。它不在派生四根内，也不并入 `DERIVED_ROOT_PREFIXES`（迁移/审计分类不得把探测对象当派生产物）。

3.3 预签名回读：用与业务同一套签址实现（`S3Backend.presignGet` 背后的 `signGet`，**不带** `response-*`）签探测对象，服务端以**无凭据** HTTP GET 取回，断言 200、字节一致、`Content-Type` 为预期值。这一项同时验证：签名参数正确、时钟在 SigV4 容差内、端点对预签名 GET 放行。

  不带覆盖头是刻意的：`Content-Type` 断言的对象是 PutObject 写入的对象元数据；带上 `ResponseContentType` 时端点回显的正是覆盖值，断言会退化成同义反复。覆盖头是否生效由 3.4 单独验证——两项职责不重叠。

3.4 覆盖头探测：再签一次，带 `response-content-disposition` 与 `response-cache-control`，断言响应确实携带这两个头（值可含编码差异，按包含关系判定）。任一未被遵守 → 能力位 `responseOverrides = false`。探测请求本身在传输层失败（网络中断、带覆盖参数的签名 GET 无法完成）时同样按 `responseOverrides = false` 降级并记 warning，不升级为启动失败：该位只决定下载形态（规则 4.2），应用流是完整降级路径；连通性与凭据已由前置致命项验证。

3.5 跨域探测：对探测对象发带 `Origin` 与 `Access-Control-Request-Method: GET` 的 `OPTIONS` 预检，读取 `Access-Control-Allow-Origin`；同时检查 GET 响应是否带该头与 `Access-Control-Expose-Headers`。结果写入能力位 `browserCors`，**只警告不失败**：CORS 策略通常在云控制台人工修改，硬失败会让整个应用（含不需要浏览器直连的接口）不可用，而该缺陷只影响浏览器读图，且可切 `local` 后端规避。s3 模式的部署验收要求该位为 `true`（见验收标准）。

  探测的 `Origin` **必须是部署自己的浏览器来源**（`network.public_base_url` 的 scheme+host），判定按 CORS 的回显语义：端点回 `*` 或回显该来源即放行。CORS 是「按来源白名单放行」的机制，拿一个编造的探测专用域名去问，合规配置（`AllowedOrigins` = 生产域名，见 README）必然回「未放行」——能力位会恒假，而它恰恰是部署验收要求为真的那位。未配置公开地址时退回固定探测源，此时只有通配放行能通过，探测必须就此输出 warning 说明判定口径。

3.5.1 预签名回读（3.3）是探测**致命项**：不通过即启动失败，因此进入服务态的进程该位恒为真。它不设为能力位——恒真且无人分支的位只会让人以为存在降级路径（规则 4.1）。

3.6 时钟：用探测响应（`HeadBucket` 或回读）的 `Date` 头与本地时间比较。`|偏差| > 5 分钟` 即启动失败并输出双向偏差（SigV4 容差 15 分钟，留 3 倍余量；多实例预签名时钟漂移的故障形态是「URL 时好时坏」，没有明确错误可用）；`60s < |偏差| ≤ 5min` 记 warning。

3.7 探测结果（provider、寻址风格、能力位、时钟偏差、CORS 结果）在启动结束时以**一条**结构化日志输出，并写入指标 `storage_probe_ok{addressing, response_overrides, browser_cors}` 与 `storage_probe_clock_skew_seconds`（见 [observability-baseline.md](observability-baseline.md) 3.4）。健康检查只报告**布尔就绪位**（`checks.storage`：探测是否成功产出摘要），不携带能力位明细——`/api/health/ready` 的响应面向编排探针，`checks` 只含布尔与数值（observability 规则 1.3）。能力位明细的消费方是启动日志与 `/metrics`。

3.8 能力位是进程级不可变量：不做运行期重新探测，参数变更重启生效（与现有「不支持热切换」一致）。

### 4. 能力位与降级

4.1 能力位包含：`addressing: "path" | "virtual"`、`responseOverrides: boolean`、`browserCors: boolean`。只收「可能为假、且为假时改变行为」的位——预签名回读是探测致命项（3.5.1），不设为能力位。

4.2 `response-*` 覆盖只在 `responseOverrides = true` 时使用。为 `false` 时：

- `ResponseContentType` 不再使用（对象自身的 `Content-Type` 在 PutObject 时已写入，展示不需要覆盖）；
- 需要自定义附件名的下载改为 `stream` 形态（`Content-Disposition` 由应用响应头保证，见 [storage-signed-direct-delivery.md](storage-signed-direct-delivery.md) 规则 2.3/3.7）。

4.3 描述接口的 `delivery` 因此由「后端类型 + 能力位」决定，前端仍只感知 `signed | stream` 两种形态，不感知原因。

4.4 禁止在业务代码里按 provider 名分叉；任何新的厂商差异必须先成为能力位（否则就是把配置知识漏进业务层）。

### 5. ETag 与对象身份

5.1 ETag 只用于迁移校验，且必须走既有降级矩阵（[migration.ts](../server/services/storage/migration.ts)）。

5.2 任何以对象内容为身份的场景使用本地 `sha256`，禁止用 ETag：单次 PUT 的 `ETag == MD5` 只在部分实现成立，分片上传的 ETag 形态因厂商而异。

### 6. 契约测试

6.1 现有存储后端测试矩阵在 MinIO 容器上执行（integration；环境变量缺失时跳过，与现有 Redis 集成测试同口径）。

6.2 新增「provider 一致性」手工脚本：给定真实凭据，依次执行探测六项 + 上传/回读/预签名/覆盖头/删除，逐项输出结果。用于 OSS/COS/R2 接入前验证，也用于厂商升级后的回归。

6.3 单测：寻址表（六个 profile + `generic` 探测顺序）、校验和配置固定、预签名 PUT 参数集断言、`responseOverrides = false` 时 `presignGet` 不带覆盖参数且下载降级为 `stream`。

### 7. 文档

7.1 README 设置表：删除 `storage.s3.path_style`，新增 `storage.s3.provider`。

7.2 README 增加厂商对照表：端点形态、寻址风格、region 取值、所需权限（`HeadBucket` / `PutObject` / `GetObject` / `DeleteObject`）、已知限制。

7.3 OSS/COS 章节明确「只使用 S3 兼容子集」，逐条列出不可用能力（原生 ACL 语义、`x-oss-process`、bucket 版本控制等）。

## 技术影响

### 服务端

- [server/core/settings/registry.ts](../server/core/settings/registry.ts)：新增 `storage.s3.provider`（enum），删除 `storage.s3.path_style`。
- 新增 `server/services/storage/providers.ts`：profile → 寻址风格 + 探测项 + 能力基线的唯一来源。
- [server/services/storage/backends/s3.ts](../server/services/storage/backends/s3.ts)：构造 `S3Client` 时固定校验和策略与 `forcePathStyle`；`probe()` 由 `void` 改为返回能力摘要；`presignGet` 按能力位决定是否带 `response-*`。
- [server/services/storage/backend.ts](../server/services/storage/backend.ts)：`probe` 契约由「成功/抛错」扩展为「成功/抛错 + 能力摘要」。
- [server/services/storage/service.ts](../server/services/storage/service.ts)：装配时读 profile，持有探测结果，向 HTTP 层暴露只读摘要。
- [server/core/bootstrap.ts](../server/core/bootstrap.ts)：输出探测摘要日志；启动失败信息包含两种寻址的尝试结果。
- [server/http/app.ts](../server/http/app.ts)：健康检查附带能力摘要。

### 前端

- 无变化：仍只消费 `signed | stream` 两种描述。

### 数据与持久化

- 无数据库结构变更；设置表新增一个键、停止读取一个已存键（旧行保留在表中无副作用）。

### 部署

- MinIO（含现有 NAS 演练桶）：`storage.s3.provider` 缺省 `generic` 即可正确落到 path-style；显式设 `minio` 可跳过探测分支。
- OSS/COS：必须设 provider，且 bucket 必须虚拟主机可达（官方端点或自定义域名）；path-style 不作为回退尝试。
- 上传直传的浏览器 CORS 规则不变（见 `storage-s3-backend.md` 清单）。

## 异常与边界

- **HeadBucket 通过但写失败**（只读凭据 / 桶策略限制）：启动失败，错误明确指出「连通与凭据正常，PutObject 被拒」。
- **桶名错误**：HeadBucket 404 → 启动失败，信息含状态码。
- **自建端点用 IP 且无通配证书**：`generic` 先试 virtual-hosted（DNS 失败或证书错误）再退回 path-style；只有 `HeadBucket` 失败会触发回退，`HeadBucket` 通过后的能力探测失败不切换寻址。两者皆失败时两类错误都要出现在启动错误里。
- **预签名回读 403**：签名参数或时钟问题，启动失败（这是「用户打开画布必裂图」的提前暴露点）。
- **时钟漂移**：> 5 分钟启动失败；运行期漂移超出 SigV4 容差时表现为预签名 403，前端按既有失败态处理（`forceRefresh` 一次后进入失败态）。
- **CORS 未配置**：启动只 warning，能力位 `browserCors = false`；浏览器侧按既有失败态展示，部署验收要求修正 bucket CORS。
- **分片上传 ETag 非 MD5**：迁移降级矩阵已覆盖，不受本 Spec 影响。
- **OSS 不支持 path-style**：`provider = oss` 时不做 path-style 尝试，避免无意义的失败与误导性错误。
- **覆盖头取值含非 ASCII 文件名**：`response-content-disposition` 的编码在实现期按 RFC 5987 处理，并用真实桶验证（见「已确认事项」的真实桶验证项）。
- **厂商对未知查询参数报错**：预签名 URL 上的 `response-*` 若厂商不识别，可能 400 而非忽略；由 3.4 的探测提前发现并降级。

## 验收标准

### 静态检查与测试

- 寻址表：六个 profile 各生成预期形态的 URL；`generic` 按「virtual → path」顺序尝试，`HeadBucket` 第一次成功即停止，后续能力探测失败不触发寻址回退。
- S3 客户端配置：`requestChecksumCalculation` / `responseChecksumValidation` 为 `WHEN_REQUIRED`（构造参数可注入，用 spy 断言）。
- 预签名 PUT：URL 查询串不含 `x-amz-checksum-*` / `x-amz-sdk-checksum-algorithm`。
- 能力位降级：`responseOverrides = false` → `presignGet` 不带 `response-content-disposition`；下载描述返回 `stream`。
- 探测：六项全绿时返回能力摘要；每项各自失败时启动失败且错误信息可定位（含探测阶段名）；覆盖头子探测的传输层失败按不支持降级，不升级为启动失败。
- 探测残留清扫：`_probe/` 下超 24 小时对象回收，未到期与 `lastModifiedMs` 缺失不删，`gc_dry_run` 只报不删，枚举失败作为独立阶段失败上报。
- MinIO 集成：探测六项 + 上传/回读/预签名/覆盖头全绿。
- 类型检查、lint、相关测试串行通过（Vitest 单 worker）。

### 实机走查

- MinIO（现有演练桶）：`provider = minio`，探测摘要完整，画布图片直连显示、下载文件名正确。
- 至少一家公有云（OSS / COS / R2 之一）：`provider` 对应，探测六项通过，浏览器直连显示正常，`browserCors = true`；未通过项记录在「已确认事项」的真实桶验证项。
- 故障注入：错误 secret → 启动失败；只读凭据 → 启动失败；系统时钟人为偏移 10 分钟 → 启动失败；删除 bucket CORS → 启动 warning 且 `browserCors = false`。

## 实施顺序（确认后）

1. 设置键与 profile 表（含删除 `path_style`）。
2. 校验和策略与预签名 PUT 参数断言。
3. 探测六项与能力位，装配层接线，启动摘要日志。
4. 能力位驱动的 `response-*` 与 `stream` 降级。
5. 测试：单测 + MinIO 集成 + 一致性脚本。
6. README 厂商对照表。

## 已确认决策（用户反馈）

- 2026-10-26：用户同意按「provider profile + 启动探测 + 校验和收敛」的方向推进（原话「就按照建议做吧」），并声明「不需要太多自研方案，有成熟且前沿的库可以使用」——因此继续用 AWS SDK v3，不引入厂商原生 SDK。具体规则待确认。

## 已确认事项（2026-10-26 用户确认）

2026-10-26 用户确认本 Spec 方案通过，原待确认六项按当前实现口径定案：

- `storage.s3.provider` 不设为必填，缺省 `generic` + 启动探测（既有部署无需改配置即可启动）。
- `storage.s3.path_style` 直接丢弃，不做迁移（无向后兼容）。
- CORS 探测缺失只 warning 不失败（规则 3.5）。
- 一致性脚本 `storage:provider-check` 不纳入 CI，保持本地 / 发布前手动执行（需真实凭据）。
- 仍待真实桶验证（属部署验收项，不改变方案）：OSS/COS 的 `response-*` 覆盖语义与预签名 PUT 参数集（厂商不识别覆盖参数而非忽略时，按规则 4.2 降级）、S3 兼容 `region` 取值（验证后写入 README 对照表）。

## 当前状态

已按用户指示实现，代码于 2026-10-26 随 `023f6489` 提交并推送（此前记录中的「工作区（未提交）」已过时）：`storage.s3.provider` 画像（`server/services/storage/providers.ts`，替代 `path_style`）、统一 `createS3Client`（`forcePathStyle` + 双向 `WHEN_REQUIRED`）、六项启动探测与 `generic` 寻址回退、能力位（`addressing` / `responseOverrides` / `browserCors`）、`storage:provider-check` 运维脚本、`s3.integration.test.ts`（按 `TEST_S3_*` 门控）。

测试（2026-10-26，串行、`--maxWorkers=1`）：storage 套件与 server 全量 1118 个用例通过（该轮基线；两轮复审修复后为 98 个文件 / 1132 个用例）；providers/s3 探测用例覆盖寻址表、校验和收敛、预签名只签 `host`、探测六项与失败诊断，以及 CORS 按真实站点来源判定（白名单回显）与「未配置公开地址」警告两条分支。

2026-10-26 复审修复（双轴代码审查后，用户「从根因修复所有问题，不要打补丁」）：

- **6.1 的容器矩阵落地**：新增 `docker-compose.test.yml`（MinIO + `minio-init` 建桶，端口只绑回环）与 `vitest.minio.config.ts`（注入 `TEST_S3_*`，不挂数据库 globalSetup），`npm run test:storage:minio` 一条命令跑契约测试。
- **3.3 与实现的偏差订正**：原文「用与业务同一路径的 `presignGet`」与实现不符——探测用不带 `response-*` 的签址。这不是实现偏差而是**规格写错**：带上覆盖头时端点回显的正是覆盖值，`Content-Type` 断言会退化成同义反复，覆盖头是否生效是 3.4 的职责。规则正文已改述。
- **3.7 与实现的偏差订正**：原文「健康检查附带只读摘要」与 `/api/health/ready` 只报布尔 `storage` 不符。按 observability 规则 1.3（`checks` 只含布尔与数值）以实现为准，摘要的去处是启动日志与 `/metrics`；正文已改述。
- **探测超时**：`@smithy` 的 `connectionTimeout` / `socketTimeout` 缺省为 0（不限），端点黑洞会让 bootstrap 永不返回。修复为两档超时（运行期 10s/5min；探测期 5s/15s 且不重试），并给三处裸 `fetch` 加 `AbortSignal.timeout`。实测：黑洞端点从「永不返回」变为 15s 明确失败；真实 MinIO 上探测 220ms 通过、能力位不变。

2026-10-26 复审修复（第二轮，同样是根因修复）：

- **3.5 CORS 探测来源**（原实现用固定的探测专用假域名 `https://probe.noxrea.invalid`）：CORS 是按来源白名单放行的机制，白名单配生产域名时拿假域名去问必然得到「未放行」——`browserCors` 恒假，而它正是部署验收要求为真的位。改为取 `network.public_base_url` 的 scheme+host 作为 `Origin`；未配置公开地址时才退回哨兵值，并就此输出 warning 说明判定口径（此时只有通配放行能通过）。
- **3.5.1 / 4.1 能力位收敛**：预签名回读是探测致命项，进入服务态的进程该位恒真、且没有任何分支读它。`presignRead` 从 `StorageCapabilities` 移除，`BASELINE_CAPABILITIES` 与启动日志、`provider-check` 输出同步去掉——恒真且无人分支的位只会让人以为存在降级路径。

验证（2026-10-26，串行 `--maxWorkers=1`）：真实 MinIO 桶（NAS 演练环境，`TEST_S3_*` 由 shell 提供）上 `npm run test:storage:minio` 3/3 通过（六项探测 + 读写往返 + 预签名无凭据回读）；`storage:provider-check` 的探测段同环境 220ms 通过、当时列出的四项能力位全真、零 warning（该轮跑在第二轮修复之前，输出里还有 `presignRead`）。第二轮修复后 server 全量 98 个文件 / 1132 个用例通过；CORS 走真实站点来源的分支只有单测覆盖（`s3.test.ts` 的白名单回显用例），尚未在真实桶上以配置了 `network.public_base_url` 的形态跑过。

容器矩阵本身**未在本机执行**：开发机没有 Docker（`docker: command not found`），`docker-compose.test.yml` 与 `vitest.minio.config.ts` 里指向 `127.0.0.1:9000` 的缺省值因此从未被走过一遍。上述 3/3 是用同一份配置、由 shell 提供 `TEST_S3_*` 指向演练桶得到的——配置的注入路径验证过，compose 文件的启动路径没有。

2026-10-26 判断项根因修复：探测对象删除失败后的残留此前记为「由存储 GC 孤儿回收」，但引用回收只处理 `file_objects` 行、派生清扫只扫四根、staging 清扫只扫 `staging/`——`_probe/` 实际无人回收。现新增第四阶段 `probe-cleanup.ts`（`PROBE_ROOT_PREFIX`、固定 24h、`gc_dry_run` 同口径），`GcCycleResult` 增加 `probeSwept` / `probeSweepError`，GC 日志与 `storage:gc` 退出码纳入；覆盖头子探测的传输失败在规则 3.4 明示为按不支持降级。告警文案改为「覆盖头探测未通过」——原「端点不遵守」把传输失败也说成端点违约，与实现不符。测试：`probe-cleanup.test.ts` 4 用例、`gc.test.ts` 四阶段隔离与全败阈值更新。

尚未验证：OSS / COS 的 `response-*` 覆盖与预签名行为仍只有官方文档依据（无真实凭据）；`generic` profile 在两种寻址都可用时的选择顺序只有单测覆盖；探测残留清扫尚未在真实桶上以「删除失败留下残留」的形态演练。状态已由用户于 2026-10-26 设为「已确认」；「已实现」待上述真实桶验证与部署验收后设置。
