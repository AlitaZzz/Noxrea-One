# Media Processing Concurrency Limit

状态：已确认（用户 2026-10-13 确认；第一、二阶段均已实现，未提交）

## 目标

给服务端重型媒体处理（ffmpeg 子进程、sharp 图片缩放）加上**并发上限 + 有界等待队列 + 过载快速拒绝**，防止少数媒体任务占满 CPU / 内存，拖慢全部用户的普通 API 与 SSE；多人共享时保证**按用户公平**——单个用户不能占满全站的重编码能力；过载或限流时，前端给出明确的原因与重试入口，不静默失败。缩略图按固定档位供给、视频海报以每视频一份的高保真母版派生。上限、队列深度、等待时限作为运行期设置落库，沿用 [system-settings-db.md](system-settings-db.md) 的注册表机制。

目标部署环境：NAS 容器，**2 核 CPU / 2 GB 内存**（用户 2026-10-12 提供）。

## 分阶段

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| 一 | 全局媒体池（ffmpeg / sharp）与 503 过载响应、派生产物请求合并与原子落盘、统一取消语义 | 已实现，未提交 |
| 二 | ffmpeg 按任务重量拆为重型 / 轻型两个池；重型池按用户限额；请求次数限流只计产出类编辑并返回 `Retry-After`；缩略图宽度档位化、视频海报高保真母版（落盘时同步生成）与派生产物随源删除清理；前端失败提示、重试、卸载中止与视频节点海报升档（由 Claude 实现） | 已实现，未提交 |
| 三 | 重编码类编辑改为异步任务（提交即返回任务 ID，推送进度） | 另立 Spec，本次不做（已确认决策 16） |

下文业务规则描述第二阶段完成后的目标状态；与第一阶段实现不同的地方注明「第二阶段」。

## 范围

- 媒体处理并发门：ffmpeg 重型、ffmpeg 轻型、sharp 三个独立池，重型池按用户限额（第二阶段；第一阶段为 ffmpeg、sharp 两个池）。
- 11 个系统设置项及其含义（见业务规则 3；第一阶段为 6 个）。
- 派生产物的同键请求合并（single-flight）：缩略图、视频海报、帧序列雪碧图、预览代理；视频完整性体检同样合并。
- 派生产物统一经原子落盘生成；原子写入收敛为存储后端的单一实现，临时文件集中在启动时清空的 `_tmp`。
- 统一的过载 / 限流错误语义与 HTTP 映射：503 表示全站容量耗尽，429 表示个人限额或请求次数超限，均带 `Retry-After`；各调用方按自身性质处理。
- 请求次数限流的计数范围修正：只计产出新文件的编辑接口（第二阶段）。
- 统一的取消语义：排队、等待合并结果、运行中被中止，一律以 `AbortError` 拒绝。
- 缩略图改造（第二阶段）：请求宽度归一化到固定档位；视频海报改为「每视频一份高保真母版（落盘时同步生成）+ sharp 按需派生各档位」；图片维持直接缩放；视频节点海报升为 1280 档。
- 派生产物随源删除清理（第二阶段）：`_cache` / `_posters` 的派生文件在源文件删除时同步清除。
- 前端：媒体面板的失败原因提示、重试入口与卸载中止（第二阶段，见「前端影响」）。
- 并发门的日志可观测性（用于后续压测调参）。

## 非目标

- 不做优先级队列 / 加权公平调度；按用户限额只用于重型池（见「已知限制」）。
- 不做多进程 / 多实例共享的分布式限流（当前单进程；多实例时上限按实例各自生效）。
- 不做运行期热更新（沿用设置快照，改库后重启生效）。
- 不拆分独立媒体 worker 进程、不更换语言或数据库。
- 本 Spec 不把同步媒体接口改造成异步任务（第三阶段另立 Spec，见「演进方向」）。
- 不调整各 ffmpeg 任务自身的超时值与 ffmpeg 参数（如 `-threads`）。
- 不对 `scanFfprobe` 限流（压测后再评估，见已确认决策）。
- 不引入指标 / 监控基础设施（Prometheus 等），以结构化日志对齐。
- 不把媒体处理迁到浏览器（WebAssembly / WebCodecs）——已决策放弃（已确认决策 15），评估记录见「客户端处理评估」。
- 不做缩略图的 DPR / `srcset` 多分辨率适配（前端按需请求更高档位即可，档位表已预留）。
- 不做 `?w=` 缩略图 `<img>` 的失败提示与自动重试（已确认本期不做，见「前端影响」）。

## 现状盘点

### 第一阶段调查：服务端（2026-10-12，均已读代码核对）

- ffmpeg 全部走 [ffmpeg.ts](../server/services/storage/ffmpeg.ts) 的 `executeMediaTool`；超时计时器在 `spawn` 之后才启动，因此排队等待不应计入既有超时。`runFfmpeg` 为产出类（严格语义），`probeFfmpeg` / `runFfprobe` / `scanFfprobe` 为探测类。
- `runFfmpeg` 调用方：`media-ops.ts`（音轨分离、静音视频、片段截取、变速、裁剪）、`video-frames.ts`（截帧、雪碧图、预览代理）、`resize-cache.ts`（视频海报帧）；对应 HTTP 路由均为用户请求触发。
- `probeVideoIntegrity` 对视频**全量解码到 null**，是重型 CPU 操作，且在**上传流程**中执行（`upload.ts` 的 `probeUploadVideo`，处于用户上传并发租约内）。其结果会被缓存，且超时 / 进程未启动被当作「无法判定」并按条件写入缓存。
- 其余 `probeFfmpeg` 调用（`probeAudioDuration`、`probeVideoMeta`）与 `runFfprobe` 只读容器头部，开销很小。
- sharp 使用点共两处：`resize-cache.ts` 的 `getResizedWebP`（流式解码 + 缩放 + 编码 WebP，重）与 `media-probe.ts` 的 `probeImageMeta`（只读元数据头，轻；同时被落盘元数据探测和 `capture-frame` 使用）。
- `/api/files/*?w=` 是最高频的重型入口：`getResizedWebP` / `getVideoPosterWebP` 无同键并发合并，同一未缓存缩略图的 N 个并发请求会各自启动一次 sharp / ffmpeg。
- 失败契约现状：图片缩放失败返回 `null`，路由回退为服务原图；视频海报失败返回 404（`files.file_not_found`）。
- `persist.ts` 的 `prewarmVideoPoster` 是 fire-and-forget；`probePersistedMediaMeta` 失败返回全 null，且 null 会被落库，调用方不重试。
- 已有「按用户并发租约」[concurrency.ts](../server/core/ratelimit/concurrency.ts)：FIFO 队列、队列深度上限（超额抛过载错误，上传路由回 429）、`AbortSignal` 出队、幂等释放；按用户分桶、构造时固定上限、无等待时限。
- 已有 429 先例：`upload.too_many_pending` + `Retry-After`，语义是**单个用户**的上传队列超额。
- `failCode(status, error, ctx, headers)` 接受任意状态码与自定义响应头。
- 设置注册表现有数值类型 `int(default, min)` 与 `positive(default)`，快照同步读取。

### 第一阶段调查：前端（2026-10-12）

**缩略图 `?w=` 的使用面**（均经 `withManagedFileWidth`，见 `web/src/lib/file-url.ts`）：

- 画布内：`VideoNode` 海报（480）、`ImageRefCard`（112 / 480）、`CanvasExplorer`（64）、生成面板缩略图（64 / 128），其中海报与引用卡走 `CanvasImage` + `ImageLoadScheduler`。
- 画布外：素材库 `AssetCard`（300）、`AssetInspector`（400）、`AssetHoverPreview`、`AssetCreateDialog`（200）、项目列表 `ProjectListPage`（480）、导演模式 `Inspector`（320）。

**画布加载路径**（`image-load-scheduler.ts`）：

- 每个画布一个调度器，**并发上限 4**，用探测 `<img>` 加载 URL，60 秒超时；探测结果只有 ready / failed，**读不到 HTTP 状态码与 `Retry-After`**，404、429、503 对它完全等价。
- 失败后进入失败态：`CanvasImage` 显示警示图标 + **手动重试按钮**；**无自动重试**。
- 单个客户端对服务端的缩略图并发约为 `4 × 打开的画布数`；素材库 / 项目列表页是浏览器 `loading="lazy"` 的原生并发，无应用层限制。

**画布外 `<img>` 的失败表现**：`AssetCard`、`AssetCreateDialog` 在 `onError` 中把图片 `display: none`；其余（`ProjectListPage`、`Inspector`、`AssetInspector` 等）无 `onError` 处理，表现为浏览器破图。均无重试，需重新挂载 / 刷新才会再次请求。

**媒体处理 POST 接口**（`web/src/features/canvas/api/file-api.ts`，全部经 `apiRaw`）：编辑类调用方（`VideoNode`、`AudioNode`）检查 `res.ok`，经 `notifyActionFailed` 以 `t("error.<code>")` 翻译，缺失翻译时用调用点兜底文案；无自动重试；节点另有「处理中」忙状态拒绝重复触发。通用错误翻译（`resolveApiError`、`notifyActionFailed`）对**未登记的错误码会退回通用文案**，开发环境额外告警。

### 第二阶段调查（2026-10-13，基于第一阶段实现，均已读代码核对）

起因：用户 10 秒内连续打开截取面板，第 5 次拿不到雪碧图且前端没有任何提示；同时点「抽帧 → 首帧」提示「操作过于频繁，请稍后重试」。

