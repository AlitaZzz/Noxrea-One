# Storage S3 Backend

状态：已确认（2026-10-16 用户确认整体 Spec，含配置承载落 system_settings、上传直传、双凭据模型；实施进度见当前状态。建议在 [storage-reference-key-unification.md](storage-reference-key-unification.md) 之后实施）

## 目标

在现有 `StorageBackend` 抽象上补齐 S3 兼容对象存储实现（MinIO / Cloudflare R2 / 各云 S3 网关），运行时按 `system_settings` 设置二选一（重启生效）；**读取默认 302 重定向到预签名 URL、上传预签名直传**——文件字节不经过应用服务器，部署中立（局域网 NAS 与云服务器同等成立，公网带宽不成为必经瓶颈）。

同时修正抽象边界债：把「对象存储」与「本地工作区（临时文件、原子写）」两个职责拆开；接口命名对齐对象存储主流动词（put/get/stat/delete/list）。

产品面向**多用户公网部署**（2026-10-16 用户明确方向）：CORS 来源、files 路由鉴权模型、安全边界均以此为准；per-user 存储配额不在本期（后续独立 Spec）。

## 范围

- `StorageBackend` 接口扩展与命名对齐；移除无调用方的 `publicUrl`（URL 派生由 `buildFileUrl` 承担）。
- 新增 S3 后端实现（`@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`）。
- 本地工作区模块抽取：`tmpDir` / `writeAtomic` / `clearTmpDir` 从 `LocalStorageBackend` 拆出（任何后端下临时区都在本地盘）。
- 媒体源解析层：sharp / ffmpeg / ffprobe 等路径型消费方统一经「源解析」取输入（本地给文件路径、S3 给预签名 URL）。
- files 路由按后端能力分发：S3 默认 302 重定向，代理模式保留为配置备选。
- **files 路由双凭据**：浏览器会话鉴权 + 签名 URL 校验（`expires` + HMAC 签名）两条凭据路径；worker 提交生成任务时为引用文件即时签发短期签名 URL；`reference.ts` 的 base64 塞请求改为「签名 URL 优先、base64 兜底」策略。
- 上传链路双模式：S3 直传（ticket → PUT 到 staging → complete 服务端 CopyObject 提升到内容寻址 key 并复验），本地沿用服务器中转。
- GC 派生产物清理接入 `list` + `delete`；直传孤儿收敛在 staging 前缀按龄清扫（另设低频全 bucket 审计命令兜底）。
- 存储后端与 S3 连接配置落 `system_settings` 注册表（沿用 [system-settings-db.md](system-settings-db.md) 机制：注册表定义、启动播种、内存快照、重启生效）+ 启动连接探测；README 与 Bucket 初始化清单同步（`.env.example` / `docker-entrypoint.sh` 无新增变量）。
- **Bucket 初始化清单**（部署前置，写入 README）：CORS 规则、可选 lifecycle、服务端加密约束（见下文专节）。
- 对象迁移脚本：local → S3 全量搬迁 + 校验，**支持双向**（回滚反向补迁用）。
- 「切换与回滚流程」专节（见下文）。

## 非目标

- 不做 per-file 混合存储（无存储位置列，不长期共存）。
- 不做 S3 multipart（上传上限内单次 PUTObject 足够）。
- 不做 CDN 层、内外网双端点（预签名 URL 不可达场景用 proxy 分发模式兜底）。
- 不做 per-user 存储配额与计费（多用户化的后续 Spec）。
- 不做存储设置的管理端 UI / 写接口（沿用 [system-settings-db.md](system-settings-db.md) 既有节奏：本期改库 + 重启生效，管理端为后续阶段）；`storage.backend` / `storage.s3.*` **永不参与未来的快照热刷新**，始终重启生效。
- 不改上传限额与批次语义（`UPLOAD_BATCH_MAX_MB` 等沿用）。

## 已确认决策（2026-10-16，逐条确认）

1. **分发模式**：S3 下 files 路由默认 302 重定向到预签名 GET；代理模式保留为配置备选。
2. **派生产物**（`_cache/_posters/_sprite/_proxy`）与主对象同存 S3。
3. **切换模型**：单一后端 + 一次性迁移脚本，任一时刻只有一个后端生效。
4. **数据合同**：DB 引用统一存 key（见 [storage-reference-key-unification.md](storage-reference-key-unification.md)，建议先行）。
5. **上传链路**：预签名直传 + 服务端复验（本 Spec 建议，用户委托拟定，随整体确认生效）。
6. **双凭据模型**（2026-10-16，用户确认需求与机制）：上游 AI 经**短期签名 URL** 下载媒体——此场景的行业成熟方案即预签名/签名 URL；浏览器侧 files 路由加会话鉴权。两类凭据解耦，上游链路不受鉴权影响。
7. **配置承载**（2026-10-16 用户提出，评估采纳）：后端选择与 S3 连接配置落 `system_settings`（重启生效），不使用 env——与项目「运行期参数落库」基准及参考项目 DB 存储配置先例一致；凭据按 `model_providers.api_key` 同级处理；切换流程不变（停 → 迁移 → 改设置 → 起）。

## 业务规则

