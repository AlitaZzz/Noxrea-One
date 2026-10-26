# Storage 签名直连分发（Storage Signed Direct Delivery）

状态：已确认（2026-10-23 用户确认原版；**2026-10-26 修订版**——批量描述、签名寿命与刷新协议、描述结果持久化缓存、安全响应头——经用户确认，实现已提交 `023f6489` / `b99e6855`；「已实现」待浏览器验收后设置）

上游与关联：

- [storage-s3-backend.md](storage-s3-backend.md)（已实现）：双凭据模型、预签名能力、bucket CORS 前置。
- [storage-s3-delivery-caching.md](storage-s3-delivery-caching.md)（已废弃，2026-10-24）：签名窗口机制与能力凭据规则已并入本 Spec 规则 4；该 Spec 只保留「302 时代」的实测证据作历史记录。
- [storage-edge-cache-delivery.md](storage-edge-cache-delivery.md)（已废弃，2026-10-24）：本 Spec 取代其浏览器读路径与共享缓存方案；该 Spec 只保留为「边缘共享缓存」方向的否决记录。
- [file-access-ownership.md](file-access-ownership.md)（已实现）：归属解析与双凭据语义不变。
- [canvas-image-http-url-rendering.md](canvas-image-http-url-rendering.md)（已确认）：显示 URL 的缓存与调度语义；本 Spec 修订「URL 长期不变」的前提。
- [canvas-media-resolution-lod.md](canvas-media-resolution-lod.md)（已确认）：`w` 档位派生不变。
- [auth-request-verification.md](auth-request-verification.md)（已确认）：请求鉴权的账号状态校验改由 Redis 快照承载，本 Spec 的描述接口依赖其结果（不感知实现）。
- [storage-provider-portability.md](storage-provider-portability.md)（已确认）：`presignGet` 的 `response-*` 覆盖与 CORS 可用性由 provider 探测的能力位决定。
- 参考实现（只读调查，2026-10-23）：`H:\infinite-canvas\open-ai-canvas-main` 的 `backend/internal/assets/access.go`、`backend/internal/handler/resource_delivery.go`、`web/src/services/api/resources.ts`。

## 目标

1. **浏览器读路径零 302**：图片/视频/音频/下载直接向对象存储取字节，应用不再先返回一次跳转。
2. **应用只签发访问描述，不搬字节**：S3 后端下应用带宽与并发不随媒体流量增长。
3. **缓存有效**：同一对象在签名窗口内签出字节一致的 URL，浏览器 HTTP 缓存跨刷新命中。
4. **鉴权仍由应用单点判定**：归属判定不变；签名 URL 是签发时授权的能力凭据。
5. **配置面最小**：不新增任何设置项，删除现有分发/窗口/边缘键；行为由后端类型唯一决定。
6. **移除不再成立的机制**：302 分发、可信边缘密钥与授权回调、共享边缘缓存。

## 范围

1. 新增访问描述接口：`POST /api/files/access`，请求体为 `items` 数组（1–50 条，逐条 key/width/download/filename），只返回描述，不返回字节（2026-10-26 修订：单条 → 批量，见规则 2.1/2.8）。
2. 删除 `storage.s3.delivery`、`storage.edge.origin_secret`、`storage.s3.signed_url_ttl_seconds`、`storage.s3.signed_url_window_seconds`；签名 TTL/窗口改为代码常量。
3. 前端统一访问地址解析层（内存缓存 + `signed` 描述持久化、账号作用域、批量合并）与全部托管媒体消费点迁移。
4. 不做可信边缘（实施订正 2026-10-25：`server/http/edge.ts`、`server/http/routes/files-authz.ts` 等从未进入任何提交，见规则 6.3）。
5. 缓存头收敛：会话/流式 `private`；能力凭据 `public` 且寿命封顶到签名剩余有效期；描述响应 `no-store`。
6. 不引入 `rv` 缓存击穿参数（用户 2026-10-24 确认整体删除；该参数只存在于 LOD Spec 的规划中，从未进入提交）：`signed` 的最终地址是预签名对象 URL，版本段已在对象 key 内（`_cache/v2/...`），`rv` 冗余；`stream` 的版本失效按下述已知边界承担。

## 非目标

- S3 后端的应用代理模式（本 Spec 后 S3 只有签名直连；需要应用转发时使用 `local` 后端）。
- 批量描述接口**已纳入本版**（2026-10-26 用户决策，取代 2026-10-23 的「暂不做」，见规则 2.8）。
- CDN 交付、AVIF、TanStack Query 收拢：另立 Spec，不在本版。
- CDN 供应商选型、签名 Cookie、独立资产域名。
- 公开分享/匿名访问（当前产品没有公开分享入口）。
- 上游 AI 引用交付的形态（`storage.upstream_ref_delivery` 保留；TTL 改用同一常量）。
- 存储 key 形态、归属解析、派生 key 版本、LOD 档位规则。

## 背景与现状（已验证事实）

### 当前浏览器读路径

- 画布媒体最终派生为 `/api/files/{key}?w=<档位>`（[shared/url.ts](../shared/url.ts)、[web/src/lib/file-url.ts](../web/src/lib/file-url.ts)）。
- 路由先做双凭据与归属判定，再按 `w` 生成/命中派生图，`stat` 后按 `storage.s3.delivery` 分发（[files.ts](../server/http/routes/files.ts)）：
  - `redirect`：返回 302 到预签名 GET，`Cache-Control: no-store`；浏览器再向 bucket 发起第二次请求。
  - `proxy`：应用流式返回字节（Range 206/416）。
- 实测（2026-10-23，上游 Spec 记录）：90 图页面每次加载 90 个 302；单次 302 p50 17 ms，90 并发整轮 204–344 ms；302 响应的头字节约 90 KB/次加载。302 因 `no-store` 永不命中浏览器缓存。
- 302 不能改为可缓存：CDP 实验证明 Chrome 对 `<img>` 子资源的私有缓存不按 `Vary: Cookie` 分区，缓存 302 会把用户 A 的预签名 Location 交给用户 B（能力凭据泄漏）。
- 签名窗口机制已实现：`presignGet` 的签名时间对齐 epoch 窗口，窗口内同一 key 的 URL 字节一致；响应可带 `response-cache-control`（[s3.ts](../server/services/storage/backends/s3.ts)）。
- 现有设置（[registry.ts](../server/core/settings/registry.ts)）：`storage.s3.signed_url_ttl_seconds`（3600，同时供上游引用与媒体源）、`storage.s3.delivery`（`redirect|proxy`）。规划中的 `storage.s3.signed_url_window_seconds`（86400）与可信边缘 `storage.edge.origin_secret` 从未进入 registry（见规则 6.1 的实施订正）。可信边缘方案本 Spec 取代。
- 派生 key 已带 `_cache/v2/` 版本段，升级版本即换对象 key；原设计的 `rv` 缓存击穿参数从未进入提交，经 2026-10-24 评估整体删除（`signed` 下版本段已在 URL 内，`stream` 下的失效边界见规则 6.5）。

### 参考实现的成熟做法（只读代码调查）

- 浏览器主链路：`POST /api/resources/access` 取访问描述，描述里直接是 CDN/对象存储签名 URL；`<img src>` 使用该 URL，应用不参与字节传输，也没有 302。
- 签名时间按 `ttl/4` 的 epoch 窗口对齐，同一窗口内 URL 逐字节一致；签名 URL 带 `response-cache-control: private, max-age=<窗口寿命>, immutable`（窗口寿命 = TTL，见规则 4.3），浏览器缓存真正生效。
- 稳定的 `/api/resources/:id/file` 仅作兜底：云媒体返回 307 到签名地址，附件/私有源站走应用流；nginx 没有 `auth_request` / `proxy_cache`，不存在自建边缘层。
- 代价：撤销只能等 TTL；依赖 bucket 公网可达与 CORS；跨用户共享缓存不可用。

### 行业对照

| 做法 | 采用方 / 标准 | 与本方案的关系 |
| --- | --- | --- |
| 对象存储预签名 GET 直连 | AWS S3 presigned URL、GCS signed URL、Azure SAS、阿里云 OSS 签名 URL | 本方案主体；浏览器拿 URL 直接取字节 |
| CDN 签名 URL / 签名 Cookie | CloudFront signed URL / signed cookies、Cloudflare / Akamai token | 后续接入 CDN 时的同一模型，不在本期 |
| 应用代理字节 | Nextcloud X-Sendfile、Immich、PhotoPrism；未上 CDN 的自托管部署 | 本方案 `local` 后端的流式路径 |
| 边缘逐请求授权 + 共享缓存 | nginx `auth_request` + `proxy_cache`、CloudFront + Lambda@Edge | 原边缘方案；本 Spec 移除 |
| 预签名 302 | 下载、上传、API 间传递 | 本 Spec 移除浏览器读路径上的这一形态（302 不可缓存） |

## 方案

### 1. 分发由后端类型决定（无开关）

1.1 `storage.backend=local`：描述返回应用 URL（`delivery: "stream"`），`/api/files/*` 流式返回字节（Range 206/416）。

1.2 `storage.backend=s3`：描述返回预签名 GET（`delivery: "signed"`），浏览器直连 bucket。

1.3 S3 端点必须能被浏览器访问；不可达时由部署方改用 `local` 后端。不做自动探测、不保留 S3 代理模式、不静默降级。

1.4 非描述请求（直接访问 `/api/files/*`）一律流式返回，**不再 302**。旧页面/旧客户端升级后功能不中断。

### 2. 访问描述接口

2.1 `POST /api/files/access`，请求体（**2026-10-26 修订：单条 → 批量**）：

```json
{
  "items": [
    { "key": "9/ab/<sha256>.png", "width": 640 },
    { "key": "9/ab/<sha256>.mp4", "download": true, "filename": "cover.mp4" }
  ]
}
```