- **请求次数限流**：`createMediaEditRoute` 在入口对 8 个媒体路由（截帧、片段截取、音频片段、音频变速、画面裁剪、分离音轨、雪碧图、预览代理）共用一个按用户限流：20 次 / 60 秒（[media-edit.ts](../server/http/routes/media-edit.ts)）。限流器是滑动窗口（[ratelimit/index.ts](../server/core/ratelimit/index.ts)，每条请求记录 60 秒后过期），计数发生在缓存检查之前：雪碧图 / 代理命中缓存时不跑 ffmpeg，同样扣额度。
- **429 缺 `Retry-After`**：登录、注册、AI 生成、媒体编辑的按次数限流响应都不带 `Retry-After`（`RateLimiter.check` 只返回布尔值）。
- **面板请求**：截取 / 抽帧面板每次打开发 2 个 POST——雪碧图（[use-frame-sprite.ts](../web/src/features/canvas/hooks/use-frame-sprite.ts)）与预览代理（[ClipStripPanel.tsx](../web/src/features/canvas/editing/ClipStripPanel.tsx)、`FrameStripPanel.tsx`），都不带中止信号。开发模式 `reactStrictMode: true`（`web/next.config.ts`）使 effect 双挂载，每次打开实际发 4 个请求，约 5 次打开即用完 20 次额度。
- **恢复时间**：额度按请求逐条过期；10 秒内连续触发后，自第一次请求起 60 秒开始逐个恢复，约 70 秒后全部恢复。面板不会自动重试，恢复后需关闭重开。
- **前端失败表现**：`apiRaw` 不重试、不解析 `Retry-After`。雪碧图失败静默退为「无缩略图但可定位」的轨道，不提示；代理失败只显示「预览代理生成失败，请关闭后重开面板重试」，不区分限流 / 繁忙 / 真失败，也没有重试按钮。截帧由节点工具栏「首帧 / 尾帧」菜单与抽帧面板派发、`VideoNode` 调用接口，失败经 `notifyActionFailed` 按 `error.<code>` 提示（因此抽帧会显示「操作过于频繁」；第一阶段的「`capture-frame` 前端调用方待核实」至此核实）。
- **池不分用户与任务重量**：ffmpeg 池全局 2 槽 / 队列 4。一个用户同时裁剪并打开截取面板（代理 + 雪碧图），即可占满 2 槽并排满队列，其他人收到 503；秒级的海报帧与分钟级的重编码共用槽位。
- **各 ffmpeg 调用的工作量**（读 `media-ops.ts`、`video-frames.ts`、`resize-cache.ts`、`media-probe.ts` 核对）：
  - 随媒体时长线性增长（整段解码 / 重编码）：预览代理（libx264 重编码）、雪碧图（整段解码 + 拼图）、完整性体检（整段解码到 null）、片段截取（libx264 帧精确重编码）、画面裁剪（libx264 重编码）、音频变速（atempo + AAC 重编码）、分离音轨阶段二（源编码装不进 MP4 时重编码为 PCM wav）。
  - 工作量有界或只做流拷贝：视频海报帧（单帧）、截帧（单帧；尾帧先用豁免的 `scanFfprobe` 读包索引）、音频片段（`-c:a copy`）、分离音轨阶段一（`-acodec copy`）、静音视频（`-c:v copy`）。
- **用户归属**：所有整段处理的调用都发生在已鉴权请求内（媒体编辑路由的 `userId`、上传批次 `processUploadBatch` 的 `userId`）；媒体编辑路由校验源存储键首段等于当前用户，同一产物只会被同一用户请求。没有用户归属的调用只有落盘后的海报预热（单帧，轻型）。
- **缩略图调用面**：全部 `withManagedFileWidth` 共 13 处，宽度集合为 64 / 112 / 200 / 300 / 320 / 400 / 480（`CanvasExplorer` 与生成面板参考图 64、`ImageRefCard` 112、`AssetCreateDialog` 200、`AssetCard` 300、导演 `Inspector` 320、`AssetInspector` 与悬浮预览 400、`VideoNode` 海报 / `ImageRefCard` 预览 / `ProjectListPage` 480），无一超过 480。
- **视频海报按宽度重复解码**：同一视频被 N 种宽度请求就跑 N 次 ffmpeg；落盘预热只覆盖 480 一档，且是 fire-and-forget、池忙即静默跳过。批量上传（每批 3 个文件并行）与 AI 下载（Worker 并发 10）落盘时会成批触发预热。
- **派生产物无生命周期清理**：源文件被删除 / GC 后 `_cache` 的派生文件永久残留。雪碧图（`_sprite`）与代理（`_proxy`）的文件名由源键单向哈希派生、有 30 天 TTL 清扫兜底；`_cache` 没有任何清理。
- **视频节点 poster-first**（[VideoNode.tsx](../web/src/features/canvas/nodes/VideoNode.tsx)）：静止态只有海报 `<img>`（480），无 `<video>` 元素、无常驻媒体缓冲；hover 挂载会话元素播放原视频，海报同时垫底防黑场闪烁。画布可缩放，2× retina 屏下 480 海报已不够清晰。
- **异步任务基础设施**（供第三阶段评估）：已有 Worker 循环、SSE 与 `taskWatcher`；任务表 `GenerationTask`（`prisma/schema.prisma`）是 AI 生成专用（模型、协议、提示词、上游任务 ID）；事件总线（`server/services/tasks/event-bus.ts`）只广播任务终态，没有进度事件。

### 未验证推测（需压测 / 实测确认）

- 生产镜像为 `node:20-slim`（glibc），sharp 的 libvips 线程数默认为 1（官方说明 glibc 且未使用 jemalloc 时默认 1，其余平台默认 CPU 核数）。若属实，sharp 池并发 = 实际线程数；Windows 开发环境默认为核数，行为不同。
- sharp 的异步任务运行在 libuv 线程池（默认 4 个线程，`UV_THREADPOOL_SIZE`），与 `fs` 等操作共用。`media.sharp_max_concurrency` 不应达到或超过线程池大小，否则缩放会挤占文件读写（业界通用说明，未实测）。
- 各默认值为按 2 核 2 GB 估计的初始值，需压测后校准。
- 4K 母版的体积（约 1～2.5 MB）与生成耗时（约 1～2 秒）、1280 档体积（约 150～400 KB）与解码位图内存（约 3.5 MB/张）均为估算，实现后实测校准。
- 「第 5 次失败」由请求次数限流导致，是按代码推算的结论：浏览器 Network 中对应的雪碧图 / 代理请求应返回 429、响应体 `{"error":"common.rate_limited"}`，待用户确认。

## 业界对标

以下对照来自通用工程知识（RFC、常见代理 / 弹性库 / 任务队列 / 图片服务的公开行为），**本次未逐一联网核对具体版本细节**，实现前若依赖某一产品的精确行为需再行确认。

| 设计点 | 本方案 | 业界通行做法 |
| --- | --- | --- |
| 并发控制模型 | 有界信号量 + 有界等待队列 + 等待时限 + 快速失败 | Bulkhead 隔离模式：Resilience4j 的 `maxConcurrentCalls` + `maxWaitDuration`、Polly 的 `maxParallelization` + `maxQueuingActions`；Envoy 熔断的 `max_requests` / `max_pending_requests`；图片代理（如 imgproxy）固定 worker 数 + 有界请求队列 |
| 资源隔离 | ffmpeg 重型 / ffmpeg 轻型 / sharp 三个独立池，互不占槽 | Bulkhead 按资源 / 负载类别分池，避免一类负载拖垮另一类；按任务重量划分队列（如 Sidekiq 多队列） |
| 多用户公平 | 重型池两级准入：先取个人名额、再取全局槽位，每人至多 1 个请求进入全局阶段 | 层级 Bulkhead / 按租户并发配额：nginx `limit_conn` 按 key 限并发、BullMQ 分组并发、Sidekiq 按 key 的并发限制、Kubernetes ResourceQuota |
| 缩略图尺寸 | 固定档位、请求宽度向上取档（64/112/200/300/320/400/480/1280） | 图片 / 视频平台普遍以固定尺寸档位供给缩略图并向上取整（如 Next.js Image 的 deviceSizes、imgproxy 的固定宽度列表）：变体数有上限、命中率更高、防止任意宽度刷缓存 |
| 海报母版 | 每视频一次 ffmpeg 解码产出高保真母版，**落盘（ingest）时同步生成**，各档位由 sharp 派生 | 视频平台在 ingest 管线里抽帧生成海报母版再派生整套尺寸（如 YouTube 处理管线的 poster 阶梯），资产就绪前完成，不按尺寸重复解码 |
| 限流对象 | 请求次数限流只计「产出新文件」的编辑接口；幂等、可缓存的预览产物不计；CPU 由并发门保护 | 并发限制保护昂贵资源，速率限制防请求洪泛；可缓存的幂等读取不计入写配额 |
| 过载状态码 | 全站容量耗尽返回 **503**；个人限额与请求次数超限返回 **429**；均带 `Retry-After` | RFC 9110：503 表示服务器临时过载，可带 `Retry-After`；RFC 6585：429 表示**该用户**请求过多，可带 `Retry-After`。Envoy / nginx / HAProxy 的全局过载默认均为 503 |
| 过载响应缓存 | 带 `Cache-Control: no-store` | 失败响应不应被缓存是通行卫生要求 |
| 请求合并 | 同产物 single-flight，引用计数中止 | Go `singleflight`、nginx `proxy_cache_lock`、Varnish request coalescing，防缓存击穿 / 惊群 |
| 队列顺序 | FIFO | 极端过载下可用自适应 LIFO 减少无效等待；本期不采用，保持与现有并发租约一致 |
| 可观测性 | 拒绝与慢等待的结构化日志字段（池名、阶段、原因、active、pending、waitMs） | 通常暴露 active / queued 仪表、rejected 计数器、wait 直方图；日志字段按此命名，将来接入指标时可直接映射 |
| 同步长请求 | 第一、二阶段保持同步契约，加保护层 | 转码类业务主流做法是任务队列 + 进度查询 / 推送（BullMQ、SQS + worker、托管转码服务的作业接口），即第三阶段 |
| 客户端重试 | 不做自动重试；面板提供手动重试，并按 `Retry-After` 显示可重试时间 | 指数退避 + 全抖动、尊重 `Retry-After`、限定次数、仅对幂等请求 |