1. **后端选择（system_settings，重启生效）**：设置键 `storage.backend`（`local|s3`，默认 `local`），经既有设置注册表（播种 / 快照 / zod 校验）管理。存储层在引导期 `initSettings()` 之后构建进程级单例，**不支持热切换**；未来管理端引入快照热刷新时，`storage.backend` 与 `storage.s3.*` 也不参与热刷新、始终重启生效（杜绝多实例 split-brain 与「切换未迁移」脏状态）。`local` 后端保留且为默认。
2. **S3 连接配置**（`system_settings` 设置键，引导期校验；凭据与 `model_providers.api_key` 同级明文存库——项目已确认的密钥处理基准，落库加密列为后续加固）：

   | 设置键 | 默认 | 说明 |
   | --- | --- | --- |
   | `storage.s3.endpoint` | 空 | S3 兼容端点（含 `http(s)://`）；`backend=s3` 时必填 |
   | `storage.s3.bucket` | 空 | bucket 名；`backend=s3` 时必填 |
   | `storage.s3.region` | 空 | region（MinIO/R2 有约定值即可）；`backend=s3` 时必填 |
   | `storage.s3.access_key_id` / `storage.s3.secret_access_key` | 空 | 凭据；`backend=s3` 时必填 |
   | `storage.s3.path_style` | `true` | path-style 寻址（MinIO 等自建默认 true） |
   | `storage.s3.prefix` | 空 | 对象 key 统一前缀（bucket 复用） |
   | `storage.s3.signed_url_ttl_seconds` | `3600` | 预签名有效期 |
   | `storage.s3.delivery` | `redirect` | `redirect`（302 预签名）/ `proxy`（服务器流式转发） |
   | `storage.upstream_ref_delivery` | `signed-url` | `signed-url`（上游签名 URL）/ `base64`（无公网可达性时兜底） |

   `backend=s3` 而必填键缺失/非法时，存储层初始化即启动失败并指明键名（跨项联合校验放在存储初始化点，注册表维持各项独立校验的现状）。

3. **目标接口**（`server/services/storage/backend.ts`，命名对齐对象存储动词）：

   ```ts
   export interface StorageBackend {
     /**
      * 保存（服务端直写：派生产物、AI 结果、local 中转上传）；S3 按 key 扩展名写 Content-Type。
      * 未知长度的 ReadableStream 需先落工作区 tmp 再上传（S3 单请求上传要求已知 Content-Length）；
      * 现有调用方（ensureArtifact / media-ops）实际都先经 tmp 文件。
      */
     put(key: string, source: string | Buffer | ReadableStream): Promise<void>;
     /** 读取流；range 供 proxy 分发模式透传 Range */
     get(key: string, opts?: {
       range?: { start: number; end?: number };
       signal?: AbortSignal;
     }): Promise<NodeJS.ReadableStream>;
     /** 文件信息；null = 不存在（S3：HeadObject 404） */
     stat(key: string): Promise<{ size: number; mtimeMs: number } | null>;
     /** 删除；不存在视为成功（S3：NoSuchKey 视为成功） */
     delete(key: string): Promise<void>;
     /** 按前缀枚举（派生清理、staging 清扫、全 bucket 审计） */
     list(prefix: string): Promise<Array<{ key: string; size: number; lastModifiedMs: number }>>;
     /** 预签名 GET（重定向分发、媒体工具输入）；不支持的后端不实现 */
     presignGet?(key: string, opts?: {
       ttlSeconds?: number;
       dispositionFilename?: string;
       cacheControl?: string;
     }): Promise<string>;
     /** 预签名 PUT（直传）；不支持的后端不实现 */
     presignPut?(key: string, opts?: { ttlSeconds?: number; contentType?: string }): Promise<string>;
   }
   ```

4. **读取分发**（`storage.s3.delivery=redirect`，默认）：
   - 预签名 GET 的**签名时间对齐到 TTL/4 固定窗口，窗口基于 Unix epoch 绝对对齐**（`floor(now / window) * window`，锚定 epoch 而非进程启动时间）：多实例部署时所有实例对同一窗口签出字节一致的 URL，配合 `response-cache-control`（含 immutable 语义）保证浏览器缓存命中（open-ai-canvas 验证过的方案）。
   - `?download` 经 `response-content-disposition` 透传；Content-Type 由 key 扩展名推导（put 时写入 + presign 时覆盖）。
   - Range 请求由浏览器直接向 S3 发起（原生 206）；服务器不搬字节。
   - bucket CORS 是**硬前置**：未配置时 redirect 上线首日派生图与前端 JS 消费（mediabunny 解码、canvas 抓帧、带 Range 的 fetch）即全部失效——初始化要求见「Bucket 初始化清单」专节。
5. **代理分发**（`storage.s3.delivery=proxy`）：`get(key, { range })` 透传，206/416 语义与现 files 路由一致；兜底「预签名 URL 不可达」（如内网 MinIO + 外网浏览器）。
6. **上传**：
   - **s3 模式（直传，staging → promote，行业主流形态）**：
     1. `POST /api/files/upload-ticket`（校验 auth / 白名单 / 限额；ticket 签发接入既有按用户并发租约限流，防 presign 滥用；`(userId, hash)` 已存在则直接返回命中结果——**秒传**，无需上传）→ 返回 `presignPut(stagingKey)`，stagingKey 形如 `staging/{userId}/{uuid}`（客户端不接触内容寻址命名空间）；
     2. 客户端**流式计算 SHA256**（hash-wasm 等增量实现，避免大文件整读内存——`crypto.subtle.digest` 需整 Buffer）后 `PUT` 到预签名 URL（可重试，同 URL 同内容幂等）；
     3. `POST /api/files/upload-complete`（**CopyObject 将 staging 对象提升到内容寻址 key**——同 bucket 服务端复制不出网；提升前对 staging 源流拉流复算 SHA256 + 字节数 + 内容嗅探 + XML 拦截 + 媒体探测，复验通过才复制提升，不符即拒绝且不落内容寻址 key；通过则 upsert `file_objects`。原「HeadObject ETag(MD5) 预检 / 复制后验副本」流程经实施修订废弃，见「当前状态」）。

     staging 残留（未 complete / 复验失败）由规则 9 的按龄清扫回收，失败与伪造内容永不进入内容寻址命名空间。
   - **local 模式**：沿用现 multipart 中转（hash / 校验 / 探测同点）。
   - 上传路径按后端能力分派，`GET /api/files/upload-limits` 暴露 `{ mode: "direct" | "relay" }` 供前端选择。
   - 完整性立场：key 即内容 hash 是寻址根基，服务端复验不作为可选项省略；复验流量走内网/同区域端点（NAS 局域网、云上内网免费），公网带宽仍不被占用。