- `items` 必填，数组，1–50 条；空数组或超过 50 条属于请求体契约 → 400 `common.invalid_request`。
- 每条 `key` 必填，字符串、非空（类型 / 空串属于请求体契约 → 400）。**可读键域**：严格存储 key 形态（`STORAGE_KEY_PATTERN`）或四个派生命名空间（`_cache` / `_posters` / `_sprite` / `_proxy`，见 [file-access-ownership.md](file-access-ownership.md) 规则 7）；`staging/` 未提交缓冲与其他命名空间不在域内，与「对象不存在」同响应（404）。key 域判定是读管线的一部分（GET 字节路由与描述路由共用），不是描述接口的私有校验。`access` 不可能是合法 key，该路径为保留路由；它与 `/api/files/*` 注册在同一 router 内，靠 HTTP 方法区分（GET 通配不吞 POST），因此注册先后不影响可达性。
- 每条 `width` 可选，出现时必须为正整数；缺省表示原图。
- 每条 `download` / `filename` 可选；`filename` 只在 `download: true` 时参与附件名。
- 会话凭据必需；路由加 64KB JSON 体积上限（复用 `app.ts` 的 `jsonBodyLimit`；50 条描述远低于该上限）。
- 批量**不是全有或全无**：逐条独立鉴权、派生与签名，单条失败只影响该条（见 2.3 / 2.4）。

2.2 复用读路由同一份管线：key 校验 → `authorizeFileRead`（会话 + 归属）→ 穿越检查（`isKeyWithinNamespace`，与各后端寻址入口共用同一判据）→ `w` 派生生成 → `stat`。描述路由与 GET 字节路由共用抽出的读管线，不复制鉴权与派生逻辑。

2.3 成功响应（HTTP 200，`Cache-Control: private, no-store`，项目统一 `ok()` 信封；批量下**整批 200、逐条成败**）：

```json
{
  "code": 200,
  "msg": "success",
  "data": {
    "items": [
      {
        "key": "9/ab/<sha256>.png",
        "url": "https://bucket.example/<objectKey>?X-Amz-...",
        "delivery": "signed",
        "expiresAt": 1760011200,
        "refreshAt": 1760008800
      },
      { "key": "9/ab/<sha256>.missing.png", "error": "files.file_not_found" }
    ]
  }
}
```

- `items` 与请求**同序、同长度**；每条要么成功字段，要么 `error`（错误码字符串，前端按 i18n 展示；不下发错误文案）。
- `delivery = "signed"`：`url` 为最终对象（原图或 `_cache`/`_posters` 派生图）的预签名 GET；`expiresAt` 为 URL 失效 Unix 秒；`refreshAt` 为建议重新描述时刻（有效期 80%，见规则 4.7）。
- `delivery = "stream"`：`url` 为同一应用路径（含 `w`/`download`/`filename`）；无 `expiresAt` / `refreshAt`。
- 只有整批级失败（鉴权、请求体、体积上限）才走 `failCode()` 信封；响应体不包含 bucket、对象存储内部路径（`storage.s3.prefix` 后的对象 key）、凭据或内部错误细节。每条回显的 `key` 是请求里的逻辑 key（可读键域内的存储 key），前端据此把结果对回请求——它不是内部路径，`w` 派生后的对象 key 不出现。

2.4 失败语义：

| 情形 | 状态 |
| --- | --- |
| JSON 畸形 | 400 `common.invalid_json`（全项目统一语义） |
| `items` 为空 / 超过 50 条 | 400 `common.invalid_request` |
| 单条失败（他人 key / 不存在 / 过载 / 签名失败 / 读管线内部故障） | HTTP 200，该条返回 `error`（语义与单条版本一致） |
| 单条读管线抛出意外异常（存储读失败等非枚举故障） | HTTP 200，该条返回 `files.read_failed`（逐条隔离：一条的异常不得把整批打回 500，整批仍是 200） |
| 字段类型非法 | 400 `common.invalid_request`（`server/schemas/file-access.ts` 的 `safeParse`，与其余路由同一约定） |
| 请求体超过 64KB | 413 `common.body_too_large`（`jsonBodyLimit` 全项目统一语义，不为此路由特判） |
| 无会话 | 401 |
| 他人 key / 不存在 / 键域外（含 `staging/`） | 404（逐字节一致，防存在性预言机） |
| 路径穿越（已通过凭据校验） | 403（实际只可能在 GET 的能力凭据路径出现：会话路径下穿越键解析不出属主，已在归属守卫按 404 吸收；该分支保留为共用读管线的能力凭据防护。判据为 `isKeyWithinNamespace`：绝对形态与含 `..` 的路径段，与后端寻址入口同一实现） |
| 媒体池过载 | 503 `media.busy` / 429 `media.user_busy` |
| 预签名失败 | 503 `files.signing_failed` |
| 视频海报生成失败 | 404 |

2.5 描述接口只接受会话凭据；查询里的签名参数不参与鉴权，无会话一律 401。能力凭据用于无会话上游直接读取，不经过描述接口。

2.6 `download: true` 参与描述：`signed` 模式下预签名带 `response-content-disposition=attachment` 与 `response-cache-control=private, no-store`；`stream` 模式下返回的 URL 带 `download=1&filename=`，由 GET 字节路由输出 `Content-Disposition`。

2.7 `filename` 清洗与补扩展名沿用 GET 字节路由的现有规则（`attachmentDisposition` + `downloadBaseName`），附件名上限 255 字符由两条读路径共用同一常量（超长按上限截断并保留扩展名，不另立 400 分支）；客户端 URL 构造不引入 `rv`（服务端从未读取，见规则 6.5）。

  **扩展名取自实际服务的字节**：基名取 `filename` 或**请求 key** 的文件名（`PreparedRead.requestedKey`），扩展名取实际取字节的对象（`PreparedRead.ext`）。派生读（`w=` → WebP）时基名仍是用户请求的原图名，先剥掉请求 key 的源扩展名再补实际扩展名——否则会叠成 `photo.png.webp`。只剥源扩展名而不是任意末段：`report.final` 里的点属于文件名本身。
   - **文件名是编码边界的不可信输入**：截断按 UTF-16 码元进行但不得劈开代理对（`shared/text.ts` 的 `truncateUtf16`），进入 `encodeURIComponent` 前必须归一为 well-formed（`wellFormedUtf16`，孤立代理 → U+FFFD）。否则半截 emoji 会把客户端错误变成 500（`URIError`）。前端 `sanitizeFileName` 与本路由共用同一规则；归一后长度可能低于上限，此时不截断。

2.8 单请求批量（**2026-10-26 修订，取代原「不做批量」**）：

- 背景：一次 90 图画布加载 = 90 次描述请求，每次含 1 次会话用户查询与 1 次对象 `stat`；参考实现（open-ai-canvas `POST /resources/access`）已验证数组批量可行。
- 上限 50 条/请求；服务端对批内条目用有界并发（6）处理，避免单个批量请求打满媒体池。
- 逐条结果，不引入「全批失败」语义；客户端逐条消费，失败条目按规则 3.6 单独重试。
- 原 2026-10-23「另立 Spec 评估批量」的前提（等描述变纯快路径）已由用户 2026-10-26 决策取代：降低单请求成本本身就能解决瓶颈，不必先等派生提速。

### 3. 前端解析

3.1 新增统一解析服务（`web/src/lib/file-access/`，按 `protocol` / `batch` / `cache` / `persisted` / `state` / `abort` / `proactive` / `index` 分文件，对外入口不变）与 Hook（`web/src/lib/use-file-access-url.ts`）：

- 值域分流：存储 key / 托管 URL → 解析；外部 `http(s)`、`data:`、`blob:` → 原样返回，不发请求。
- 解析：`POST /api/files/access`，请求体由逻辑值（key/width/download/filename）构造，取 `url` / `delivery` / `expiresAt` / `refreshAt`。
- 逻辑值上的 URL 片段（如视频缩略的 `#t=0.1`）只属于客户端：不进入描述请求与缓存键，解析结果保留该片段（签名 URL 本身不带片段）。
- 调用方依据 `delivery` 决定 `fetch` 的 `credentials`：`signed` → `omit`；`stream` → `include`；外部地址保持 fetch 默认。该映射由 `credentialsForDelivery(delivery)` 单点提供，字节消费方（wavesurfer `fetchParams`、Mediabunny `Request`）不得各自再写一份三元式。

3.2 缓存（内存 + 客户端持久化，**2026-10-26 修订**）：

- 键：`账号作用域 + key + width + download/filename`。
- 值：`{ url, delivery, expiresAt, refreshAt }`。
- 内存：`signed` 条目在 `refreshAt` 失效（无 `refreshAt` 时 `expiresAt - 60s`）；`stream` 条目在会话内长期有效。规则 3.8 的主动刷新会以新描述就地替换该条目，替换后按新 `refreshAt` 计时。
- 持久化：仅 `signed` 描述写入 IndexedDB（`idb`，按 `key + width` 分键）；每条记录带账号作用域字段，载入时校验作用域一致且未过期，不符的条目连同磁盘记录一并丢弃。`stream` 与下载描述不持久化（前者由形态学习直接构造，后者含一次性附件名）。
- `refreshAt` 缺省即缺省：落盘记录不得用 `expiresAt` 填补。填补会把「服务端没有建议时刻」固化成「有效到最后一刻」，跨会话命中就丢掉 `expiresAt - 60s` 的余量，与同会话内的行为不一致。落盘记录 → 描述由单一函数还原，载入与命中两处判定共用它，避免两条路径各写一份。
- 取舍：签名 URL 是能力凭据，落盘会扩大其可用面（上限仍是 TTL 4h）；缓解是账号作用域隔离 + 登出清空 + TTL 封顶。XSS 本就能读内存，持久化不额外扩大攻击面；与参考实现（只持久化 cdn/origin）同一取向。
- 登录/登出/切换账号清空内存与持久化条目，在途请求结果不得写入新作用域。
- 不写入 localStorage、sessionStorage 或画布数据；描述结果不得直接写进 `<img src>`。

3.3 批量调度（**2026-10-26 修订**）：

- 同一事件循环内到达的描述请求合并为一次批量调用（DataLoader 式，最多 50 条），同批共享在途 Promise。
- 批量请求并发上限 2（等价于最多 100 条描述在途；旧版「同时 6 个单条请求」的目的——不一次打满应用与媒体池——保持不变）。
- 队列先进先出；逐条失败按规则 3.6 处理，不重试整批。组件卸载或账号切换时取消排队项，其结果不得写入新作用域。