## 业务规则

### 1. 池与受控范围

三个独立池，互不占用对方槽位（第二阶段；第一阶段为 ffmpeg、sharp 两个池）：

| 池 | 受控调用 | 按用户限额 |
| --- | --- | --- |
| ffmpeg 重型 | 预览代理、雪碧图、完整性体检（`probeFfmpegDecode`）、片段截取、画面裁剪、音频变速、分离音轨阶段二（PCM 回退） | 有：每人同时 1 个、个人排队 2 个 |
| ffmpeg 轻型 | 视频海报母版、截帧、音频片段（copy）、分离音轨阶段一（copy）、静音视频（copy） | 无 |
| sharp | 缩略图派生（视频海报各档位、图片 `?w=` 缩放） | 无 |

豁免（不占槽位、不排队）：`runFfprobe`、`scanFfprobe`、仅读头部的 `probeFfmpeg`（音频时长、视频元数据）、`probeImageMeta`（只读元数据头）。豁免理由：元数据探测开销极小，且落盘元数据探测失败会把 null 永久写库；让它们参与排队 / 拒绝会在高负载下静默丢失元数据。`scanFfprobe` 暂豁免，压测后再评估。

划分原则：CPU 工作量随媒体时长线性增长的（整段解码 / 重编码，含纯音频重编码）归重型；工作量有界（单帧）或只做流拷贝的归轻型。所属池是各调用点固定的属性，由所用入口函数决定，不提供逐次覆盖的开关；重型入口必须带属主用户。

### 2. 获取与释放

1. 槽位在**启动子进程 / 启动 sharp 管线之前**获取；获取成功后才创建超时计时器。既有超时只覆盖运行时间，不含排队时间。
2. 槽位在子进程**真正结束**（`close`，句柄已释放）或 sharp 管线结束 / 失败后释放；超时被 SIGKILL、客户端中断、spawn 失败、异常均必须释放，且重复释放无副作用。
3. 排队者按 FIFO 放行。排队期间 `AbortSignal` 触发：立即出队并以 `AbortError` 拒绝，**不启动子进程**，不占槽位。
   `AbortSignal.reason` 可以是任意值（`@hono/node-server` 在客户端断开时传入的是字符串），不得原样抛出：
   取消一律构造为 `name === "AbortError"` 的错误，原始 reason 放进 `cause`（与 Node 核心 API 的约定一致），
   排队、等待合并结果、运行中被中止三种情况相同，下游按错误名识别取消。
4. 获取阶段有两种拒绝，均**不启动任何处理**：
   - 队列已满（等待者数 ≥ `max_pending`）：立即拒绝；
   - 排队超过 `max_wait_seconds`：出队并拒绝。

   两者用同一错误类型表达（含 `reason: queue_full | wait_timeout` 与池名），不与处理失败混淆。
5. 并发门的核心逻辑（FIFO、队列上限、等待时限、`AbortSignal` 出队、幂等释放）只有 `concurrency.ts` 中的一份实现，全局池与按用户名额共用，禁止另写重复实现。
6. **重型池两级准入**（第二阶段）：
   1. 先取属主用户的个人名额，再取全局重型槽位；释放顺序相反（先全局槽位、后个人名额），都在子进程真正结束后执行，幂等。
   2. 等待时限 `media.ffmpeg_heavy_max_wait_seconds` 从请求到达开始计，个人排队与全局排队合计；进入全局阶段时只剩余下的时间。运行超时仍在两段都拿到之后才开始计时。
   3. 个人阶段被拒（个人排队已满 / 个人阶段等待超时）与全局阶段被拒（全局排队已满 / 全局阶段等待超时）用同一过载错误类型表达，携带 `scope: user | global`，分别映射为 429 与 503（见规则 4）。
   4. 每人至多 `media.ffmpeg_heavy_user_max_concurrency` 个请求进入全局阶段（默认 1），因此全局队列里同一用户至多占 1 位，全局 FIFO 即按用户轮转；同一用户的其余重型请求在个人队列里按 FIFO 等待。
   5. 请求合并下只有生成者占名额：同一产物的搭车请求不占个人名额与全局槽位。
   6. 任一阶段排队中被中止：出队并以 `AbortError` 拒绝，不占名额、不启动子进程。
   7. 获取顺序固定为「个人 → 全局」，任何调用都不会持有槽位再等待另一种名额，不存在循环等待。

### 3. 设置项

设置在注册表 `media` 分组下（命名沿用点分层级 + 单位后缀）。每个池都由三个参数描述：

- **并发上限**（`*_max_concurrency`）：同时运行的任务数。达到上限后新任务排队。
- **排队上限**（`*_max_pending`）：排队等待的任务数上限。排满后新任务立即被拒，不排队、不启动处理。取 0 表示不排队，槽位满即拒。
- **等待时限**（`*_max_wait_seconds`）：任务在队列里最多等多久。超时出队并被拒，不启动处理。只算排队时间，不算运行时间（运行另有各任务自己的超时）。

一个任务到达后的判定顺序：有空闲槽位 → 立即运行；没有空闲槽位且排队数小于排队上限 → 排队（FIFO）；排队已满 → 立即拒绝；排队超过等待时限 → 出队拒绝。例：并发 10、排队 5，同时到达 15 个 → 10 个立即运行、5 个排队，等前面的任务结束后依次运行；同时到达 18 个 → 第 16～18 个立即被拒。

| 键 | 含义 | 类型 / 范围 | 默认值 | 调整的影响 |
| --- | --- | --- | --- | --- |
| `media.ffmpeg_heavy_max_concurrency` | 全站同时运行的重型 ffmpeg 任务数（所有用户合计） | int ≥1 | `2` | 2 核下一路重编码即可打满 CPU。调大：多人同时重编码时排队变短，但每个任务变慢、内存峰值上升（4K 重编码每路可达 1 GB 量级）；调为 1：最省内存，全站重编码串行 |
| `media.ffmpeg_heavy_max_pending` | 全站重型任务的排队上限，计的是已拿到个人名额、在等全局槽位的请求 | int ≥0 | `4` | 每人至多 1 个请求进入这一段，因此它也约等于「最多几个不同用户同时排队」。重型任务均值数十秒、2 路并行：队尾最坏等待约 `4 ÷ 2 × 30s = 60s`，与等待时限对齐；排满后新请求立即 503 |
| `media.ffmpeg_heavy_max_wait_seconds` | 重型请求从到达到开始运行的最长等待，个人排队与全局排队合计 | 定时器秒，>0，≤86400 | `60` | 超时时仍在个人阶段 → 429 `media.user_busy`；已在全局阶段 → 503 `media.busy`。前端是同步长请求，不宜久等 |
| `media.ffmpeg_heavy_user_max_concurrency` | 每个用户同时运行的重型任务数 | int ≥1 | `1` | 1：同一用户的重型任务依次执行，任何用户最多占 1 个全局槽位，其他用户仍可使用其余槽位。取值大于等于 `heavy_max_concurrency` 时个人限额失去作用（等同第一阶段），合法但不推荐；不做跨项校验 |
| `media.ffmpeg_heavy_user_max_pending` | 每个用户在个人队列里排队的重型请求数上限 | int ≥0 | `2` | 2：覆盖「自己有一个任务在跑时打开截取面板（雪碧图 + 代理）」。排满后该用户的新请求立即 429 `media.user_busy`；取 0：自己有任务在跑时，其余重型请求立即 429 |
| `media.ffmpeg_light_max_concurrency` | 全站同时运行的轻型 ffmpeg 任务数（海报母版、截帧、流拷贝） | int ≥1 | `2` | 与重型池互不占用：重编码占满时海报与截帧仍可立即执行。轻型任务通常 1 秒左右，与重型并行时会略微拖慢重编码 |
| `media.ffmpeg_light_max_pending` | 全站轻型任务的排队上限 | int ≥0 | `16` | 单个任务约 1 秒、2 路并行：16 个约 8 秒排空，配合 10 秒等待时限 |
| `media.ffmpeg_light_max_wait_seconds` | 轻型任务的最长排队时间 | 定时器秒，>0，≤86400 | `10` | 海报与截帧是交互式请求，排队过久不如快速失败（503 `media.busy`） |
| `media.sharp_max_concurrency` | 全站同时运行的 sharp 缩放任务数（缩略图派生与图片缩放） | int ≥1 | `2` | libvips 单线程（推测）、2 核；大图 PNG 全量解码可达近 200 MB，2 路并发最坏约 400 MB，在 2 GB 内可接受；同时低于 libuv 线程池默认大小 4，不挤占文件读写 |
| `media.sharp_max_pending` | sharp 缩放的排队上限 | int ≥0 | `64` | 单次缩放通常数十到数百毫秒；画布批量加载（`4 × 画布数` 并发）瞬时涌入，由 10 秒等待时限兜底 |
| `media.sharp_max_wait_seconds` | sharp 缩放的最长排队时间 | 定时器秒，>0，≤86400 | `10` | 缩略图是交互式请求，排队过久不如快速失败 |