7. **派生产物生成**：`ensureArtifact` 命中检查经 `stat`；生成写入本地工作区临时文件后 `put(key, tmpPath)`。
8. **媒体工具接入**：新增 `resolveMediaSource(key)` 返回 `{ kind: "path", path }`（local）或 `{ kind: "url", url }`（S3 预签名 GET）。ffmpeg / ffprobe 原生支持 HTTP 输入直接消费；sharp 经 fetch 流式消费（Web Stream 需 `Readable.fromWeb` 转换）或下载到工作区走文件路径（更稳）；ffmpeg 消费预签名 HTTPS URL 需构建含 TLS 支持的 ffmpeg（常规发行版均满足，`FFMPEG_PATH` 指向自编译产物时注意）。**输入策略启发式**：短操作（probe、单帧抽帧）直接消费 URL；全量解码 / 转码类（雪碧图 / 预览代理 / crop / extract 重剪辑）一律先下载到工作区处理——既避免预签名 URL 在作业中途过期，也避免 HTTP seek 的额外往返。单帧抽帧（capture-frame）在 S3 后端下经源解析取 URL 直接消费，雪碧图与预览代理属重操作走下载租约。现有全部 `localStorage.` 直连消费方（含 files.ts 裸 `createReadStream`、media-probe / resize-cache / media-edit / frame-sprite / video-proxy / reference.ts 的 baseDir 拼路径）收敛到 backend / 工作区 / 源解析三个入口。
9. **删除与 GC / 孤儿治理**：`delete(key)` 负责该 key 的一切——主对象 + `_cache` / `_posters` 派生（经 `list` 按 stem 前缀枚举后逐个 `delete`）；`_sprite` / `_proxy` 维持 30 天 TTL 清扫（实现改走 `list` + `delete`）。GC 调用方不变。孤儿对象治理分层：**staging 前缀按龄清扫**（每日任务，超 24h 的 staging 对象回收；MinIO/R2 lifecycle 规则可替代，代码保留兜底）；**低频全 bucket 审计命令**（人工触发）：bucket 与 `file_objects` 全量对账，兜底 GC「先删 DB 行后删对象」窗口的崩溃残留与异常路径孤儿——不作为定时任务（多用户大 bucket 上全量 List 昂贵）。
10. **启动探测**：`storage.backend=s3` 时启动即 HeadBucket 校验连通性与凭据（先于 HTTP 服务与 Worker 开始工作），失败直接启动失败并输出端点与缺失键名（凭据不落日志）；**禁止静默降级到本地**。
11. **对象迁移脚本**（`scripts/storage/`，一次性）：遍历 `file_objects` 全部行 + 本地派生目录（排除 `_tmp`），逐对象上传并以本地 MD5 与 S3 ETag 校验；支持 dry-run 与断点续跑；**不删除本地任何数据**（原 `uploads/` 留作备份，用户手工处置）。校验失败即中止；ETag==MD5 的前提为单次 PUTObject 且 bucket 未启用 SSE-KMS/SSE-C（见「Bucket 初始化清单」），不满足时降级为 size 比对 + 重读哈希。**支持双向**（`--direction local-to-s3 | s3-to-local`），回滚前先反向补迁。完整流程见「切换与回滚流程」专节。
12. **上游 AI 媒体引用（M2M，双凭据）**：生成任务提交时，服务端把引用 key **即时签发为短期签名 URL** 发给上游，上游拿 URL 自行下载——s3 模式 `presignGet` 直连 bucket（前提 bucket 端点公网可达）；local 模式应用层 HMAC 签名 URL（`?expires=…&signature=…`，files 路由校验后放流）。规则：
    - 签名 URL **不入库不持久化**（`generation_tasks` 存 key），每次提交/重试即时重签；
    - TTL 覆盖上游拉取窗口（默认沿用 `S3_SIGNED_URL_TTL_SECONDS` = 1h）；
    - 部署不具备公网可达性（如内网 MinIO + NAT）时经设置 `storage.upstream_ref_delivery=base64`（默认 `signed-url`）退回 base64（现有 `reference.ts` 行为兜底，属网络可达性策略而非兼容层）；
    - 浏览器会话鉴权与签名 URL 两类凭据互不影响。

## Bucket 初始化清单（部署前置）

切换到 `storage.backend=s3` 前必须完成，写入 README 部署文档：

