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
     2. 客户端**流式计算 SHA256/MD5**（hash-wasm 等增量实现，避免大文件整读内存——`crypto.subtle.digest` 需整 Buffer）后 `PUT` 到预签名 URL（可重试，同 URL 同内容幂等）；
     3. `POST /api/files/upload-complete`（服务端 HeadObject 校验 size + ETag(MD5)——前提见「Bucket 初始化清单」，不满足时降级为重读哈希；**CopyObject 将 staging 对象提升到内容寻址 key**——同 bucket 服务端复制不出网 → 拉流复算 SHA256 + 内容嗅探 + XML 拦截 + 媒体探测 → 不符即删提升对象并拒绝；通过则 upsert `file_objects`）。

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
   - `AllowedHeaders`：`Range`、`Content-Type`、`Content-MD5`（与 presign 签名的请求头保持一致；缺 `Content-MD5` 时直传 PUT 会被 CORS 拦截）；
   - `ExposeHeaders`：`Content-Length`、`Content-Range`、`Content-Type`、`ETag`（服务端复验需要读到 ETag）；
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
- [进行中] S3 后端 + 启动探测 → 迁移脚本 → 切换演练。
- 后续小项：media-edit 各路由 schema 的 video_key/audio_key 目前仍是 z.string().min(1)，穿越拒绝由工厂 + 后端守卫兜底；若收紧为存储 key schema 属 Phase 2 范围外，另行确认。
- 第七轮代码审核（接口/工作区/收敛阶段）修订：规则 3 的 list 签名补 lastModifiedMs；规则 8 澄清短/重操作分类（单帧抽帧=短、雪碧图/代理=重）；派生 TTL 清扫抽公共 derived-cleanup（每前缀节流）；local list 遍历根按前缀首段收窄、临时区排除锚定本后端 baseDir；acquireMediaFile 的 release 改为尽力而为（重试后吞错，防顶替成功响应）；put 零拷贝快路径「发布即消费源文件」契约显式化。
- 第八轮代码审核修订：uploadRoot 锚定回归 resolveFromRoot（修正 cwd 锚定的未授权行为变更）；capture-frame 按规则 8 改为 direct 源交付（路由工厂新增 sourceDelivery 选项，租约/direct 两模式，工厂 ctx 字段更名 sourceInput）；规则 9 枚举半边抽为接口级共享 listDerivedArtifactKeys（backend.ts，S3 后端复用）；接口新增可选 resolveLocalPath 能力，media-source 消除 instanceof 具体类耦合；RENAME_RETRIES / rmQuiet 收敛 fs-utils；initStorageBackend 双初始化守卫（fail-fast）；media-probe 修正 sharp 可吃 URL 的失实注释并补 S3 探测通道（URL 拉成 Buffer）。