- **场景示例**（默认值）：用户 A 正在裁剪（占 A 的个人名额和 1 个全局重型槽位），此时 A 打开截取面板：雪碧图与代理进入 A 的个人队列（2 个），A 的裁剪结束后依次运行；用户 B 同时提交裁剪，直接使用第 2 个全局槽位，不受 A 影响；A 再提交第 4 个重型请求 → 立即 429 `media.user_busy`；A 的面板请求若 60 秒内仍未开始运行 → 429 `media.user_busy`，前端提示并提供重试。
- **校验**：遵循 system-settings-db 的统一规则（非法值启动失败并指明键名）；三个 `*_max_wait_seconds` 属「定时器类时长」，上限 1 天——超出 Node 定时器上限的延迟不会报错，而是被改成 1ms，导致排队请求立即被拒。改库后需重启生效。
- **键名调整**（第二阶段）：第一阶段的 `media.ffmpeg_max_concurrency`、`media.ffmpeg_max_pending`、`media.ffmpeg_max_wait_seconds` 改名为 `media.ffmpeg_heavy_*`，语义收窄为重型池；库中的旧行不再被读取（注册表忽略未定义的键），可手工删除，不做迁移。

### 4. 过载与限流的 HTTP 语义

| 情况 | 状态码 | 错误码 | `Retry-After`（秒） |
| --- | --- | --- | --- |
| 全局重型池排队已满 / 全局阶段等待超时 | 503 | `media.busy` | 5 |
| 轻型池或 sharp 池排队已满 / 等待超时 | 503 | `media.busy` | 1 |
| 个人重型名额排队已满 / 个人阶段等待超时（第二阶段） | 429 | `media.user_busy` | 5 |
| 产出类编辑超过请求次数限流（规则 5，第二阶段） | 429 | `common.rate_limited` | 窗口内最早一次计数到期的剩余秒数 |
| 客户端断开 | 499 | `media.cancelled` | — |

- 过载响应都带 `Cache-Control: no-store`；响应体沿用统一错误结构（`{ error }`，`failCode` 自动带 `requestId`）。
- 503 表示全站容量耗尽，429 表示该用户超出自己的限额，两类语义在日志与前端提示中保持可区分。

| 调用方 | 过载 / 限流时的处理 |
| --- | --- |
| 媒体处理类 HTTP 路由（截帧、截取、变速、裁剪、分离音轨、雪碧图、预览代理） | 返回上表对应响应，前端按错误码提示（见「前端影响」） |
| `/api/files/*?w=` 缩略图（图片缩放、视频海报档位派生） | 503。**不**回退原图 / 原视频（原图上限 100 MB，回退会把 CPU 过载变成带宽洪峰；已确认） |
| 上传流程的视频体检（`probeUploadVideo`） | best-effort：个人（429 语义）与全局（503 语义）两类过载都按「无法体检」处理，跳过 `media_warning`，不使上传失败；**过载不得写入 `integrityCache`** |
| 落盘时的海报母版生成（规则 8，第二阶段） | 过载按「等待超时 / 排队满」处理：不阻塞落盘，记日志后继续，档位首次请求时按需补生成 |
| `prewarmVideoPoster`（fire-and-forget） | 第二阶段删除，由落盘同步生成取代（规则 8） |

### 5. 请求次数限流（第二阶段）

1. 只对**产出新文件**的编辑接口计数：截帧、片段截取、音频片段、音频变速、画面裁剪、分离音轨。额度不变：每人 20 次 / 60 秒，滑动窗口（代码常量）。它的用途是限制单个用户每分钟能产生的派生文件数量（存储增长），不承担 CPU 保护——CPU 由并发门负责。
2. 雪碧图与预览代理**不计数**：两者幂等、可缓存，命中缓存不跑 ffmpeg；需要生成时，CPU 由重型池的个人与全局限额约束，个人排队已满即 429 `media.user_busy`。
3. 被限流时返回 429 `common.rate_limited`，`Retry-After` = 窗口内最早一次计数到期的剩余秒数（向上取整，至少 1）。
4. 同类问题一并修正：登录、注册、AI 生成的按次数限流共用同一限流器，429 同样带 `Retry-After`。

### 6. 派生产物请求合并（single-flight；缩略图部分已确认纳入，其余产物与体检见待确认事项）

对同一产物的并发生成请求做合并，覆盖缩略图与视频海报（`_cache/<w>/<key>.webp`，`getResizedWebP` / 视频海报档位派生）、帧序列雪碧图（`_sprite/`）与预览代理（`_proxy/`）；视频完整性体检（`probeVideoIntegrity`）按同一机制合并同一视频的并发首次问询：

1. 同键同时只执行一次生成，其余请求等待同一结果；合并后的等待者**不占并发槽位、不占队列、不占个人名额**。一次生成只对应一个池槽位。
2. 在途表为进程内 Map，生成结束（成功 / 失败 / 过载拒绝）即移除条目。派生产物的键为 `artifact|<产物存储键>`；完整性体检的键为 `integrity|<视频路径>|<超时预算>`（短预算被杀不写缓存，不能与全预算的结果互相复用）。
3. **中止语义按引用计数**：生成的 `AbortSignal` 不绑定首个请求，而是在**所有等待者均已中止**时才取消；先到的请求断开不得影响仍在等待的其他请求（否则 leader 断开会让所有搭车者失败）。某个等待者自身中止只退出等待，不影响生成。最后一个等待者离开时先从在途表摘除再取消，之后到达的同键请求发起新的生成。
4. 过载拒绝由全体等待者共享：队列满 / 等待超时时，该键的所有等待者得到同一过载结果。
5. 命中检查在合并之前，命中则不进入在途表；进入合并后再复核一次（关闭「入口检查 → 发起生成」之间上一轮同键生成刚落盘的窗口）。命中检查只读，不删除任何文件。
6. 失败不做负缓存：生成失败后条目移除，下一次请求重新尝试。
7. **有效产物 = 非空文件**：生成写出空文件或未写出文件（如 ffmpeg 无输出却正常退出）按生成失败处理，不发布；命中检查用同一规则，0 字节的旧产物不算命中，由新产物原子覆盖。

### 7. 可观测性

- 拒绝（队列满 / 等待超时）记录 `media` 事件日志：池名、阶段（`user` / `global`，第二阶段）、原因、当前活动数（`active`）、等待数（`pending`）、`max_*` 配置；个人阶段的拒绝附带 `userId`。
- 获取槽位时等待超过 1s 记录等待时长（`waitMs`），用于压测调参。
- 日志沿用现有 `logEvent("media", ...)`；字段命名与业界仪表（active / queued 仪表、rejected 计数、wait 直方图）一一对应，将来接入指标体系时可直接映射，本期不新增监控依赖。

### 8. 缩略图宽度档位与视频海报母版（第二阶段）

**档位与归一化**

1. 缩略图宽度固定 8 档：**64 / 112 / 200 / 300 / 320 / 400 / 480 / 1280**。前 7 档来自现有调用点的全部宽度；1280 为视频节点海报新增（画布可缩放、2× retina 屏下 480 已不够清晰；解码位图约 3.5 MB/张，全画布可承受，见「未验证推测」）。请求宽度**向上取到最近档位**，超过 1280 一律按 1280。例：`w=1`→64、`w=100`→112、`w=500`→1280、`w=2048`→1280。`w` 缺失或非法（非数字 / ≤0）沿用现状：不缩放。
2. `?w=` 参数保留：对视频它是「要海报而不是原视频」的信号，对图片是「要缩放而不是原图」的信号；数值只是语义提示，归一化在服务端完成。前端除视频节点海报升为 1280 外，其余 12 处调用点无需改动。
3. 档位表、母版宽度与质量、海报版本号为**代码常量**（结构性参数，不做运行期设置）。将来新增档位：在表中追加即可——母版宽度覆盖到 3840，新增档位不需要重新解码视频。

**视频海报母版**

4. ffmpeg 每个视频**恰好执行一次**：解码首帧，宽度 min(源视频宽度, 3840)、WebP q90 高保真，落为母版 `_posters/v<版本>/<源键去扩展名>.webp`。版本号沿用雪碧图 / 代理的机制：海报参数（宽度上限、质量）变更后整体重生成。
5. **母版在落盘时同步生成**：`persistFileObject` 落库视频时等待母版完成再返回（取代第一阶段的 fire-and-forget 预热）。入库即完备是 ingest 管线的通行做法；母版是全部档位的根，属于必备步骤而非可选优化。生成经轻型池（正常约 1～2 秒；忙时最多等 `media.ffmpeg_light_max_wait_seconds`）；失败或超时**不使落盘 / 上传失败**，记日志后继续，档位首次请求时按需补生成（同一单飞）。
6. 档位文件 `_cache/<档位>/<源键>.webp` 全部由 sharp 从母版派生，按需生成：命中检查 → 单飞合并 → （母版缺失时先补生成母版）→ sharp 缩放（`withoutEnlargement`，小源视频的大档位实际宽度 = 源宽）→ 原子落盘。档位之间互不重复派生（业务规则 6）。旧缓存不迁移：旧档位宽度的缓存文件（旧管线逐宽度生成，画质等同）键不变、继续有效；非档位宽度的旧文件不再被读取，可手工清理。
7. 图片不生成母版：原图即母版，`getResizedWebP` 维持「从原图直接缩放」的现有管线，仅宽度归一化。
8. **视频节点海报升为 1280 档**：`VideoNode` 的 `withManagedFileWidth(src, 480)` 改为 1280；`posterUrl` 同时用于静止态与会话垫底，一处改动两处受益。列表类调用点（300 / 400 / 480 等）保持现档位。