1. **CORS 规则（必配，redirect 读与直传写共同依赖）**：
   - `AllowedOrigins`：生产域名 + 本地开发来源（如 `http://localhost:9898`）——多用户公网部署以生产域名为准；
   - `AllowedMethods`：`GET`（redirect 读、前端 fetch / mediabunny 解码 / canvas 抓帧 / 带 Range 请求）与 `PUT`（预签名直传）；
   - `AllowedHeaders`：`Range`、`Content-Type`（PUT 只签/只发 Content-Type；Range 不参与签名，但浏览器跨源发送需在 CORS 放行）；
   - `ExposeHeaders`：`Content-Length`、`Content-Range`、`Content-Type`（浏览器侧不消费 ETag：客户端哈希本地计算，复验以服务端重算为准，ETag 仅迁移脚本经 SDK 读取）；
   - `MaxAgeSeconds`：86400。
   - 配置入口：MinIO 用 `mc cors set` / 控制台；R2 与各云 OSS S3 网关各有仪表盘/API 入口。
2. **lifecycle 规则（可选）**：MinIO/R2 支持按前缀自动过期，可替代 `_sprite` / `_proxy` 的自写 30 天 TTL 清扫（代码侧保留 `list` + `delete` 兜底，不依赖部署配置）；**禁止**对主对象前缀配置 lifecycle——主对象删除只能由引用计数 GC 驱动。
3. **服务端加密约束**：bucket 不得启用 SSE-KMS / SSE-C（MinIO/R2 默认关闭）；启用会使 ETag≠MD5，迁移校验与直传复验自动降级为 size + 重读哈希（代码检测降级并告警）。

## 切换与回滚流程

「单一后端 + 无存储位置列」意味着不允许 local / S3 并存写入，切换必须停写：

1. **停应用**（单实例停进程；多实例部署全部实例同时停止——任何实例继续写入都会产生迁移盲区）。
2. **跑迁移脚本** local → S3（应用已停止，不产生新文件；支持断点续跑）。
3. **校验通过** → 把 `system_settings` 的 `storage.backend` 改为 `s3` → **起应用**（多实例同时重启，杜绝并存写入窗口；配置改动重启生效）。
4. **`uploads/` 目录原样保留**，作为回滚备份留存（处置由用户决定）。

**回滚路径**：S3 侧异常 → 先跑反向补迁（`--direction s3-to-local`，把切换后新写入的对象拉回本地）→ 把 `storage.backend` 改回 `local` → 重启。本地数据全程未删是回滚可行性的根基。

**验收演练**：实施最后一项为切换演练——测试环境完整走一遍「切换 → 读取/直传/删除回归 → 回滚」。

## 技术影响

- 新增：`backends/s3.ts`、`workspace.ts`（临时区）、`media-source.ts`（源解析）、对象迁移脚本。
- 修改：`service.ts`（按 `storage.backend` 设置构造单例）、`backend.ts`、`backends/local.ts`（剥离工作区职责、方法更名）、`files.ts`（能力分派）、上传链路（`upload.ts` + 新 ticket / complete 路由 + 前端 `uploadWithRetry` 双模式）、受管 `<video>` 元素补 `crossOrigin="anonymous"`（抓帧/封面链路）、`artifact.ts`、`resize-cache.ts`、`media-probe.ts`、`media-ops.ts`、`media-edit.ts`、`frame-sprite.ts`、`video-proxy.ts`、`reference.ts`、`gc.ts`、`download.ts`、`generate.ts`、`bootstrap.ts`（存储层初始化移至 `initSettings()` 之后）、`core/settings/`（注册表新增 `storage.*` 键）、README。`core/config/index.ts` 与 `.env.example` 无新增（`UPLOAD_DIR` 等 B 类 env 维持现状）。
- 依赖：`@aws-sdk/client-s3`、`@aws-sdk/s3-request-presigner`。
- 关联 Spec：[media-processing-concurrency.md](media-processing-concurrency.md) 中 `localStorage.writeAtomic` / 派生清理表述同步更新；[storage-reference-key-unification.md](storage-reference-key-unification.md) 先行实施；设置注册表机制与键命名遵循 [system-settings-db.md](system-settings-db.md)。
- 测试：backend 层用 MinIO 容器（或内存 S3 桩）覆盖 put/get/stat/delete/list/presign；files 路由 redirect 与 proxy 两模式、直传复验（含秒传、复验失败清理）、迁移脚本校验逻辑补测试；存储层按设置快照初始化、「backend=s3 且必填键缺失 → 启动失败指明键名」补测试（设置 fixture）。

## 异常与边界