3.4 分发形态学习：首次描述响应是 `stream` 时，模块内记住 `delivery=stream`，其后所有托管 URL 直接返回 `fileRefUrl(value)`，不再请求描述接口（本地/流式部署此后不再产生新的描述请求；学习前已启动的首批请求受规则 3.3 的在途上限约束，无法撤回）。学习结果属于会话作用域，登录 / 登出 / 切换账号按规则 3.2 清空后重新学习。`signed` 不缓存形态，逐条解析。

**下载描述不参与形态学习**（2026-10-26 补充）：`download: true` 的响应即使返回 `stream` 也不学习——那是端点不遵守 `response-*` 覆盖时「这一次下载」的降级（规则 4.2），不代表后端不能签发读地址。从下载响应学习会让一次下载把整个会话的媒体都改走应用流。

3.5 组件迁移：所有托管媒体消费点改用 Hook/服务，不再直接把 `fileRefUrl()` 的结果作为 `<img>`/`<video>`/`<audio>`/`fetch` 的最终地址。清单见「技术影响 / 前端」。

3.6 媒体元素失败重试：签名 URL 因过期、时钟或 bucket 策略返回 403/404 时，调用方以 `forceRefresh` 重新解析一次；仍失败才进入现有失败态。不得无限重试。重试预算按**失败地址**计：同一签名地址只重新解析一次（同一窗口重签得到同一地址，重复刷新无意义）；重新签发得到新地址后再次失败，重新获得一次预算（2026-10-26 用户确认）。规则 3.8 已在后台取得更晚失效的地址时，`retrySigned` 先使用该地址、不发描述请求；该判断先于失败地址预算。

404 的边界（2026-10-26 补充）：预签名 GET 的 403 通常是签名过期、时钟偏移或 bucket 策略；404 通常是对象已删除（部分 S3 兼容实现与策略配置也会对无读权限返回 404）。元素失败路径不区分 403/404，都按本规则重描述一次——重新描述成功仍返回 404 说明对象确实不可读，属终态，Hook 不再重试；只有描述成功且地址变化（或重挂同一地址后恢复）才可能恢复加载。

3.7 下载的失败反馈：下载必须先解析再触发（规则 3.5），因此它从同步跳转变成了可能失败的异步动作。描述失败属**用户点击的即时反馈**，按 `web/AGENTS.md` 七.1 走轻量消息（`showGlobalMessage().error`），不走通知——失败原因无需展开说明，消息条足以让用户知道「这次没成」并自行重试（同规则适用于试听失败，见「当前状态」）。消息通道没有 `key` 去重能力，连点同一项下载可能叠出多条（文案相同、随即消失），这是轻量消息的既有行为，不为去重改用通知。非托管值（外部 URL / `data:` / `blob:`）不解析、不会走这条失败路径。

3.8 主动刷新（2026-10-26 用户确认）：`signed` 描述在 `refreshAt` 到点后由 Hook 主动重新描述，不再只依赖元素加载失败。

- 只刷新缓存与「新鲜地址」槽：后台结果写入解析层缓存（规则 3.2），并在 Hook 内保留一份新鲜地址，不 `setState` 替换已挂载媒体元素的地址——在寿命 80% 时换 `src` 会让所有图片/视频重新下载并打断播放。
- 元素失败优先用新地址：规则 3.6 的 `retrySigned` 先检查该槽；地址已更新且失效更晚时直接切换并重挂一次，不再发描述请求。该判断先于「同一失败地址只重试一次」的预算——旧地址预算用尽也不妨碍新地址生效。
- 共享调度：所有 Hook 共用一个定时器与 `focus` / `online` / `visibilitychange` 唤醒监听，同一到期时刻的多个媒体落在同一任务里，解析层的同拍合并仍能组成一次批量描述。每个 Hook 各自 `setTimeout` 会让浏览器逐个任务触发，把批次打散成 N 个单条请求。
- 抖动：会话级 ±10%，按 `refreshAt → expiresAt` 的余量缩放并取一半。同一页面共享偏移，仍可合并；不同标签页/用户各自随机，避免所有客户端在寿命 80% 的同一时刻形成请求尖峰。
- 失败退避：瞬时故障（网络层 `status = 0`、非 503 的 5xx、`files.signing_failed`）按 30s 起指数退避、5min 封顶，最晚到失效前安全线（5s）；401 / 404 / 429 / 503 等终态不重试，由元素失败路径与手动重试兜底。主动刷新失败不进入页面失败态：当前地址通常仍可用。
- 有界：服务端未推进寿命（`expiresAt` 不增）、或新描述的建议时刻仍落在客户端过去（客户端时钟超前）时停止循环，避免时钟异常或中间层缓存造成请求自旋；后台标签页的定时器节流由焦点/可见性/网络恢复唤醒补做；会话切换与卸载取消定时器与在途请求。

### 4. 签名常量与缓存头

4.1 新增存储层常量（建议 `server/services/storage/signing.ts`）：

```ts
export const PRESIGNED_READ_TTL_SECONDS = 14400;     // 浏览器描述 URL 的最长寿命（4h，2026-10-26 修订）
export const PRESIGNED_READ_WINDOW_SECONDS = 3600;   // 对齐窗口 = TTL/4（URL 稳定期 1h）
export const CAPABILITY_URL_TTL_SECONDS = 3600;      // 上游引用 / 媒体输入凭据寿命（维持 1h，不受浏览器方案影响）
```

- 浏览器描述用 TTL + WINDOW；上游引用与媒体输入改用 `CAPABILITY_URL_TTL_SECONDS`（行为与修订前一致，避免浏览器侧收紧/放宽牵连上游）。
- 模块加载时断言 `WINDOW * 4 === TTL`（窗口语义单一来源）与 `TTL <= MAX_PRESIGNED_URL_SECONDS`（SigV4 7 天上限），由单测覆盖。

4.2 `presignGet` 调用：`windowSeconds = PRESIGNED_READ_WINDOW_SECONDS`、`ttlSeconds = PRESIGNED_READ_TTL_SECONDS`，`expiresIn = ttl`（**2026-10-26 修订**：签名时刻对齐到窗口起点，实际剩余寿命落在 `[3/4·ttl, ttl]`，最长 4h；旧版 `ttl + window` = 25h 已废止）。

4.3 预签名响应头：`private, max-age=<窗口寿命>, immutable`，窗口寿命 = `expiresAt - issuedAt` = TTL（≤ 14400）（**2026-10-26 订正**：原表述为 `max-age=<expiresAt - now>`，逐秒剩余值已作废）。不使用 `public`。

- 不取逐秒剩余值的原因：该值会内嵌进预签名 URL 的 `response-cache-control` 查询参数。逐秒变化会让同一窗口内签出的 URL 不再逐字节一致，直接破坏规则 4.4 的多实例一致性，也让以 URL 为键的探测缓存（规则 4.6）永久不命中。
- 代价有界：浏览器最多在 URL 失效后再从私有缓存取用约一个窗口（≤1h）的字节。缓存内容是该用户已取得的同一对象（对象 key 内容寻址 / 派生 key 带版本），客户端在 `refreshAt`（寿命 80%）之后即重新描述；这不延长签名凭据的可用面，也不引入跨用户共享。

4.4 窗口锚定 Unix epoch 绝对值（现有实现），多实例签出同一 URL；时钟同步沿用 NTP 前提。

4.5 泄漏边界：签名 URL 即凭据，TTL 内无法撤销；默认最长可用 4 小时（**2026-10-26 修订**，旧版约 25 小时）。降低暴露面需改常量并重新部署，不提供运行时开关。

4.6 能力型凭据（上游引用、媒体工具输入）不传 `windowSeconds`，`presignGet` 取缺省 `ceil(ttl / 4)` 对齐窗口：有效期不因浏览器缓存方案放大，同时同一窗口内签出的 URL 字节一致，可继续作为进程内探测缓存键（[media-probe.ts](../server/services/storage/media-probe.ts) 的 `probeVideoMetaCached` / `integrityCache` 以输入串为键）。缺省值不得改为「不对齐」（`windowSeconds = 0`）：那会让每次签出的 URL 都不同，S3 后端下视频探测缓存永久不命中，每次探测多一次 ffmpeg spawn。能力凭据的 TTL 使用 `CAPABILITY_URL_TTL_SECONDS`（规则 4.1），因此缺省窗口为 900s，与修订前一致。

4.7 `refreshAt` 定义：`issuedAt + floor((expiresAt - issuedAt) * 0.8)`。客户端在 `refreshAt` 附近主动重新描述（规则 3.8，含会话级抖动）；服务端保证 `refreshAt < expiresAt`。`stream` 无该字段。

### 5. 鉴权与安全边界

5.1 归属判定仍在描述接口执行，复用 [file-read-auth.ts](../server/http/file-read-auth.ts)；描述接口只接受会话凭据。

5.2 签名 URL 不携带会话 Cookie；`<img>`/`<video>` 直连不发送应用 Cookie。`fetch` 按规则 3.1 设置 `credentials`。

5.3 签名 URL 属于能力凭据：拿到 URL 的任何人在有效期内可读取；与现有 `?expires&signature` 凭据模型一致，不是新增信任边界。

5.4 描述响应 `no-store`，不进入任何 HTTP 缓存（批量接口是 POST，HTTP 缓存语义不可靠；缓存改由客户端按规则 3.2 承担）。

5.5 删除对象后，已签发的 URL 在 bucket 侧返回 404；应用不维护吊销列表。浏览器缓存中的旧字节不因删除而消失（与现有 `immutable` 语义一致）。

5.6 所有媒体字节响应与描述响应补 `Referrer-Policy: no-referrer`：签名 URL 与带 `?expires&signature` 的应用 URL 都不得以 `Referer` 形式外泄到第三方。

### 6. 删除与缓存头收敛

6.1 删除设置键：`storage.s3.delivery`、`storage.s3.signed_url_ttl_seconds`、`storage.s3.signed_url_window_seconds`、`storage.edge.origin_secret`。数据库中的旧行由设置初始化忽略，无需迁移。