**派生产物随源删除清理**

9. `_posters` 与 `_cache` 的派生路径包含源键：`localStorage.delete` 删除源文件时按前缀同步删除对应派生文件（上传删除与存储 GC 走同一删除入口）。`_sprite` / `_proxy` 的文件名由源键单向哈希派生、无法反查，维持既有 30 天 TTL 清扫兜底。

## 客户端处理评估（WebAssembly / WebCodecs）

**2026-10-13 用户决策：放弃客户端处理方案（已确认决策 15），本节仅作记录，不再作为将来扩容手段。**

结论：本期不采用。外部技术事实为通用工程知识；本次联网检索不可用，未核对具体浏览器版本与性能数据。

| 方案 | 能做什么 | 主要问题 |
| --- | --- | --- |
| ffmpeg.wasm（ffmpeg 编译为 WebAssembly） | 在浏览器里执行与服务端相同的 ffmpeg 命令 | 纯软件编解码、无硬件加速，明显慢于原生；多线程依赖 `SharedArrayBuffer`，需整站开启跨源隔离（COOP / COEP），第三方资源都要配合响应头；输入文件通常要整份放进 wasm 内存，大文件与低内存设备易崩；核心包数十 MB；含 libx264 的构建是 GPL，分发给客户端涉及许可义务 |
| WebCodecs（浏览器原生编解码接口，多数平台可用硬件加速） | 解码 / 编码视频帧；配合 JS 解复用 / 封装库（如 mp4box.js）读写 MP4 | 解复用、封装、时间戳与音画同步都要自建；编码器与音频编码（如 AAC）的可用性随浏览器 / 操作系统 / 显卡而异，产物不一致；服务端仍要保留兜底，形成两套实现 |

项目事实（已核实）：

- 帧序列缩略图曾在浏览器里用隐藏 `<video>` + canvas 逐点 seek 抽帧，因串行 seek 慢、seek 超时、canvas 跨域污染，改为服务端雪碧图（`use-frame-sprite.ts` 文件头）。
- 源文件存放在服务端（单文件上限 100 MB）；浏览器处理需先下载源文件，产物要再上传，服务端仍要落盘、探测与体检。
- 前端目前只在兜底时用 `<video>` 读元数据（`loadedmetadata`）取时长。

逐项判断：

- **产出新文件的编辑**（截取、裁剪、变速）：不推荐。产物要成为文件对象，需完整下载源文件 + 本地编码 + 上传，服务端仍要体检，节省的 CPU 有限；编码器支持与产物一致性无法保证；处理期间标签页必须保持打开。
- **预览代理**：不推荐。客户端转码同样需要整段解码 + 编码，只是把开销挪到客户端；更合理的替代是浏览器直接解码原视频做拖动预览，需原型验证流畅度。
- **帧序列缩略图**：最有潜力（WebCodecs 只需解码约 20 个关键帧），但已随整体方案放弃。

## 演进方向：异步任务（第三阶段，另立 Spec）

**本次不做（已确认决策 16）。**

- 适用范围：产出新节点的编辑操作（片段截取、画面裁剪、音频变速、分离音轨）。雪碧图 / 预览代理是面板交互必需、可缓存的预览产物，截帧 / 海报是秒级任务，保持同步。
- 做法：提交即返回任务 ID（HTTP 202），任务在服务端排队执行；进度经现有 SSE 推送，轮询只作兜底。按用户限额改在任务调度里实现（超额任务排队而不是被拒），同步请求长时间挂起的问题随之消失；用户关闭面板或刷新页面不中断任务。
- 需要新增：媒体任务表（数据库结构变更，`GenerationTask` 是 AI 生成专用，不复用）、Worker 内独立的媒体任务通道（不与 AI 任务共用 `worker.max_concurrency`）、ffmpeg 进度解析与进度事件（现有事件总线只有终态事件）、提交 / 查询 / 取消接口、失败产物清理、重启后的任务恢复；前端把节点「处理中」忙状态改为任务占位 + 进度。

## 技术影响

### 第一阶段（已实现，未提交）

- **设置**：`server/core/settings/registry.ts` 新增 6 个键；无数据库结构变更（键值表自动播种）。两个等待时限使用注册表的定时器类时长类型（上限 1 天）；该类型同时用于其余换算成定时器的既有时长设置，规则与受影响键记录在 `system-settings-db.md`。
- **并发门**：扩展 `server/core/ratelimit/concurrency.ts`，抽出可复用的有界 FIFO 门 `BoundedGate`（上限 + 队列深度 + 等待时限 + `AbortSignal`），按用户租约与全局池共用同一实现。`waitForUserConcurrency` 的签名与排队语义不变，以下随之变化：队列满抛 `GateRejectedError`（不再保留 `ConcurrencyQueueFullError`）；注册表由 `globalThis` 改为模块级变量；释放函数连同空闲清理严格只执行一次（重复调用若再清理一次，会把同一用户随后新建的门从注册表删掉，绕过按用户的并发上限）。
- **ffmpeg 执行器**：在 `executeMediaTool` 的子进程启动前接入 ffmpeg 池。是否占池是各入口固定的内部属性：`runFfmpeg` 与全量解码入口 `probeFfmpegDecode`（`probeVideoIntegrity` 使用）受控；`probeFfmpeg`（仅读头部）、`runFfprobe`、`scanFfprobe` 豁免。不提供任何可逐次传入或覆盖的占池开关。
- **过载错误**：核心层只有 `GateRejectedError`（`reason: queue_full | wait_timeout`）；媒体池把它包装为携带池名与原因的 `MediaPoolBusyError`，路由据池名构造 `Retry-After`。按用户租约的上传队列直接抛 `GateRejectedError`（不设等待时限，只会是队列满），`upload.ts` 据此回 429。媒体池存放于模块级变量，不使用 `globalThis`（多次求值同一模块时旧实例抛出的错误类会让 `instanceof` 失效，过载被当作普通失败吞掉）。
- **取消错误**：`server/core/abort.ts` 提供唯一的 `AbortError`（原始 reason 置于 `cause`）与 `throwIfAborted(signal)`；并发门、请求合并、ffmpeg 执行器、截帧（`capture-frame` 路由、`video-frames.ts`）统一使用，不再出现直接抛出 `signal.reason` 或调用 `signal.throwIfAborted()` 的写法。
- **sharp**：在 `getResizedWebP` 的管线外层接入 sharp 池；`probeImageMeta` 不接入。
- **请求合并**：`media-singleflight.ts` 提供唯一的同键合并实现（引用计数中止；最后一个等待者离开时先从在途表摘除再取消生成）。
- **派生产物生成**：`artifact.ts` 的 `ensureArtifact` 是唯一入口（入参为产物存储键），把「命中检查 → 单飞合并 → 入合并后再复核 → `localStorage.writeAtomic` 原子落盘 → 校验非空」收成一处。图片缩放、视频海报、雪碧图（`/api/files/frame-sprite`）、预览代理（`/api/files/video-proxy`）统一使用；两条路由原有的私有在途表、各自手写的临时文件逻辑与「搭车者遇 leader 失败一律 500」的处理一并移除。雪碧图 / 代理响应里无任何消费方的 `cached` 字段随之移除。
- **原子落盘**：`LocalStorageBackend.writeAtomic` 是唯一的原子写入实现，`save()` 与 `ensureArtifact` 共用：临时文件位于 `<baseDir>/_tmp`（文件名以目标 basename 结尾，保留扩展名，ffmpeg 靠扩展名选封装），rename 遇瞬时占用退避重试，任一步失败清理临时文件。`_tmp` 由 `bootstrap()` 在 HTTP 服务与 Worker 启动之前清空；清空失败只记 warn、不阻断启动。**部署约束**：上传根目录（含 `_tmp` 与各派生目录）必须位于同一文件系统，否则 rename 报 EXDEV。
- **媒体编辑路由**：`createMediaEditRoute` 的请求独享临时目录改为按需创建（`tmpDir()`），雪碧图 / 代理等不使用临时目录的路由不再为每个请求创建再删除目录。
- **完整性体检合并**：`probeVideoIntegrity` 经 `runSingleFlight` 合并同一视频的并发首次问询，并接收调用方的取消信号：雪碧图路由客户端断开且无其他等待者时取消解码。
- **错误码**：`server/core/errors/codes.ts` 注册 `media.busy`；过载响应的构造集中在 `server/http/media-busy.ts` 一处，各路由复用。

### 第二阶段（已实现，未提交）