- **S3 写失败明确报错**：上传 complete 返回错误、AI 结果下载按既有重试重试；不回退本地（避免数据落在错误后端导致引用悬空）。
- **直传孤儿对象**：PUT 成功但未 complete（客户端中断 / 复验失败）的对象收敛在 staging 前缀，由按龄清扫回收，不污染内容寻址命名空间。
- **预签名 URL 不可达**：切 `storage.s3.delivery=proxy`（改库重启生效）；本期不做内外网双端点重签名。
- **客户端哈希错误 / 伪造**：complete 全量复验拦截，错误对象即删；key 与内容不符的记录不可能入库。
- **迁移与切换的间隙**：脚本输出缺失对象清单供二次补迁（标准流程停服务执行，间隙为零）。
- **派生产物随迁移一并拷贝**：避免切换后全量缩略图/海报重建形成 CPU 风暴；拷贝失败对象记入清单并允许跳过（可再生）。
- **Windows 语义**（fs-utils 瞬时占用重试）仅 local 后端相关。
- **大文件内存**：local 中转 Buffer 模型不变；直传不经服务器内存；proxy 分发为流式转发。
- **受管媒体元素统一 CORS 加载（redirect 硬前置）**：302 后资源最终 origin 变为 bucket 域，未带 `crossOrigin="anonymous"` 的 `<img>`/`<video>` 会污染画布——`drawImage` + `toBlob`/`toDataURL` 抛 SecurityError。前端图片编辑链路已普遍设置 `crossOrigin="anonymous"`（ImageNode / crop / annotation / grid 等，已核实）；**video 抓帧链路（video-playback-registry 的 `captureCurrentFrame`、VideoRefCard 等播放元素）当前未设置，必须随本 Spec 补齐**——该链路 catch 吞错，污染后表现为抓帧/封面静默失效。bucket CORS 与元素属性二者缺一即坏。
- **签名 URL 的能力暴露**：预签名 URL 在 TTL 内凭 URL 即可访问，会出现在应用日志、反向代理 access log 与浏览器历史中——按「与稳定代理 URL 同级的能力暴露」接受；日志脱敏列为后续加固项，不阻塞本期。
- **多用户公网部署基准**（2026-10-16 用户明确产品方向）：CORS 来源按生产域名配置；files 路由双凭据（会话 + 签名 URL）；per-user 存储配额为后续独立 Spec。

## 验收标准

- `STORAGE_BACKEND=local`（默认）：现有测试全绿，行为一致（回归底线）。
- `STORAGE_BACKEND=s3`（MinIO 集成测试）：直传（staging → promote → 复验）→ 秒传命中 → redirect 读（302、Range/206、`?download`、`?w=` 档位派生与命中）→ proxy 模式 Range/416 → 上游签名 URL 拉取成功、过期后失效 → 删除 + GC 回收主对象与派生对象 → staging 按龄清扫孤儿、审计命令对账通过 → redirect 模式下视频抓帧/封面正常（crossOrigin 回归点）。
- files 路由双凭据：无会话且无签名的请求被拒；有效签名 URL 可拉取、过期/篡改签名失效；会话请求不受签名逻辑影响。
- 设置承载：全新库播种 `storage.*` 键为默认值；`backend=s3` 且必填键缺失时启动失败并指明键名；手工改库重启后新后端与参数生效。
- 生成链路：worker 提交时引用 key 签发为签名 URL、重试重签、DB 中无签名 URL 落库。
- 迁移脚本：样例数据全量搬迁、MD5/ETag 校验通过、dry-run 不写、断点续跑幂等、`_tmp` 与本地数据不删。
- typecheck / lint / test 串行通过。

## 待确认事项

无（四项方向、上传链路、双凭据模型均已逐条确认）。

## 当前状态

已确认（2026-10-16）。实施顺序：key 化 → 接口扩展 + 工作区拆分 → LocalStorageBackend 收敛 13 处直连 → S3 后端 + 启动探测 → 迁移脚本 → 切换演练。