- **实施订正（2026-10-25 核查）**：真正进入过 registry 的只有前两个键（`storage.s3.delivery`、`storage.s3.signed_url_ttl_seconds`，随 9a7ccbb3 引入）；`storage.s3.signed_url_window_seconds` 与 `storage.edge.origin_secret` 只存在于当时规划/未提交的可信边缘方案中，从未落库（全历史检索无引入提交），因此实际删除动作只有两项。原表述把规划态键当成现状，与 git 历史不符；第 2 节「现有设置」的同一处也已按此订正。

6.2 `/api/files/*` 非描述响应：

- 会话/流式：`Cache-Control: private, max-age=31536000, immutable`（修正既有「会话响应标 public」缺陷）。
- 能力凭据：`Cache-Control: public, max-age=<签名剩余秒数>, immutable`。
- 非 2xx：`no-store`。**在错误响应构造点单点保证**（`server/core/response` 的 `failCode` 默认带 `no-store`，调用方只能覆盖、无需补写）：逐个路由补头会漏——体积上限、全局 404、鉴权中间件都在业务路由之外生成响应。回归用例：`server/__tests__/core/response.test.ts`。

6.3 不做可信边缘：

> **实施订正（2026-10-25 核查）**：本节原写作「删除」，把可信边缘当成既有实现。全历史检索（`git log --all -S`）显示 `server/http/edge.ts`、`server/http/routes/files-authz.ts`、`assertEdgeDeliveryValid`、`isTrustedEdge` 与 `FileCachePolicy` 的 `shared` 分支**从未进入任何提交**——它们只存在于上一版草稿的方案描述中，`file-read-auth.ts` 的 `_authz` 端点也从未落地。因此实际动作是「不引入」，而非删除；原表述与仓库事实不符，已按事实订正。

- 不引入可信边缘：`server/http/edge.ts`、`server/http/routes/files-authz.ts` 及其 `app.ts` 注册、`assertEdgeDeliveryValid`、`isTrustedEdge`、`FileCachePolicy` 的 `shared` 分支均不存在于代码库。
- 不新增 README 边缘缓存章节与 nginx 参考配置（仓库中本就没有）。
- `file-read-auth.ts` 保留（读路由仍需单点判定）；描述路由只用会话分支。

6.4 `upload-limits` 不新增字段：分发形态由首次描述响应学习，不引入模式探测接口。

6.5 **`stream` 路径的版本失效边界（方案 B，已知边界）**：`signed` 的版本段内嵌在对象 key（`_cache/v2/...`），`RESIZE_CACHE_VERSION` 提升即换 URL，浏览器缓存自然失效；`stream` 的最终地址是源 key 上 `?w=<档位>` 的应用 URL，版本段只存在于服务端派生键，URL 不随版本变化。因此提升 `RESIZE_CACHE_VERSION` 后，`stream` 部署的浏览器可能在 `private, max-age=31536000, immutable` 生命期内继续使用旧派生字节，直到缓存过期或用户清缓存。

- 这是**接受的已知边界**，不引入 `rv`、不为本地后端缩短 `max-age`、不做版本感知的 URL 变换：`stream` 是单机/自托管部署形态（`local` 后端），与 `signed` 的多实例生产形态不同；本地后端没有共享 CDN/多实例缓存一致性问题，运维可直接清缓存或换端口/域名。
- 记录在案的原因：`rv` 的唯一收益只对 `stream` 成立，而为它保留一个跨前后端、跨缓存层的参数，会让「派生版本」在客户端也成为一个必须维护的契约；用户 2026-10-24 评估后选择接受该边界、整体删除 `rv`。
- 若未来 `local` 后端成为多用户生产形态、且版本失效成为真实故障，按新 Spec 处理（例如把版本段带进 stream URL），不在本 Spec 预留开关。

### 7. 与其他 Spec 的关系

7.1 本 Spec 取代 [storage-edge-cache-delivery.md](storage-edge-cache-delivery.md) 的全部浏览器读路径规则；该 Spec 已于 2026-10-24 由用户确认标记「已废弃」。

7.2 [storage-s3-delivery-caching.md](storage-s3-delivery-caching.md) 已整体标记「已废弃」（2026-10-24，用户确认）。其仍然有效的签名窗口**机制**（epoch 对齐、窗口内 URL 字节一致、能力凭据不继承长窗口）已并入本 Spec 规则 4.1 / 4.4 / 4.6 并由本 Spec 承载，承载方式由设置项改为代码常量；原 Spec 的 `storage.s3.*` 设置键、302 语义（规则 2）、代理模式（规则 5）与阶段 C（规则 8）均随废弃失效，其正文只保留「302 时代」的实测证据作历史记录，不得作为实现依据。

7.3 [canvas-image-http-url-rendering.md](canvas-image-http-url-rendering.md) 的「显示 URL 长期不变、可直接作为 `<img src>`」前提修订为：显示 URL 由异步解析层提供，`signed` 模式下是窗口内稳定、跨窗口轮换的能力 URL；预热与渲染仍使用同一 URL 字符串（规则 7 不变）。

7.4 [file-access-ownership.md](file-access-ownership.md) 不变：会话归属、签名能力凭据、404 一致性。

7.5 **读分发主题**的 Spec 收敛为三份并存（另加一份否决记录），职责互不重叠：

| Spec | 状态 | 当前职责 |
| --- | --- | --- |
| [storage-s3-backend.md](storage-s3-backend.md) | 已实现 | 后端实现：接口、上传直传、迁移、GC、CORS 清单；读路径规则外链本 Spec |
| 本 Spec | 已确认（2026-10-26 修订） | 浏览器读路径：描述接口、前端解析层、签名常量与缓存头、鉴权边界 |
| [storage-s3-production-cutover.md](storage-s3-production-cutover.md) | 已确认 | 生产部署演练：凭据、TLS、可达性、回滚、对账 |
| [storage-edge-cache-delivery.md](storage-edge-cache-delivery.md) | 已废弃 | 无；只作「边缘共享缓存」方向的否决记录 |

[storage-s3-delivery-caching.md](storage-s3-delivery-caching.md) 已于 2026-10-24 转为「已废弃」（见规则 7.2），不计入并存集合。归属、配额、key 命名（`file-access-ownership.md`、`storage-user-quota.md`、`storage-reference-key-unification.md`）不是读分发主题，不在此表。

## 技术影响

### 服务端

- [server/core/settings/registry.ts](../server/core/settings/registry.ts)：删除规则 6.1 实际落库的两个键（`storage.s3.delivery`、`storage.s3.signed_url_ttl_seconds`）；不新增键。
- [server/http/app.ts](../server/http/app.ts)：注册 `POST /api/files/access`（具体路径先于 `/api/files/*`），并加 64KB JSON 体积上限。
- [server/services/storage/signing.ts](../server/services/storage/signing.ts)：TTL/窗口/能力凭据三个常量与断言（规则 4.1）；`expiresIn = ttl`（规则 4.2）。
- [server/services/storage/service.ts](../server/services/storage/service.ts)：S3 后端配置改读常量（`assertPresignWindowValid` / `assertEdgeDeliveryValid` 从未存在，见规则 6.3）。
- [server/schemas/file-access.ts](../server/schemas/file-access.ts)：请求体改为 `items` 数组（1–50），响应项含 `refreshAt`。
- [server/http/routes/files.ts](../server/http/routes/files.ts)：`POST /api/files/access` 描述路由改为批量（批内有界并发 6、逐条成败）；GET 路由回归纯字节/流式（删除 302 分支与 `access=1` 分支、`storage.s3.delivery` 读取；`isTrustedEdge` 从未存在，见规则 6.3）；两条路由共用抽出的读管线（鉴权、穿越、派生、`stat`），Range 不变。
- [server/http/file-read-auth.ts](../server/http/file-read-auth.ts)：保留；描述接口只用会话分支。
- [server/http/file-response.ts](../server/http/file-response.ts)：`FileCachePolicy` 收敛为 `session | capability` 两态；字节与描述响应补 `Referrer-Policy: no-referrer`（规则 5.6）。
- [server/services/resolvers/reference.ts](../server/services/resolvers/reference.ts)、[media-source.ts](../server/services/storage/media-source.ts)：预签名 TTL 改读 `CAPABILITY_URL_TTL_SECONDS`（保持 1h）。
- 会话用户查询的去除见 [auth-request-verification.md](auth-request-verification.md)（本 Spec 只依赖其结果）。
- 无删除文件：`server/http/edge.ts`、`server/http/routes/files-authz.ts` 从未存在（见规则 6.3）。

### 前端

- 新增解析服务与 Hook（规则 3）：批量合并队列（规则 3.3）、IndexedDB 持久化（规则 3.2）；按以下清单迁移：
  - 画布展示：`CanvasImage.tsx`、`use-canvas-image.ts`、`use-canvas-image-lod.ts`、`ImageNode.tsx`、`VideoNode.tsx`、`AudioNode.tsx`、`AudioWaveform.tsx`、`VideoPlayer.tsx`、`MediaPreviewOverlay.tsx`、`ImageRefCard.tsx`、`VideoRefCard.tsx`、`AudioRefCard.tsx`、`MentionChip.tsx`、`MentionDropdown.tsx`。
  - 编辑/导出：`AnnotationPanel.tsx`、`CropPanel.tsx`、`GridSplitter.tsx`、`PanoramaPanel.tsx`、`LightingPanel.tsx`、`MultiAngleEditor.tsx`、`AudioClipStripPanel.tsx`、`canvas-edit-actions.ts`、`use-frame-sprite.ts`、`editing/client-media/client-video.ts`（客户端媒体管线的源读取，Mediabunny `UrlSource` 也消费解析结果）。
  - 其他界面：`ProjectListPage.tsx`、`DirectorViewport.tsx`、`Inspector.tsx`、`AssetCard.tsx`、`AssetInspector.tsx`、`AssetHoverPreview.tsx`、`AssetCreateDialog.tsx`、`SettingsModal.tsx`、`CanvasExplorer.tsx`、`ConfirmCard.tsx`、`reference.ts`、`use-sse-task-monitor.ts`、`lib/utils/download.ts`。
  - 服务端响应里的逻辑 URL 同样是解析层输入：媒体编辑路由返回的 `url`、`video-proxy` 的代理地址、`frame-sprite` 的雪碧图地址都在产出的 hook（`use-video-proxy.ts`、`use-frame-sprite.ts`）内解析，元素与 CSS 背景只消费最终地址；解析失败按该产物自身的失败态处理（代理回退原视频 scrub、雪碧图退化为无缩略图轨道），不得把逻辑 URL 透出给浏览器。