- **设置**：`media.*` 由 6 个键调整为 11 个（业务规则 3）：`media.ffmpeg_*` 三个键改名为 `media.ffmpeg_heavy_*`，新增 `media.ffmpeg_heavy_user_*` 两个与 `media.ffmpeg_light_*` 三个；无数据库结构变更。`system-settings-db.md` 中对等待时限键的引用同步更新。
- **媒体池**：`media-pool.ts` 管理三个全局池（`ffmpeg_heavy`、`ffmpeg_light`、`sharp`）。重型池的个人阶段复用 `concurrency.ts` 的按用户门，补上等待时限参数，不另写实现。`MediaPoolBusyError` 增加 `scope: user | global`；`failMediaBusy` 按 `scope` 与池名映射 429 / 503 及对应 `Retry-After`。
- **ffmpeg 执行器**：入口按池固定——`runFfmpegLight`（轻型）、`runFfmpegHeavy` 与 `probeFfmpegDecode`（重型，签名要求属主 `owner`）；`runFfmpeg` 拆分后不再存在。各调用点按业务规则 1 的表选择入口。
- **属主传递**：媒体编辑路由把 `userId` 传给 `media-ops.ts` / `video-frames.ts` 的重型函数；雪碧图 / 代理把 `userId` 带进 `ensureArtifact` 的生成函数；上传体检 `probeUploadVideo` 传上传批次的 `userId`；`probeVideoIntegrity` 增加 `owner` 参数。
- **缩略图档位与母版**：`resize-cache.ts` 新增档位归一化（替换 `safeCacheWidth` 的 1..2048 钳位）与视频海报母版模块（`_posters/`：ffmpeg 首帧、min(源宽, 3840)、q90、带版本号）；视频档位派生改为「确保母版 → sharp 缩放（withoutEnlargement）」；`files.ts` 的宽度处理同步替换；`MAX_RESIZE_WIDTH`（2048）由档位上限取代。档位表、母版参数为代码常量。
- **落盘生成母版**：`persist.ts` 删除 `prewarmVideoPoster`（fire-and-forget），`persistFileObject` 对 `video/*` 同步等待母版生成（轻型池，失败 / 超时不阻塞落盘）；上传、AI 下载（`download.ts`）、派生剪辑（`media-edit.ts` 的 `persistDerived`）三条落盘路径一致受益。上传响应时间增加约 1～2 秒 / 视频（估算），受轻型池排队上限与等待时限约束。
- **派生产物清理**：`LocalStorageBackend.delete` 在删除源文件后按前缀清理 `_posters` / `_cache` 下的派生文件；`_sprite` / `_proxy` 维持 TTL 清扫。
- **请求次数限流**：`RateLimiter.check` 返回是否放行与 `retryAfterSeconds`，`checkUserRateLimit` 随之调整；登录、注册、AI 生成、媒体编辑的 429 全部带 `Retry-After`。`createMediaEditRoute` 按路由声明区分「产出类编辑」与「派生预览产物」，只对前者计数。
- **错误码**：新增 `media.user_busy`；中英文案由 Claude 补齐，`web-contract.test.ts` 保证一一对应。
- **前端**：`VideoNode` 海报 `?w=480` → `?w=1280`（一处调用点）；面板中止、失败提示与重试见「前端影响」。
- **测试**：池隔离（重型满时轻型可立即执行）、两级准入（个人满、全局满、两段合计等待时限、个人排队边界、中止；释放顺序为规则 2.6.1 的结构保证，由两级准入行为测试覆盖）、合并不占个人名额、请求次数限流的计数范围与 `Retry-After`、档位归一化、母版一次生成与档位派生、落盘同步生成（含失败不阻塞）、派生产物清理、错误映射；既有用例按新入口与新键名迁移。

## 前端影响

### 已完成（第一阶段）

1. **`media.busy` 的翻译**：`web/src/lib/i18n/zh-CN.json` 与 `en-US.json` 的 `error.media.busy`。
   - zh-CN：「媒体处理繁忙，请稍后重试」
   - en-US：「Media processing is busy. Please try again shortly.」
2. **错误码与翻译的一一对应（已核实）**：`server/__tests__/schemas/web-contract.test.ts` 校验每个服务端登记错误码在 zh-CN / en-US 的 `error` 命名空间都有文案。

### 必须（第二阶段，由 Claude 实现）

1. **卸载即中止**：雪碧图（`useFrameSprite`）与预览代理（截取面板、抽帧面板）的请求都带 `AbortController`，面板卸载或视频切换时中止。开发模式双挂载、快速开关面板不再白白发请求；服务端对被中止的搭车请求只退出等待，仍有其他等待者时生成继续。
2. **雪碧图失败要提示**：不再静默降级。轨道保留「无缩略图但可定位」的兜底能力，同时在轨道上显示原因与「重试」按钮。
3. **代理失败要区分原因**：用按错误码翻译的原因替换笼统的「预览代理生成失败，请关闭后重开面板重试」，并提供「重试」按钮，不必关闭重开面板。
4. **原因文案与重试时机**：按 `error.<code>` 翻译（`common.rate_limited`、`media.user_busy`、`media.busy`、各路由失败码）；响应带 `Retry-After` 时附「约 N 秒后可重试」，倒计时结束前重试按钮不可用。
5. **编辑动作**：截帧、截取、裁剪、变速、分离音轨沿用 `notifyActionFailed`（按节点去重），响应带 `Retry-After` 时文案附带秒数。
6. **新增错误码文案**：`error.media.user_busy`。文案——zh-CN：「你已有媒体处理任务在进行，请等待完成后再试」；en-US：「You already have a media task in progress. Please wait for it to finish and try again.」
7. **不做自动重试**：重试由用户点击触发，避免放大过载。
8. **视频节点海报升档**：`VideoNode` 的 `withManagedFileWidth(src, 480)` 改为 1280。其余 12 处缩略图调用点无需改动——档位归一化在服务端完成，`withManagedFileWidth` 保持原样。

### 本期不做（已确认）

1. **画布外缩略图 `<img>` 过载表现**：`AssetCard`、`AssetCreateDialog` 失败后永久隐藏图片，其余破图；过载时（预计少见：sharp 队列 64、等待 10 秒）用户需刷新。若压测发现过载不罕见，再单独评估为这些位置加失败态 / 重试。
2. **画布失败态的自动重试**：调度器探测 `<img>` 读不到状态码，只能做固定策略的重试。将来若做，按业界通行方式：指数退避 + 全抖动、限定次数（如 2～3 次）、仅用于幂等的 GET 缩略图、保持手动重试按钮；**媒体处理 POST 不自动重试**。无退避的立即重试会放大过载，禁止。
3. 与 [canvas-media-loading-skeleton.md](canvas-media-loading-skeleton.md) 的关系：该 Spec 约定「海报 404 维持失败态契约」。该契约在前端是**状态码无关**的（探测 `<img>` 的 `onerror`），海报过载返回 503 仍落入同一失败态，无需修改该 Spec。

第一阶段「雪碧图 / 代理过载时静默降级可接受」的结论已被第二阶段取代（已确认决策 12）。

## 异常与边界

- 上限设为 1：所有受控任务串行，行为正确，仅延迟变高。
- `max_pending = 0`：不排队，槽位满即拒。
- 排队者数量为 0 且有空槽：直接获取，无额外等待。
- 排队期间客户端断开：出队，不启动处理，不占槽位，不产生日志噪音。`@hono/node-server` 以字符串作为断开原因，同样构造为 `AbortError`，媒体路由回 499 `media.cancelled`，`?w=` 不记失败日志。
- 请求合并下 leader 断开：生成继续，直至所有等待者都已中止才取消；全部中止后由 `writeAtomic` 清理临时文件。
- 生成写出空文件 / 未写出文件：按生成失败处理，不发布、不缓存失败——缩略图 503、雪碧图 / 代理回各自失败码。
- 源文件删除与派生产物生成并发（GC 删除源的同时有档位请求在途）：删除时已存在的派生文件被清掉，但在途生成可能在删除之后才落盘，留下永久孤儿（单文件 KB～MB 级，不再有删除钩子可清）。Windows 上源文件被生成方持有时 unlink 失败、源存活，孤儿不可达；Linux 上可能触发。窗口极窄，按已知限制接受，不为此引入周期清扫。
- 母版生成失败（损坏视频）：落盘照常成功（视频文件本身有效、可播放）；后续档位请求按失败语义返回，下次请求重试，不做负缓存。
- 母版生成期间档位请求到达：与母版共用同一单飞等待，不重复解码。
- 上传 / AI 下载在租约内等待母版：受轻型池排队与等待时限约束，不会无限占用上传租约。
- 小源视频：档位派生不放大，大档位文件实际宽度 = 源宽。
- 进程崩溃 / 重启：池、个人名额与在途表均为进程内存状态，重启归零；残留 ffmpeg 子进程由既有超时 / 中断逻辑回收，不由并发门管理；`_tmp` 中的半成品临时文件在下次启动时清空。
- 上传根目录跨文件系统（如把 `_cache` 单独挂载）：rename 报 EXDEV，相关生成失败；属部署约束，不做跨文件系统复制兜底。
- 上传视频体检：排在该用户自己的重型任务之后，最长等待 `media.ffmpeg_heavy_max_wait_seconds`，超时或排满按「无法体检」处理（上传成功，不写缓存）。
- 一个用户的长任务（如 4K 裁剪数分钟）占住个人名额：该用户后续重型请求在个人阶段等待，超过等待时限得到 429 `media.user_busy`；其他用户不受影响。
- 雪碧图路由一次请求先后做完整性体检与雪碧图生成，两次都是重型任务、各自取放个人名额；两步之间同一用户排队的其他重型请求可以先执行。
- 同一用户多个标签页共享个人名额。
- `probeVideoIntegrity` 超时（`killed`）既有语义不变；过载拒绝发生在启动之前，与超时是两种不同结果。
- 设置值不合法：启动失败并指明键名（统一规则）。