- [已完成] key 化：specs/storage-reference-key-unification.md（提交 b5f4befb）。
- [已完成] 接口扩展 + 工作区拆分：`storage/backend.ts`（put/get/stat/delete/list + 可选 presignGet/presignPut；`StorageTraversalError`；get 返回 Node Readable、list 带 lastModifiedMs 供按龄清扫）；`storage/workspace.ts`（`_tmp` 临时区、writeAtomic、uploadRoot 惰性解析）。
- [已完成] 直连收敛：media-edit（路由工厂 stat/租约/错误映射统一，persistDerived 经 put）、resize-cache（三处 produce 租约化，穿越守卫移交后端）、media-probe（探测经 resolveMediaSource，ffmpeg 直吃 URL、sharp 拉成 Buffer）、files（stat/get 流式分发，Range 206/416 语义不变）、upload（put + 探测 URL 化）、download、gc、video-proxy / frame-sprite（TTL 清扫经 list + lastModifiedMs）、reference（readSelfFile 租约化）、generate（resultSizes 经 stat）；localStorage 单例导出删除，单例由 service 引导期构造。
- [已完成] S3 后端 + 启动探测 + 全部 S3 运行时接线（2026-10-17，提交 9a7ccbb3）：设置键（storage.backend / storage.s3.* / storage.upstream_ref_delivery，注册表 + 播种 + 快照）、S3Backend（put/get/stat/delete/list + presignGet/presignPut/copy/probe，签名时间对齐 TTL/4 epoch 窗口）、引导探测失败即启动失败（禁止静态降级）、files 双凭据（会话 + HMAC 签名 URL，密钥从 JWT 密钥域分离派生）与 redirect/proxy 分发、reference 签名 URL 优先 base64 兜底、直传双模式（ticket/complete 路由 + upload-direct 服务（秒传 / 归属校验 / 提升前复验 / 幂等短路）+ 客户端 hash-wasm 增量 SHA256 直传管线与 relay 回落）、staging 24h 清扫挂接 GC、storage:audit 全 bucket 对账命令（只读）、README Bucket 初始化清单与设置文档、受管 video 元素补 crossOrigin（异常边界要求）。测试：server 753 通过 / web 928 通过（复审六轮补齐 files redirect/proxy 路由级、reference 规则 12 双凭据、S3 非 content key 删除短路、直传幂等完成 / 复制中断清理 / 统一准入三态 / 丢失响应重试幂等、XML 状态机直接单测、超长空白后置 XML 回归用例；第七轮补齐视频体检直接单测与 PUT 同 URL 重试用例），typecheck / lint 串行通过；S3 后端单测（命令捕获桩）、存储引导（缺键启动失败指明键名）、直传（秒传 / 复验失败清理 / 落库失败保留对象 / 清扫）、客户端直传批次单测。
- 实施修订（随 Stage 3，规则文本不改）：规则 6 的 complete「ETag(MD5) 快速预检 vs 客户端哈希」不成立——ETag 为 MD5（32 hex）、客户端为 SHA256（64 hex），二者永不相等，比较会误杀全部直传；故不实现该预检，复验以拉流重算 SHA256 + 字节数 + XML 嗅探为准，ETag 校验仅用于迁移脚本；complete 增补可选 source 透传（与中转 ?source= 同口，画布派生文件标记 derived）；ticket 签发接入并发租约（规则 6 原文要求，防 presign 滥用）；upload-limits 暴露 mode 字段供前端分派。
- 实施修订（复审后补充，2026-10-17）：`stat` 接口不携带 etag 字段（ETag 预检取消后无消费方，迁移脚本以 SDK 直读对象 ETag）；`presignGet` 的 `dispositionFilename` 选项改为 `responseContentDisposition`（Content-Disposition 构造单一来源 file-response.ts，后端只透传头值）；`listDerivedArtifactKeys` 门控内容寻址 key（不变量「派生产物只挂内容 key」，staging 清扫与派生删除不再为每个 key 付两次全前缀 list）；`isVideoExt` 派生自上传白名单单一口径（原 m4v/mpg/mpeg 为不可达死分支）。
- 实施修订（第三轮复审，2026-10-17）：直传复验顺序根因修正为「提升前复验 staging 源流」——原「复制后验副本」下复验失败会删除已提升对象，并发完成请求存在以未验证内容覆盖先到对象的破坏性竞态；改为先拉流复验（SHA256/字节数/XML）验证通过才复制提升，复验失败根本不落内容寻址 key（staging 保留供排查），复制中断清理可能残留的内容 key。XML 判定抽为流式状态机 `createXmlContentDetector`（中转整份 Buffer 与直传逐块 feed 共用单一实现），消除直传固定 4KB 前缀截断漏判（超长空白/注释后置 `<svg` 的构造文件）。complete 增加幂等存在性短路（file_objects 查得即返回既有对象并清 staging）；秒传与幂等完成以 `existingTicketFile` 统一既有对象映射；ticket 响应删除 `expires_in` 死字段（客户端从不消费，有效期由服务端 presign TTL 控制）。storage:audit 主对象分类复用 shared/url `isStorageKey`（key 严格形态单一来源）；`isVideoExt` 入参收敛为含点扩展名（extOfName 产物），files 路由先取扩展名再判定。
- 实施修订（第五轮复审，2026-10-17）：直传准入口径与中转统一——`evaluateUploadIdentity` 单一判定（白名单 MIME 或白名单扩展名任一命中即受理），中转 processFile 与直传 ticket/complete 三处共用；直传不再要求名字扩展名必在白名单、不再对非白名单 MIME 直接拒绝（与中转同为元数据回退，坏信号不改变受理）。结构性差异记录：票据阶段无字节可嗅探，两侧信号皆缺（无名扩展且 MIME 不在白名单）只能 415 快速失败，无法像中转那样靠魔数回退；完成阶段以验流魔数 `normalizeExt(sniffed.ext)` 定 `finalExt`，与中转完全同源，`resolveUploadExt` 删除。complete 幂等存在性短路前移至 staging 存在性检查之前（file_objects 查得即幂等返回，尽力清 staging）——首次成功已清 staging 的丢失响应重试不再 404；staging 归属形态检查保留在最前（不泄露他人 key 存在性）。并存语义记录：直传重复完成「返回既有对象」（已批准语义）与中转同内容重传「upsert 刷新 ext/mime 元数据」（persist 既有行为）——内容寻址下均不产生第二行，ext 元数据是否随重传刷新两模式有别，不改。补 `createXmlContentDetector` 直接单测（跨块 carry / BOM 跨块 / 短流 / 双端序 / 长空白后置标签 / 与整份 Buffer 判定对齐）。
- 实施修订（第六轮复审，2026-10-17）：SVG 拒绝并入 `evaluateUploadIdentity.admitted`（名字 .svg 或 MIME image/svg+xml 任一申报即拒，中转与直传同一判定；字节层 XML 拦截仍由中转整份 Buffer 与直传流式状态机各自承担）——SVG 不支持，消除直传仅靠字节拦截的口径残留分歧。格式白名单与准入规则独立为 `formats.ts`（UPLOAD_FORMATS / ALLOWED_MIME / ALLOWED_EXT / isVideoExt / evaluateUploadIdentity），上传流程留在 upload.ts，读路径（files 海报分支）不再为取规则而拉入上传流程依赖图；`resolveUploadMime` 收敛为接收 evaluateUploadIdentity 已判定的白名单 MIME（白名单门禁单一来源）。XML 状态机抽出共享逐字节 / UTF-16 配对扫描器（scanHead 与 feed 消除重复）。GC tick 锁存器改整体 try/finally 兜底（日志调用抛错不再可能卡死 GC）。
- 实施修订（第七轮复审，2026-10-17）：线上文件视图单一来源——`storedFileView` / `StoredFileView` 落在 service.ts（key/url 派生与 size 收敛单一实现），中转成功项、直传秒传 / 幂等完成 / 提升完成四处构造共用，`DirectUploadFile` 平行类型声明删除，`media_warning` 类型统一为 media-probe 的 `VideoUploadWarning`。共享件迁出流程模块、依赖方向修正——XML 状态机独立为 `xml-content.ts`（零依赖），`resolveUploadMime` 并入 formats.ts 规则层，`probeUploadVideo` 归位 media-probe.ts，upload-direct 不再 import upload.ts（直传路径不再拖入中转流程的持久化/媒体依赖图）。PUT 同 URL 重试落地规则 6 原文——预签名 PUT 对网络 / 超时 / 5xx 在同一 URL 退避重试（上限 2 次，响应丢失时同字节覆盖终态正确），4xx 不可同 URL 恢复上抛交批次层重开票据。staging 清扫纳入 `storage.gc_dry_run` 护栏（与引用回收同一安全口径，dry-run 只统计不删除）。web 端收尾：isUploadFileData 补齐 width/height 校验（类型断言不再为未检字段背书）、票据/完成异常归一与 staging 清理重复 catch 抽公用、runOne 会话校验死 try/catch 删除。README 迁移脚本标注 Stage 4 待交付（交付前不得执行切换）。
- 实施修订（第八轮复审，2026-10-17）：收敛清理与失败语义收紧——直传秒传/幂等两处既有行直接传 `storedFileView(existing)`（视图入参即 file_objects 行投影，消除三处字段逐一复制）；魔数嗅探窗口收敛为 `SNIFF_WINDOW_BYTES`（mime.ts 单一常量，中转/直传/下载三处共用）；presignPut 移除无调用方的 ttlSeconds 死参数（TTL 恒用 signed_url_ttl_seconds）；直传路由两端点共用 directHandler 骨架（JSON 解析/schema 校验/错误映射单一实现）；web 批次上下文收敛为 BatchUploadParams 参数束（公开 API 不变）；参考签名失败语义修正：presignGet 临时故障不再静默回退 base64，按 GenerationFailureError 明确失败（交付形态由 storage.upstream_ref_delivery 决定，规则 12 授权的回退仅限设置选择与 local 未配 public_base_url 的结构性不可用），对应测试翻转为断言失败上抛；gc 的 staging_swept 日志补 dryRun 标记；files 路由路径穿越检查移到鉴权之后（key 形态的 403 信息只暴露给通过凭据校验的调用方）；web directUploadFile 注释修正为与行为一致（4xx 直接失败，批次层不重开 ticket）。测试：server 753 通过 / web 928 通过，typecheck / lint 串行通过。
- 实施修订（第九轮复审，2026-10-18）：后端直传能力判定收敛为单一谓词 `supportsDirectUpload`（backend.ts，预签名 PUT 与服务端复制缺一不可）——mode 通告 / ticket / complete 三处同口径，消除「mode 通告只查 presignPut 而 complete 另需 copy」的潜在口径漂移，并把不可用失败提前到票据签发处；视频体检门槛内聚于 `probeUploadVideo`（非视频 key 直接不探测，调用方不再各自预判 isVideoExt）；web 受管文件引用收敛 `RemoteFileRef` 类型（票据/完成响应与 isUploadFileData 守卫同一形状，返回改展开）；`mapDirectApiError` 复归纯映射（`UploadBusinessError` 增 code 字段携带服务端错误码，direct_unavailable 清 limits 缓存的副作用归批次执行层）；规则 6 措辞修订：客户端哈希收敛 SHA256 单一口径，complete 描述对齐提升前复验的既定修订。测试：server 754 通过 / web 928 通过，typecheck / lint 串行通过。
- [已完成] 迁移脚本（规则 11，2026-10-18）：`scripts/storage/migrate.mts`（npm run storage:migrate）+ `server/services/storage/migration.ts`（核心逻辑，传输端口注入，零 prisma/aws-sdk 依赖，可直接单测）。双向 `--direction local-to-s3 | s3-to-local`。校验矩阵：内容对象 local→s3 以 ETag==本地 MD5 为主校验，ETag 非 32 位 hex（multipart `-` 后缀 / SSE-KMS/SSE-C 形态）自动降级为回读重算 SHA256 与 key 内 hash 比对 + 字节数核对（检测降级并告警）；s3→local 边下边算 SHA256 与 key 内 hash 比对（最强校验，与原子落盘同一流）；派生产物按字节数核对（可再生，失败或体积不可查记清单跳过不中止，不误判通过）。断点续跑：JSONL 日志逐对象落盘（默认 `<存储根父目录>/storage-migration/<direction>.state.jsonl`，随 UPLOAD_DIR 走、缺省布局下即项目根；`--state-file` 覆盖，按 direction 过滤，损坏行跳过，读取故障（非 ENOENT）上抛不当首跑处理），重跑幂等；dry-run 只读盘点（在位/体积核对；失败与不可迁移对象逐条列出，计划搬迁以计数给出），不写远端不写续跑日志，盘点报告照常落盘。安全立场：本地数据全程不删——s3→local 既有同体积内容按内容寻址不变量（同 key 同体积 ⇒ 同内容，与 local 后端 put 去重同一口径）跳过，体积冲突记失败中止、不覆盖本地（该限定仅内容对象；本地既有派生产物体积不符时以远端覆盖——派生可再生且落盘经字节数校验，不入失败清单）；迁移逻辑零 DB 写入（引导期 schema 迁移与设置播种属标准引导，不属迁移逻辑）；内容对象校验失败即中止（实跑语义；dry-run 盘点收集全部缺口不中止；内容先行、派生殿后，中止时派生未搬、重跑幂等补齐）；staging 在途暂存不迁移；staging 残留与未知 key 形态在两侧方向一律列入清单交人工/审计处置，绝不静默丢弃（两侧枚举分类共用 migration.classifyObjectKey 单一实现）；孤儿判定两侧方向均做、各自对账自身源侧：local→s3 对账本地盘 vs DB（本地孤儿），s3→local 对账远端枚举 vs DB（远端孤儿，不回迁——回滚只恢复 DB 引用的对象）；均列入清单交审计处置。报告 JSON（`--report-file`，默认 `report-<direction>.json`），退出码 1 表示存在失败对象。实现注记：ETag 经 SDK 直读 PutObject 响应（脚本持独立 S3Client，实施修订授权）；S3 连接参数组装抽 `service.s3OptionsFromSettings` 单一来源；bucket 前缀映射抽 s3.ts 模块函数（类与脚本共用）；dry-run 对本地缺失/体积不符逐条记失败并继续盘点（一次暴露全部数据缺口，中止是实跑语义）；枚举与搬运顺序执行（一次性工具，2C2G NAS 以磁盘/内网带宽为界，不并行）。测试：迁移核心 19 用例（校验矩阵 / dry-run 不写 / 续跑幂等与损坏行容忍 / 跨方向日志过滤 / 孤儿与 staging/未知跳过 / 派生失败与体积不可查跳过 / 冲突不覆盖本地 / 命名空间分类器）。
- [待办] 切换演练（MinIO，验收标准见验收标准节）。验收缺口：MinIO 实桶集成验证（含迁移脚本对真实网关的 ETag 形态与降级行为）、切换/回滚演练、CopySource 编码形态在真实网关的行为确认均留待演练。
- 后续小项：media-edit 各路由 schema 的 video_key/audio_key 目前仍是 z.string().min(1)，穿越拒绝由工厂 + 后端守卫兜底；若收紧为存储 key schema 属 Phase 2 范围外，另行确认。
- 第七轮代码审核（接口/工作区/收敛阶段）修订：规则 3 的 list 签名补 lastModifiedMs；规则 8 澄清短/重操作分类（单帧抽帧=短、雪碧图/代理=重）；派生 TTL 清扫抽公共 derived-cleanup（每前缀节流）；local list 遍历根按前缀首段收窄、临时区排除锚定本后端 baseDir；acquireMediaFile 的 release 改为尽力而为（重试后吞错，防顶替成功响应）；put 零拷贝快路径「发布即消费源文件」契约显式化。
- 第八轮代码审核修订：uploadRoot 锚定回归 resolveFromRoot（修正 cwd 锚定的未授权行为变更）；capture-frame 按规则 8 改为 direct 源交付（路由工厂新增 sourceDelivery 选项，租约/direct 两模式，工厂 ctx 字段更名 sourceInput）；规则 9 枚举半边抽为接口级共享 listDerivedArtifactKeys（backend.ts，S3 后端复用）；接口新增可选 resolveLocalPath 能力，media-source 消除 instanceof 具体类耦合；RENAME_RETRIES / rmQuiet 收敛 fs-utils；initStorageBackend 双初始化守卫（fail-fast）；media-probe 修正 sharp 可吃 URL 的失实注释并补 S3 探测通道（URL 拉成 Buffer）。