- [web/src/lib/file-url.ts](../web/src/lib/file-url.ts)：保留 `fileRefUrl` / `managedFileUrl` / `withManagedFileWidth` 作为逻辑 URL 派生；不引入 `rv` 追加，不引用 `RESIZE_CACHE_VERSION`；不再直接作为跨域媒体元素的最终 `src`。
- 下载改为解析后触发：`signed` 用响应头强制附件名（跨域 `href` 的 `a.download` 无效，不设），`stream` 保持 `a.download` + 查询参数；失败反馈按规则 3.7。
- 测试：解析服务（批量合并、缓存、去重、作用域、过期、持久化复用与清理、形态学习、forceRefresh）、Hook、`CanvasImage`、`VideoNode`、下载工具、媒体编辑链路（至少一处 `crossOrigin` + 直连）。

### 数据与持久化

- 无数据库结构变更；设置表删除实际落库的两个键（`storage.s3.delivery`、`storage.s3.signed_url_ttl_seconds`，旧行被设置初始化忽略），不新增键。
- 画布数据、资产引用仍只存存储 key / 外部 URL；签名 URL 与描述结果不落库、不写画布。
- 客户端 IndexedDB 只保存签名描述（规则 3.2），属于设备本地缓存，不是数据源；清空不影响正确性。

### 部署

- bucket CORS 仍是硬前置（`GET`/`PUT`、`Range`/`Content-Type`、`ExposeHeaders`），见 [storage-s3-backend.md](storage-s3-backend.md)「Bucket 初始化清单」；本方案不新增 CORS 需求。
- bucket 端点必须能被浏览器访问；不可达时使用 `storage.backend=local`。
- README 设置表删除两个键（实际落库的 `storage.s3.delivery`、`storage.s3.signed_url_ttl_seconds`），补「S3 = 浏览器直连、local = 应用流式」的说明。

## 异常与边界

- **描述成功但媒体请求失败**：过期/时钟偏移/CORS 配错/对象被删。调用方 `forceRefresh` 一次；仍失败进入失败态。对象被删时重新描述也返回 404，不重试。
- **描述请求本身的瞬时故障**：网络层失败（`status = 0`）与非过载 5xx 在需要最终地址的非元素形态（`resolveMediaUrlString`：下载、试听、客户端媒体管线）下重新描述一次；503/429（媒体池过载）、401（已触发全局登出）、404（对象已删）与其他 4xx 是终态，不重试。元素形态不重试描述层故障，失败态提供手动重试（`refresh`）。
- **媒体池过载**：批量接口按条返回 503/429（整批仍 200），前端沿用现有 busy 提示；不整批失败。
- **批量部分失败**：失败条目只影响自身，其余条目正常返回；客户端按条展示失败态，不因一条 404 放弃整屏。
- **批内重复 key**：按条独立处理（不合并），结果与请求同序；重复描述不会产生额外派生（同键单飞）。
- **派生图未生成**：`w` 触发 `getResizedWebP` / `getVideoPosterWebP`；图片失败回退原图（与现路由一致），视频海报失败 404（与现路由一致）。
- **APNG**：不生成静态档位，描述原图（现有行为）。
- **下载与大文件**：签名 URL 由浏览器直连，Range 天然支持；不经过应用内存。
- **登出/切换账号**：内存缓存与 IndexedDB 条目按作用域清空；已签发的 URL 在 TTL 内仍可被持有者使用（能力凭据边界）。
- **多标签页**：各自描述、各自内存缓存；字节缓存按 URL 共享（浏览器 HTTP 缓存），可接受。
- **时钟偏移**：窗口按 epoch 对齐，多实例需 NTP；偏差跨越窗口边界会产生不同 URL（各缓存一次，不损坏）。
- **旧页面/旧客户端**：升级后旧页面仍请求 `/api/files/...`，服务端流式返回，功能不中断；新页面使用描述接口。无兼容层。
- **刷新**：未过期的 `signed` 描述从 IndexedDB 复用（规则 3.2），不重新请求；条目过期或 `stream` 形态仍会重新描述。窗口内签名 URL 字节一致，图片字节命中浏览器缓存；跨窗口首次刷新会重新下载一次（URL 轮换的固有成本）。
- **CDN 后续接入**：签名 URL 的缓存键含 `X-Amz-*`，跨用户共享需 CDN 侧特殊配置；本 Spec 不承诺，后续另立。

## 验收标准

### 静态检查与测试

- 描述接口（`POST /api/files/access`，批量）：1–50 条逐条返回、同序同长；本人 key → 200 + `url`/`delivery`/`expiresAt`/`refreshAt`，`no-store`；他人 key、不存在、key 形态非法 → 该条 `error`（404 语义逐字节一致）；`items` 为空 / 51 条 → 400；无会话 → 401；JSON 畸形/字段类型非法 → 400；请求体超过 64KB → 413；`download: true` 的 `signed` 描述含附件 disposition；`stream` 描述返回 GET 字节路由 URL 且无 `expiresAt`；查询里的签名参数不影响会话鉴权。签名失败（`presignGet` 抛错）→ 该条 `error = files.signing_failed`，不返回半成品描述。
- 签名协议：`X-Amz-Expires=14400`、`X-Amz-Date` 对齐到 1h epoch 边界；`refreshAt = issuedAt + 0.8 × (expiresAt - issuedAt)`；`response-cache-control` 的 `max-age` 恒等于 TTL（14400，窗口寿命），不随签发时刻递减；能力凭据（上游引用 / 媒体输入）仍为 1h。
- 分发：`backend=local` 描述为 `stream`；`backend=s3` 描述为 `signed`；`storage.s3.delivery` 与 `storage.s3.signed_url_ttl_seconds` 已无读取点（另两个键从未落库，实施订正见规则 6.1）。
- GET 字节路由：不再有 `access=1` 描述分支、不再出现 302；Range 206/416 不变；会话响应 `private`、能力响应 `public` 且 `max-age` 不超过签名剩余时间；错误响应 `no-store`。
- 前端解析层：外部/data/blob 直通；首次 `stream` 响应后不再请求描述；同一事件循环内的 N 个请求合并为 1 次批量调用（≤50 条）；同批共享 Promise；`refreshAt` 后重新解析；`forceRefresh` 生效；账号切换清空内存与 IndexedDB、取消排队项且旧请求结果不写入；页面刷新后未过期的 `signed` 描述从 IndexedDB 复用（不产生描述请求）。
- 主动刷新（规则 3.8）：到达 `refreshAt`（含会话抖动）后后台重描述，展示地址不变、缓存换新；同一到期时刻的多个 Hook 合并为一次批量描述；元素失败优先消费新鲜地址且不再发描述请求；瞬时失败按 30s 起退避，401/404/429/503 不重试；服务端未推进寿命或建议时刻仍在过去时停止循环；卸载与会话切换取消定时器与在途请求。
- URL 构造不包含 `rv`；派生 key 版本段（`_cache/v2/`）仍生效；`stream` URL 与版本无关，规则 6.5 的边界有文档记录。
- 无边缘残留：`edge.ts`、`files-authz.ts`、`origin_secret`、`assertEdgeDeliveryValid` 在代码库中均不存在（从未落地，无「删除后可验证」的测试项，见规则 6.3）。
- lint、类型检查、相关测试串行通过（Vitest 单 worker）。

### 浏览器实测（CDP，记录数据）

- 90 图项目首次加载：描述请求全部为 `POST /api/files/access` 批量（≤50 条/请求，整屏约 2 个请求；无字节响应、无 302）；bucket 请求 90 个，成功解码；Network 中 302 数为 0。
- 同标签页刷新：未过期条目从 IndexedDB 复用，描述请求数接近 0；bucket 请求全部命中浏览器缓存，传输 0 字节；`refreshAt` 之后刷新会重新描述一次。
- 跨签名窗口（用短窗口常量模拟）：同一对象 URL 变化一次，缓存未命中一次，其后命中。
- 下载：点击下载得到 `Content-Disposition: attachment` 的文件名，字节不经过应用。
- 视频：`<video>` 直连播放，seek 触发 206；抓帧/裁剪/标注等 canvas 像素操作正常（CORS 回归）。
- `local` 后端：首次描述返回 `stream`，其后画布媒体直接走应用 URL；无 bucket 请求；无 302。

### 部署

- README 设置表删除两个键（`storage.s3.delivery`、`storage.s3.signed_url_ttl_seconds`），补「S3 = 直连 / local = 流式」说明与 bucket 可达性、CORS 前置。
- 已有部署升级核对：两个旧键无代码读取；`storage.upstream_ref_delivery` 仍生效。

## 实施顺序（确认后）

1. 常量与设置清理：新增 `signing.ts`，删除两个曾落库的键（另两键从未落库，无校验函数可删，见规则 6.3）；补单测。
2. 路由：抽出共用读管线；新增 `POST /api/files/access` 描述路由；GET 字节路由删除 302、缓存头收敛；补路由测试。
3. **（2026-10-26 修订）** 签名协议：TTL 4h / 窗口 1h / `expiresIn = ttl` / `refreshAt` / 能力凭据独立常量；补签名与响应头用例。
4. **（2026-10-26 修订）** 批量描述：请求体 `items`、批内有界并发、逐条成败；补批量路由用例（部分失败、上限、同序）。
5. **（2026-10-26 修订）** 前端解析层：批量合并队列 + IndexedDB 持久化（作用域隔离、过期校验、登出清理）；补单测。
6. **（2026-10-26 修订）** 安全头：媒体与描述响应补 `Referrer-Policy: no-referrer`。
7. 按清单迁移消费点（画布展示 → 编辑链路 → 其他界面 → 下载）；不引入 `rv`。
8. 删除边缘代码与 README 章节；[storage-edge-cache-delivery.md](storage-edge-cache-delivery.md) 已于 2026-10-24 由用户确认标记「已废弃」。
9. CDP 实测（90 图、刷新、跨窗口、下载、视频、local 模式）。
10. 报告验证结果与未覆盖项。