## 已知限制

- 轻型池与 sharp 池不按用户限额：单个用户大量请求海报 / 缩略图仍可排满这两个池（单个任务短、等待时限 10 秒，影响有限）。
- 仍是同步请求：排队期间 HTTP 连接一直挂着，前端同步等待；第三阶段异步化后解决。
- 同一用户的雪碧图与代理依次生成：首次打开截取面板变慢（约为两者耗时之和）。
- 落盘同步生成母版使上传 / 下载路径每视频增加约 1～2 秒（估算，受轻型池约束）。
- 每个视频永久多存一份母版（4K 源约 1～2.5 MB，估算）：约为视频自身体积的 1%；超过 4K 的源按 3840 封顶。
- 2 核下重型 2 路 + 轻型 2 路 + sharp 2 路同时运行时 CPU 超额分配：轻型与 sharp 任务短，可接受；内存峰值主要来自重型池，必要时把 `media.ffmpeg_heavy_max_concurrency` 调为 1，并建议为容器设置内存限制以免拖垮整机。
- 多实例部署时上限按实例生效，总并发 = 实例数 × 上限。
- 默认值未经压测，可能偏保守或偏宽松。

## 验收标准

### 第一阶段

- 任意时刻受控 ffmpeg 进程数 ≤ 池并发上限，受控 sharp 缩放数 ≤ `media.sharp_max_concurrency`（并发门单元测试用可控延迟的假任务验证，含 FIFO 顺序）。
- 队列已满时，新请求立即被拒且**未启动**子进程 / sharp 管线；等待超时同理，并从队列移除。
- 排队中的请求触发 `AbortSignal`：出队、不启动处理、不泄漏槽位。
- 排队、等待合并结果、运行中被中止，均以 `name === "AbortError"` 的错误拒绝，中止原因为字符串时同样如此（原因置于 `cause`）；派生产物路由的发起者以字符串原因断开时回 499。
- 超时被杀、客户端中断、spawn 失败、处理异常后槽位均被释放，后续任务可继续获取。
- 既有 ffmpeg 超时只覆盖运行时间：排队 N 秒的任务仍享有完整超时预算。
- 豁免路径（ffprobe、`scanFfprobe`、头部探测、`probeImageMeta`）在受控池已满时仍能立即执行。
- 请求合并：同一产物的 N 个并发请求只触发一次生成、只占一个槽位；leader 先中止而其余等待者仍在时生成不被取消，全部等待者中止才取消；过载拒绝由全体等待者共享；失败后条目移除，下一次请求可重新生成。
- 派生产物：生成出空文件 / 未写出文件时不发布产物；命中检查不删除任何文件，0 字节旧产物由新产物原子覆盖；临时文件位于 `_tmp`、保留扩展名，成功与失败后均不残留。
- 过载响应：媒体路由与 `?w=` 缩放返回 `503` + `media.busy` + `Retry-After` + `Cache-Control: no-store`；上传视频体检过载时上传仍成功；过载不写入 `integrityCache`；按用户的上传限额仍为 429（不回归）。
- 设置项存在于 `system_settings`，默认值正确，并发上限取 0 / 等待时限超过 1 天等非法值导致启动失败并指明键名，队列深度允许取 0。
- 既有 `waitForUserConcurrency` 与上传并发相关测试不回归；重复释放旧租约不影响同一用户之后新建的门。
- `_tmp` 在 HTTP 服务与 Worker 开始写入之前清空；不使用临时目录的媒体路由不创建临时目录。
- 前端：`error.media.busy` 在 zh-CN 与 en-US 中均存在。

### 第二阶段

- 池隔离：重型池占满时，海报母版、截帧、流拷贝类任务仍可立即执行；轻型池占满时，重型任务不受影响。
- 按用户限额：同一用户同时最多 1 个重型任务运行，第 2、3 个在个人队列等待，第 4 个立即 429 `media.user_busy`（带 `Retry-After`）；此时另一用户的重型请求可立即使用剩余全局槽位。
- 等待时限覆盖两段合计：个人阶段超时返回 429 `media.user_busy`，全局阶段超时返回 503 `media.busy`；任一阶段排队中止都不占名额、不启动子进程；释放后同一用户的下一个请求可继续获取。
- 请求合并：同一产物的搭车请求不占个人名额。
- 请求次数限流：雪碧图 / 代理（含命中缓存）不计数；产出类编辑超过 20 次 / 60 秒返回 429 `common.rate_limited` 与正确的 `Retry-After`；登录、注册、AI 生成的 429 同样带 `Retry-After`。
- 缩略图档位：任意宽度向上取档（`w=1`→64、`w=100`→112、`w=500`→1280、`w=2048`→1280）；缓存全冷时并发请求同一视频全部档位，ffmpeg 恰好执行 1 次（母版），各档位由 sharp 各派生一次；再次请求全部命中缓存。
- 海报母版：宽度 = min(源宽, 3840)、WebP q90、`_posters/` 带版本号；视频落盘时同步生成（轻型池忙 / 超时不阻塞落盘，失败记日志）；`prewarmVideoPoster` 不复存在。
- 节点海报：`VideoNode` 请求 `?w=1280`。
- 派生产物清理：删除源视频 / 图片后，`_posters` 与 `_cache` 下对应派生文件同步清除；`_sprite` / `_proxy` 维持 TTL 清扫。
- 设置：11 个键存在于 `system_settings`、默认值正确、非法值启动失败并指明键名；第一阶段旧键不再被读取。
- 前端：面板卸载 / 视频切换时中止雪碧图与代理请求；雪碧图、代理失败均显示按错误码翻译的原因与重试按钮，带 `Retry-After` 时显示倒计时；编辑动作的失败提示附带秒数；`error.media.user_busy` 中英文案存在（`web-contract.test.ts` 通过）；`VideoNode` 海报为 1280 档。
- 第一阶段验收标准全部保持。
- 服务端与前端类型检查、lint、相关测试通过（串行执行）。
- 压测验证（人工，在 2 核 2 GB 目标环境）：缩略图突发（模拟多用户 × 每画布 4 并发）与多用户并发视频重编码分别施压，确认普通 API 与 SSE 延迟不被拖垮、单用户无法挤占他人、容器内存峰值在安全范围内、429 / 503 比例可接受，并据日志校准默认值。

## 已确认决策

用户 2026-10-12 确认（"按建议来"）：

1. **缩略图请求合并纳入本期**，中止语义按引用计数（见业务规则 6）。
2. **过载时图片缩放不回退原图，返回错误响应；视频海报同样返回错误响应**。状态码经业界对标后细化为 **503**（全局容量过载），原先建议的 429 保留给按用户的限额。
3. **`scanFfprobe` 暂豁免**，压测后再评估是否计入 ffmpeg 池。
4. **默认值采用 2 核 2 GB 初始值**：ffmpeg 2 / 4 / 60s，sharp 2 / 64 / 10s，`Retry-After` 5 / 1 秒（第二阶段沿用为重型池与 sharp 池的取值）。
5. **`media.busy` 前端文案与落点**：`error.media.busy`，文案见「前端影响」。
6. **前端可选项本期不做**（画布外缩略图失败态、自动重试、代理 / 雪碧图降级后恢复），将来按「前端影响」中的业界做法实现。其中「代理 / 雪碧图降级后恢复」已被决策 12 取代。

用户 2026-10-13 在第三轮代码审查后回复「从根因修复这些问题」，按审查报告中的建议执行：

7. **原子落盘收敛为单一实现**：`LocalStorageBackend.writeAtomic` 供上传保存与派生产物共用，临时文件统一放 `_tmp`，在 HTTP 服务与 Worker 启动之前清空；部署须保证上传根目录位于同一文件系统。
8. **定时器类时长加上限**：换算成定时器延迟的时长设置统一上限 1 天，同步修改 [system-settings-db.md](system-settings-db.md)（该 Spec 因规则变更回到待确认）。
9. **全量解码探测改为独立入口** `probeFfmpegDecode`，固定占 ffmpeg 池，删除逐次可传的 `heavy` 开关。

用户 2026-10-13 针对「截取面板第 5 次拿不到雪碧图且无提示」回复「按你的建议来，先写 Spec」：

10. **第二阶段按建议推进**：先修请求次数限流（只计产出类编辑、429 带 `Retry-After`）与前端提示，再做 ffmpeg 池拆分与重型池的按用户限额；异步任务化为第三阶段，另立 Spec。
11. **同一用户超出个人名额时排队**：个人排队深度 2，等待时限与全局一致且两段合计计时，排满或超时返回 429 `media.user_busy`。
12. **前端必须给出提示，从根因解决**：雪碧图 / 代理失败按错误码显示原因并提供重试，面板卸载时中止请求，不再静默降级。
13. **设置项含义写入 Spec**（业务规则 3）。

用户 2026-10-13 继续确认（缩略图设计讨论）：