- [已完成] 迁移脚本复审修复（2026-10-18）：S3 必填键判定收敛为 `service.missingS3Settings` 单一来源（后端构建与脚本共用）；staging/派生前缀常量单点化到 `backend.ts`（`STAGING_PREFIX`、`DERIVED_ROOT_PREFIXES`，直传/审计/迁移共用）；迁移核心新增 `classifyObjectKey` 命名空间分类器，两侧枚举共用；`hashFile` 收敛为 `hashStream` 的文件流适配；GetObject 读取归一化抽 `openObject`；CLI 参数解析消除双重断言；`stripS3Prefix` 收回模块私有（无第二消费方）；派生降级校验中远端体积不可查由误判通过改为记失败跳过；dry-run 盘点报告照常落盘；「DB 只读」措辞修正为「迁移逻辑零 DB 写入」。

- [已完成] 迁移脚本二轮复审修复（2026-10-18）：续跑日志读取故障仅 ENOENT 视为首跑、其余上抛（消除静默降级为全量重搬的吞噬异常）；staging key 正则改由 `STAGING_PREFIX` 常量转义拼装（前缀调整不漂移）；audit 计数前缀更名 `AUDIT_COUNTED_PREFIXES`（名称与混入 `_tmp` 的语义一致）；CLI 内容清单构建复用单次 `buildStorageKey` 计算；`DERIVED_ROOT_PREFIXES` 注释对齐真实消费方；.gitignore 的 `storage-migration/` 取消根锚定；孤儿判定方向、派生覆盖例外、默认路径锚定三处 spec 措辞对齐实现。

- [已完成] 迁移脚本三轮复审修复（2026-10-18）：前缀归一化抽 `normalizeS3Prefix` 单一实现，`applyS3Prefix`/`stripS3Prefix`/后端构造共用（修复脚本以原始设置值拼前缀、带首尾斜杠配置下对象落入错位命名空间且 ETag 主校验无法发现的缺陷）；dry-run 改为盘点收集全部缺口不中止（中止限定实跑语义，两方向一致）；s3→local 新增 DB 孤儿对账（远端孤儿列入清单不回迁）；哈希+计数抽 `createCountingHash` 单一累加器（hashStream 与 streamToFileWithHash 共用）；新增 dry-run 收集全部缺口（两方向）、前缀归一化等测试。