## 已确认决策（用户反馈）

- 2026-10-23：去掉 `access=1`，描述接口改为 `POST /api/files/access`（请求体携带 key/width/download/filename）；GET `/api/files/*` 只返回字节。
- 2026-10-23：不做批量描述接口；改为客户端解析并发上限（6），保持逐条返回、逐张出图；批量的演进条件见规则 2.8。
- 2026-10-23：TTL/窗口采用代码常量（`3600` / `86400`），不放 `system_settings`；未来只有合规/安全需求成立时，才把 TTL 单独提升为一个设置项，`window` 保持常量。
- 2026-10-23：S3 一律直连（取消 S3 应用代理模式）；bucket 必须浏览器可达，不可达时改用 `local` 后端。
- 2026-10-24：`rv` 缓存击穿参数整体删除（从未进入提交），`stream` 路径的版本失效按规则 6.5 作为已知边界接受，不做补偿机制。
- 2026-10-24：描述接口的 key 校验拆成两层——类型/非空是请求体契约（400），可读键域（内容键 ∪ `_cache`/`_posters`/`_sprite`/`_proxy` 派生命名空间，排除 staging）属于共用读管线（404）；请求体超限（64KB）按全项目统一语义回 413，不为此路由特判。
- 2026-10-26：**签名寿命改为 4h、窗口 1h**（用户选定「4h / 1h 窗口」），描述响应新增 `refreshAt`；缓存命中由批量 + 客户端持久化补回，不再依赖长窗口。
- 2026-10-26：**批量描述纳入本版**（1–50 条/请求，逐条成败），取代 2026-10-23 的「不做批量」。
- 2026-10-26：**描述结果持久化到 IndexedDB**（仅 signed、按账号作用域、登出清空）；服务端保持 `no-store`。
- 2026-10-26：**会话用户查询改由 Redis 承载**，见 [auth-request-verification.md](auth-request-verification.md)；本 Spec 只消费其结果。
- 2026-10-26：**CDN 不纳入本版**，另立 Spec。
- 2026-10-26：**规则 3.6 的重试预算按失败地址计**（不再按逻辑源生命周期）——同一地址只重描述一次；换到新地址后再次失败可再重试，避免长会话第二次过期直接进入失败态。
- 2026-10-26：**新增规则 3.8 主动刷新**——寿命 80%（`refreshAt`）后台重描述，只更新缓存与 Hook 内新鲜地址槽、不替换已挂载元素地址；共享调度 + 会话级 ±10% 抖动 + 瞬时失败指数退避；元素失败优先消费新鲜地址。原「是否需要抖动待实测」事项由此关闭。

## 已确认事项（2026-10-26 用户确认）

- 修订版（2026-10-26）经用户确认；状态由用户设为「已确认」。「已实现」待浏览器验收项走查通过后设置。
- IndexedDB 持久化条目上限按条目数 500、按 `savedAt` 最早淘汰（`PERSISTED_ENTRY_LIMIT`）；若真实画布出现「刷新后大量未命中重新描述」，再评估上调。
- 批量上限 50 按 64KB 体积与媒体池并发推得，作为已确认取值，实测后再调整。

## 当前状态

原版（2026-10-23）与修订版（2026-10-26）均已实现；代码于 2026-10-26 随 `023f6489` / `b99e6855` 提交并推送（下文各轮记录中的「未提交」均指当时暂存状态，已过时）。修订版实现范围：`POST /api/files/access` 批量描述（1–50 条、整批 200、逐条 `error`、同序同长、服务端批内并发 6）、4h 寿命 / 1h 对齐窗口（`expiresIn = ttl`、`refreshAt` = 寿命 80%）、前端同拍合并（每批 ≤50 条、批并发 2）、IndexedDB 仅持久化 `signed` 描述、描述响应 `Referrer-Policy: no-referrer` 与 `Cache-Control: private, no-store`、`CAPABILITY_URL_TTL_SECONDS` 1h。规则 3.8 主动刷新落地为 `web/src/lib/file-access/proactive.ts`（共享定时器 + 焦点/可见性/网络唤醒、会话级 ±10% 抖动）与 Hook 内的缓存重描述/新鲜地址槽；瞬时故障 30s 起指数退避、5min 封顶，终态错误不重试，服务端未推进寿命即停止循环。参考实现调查为只读，未修改外部项目。

静态检查与测试（2026-10-26，串行执行、`--maxWorkers=1` 单 worker）：

- `npm run typecheck`：server + web 通过。
- `npm run lint`：0 error（6 条既有 `no-img-element` warning）。
- web Vitest：149 个文件 / 1152 个用例全部通过（含规则 3.8 的调度单测、Hook 集成用例、寿命字段契约用例，以及调度取消、重试预算、失败态重试入口与浮层关闭态回归用例）。
- server Vitest：99 个文件 / 1146 个用例通过，3 个集成文件（14 个用例）按环境跳过（Redis / 外部 S3）。

> 执行备注：`--pool=threads --poolOptions.threads.singleThread` 会让测试文件共享同一模块注册表，`react-i18next` 的全局实例被先跑的文件初始化后，后跑用例断言裸 key 即失败（`HoverCard.test.tsx` 在 `NodeToolbar.test.tsx` 之后运行必现）。这是测试运行器的隔离配置问题，不是产品缺陷；改用默认 forks 池 + `--maxWorkers=1` 后全绿。

2026-10-26 决策（用户授权 Agent 决定）：

- 规则 4.3 的 `max-age` 口径订正为「窗口寿命 = TTL」。实现自始按此输出（`presignedCacheControl`），原「逐秒剩余值」表述无法与规则 4.4 的窗口内 URL 逐字节一致共存，故改 Spec 而非改代码；理由与代价见规则 4.3。
- 前端解析层按职责拆分：`web/src/lib/file-access/` 下的 `protocol`（值域与描述契约）、`batch`（批次、去重、取消）、`cache`（内存缓存与定序）、`persisted`（IndexedDB 副本与载入）、`state`（会话作用域与形态学习）、`abort`（取消语义）与 `index`（编排与会话重置）。对外入口 `@/lib/file-access` 不变，行为与测试逐项保持。

2026-10-26 复审修复（双轴代码审查后，用户「从根因修复所有问题，不要打补丁」）：

- **派生读的下载名叠加扩展名**（实现 bug，已实测复现）：GET 路由传 `read.requestedKey` 却用 `read.ext`（= 实际对象扩展名）补后缀，`?w=480&download=1` 输出 `photo.png.webp`。根因是 `downloadBaseName` 把「基名来源」与「扩展名来源」混为一谈。修复：基名取 `requestedKey`（用户请求的名字），扩展名取实际服务的字节，先剥掉基名的**源扩展名**再补——只剥源扩展名，`report.final` 这类名字里的点保留。两条路径（GET / 描述接口）现在传同一入参，规则 2.7 已回写。
- **探测的裸 HTTP 请求无超时**（实现缺陷，已实测复现）：预签名回读 / 覆盖头 / 预检三处 `fetch` 无 `signal`，undici 缺省上界是 5 分钟且只到响应头；端点黑洞时 bootstrap 事实永久挂起。修复：三处收口到 `probeFetch`（统一 `AbortSignal.timeout`）；`Origin` 头只在 CORS 相关的两处显式给出（它是被测输入，不是公共头）。规则 3.5 的 CORS 判定因此不再假阴性。
- **SDK 客户端缺时间上界**（同类根因）：`@smithy` 的 `connectionTimeout` / `socketTimeout` 缺省为 0（不限）。修复：拆两档——运行期（连接 10s / 空闲 5min，容纳大文件慢链路）与探测期（连接 5s / 空闲 15s、不重试）。实测：黑洞端点探测从「永不返回」变为 15s 明确失败；真实 MinIO 上探测 220ms 通过、能力位不变。
- **死代码**：`shared/url.ts` 的 `getManagedFilePathname` 收为模块私有（唯一消费方在同模块，架构测试白名单同步移除）；`FILE_ACCESS_DELIVERIES` / `DERIVED_TIERS` / `AUTH_SNAPSHOT_RESULTS` 三个运行期元组常量删除（取值只用于类型约束，无运行期消费方，联合类型直接声明）；`FILE_ACCESS_BATCH_CONCURRENCY` / `MEMORY_ENTRY_LIMIT` 不再从 `@/lib/file-access` 再导出（测试改从定义模块导入）。
- **规格与实现的三处不一致**（改 Spec）：2.3「响应体不包含存储 key」与逐条回显的 `key` 矛盾，改为「不含 bucket / 对象存储内部路径 / 凭据」；3.4 补「下载描述不参与形态学习」的例外（否则按字面实现会引入本次修掉的 bug）；2.4 补 `files.read_failed`（逐条异常隔离的收敛码）。

2026-10-26 复审修复（第二轮：主动刷新、失败态与存储清理）：