14. **前端改由 Claude 实现**（取代「前端代码由用户自行实现」的原分工）。
15. **放弃客户端处理（WebAssembly / WebCodecs）**，不再作为将来扩容手段；「客户端处理评估」留作记录。
16. **第三阶段（异步任务）本次不做**，保留演进方向另行启动。
17. **轻型池保留，不按用户限额**（2 / 16 / 10 秒）。
18. **缩略图档位化与海报母版**：档位 = 现有调用点的 7 个宽度 + 视频节点海报新增 1280，请求宽度向上取档；视频海报每视频一次高保真母版（宽度 min(源宽, 4K=3840)、WebP q90），8 档全部由 sharp 派生，图片不加母版；**母版在落盘时同步生成**（ingest 管线通行做法），取代 fire-and-forget 预热；旧缓存不迁移。
19. **派生产物随源删除清理纳入第二阶段**：`localStorage.delete` 按前缀清理 `_posters` / `_cache`（`_sprite` / `_proxy` 维持 TTL）。

用户 2026-10-13 确认 Spec 并下令实现：

20. **Spec 整体确认**（含音频变速 / PCM 回退归重型池）；**轻型池不按用户限额**（与业务规则 1 一致，经用户再次确认）；实现不需要向后兼容，从根因实现。

用户提供的输入：目标环境为 2 核 CPU / 2 GB 内存；磁盘相对充裕（NAS），CPU / 内存是稀缺资源，权衡时可用存储换 CPU。

## 待确认事项

无。（原待确认 1「第一阶段范围扩展」与 2「音频变速 / PCM 回退归重型池」随 Spec 于 2026-10-13 一并确认；轻型池不按用户限额经用户再次确认，见已确认决策 20。）

## 当前状态

已确认（用户 2026-10-13）。第一阶段与第二阶段均已实现、未提交；「已确认」状态由用户设置。

第二阶段实现与验证情况（2026-10-13）：

- 已实现：三池与重型池两级准入（`acquireHeavySlot`：个人名额 → 全局槽位，等待时限两段合计，`MediaPoolBusyError.scope` 区分 429 / 503）；11 个设置项（`media.ffmpeg_heavy_*` / `media.ffmpeg_heavy_user_*` / `media.ffmpeg_light_*` / `media.sharp_*`）；ffmpeg 入口拆分（`runFfmpegHeavy` / `runFfmpegLight` / `probeFfmpegDecode` 均要求属主）；缩略图 8 档归一化（`normalizeResizeWidth`）与视频海报母版（`_posters/v1/`，min(源宽, 3840) q90，`persistFileObject` 落盘同步生成、失败不阻塞）；档位全部由 sharp 从母版派生；`localStorage.delete` 前缀清理 `_cache` / `_posters`；`RateLimiter.check` 返回 `retryAfterSeconds`，登录 / 注册 / AI 生成 / 媒体编辑的 429 全部带 `Retry-After`，`createMediaEditRoute` 只对产出类编辑计数（雪碧图 / 代理 `persistsFileObject: false`）；`media.user_busy` 错误码与中英文案；前端：面板请求卸载中止、雪碧图 / 代理失败原因与手动重试（`MediaRetryNotice`，`Retry-After` 倒计时禁用重试）、编辑动作失败提示附秒数、`VideoNode` 海报升 1280。
- 已验证：服务端与前端类型检查、lint 通过；全量服务端测试 66 个文件 / 673 个用例通过（`FFMPEG_TEST_DIR=bin`，单 worker；真实 ffmpeg 场景覆盖：重型池全局上限 / 排队 / 超时 / 中止，海报母版每视频只解码一次、**并发请求全部 8 档**由 sharp 派生并各自落盘、再次请求全部命中）；web 测试 124 个文件 / 902 个用例通过（含 `VideoNode` 海报 1280 断言、错误码-翻译一一对应）。
- 第四轮代码审查修复（2026-10-13，用户确认后）：倒计时 interval 归零自停；落盘母版过载补记视频键上下文日志（对齐规则 4「记日志后继续」）；限流 429 补 `Cache-Control: no-store`（media-edit / auth / generate / upload 队列）；个人阶段拒绝日志经 `getUserGateCounts` 补 `active` / `pending`（规则 7）；补测试：限流路由级（产出类 429 + 头断言、预览产物不计数）、登录 / 注册限流头断言、个人排队边界 `user_max_pending=2`、合并不占个人名额、超档宽度 500→1280 落盘。
- 第五轮代码审查修复（2026-10-13，用户确认后）：删除 MediaRetryNotice 中残留的 `waiting` effect（第 4 轮修复不彻底，interval 仍在归零后空转）；面板与雪碧图请求的失败 catch 区分「本组件中止」与「真实网络失败」——后者进入失败态并带 `network_error` 原因与重试入口，不再永久卡在加载中；`upload.too_many_pending` 429 补 `no-store`；错误映射测试独立用户与源文件（限流键按 userId 隔离，预算不再贴边）；补测试：等待时限两段合计（个人阶段消耗的预算从全局余量扣除）、雪碧图 / 代理路由全程不接入限流（含缓存命中）、并发全档位单次解码与复请求命中。
- 未验证：2 核 2 GB 目标环境的压测（默认值校准）；前端失败路径的面板浮层（429 / 503 时的提示与倒计时）未在真实浏览器中人工走查——该路径需要把媒体池填满才能触发，现有覆盖为组件级单测；sharp 生产镜像线程数假设。
- 已知未处理：`produceImageWebP` / 档位派生在 abort 时 `pipeline` 一旦拒绝即释放 sharp 槽位，libvips 可能尚未收尾（未复现，影响低，见「已知限制」）。

第一阶段实现与验证情况（2026-10-13，第三轮代码审查修复后）：

- 已实现：6 个设置项（等待时限受定时器类时长上限约束）、`BoundedGate` 与媒体池、ffmpeg / sharp 接入（全量解码走 `probeFfmpegDecode`）、统一的取消错误（`server/core/abort.ts`）、统一的派生产物生成（`ensureArtifact` + `LocalStorageBackend.writeAtomic`，含雪碧图 / 代理路由迁移与空产物校验）、`_tmp` 在 `bootstrap()` 中先于 HTTP 服务与 Worker 清空、媒体路由临时目录按需创建、完整性体检合并与取消、503 过载响应、预热与上传体检的过载处理、前端 `error.media.busy` 翻译。
- 已验证：服务端类型检查、lint 通过；全量服务端测试 65 个文件 / 643 个用例通过（`FFMPEG_TEST_DIR=bin`，单 worker；含真实 ffmpeg 的并发实测：10 并发 + 队列 5 + 同时 15 个 → 10 个运行 5 个排队全部成功；队列 3 → 2 个立即拒绝；等待超时与排队中止均不启动子进程）。真实 ffmpeg 用例需 `FFMPEG_TEST_DIR` 指向含 ffmpeg 的目录（`media-pool-concurrency` 缺省用仓库 `bin/`，`video-frames` 缺省会整体跳过）。两个回归用例做过变异验证：去掉租约释放的一次性守卫、或让请求合并的等待者原样抛出字符串原因，对应用例均失败。
- 未验证：2 核 2 GB 目标环境的压测（默认值与 OOM 风险）、sharp 在生产镜像内的线程数假设、ffmpeg 对海报 / 雪碧图命令实际产出空文件的条件（空产物校验按通用规则实现，未用真实坏视频复现）。
- 已知未处理：`produceImageWebP` 在 abort 时 `pipeline` 一旦拒绝即释放槽位，libvips 可能尚未收尾，sharp 并发上限可能短暂被超出（未复现，影响低）。
- 已知无关问题：`server/__tests__/http/routes/canvas.test.ts` 在单 worker 全量运行下随测试顺序偶发套件级失败（pino 日志级别为 undefined），在未包含本次改动的 HEAD 上同样复现，不属于本需求。

调查范围：

- 第一阶段：`server/services/storage/{ffmpeg,media-ops,media-probe,resize-cache,video-frames,upload,persist}.ts`、`server/http/routes/files.ts`、`server/core/ratelimit/concurrency.ts`、`server/core/response/index.ts`、`server/core/settings/registry.ts`、`specs/system-settings-db.md`；前端 `web/src/lib/file-url.ts`、`web/src/lib/api/{client,error-message}.ts`、`web/src/features/canvas/{api/file-api.ts,services/image-load-scheduler.ts,shared/{CanvasImage,notify}.ts*,nodes/{VideoNode,AudioNode}.tsx,hooks/use-frame-sprite.ts,editing/ClipStripPanel.tsx}` 及所有 `withManagedFileWidth` 使用点。
- 第二阶段：`server/core/ratelimit/index.ts`、`server/http/routes/{media-edit,auth,generate,upload}.ts`、`server/services/storage/{media-ops,video-frames,upload,persist,gc}.ts`、`server/services/storage/backends/local.ts`（delete 路径）、`server/http/file-response.ts`、`prisma/schema.prisma`、`server/services/tasks/event-bus.ts`；前端 `web/next.config.ts`、`web/src/lib/api/client.ts`、`web/src/features/canvas/hooks/use-frame-sprite.ts`、`web/src/features/canvas/editing/{ClipStripPanel,FrameStripPanel}.tsx`、`web/src/features/canvas/nodes/{VideoNode,NodeToolbar}.tsx`、全部 `withManagedFileWidth` 调用点（13 处，含 `web/src/features/{project,assets,director}`）、`web/src/lib/i18n/zh-CN.json`。
- 未调查：「业界对标」与「客户端处理评估」中的第三方产品行为与浏览器支持未联网逐项核对（本次联网检索不可用）。