- **共享调度搁浅**：取消最早条目后，旧定时器触发空批次时 `runDue` 直接返回，剩余条目要等到下次注册或唤醒事件。修复：批次执行后无条件 `arm()`；回归用例「取消最早项后，剩余项仍由共享定时器触发」。
- **重试预算漏记失败**：`retrySigned` 重新描述失败时未消耗该地址的预算，同一地址会在每次加载失败时重复描述。修复：`RefreshOutcome` 区分 resolved / failed / cancelled，取消不记账，失败同样记账；回归用例「重描述失败也消耗该地址的重试预算」。
- **失败态重试入口不可点**：调用方容器可能是 `pointer-events-none`（资产悬浮预览），`MediaAccessError` 根节点缺少 `pointer-events-auto`。修复：两种布局都显式恢复指针事件；补组件用例。
- **AudioWaveform 描述失败死路**：描述失败时仍调用按设计返回 `null` 的 `retrySigned`，覆盖层也没有入口。修复：只有元素加载失败才重描述；描述失败时覆盖层提供 `refresh` 手动重试；补两条用例。
- **浮层恢复旧打开态**：`AssetHoverPreview` 停用 / 无预览内容期间保留 `open=true`，重新启用会直接弹出。修复：停用期间在渲染期重置为关闭态；补用例。
- **本地后端吞掉删除错误**：`deleteFileOnly` 把所有失败当作「已删除」，缓存迁移与 TTL 清理会误报成功（`purge-legacy-cache` 退出码也因此失效）。修复：只把 `ENOENT` 视为成功，其余上抛（`StorageBackend.delete` 契约）；补真实文件系统失败用例。
- **provider-check 重复计数**：`response-*` / CORS 未通过时探测已写入 `report.warnings`，脚本又各加一项。修复：只使用 `report.warnings.length`。
- **死代码与过期注释**：移除仅测试使用的 `peekMediaUrl`（测试改用 `peekMediaAccess` 收窄）；同步 `protocol.ts`、`cache.ts`、`download.ts` 中与实现不符的注释。
- Spec 回写：3.2 持久化分键改为 `key + width` + 记录内账号作用域字段；`storage-provider-portability` 1.3 明确 `generic` 只要 `HeadBucket` 报错（含 403/404）就改试 path-style。

尚未执行的验收项：

- 「浏览器实测（CDP）」全部条目尚未执行（90 图首次加载、刷新命中、跨窗口、下载、视频 Range、`local` 后端），需用户走查确认或在具备浏览器调试条件时补测。
- 上游引用交付（`storage.upstream_ref_delivery`）未在本轮重新实测，规则未变（TTL 改读常量）。

Spec 收敛与文档回写（2026-10-24，用户「按建议」授权）：

- [storage-s3-delivery-caching.md](storage-s3-delivery-caching.md) 的状态由「已确认」改为「已废弃」。机制与能力凭据缺省窗口的约束已**并入**本 Spec 规则 4.6，不再存在「整体废弃会丢失仍然生效的约束」的问题；其余可执行规则（302 读路径、`storage.s3.*` / `storage.edge.*` 设置键、代理模式、阶段 C）全部随废弃失效，正文保留为历史证据。
- 规则 7.5 记录读分发主题的 Spec 归属表（共用：`storage-s3-backend` 实现 / 本 Spec 读路径 / `production-cutover` 部署；两份废弃只作否决与历史记录）。
- [storage-s3-backend.md](storage-s3-backend.md) 规则 4 的能力凭据外链改指本 Spec 规则 4.6，`presignGet` 的 `windowSeconds` 注释修正（原「0 = 不对齐」与实现不符，缺省为 `ceil(ttl/4)`）。
- 代码注释外链同步：`server/services/storage/backend.ts`、`server/services/storage/backends/s3.ts` 不再指向已废弃 Spec（纯注释变更）。
- 复核：`npm run typecheck` 通过；`npx vitest run server/__tests__/services/storage --maxWorkers=1` 28 文件 / 315 用例通过。

代码审查后的解析层修复（2026-10-24，未提交）：

- **`forceRefresh` 曾并入普通在途请求**：`acquireJob` 按缓存键去重，媒体元素 403/404 触发的 `retrySigned()` 可能搭上另一消费者正在进行的描述，拿回同一个已被判定失效的地址，规则 3.6 的「重新描述一次」实际是空操作。修复：强制刷新改用独立在途表（`refreshJobs`），并给每个请求编号（`seq`），缓存写入只接受更新的请求——先发起的旧描述晚返回不会覆盖后发起的新描述。回归用例：`file-access.test.ts` 的「forceRefresh 不并入普通在途请求」。
- **描述响应边界校验**：`signed` 缺少可用 `expiresAt` 时不再静默按「永不过期」或「永远过期」处理（前者拿着失效地址渲染，后者每次挂载都重新描述），而是在边界处明确失败（`parseDescriptor`），由调用方进入失败态；`FileAccessDescriptor` 同时改为判别联合，缓存与过期判定无需防御可选字段。回归用例：「signed 描述缺少 expiresAt 时明确失败」。
- **下载失败反馈**：`downloadManagedFile` 改为解析后触发，失败按规则 3.7 走轻量消息（`showGlobalMessage().error`）——下载是用户点击的即时反馈（`web/AGENTS.md` 七.1）。
- **描述路由请求体改用 zod 模式**（`server/schemas/file-access.ts`）：与其余路由同一 `safeParse` 约定；JSON 畸形回 `common.invalid_json`、字段类型非法回 `common.invalid_request`（规则 2.4 已按此更新）。

规则 3.6 的元素级接线（2026-10-24）：

- 新增共享组件 `web/src/features/media/components/ResolvedMedia.tsx`（`ResolvedImage` / `ResolvedVideo`）：引用值 → `withManagedFileWidth` → `useFileAccessUrl`；地址就绪前与加载失败后渲染调用方 `fallback`，元素 `onError` 触发 `retrySigned()` 一次，成功以 `reloadToken` 重挂元素（签名地址未变时也重新加载）。失败按**最终地址**记账，地址变化（换源 / 重描述 / 账号切换）自动复位。`fallback` 同时支持函数形态（`{ failed, retry }`）：媒体元素在描述失败时没有 `onError` 可挂，失败态与手动重试（`refresh`）由调用方在替代内容里表达——预览类「媒体即内容」的调用点据此渲染 `MediaAccessError`，装饰性缩略图继续用静态替代内容。
- 已迁移的缩略/预览消费点：`AssetCard`、`AssetInspector`、`AssetCreateDialog`、`ProjectListPage`、`SettingsModal`、`UserMenuPopover`、`CanvasExplorer`、`ConfirmCard`、`Inspector`（机位截图与放大预览）、`MentionChip`、`MentionDropdown`、`ImageRefCard`、`VideoRefCard`、`MediaPreviewOverlay`。
- 悬停大图由 `HoverCardMediaContent` 承担（`AssetHoverPreview` / `ReferenceHoverPreview`）：该组件新增 `onMediaError` / `mediaRevision` 两个与业务无关的回调，失败与重试按钮都会上报，调用方据此重新描述并重挂。
- 仍直接消费 `useFileAccessUrl` 的是需要地址本身而非媒体元素的链路（命令式读取像素、`<audio>` 播放控制、3D 贴图、视频代理 / 雪碧图产出），其失败处理按各自产物形态实现，不走元素重试。

范围补充（实现中发现）：

- `web/src/features/canvas/editing/client-media/client-video.ts` 原先直接以 `/api/files/{key}` 作为 Mediabunny `UrlSource`，同样属于托管媒体消费点（规则 3.5），已一并改为经解析层取地址；探测负缓存键仍用存储 key，不随签名 URL 轮换。
- `canvas-edit-actions.ts` 的「复制图片」原先把存储 key 直接当作图片 URL，本次一并修正为解析后加载（既修复既有缺陷，也符合直连目标）。

消费方补齐（2026-10-24，未提交）：

- **悬停大图改为打开时解析**：`AssetHoverPreview` / `ReferenceHoverPreview` 原先在卡片挂载时就调用 `useFileAccessUrl`，而消费地址的 `HoverCardMediaContent` 只随浮层打开才挂载——列表内每张卡片都会先发一次描述，且首次真实悬停时可能已过期再发一次。新增 `web/src/features/media/components/ResolvedHoverMedia.tsx`：`armed` 在首次 `open` 时置真且不复位（关闭动画期间内容仍在，重复悬停不重复描述），未武装时 Hook 收到 `undefined`、不发请求。`HoverCardMediaContent` 保持纯展示，不感知访问解析；`ReferenceHoverPreview` 的入参由 `src` / `onMediaError` / `mediaRevision` 改为 `value` / `width`。
- **面板级失败态**：裁剪 / 标注 / 全景 / 打光 / 多角度 / 音频截取这些命令式消费方没有媒体元素可挂 `onError`，规则 3.6 的元素级接线覆盖不到；此前只取 `url`，描述失败表现为空白或永久「加载中」，没有任何重试入口。新增共享组件 `web/src/features/media/components/MediaAccessError.tsx` 统一渲染「说明 + 重试」，重试走 `refresh`（强制重新描述）——描述失败时 `retrySigned` 按设计返回 false（规则 3.6 的闩锁语义）。`CropPanel` / `AnnotationPanel` 的 `<img>` 仍接 `onError → retrySigned`，并以 `reloadToken` 重挂元素（重新签出的地址与旧地址相同时也强制重新加载）。
- **音频截取面板**：wavesurfer `error` 触发一次 `retrySigned`；`reloadToken` 进入实例重建依赖，`ready` 回调清除失败态（此前一旦失败永不恢复）。描述失败显示面板级重试而不是「加载中」。
- **宫格切分**：改为在动作发生时取地址（规则 3.6 的非元素形态），不再复用挂载时的 Hook 结果——长驻节点的签名可能早已过期，且描述失败此前是静默 `return`。最终失败按规则 3.7 发全局通知（`node.gridSplitFailed`），不再只写 `console.error`。
- **命令式位图加载统一**：新增 `web/src/lib/load-media-image.ts`（`loadMediaImage`），
  「动作时解析 → `new Image` → 跨域读像素 → 元素失败强制刷新一次」由一处实现，
  `ImageNode` 变换、宫格切分、全景截图、复制图片、机位落画布五处共用；此前五份手写实现中
  只有两处做了规则 3.6 重试。`ImageNode` 同时移除挂载时的 `useFileAccessUrl(src)`——
  该地址只被变换动作消费，挂载即解析会让每个图片节点多一次描述（且长驻后已过期），
  与「同标签页刷新 90 图 = 90 次描述」的验收目标冲突。
- **stream 学习不被强制刷新绕过**：`resolveMediaUrl` 在已学习 `stream` 后对 `forceRefresh`
  同样短路。stream 地址由逻辑值确定性构造，重新描述不可能改变结果（规则 3.4）；
  此前视频手动重试会白跑一次描述请求。回归用例见 `file-access.test.ts`。
- **试听与下载失败统一改轻量消息**：`AssetCard` 的音频试听失败与 `downloadManagedFile`
  的下载失败同属点击的即时反馈，按 web/AGENTS.md 七.1 都用 `message.error`，不再用通知
  （规则 3.7 已按此改述；消息通道没有 `key` 去重能力，连点叠条属该形态的既有行为）。
- 测试基础设施：新增 `web/src/__tests__/test-utils/react-i18next-mock.ts`。只 mock `useTranslation` 的测试一旦依赖链顶层导入 `@/lib/i18n/config`（本次由 `@/lib/file-access` → `@/lib/api/client` → `error-message` 触发），会因缺少 `initReactI18next` 在收集阶段失败；共享替身补齐该导出，避免各文件各写一份不完整 mock。

代码审查后的修复（2026-10-25，未提交）：

- **`VideoPlayer` 自动播放恒静音**：地址异步化后 effect 在 `accessUrl` 未就绪时调用 `play()`，无源元素以 `NotSupportedError` 拒绝，被误当作自动播放策略拦截而永久静音。现仅在地址就绪后播放，且只有 `NotAllowedError` 才降级静音。回归用例：`VideoPlayer.test.tsx`。
- **`AssetCard` 旧尝试中止新尝试**：解析途中再次点击时，旧尝试的 abort 拒绝进入 `catch`，其收尾 `stopAudio()` 会 abort `playbackRef.current`（新尝试）。现以「是否仍是当前尝试」判定，被取代的尝试不执行收尾。回归用例：`AssetCard.test.tsx`「旧尝试的 abort 拒绝不会中止新尝试」。
- **`stream` 学习覆盖排队项**：`runJob` 在请求真正发出前重新检查已学习形态，学习后排队的描述请求直接由 `buildManagedFileQueryUrl` 构造；学习前已启动的首批请求受并发上限约束。学习结果保持在会话作用域内（会话切换仍由 `resetAccessState` 清空，规则 3.2 / 3.4 已按此修正措辞）。回归用例：`file-access.test.ts`「stream 学习后，排队中的描述请求不再发起」。
- **LOD `zoomingOut` 方向**：改为相邻两帧缩放比较，同一手势内反向（放大后回缩 / 缩小后回放）立即翻转，规则 3.9 的在途中止据此生效。回归用例：`CanvasMediaLoadingProvider.test.tsx` 反向用例。
- **客户端媒体管线取消**：`resolveMediaUrl` 传入 `signal`，并在打开媒体源前再次 `ensureNotAborted`，取消不再等待媒体探测完成。
- **重试结果携带地址**：`retrySigned` 返回重描述后的最终地址（未重试为 `null`）。`CanvasImage` 仅在地址未变（同一签名窗口）时重试调度任务；地址已换时由新 lease 自行加载，不再多探一次过期地址。
- **命令式位图加载只对 `signed` 重试**：`loadMediaImage` 检查 `delivery`，`stream` / 外部地址失败直接上抛，与元素形态（`retrySigned` 返回 `null`）一致。
- 补充单测：`credentialsForDelivery` 映射、`retrySigned` 闩锁与 `stream` / 外部值返回 `null`。
- 清理：`resize-cache.ts` 悬空注释、`s3.ts` 重复 import、`ResolvedMedia` 无消费方的类型导出与 `ResolvedVideo` 的未使用 `width`。

第二轮审查修复（2026-10-25，未提交；按「从根因修复」处置）：

- **规则 6.2 的 `no-store` 落到构造点**：原实现逐路由补头，体积上限（中间件）、全局 404、鉴权中间件生成的错误响应全部落在业务路由之外，规则实际有洞（413 即为一例）。现由 `server/core/response` 的 `failCode` 默认输出 `no-store`，调用方只能覆盖；`app.ts` / `files.ts` / `media-busy.ts` / `rate-limited.ts` / `upload.ts` 的重复补头全部删除。回归用例：`server/__tests__/core/response.test.ts`、`files.test.ts` 的 413 断言。
- **`wellFormedUtf16` 不再依赖 `String.prototype.toWellFormed`**：Next 的现代浏览器基线含 Firefox 111，而该方法到 Firefox 119 才有；在被前后端共用的纯字符串工具里调用「可能不存在的原型方法」会让下载在旧版浏览器直接抛 `TypeError`。改为按码元手写扫描（同一 ES2024 语义），原生方法只留作测试 oracle。回归用例：`server/__tests__/shared/text.test.ts` 的代理对边界用例。
- **悬停大图的手动重试曾复用自动重试闩锁**：`HoverCardMediaContent` 的失败按钮与元素 `onError` 共用 `onMediaError`，而后者在 Hook 里是「同一源只重试一次」的闩锁——用过一次后按钮变成死键（只重挂同一个已过期地址）。现新增独立的 `onRetry`（缺省回退 `onMediaError`），`ResolvedHoverMedia` 手动重试走 `refresh` 强制重新描述。回归用例：`ResolvedHoverMedia.test.tsx`「元素失败后用户点重试」。
- **元素身份镜像抽公共 Hook**：`VideoNode`（会话纪元 + 重挂令牌 + 源）、`VideoPlayer`（令牌 + 地址）、`AudioRefCard`（令牌 + 地址）三处各写一套「按元素身份作废旧镜像」的簿记，且复位口径不一（两处渲染期重置、一处只对令牌）。现统一为 `web/src/lib/use-element-mirror.ts`（渲染期复位，身份 = 调用方拼装的元素标识），三处改用同一实现。回归用例：`UseElementMirror.test.tsx`。
- **`src/hooks` 不再是分层中的一层**：通用 Hook（`use-file-access-url`、`use-online-status`）移入 `web/src/lib`，业务 Hook（`use-sse-task-monitor`）移入 `web/src/features/canvas/hooks`，`src/hooks` 目录删除；`web/AGENTS.md` 八.1 补充 `lib` 为最底层的分层说明，`components.json`、eslint 的 `no-restricted-syntax` 文件组随之收口（否则针对 `src/hooks/**` 的规则在目录消失后静默失效）。
- **LOD 在途中止的复查结论**：缩小手势中止的高档位 job 在结算后若档位未变（滞回范围内）会被重新排队加载——这是「仍想要这张图」的正确结果，不是重复请求缺陷；abort 结果被 `complete()` 的守卫丢弃，不会写入失败态。本项不改代码，记录判定依据。

2026-10-27 浏览器走查（CDP 预览，登录态，后端 `s3`，测试画布 `mvpfy0f2lp0gx2`；覆盖上文「尚未执行的验收项」中的首次加载、刷新复用、下载、视频 Range 四项）：

**已验证事实**

- 冷缓存首屏只发 2 次 `POST /api/files/access`（均 200，52ms / 19ms），13 个媒体请求全部直连 `10.10.10.2:9833`；整页无任何 `GET /api/files/<key>` 字节代理请求，Network 中 302 数为 0。
- 同标签页刷新：IndexedDB `noxrea-file-access` 已有 19～293 条未过期 signed 描述时，刷新后描述请求为 0 次，媒体仍全部直连 bucket；清空该库后刷新恢复为 2 次批量描述，并回填 signed 条目。
- `refreshAt` 到期语义：把一条记录的 `refreshAt` 改到过去后刷新，载入阶段丢弃该条并从磁盘删除，触发 1 次批量重描述，条目续期为 `refreshAt` = now+9962s、`expiresAt` = now+12842s（`savedAt` 更新）。同一签名窗口内 URL 逐字节相同，续期体现在字段而非地址。
- 描述契约：50 条 → 200 且 50 条逐条结果；51 条 → 400 `common.invalid_request`；不存在的 key → 该条 `files.file_not_found`，整批仍 200 且同序同长；`download: true` 的 signed 描述 query 含 `response-content-disposition=attachment; filename*=UTF-8''…` 与 `response-content-type`；响应头 `Cache-Control: private, no-store`、`Referrer-Policy: no-referrer`；`X-Amz-Date=20261026T160000Z`（1h 边界对齐）、`X-Amz-Expires=14400`、`expiresAt − refreshAt = 2880s`（寿命 80%）。
- 下载端到端：点击节点下载按钮生成的 `<a href>` 直指 bucket，跨域 signed 不带 `download` 属性；对同一 URL 发 Range 请求返回 206，`Content-Disposition: attachment; filename*=UTF-8''缓存验证图.png`，字节不经过应用。
- 视频：`<video>` 直连 signed 地址播放（readyState 4），seek 到 8.97s 后继续播放；Network 中该 mp4 出现多条 206 Partial Content（含 Range 读取中途 abort 的请求）。
- 90 图量级：另建测试项目（90 个图片节点、90 个不同存储 key、10×9 网格、视口缩放 0.22 整屏可见）冷加载，整页只发 **2 次 `POST /api/files/access`**（均 200，50 + 40 条；50 条上限直接生效，两批在 882 ms 同时发出、耗时 2.0 / 2.3 s，对应服务端 6 并发描述）；90 个媒体请求全部直连 `10.10.10.2:9833`（Network 记录 89 条均 200 OK，resource timing 计 90 条，属采集时尾部差 1），`GET /api/files/<key>` 代理请求 0 条、3xx 0 条；91 个 `<img>`（90 节点 + 1 界面图）全部 `complete && naturalWidth > 0`。该测试项目用后即删。

**仍然验不了（本次）**

- 跨签名窗口（1h 窗口到期后同一对象 URL 变化一次）未实测——需等到窗口边界或临时调小常量重编译。
- bucket 命中浏览器缓存时「传输 0 字节」无法从页面上下文证明（跨域无 `Timing-Allow-Origin`，resource timing 的 `transferSize` / `decodedBodySize` 恒为 0）。
- 规则 3.8 主动刷新的会话内定时行为（到点后台重描述、会话抖动、退避）未在浏览器触发：寿命 4h、`refreshAt` 在 80% 处（约 1.8h 后），本次只验证了「载入时丢弃过期条目并重描述」这一半，其余由单测覆盖。
- `local` 后端（`stream` 描述）未验证——当前运行时 `backend=s3`，切换后端属于运行时设置变更，本次未做。

以上未验证项不改变状态：本 Spec 维持「已确认」，「已实现」由用户设置。
