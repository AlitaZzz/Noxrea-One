# Storage 边缘缓存分发（Storage Edge Cache Delivery）

状态：已废弃（2026-10-24 用户确认；由 [storage-signed-direct-delivery.md](storage-signed-direct-delivery.md) 取代）

上游与关联：

- [storage-s3-delivery-caching.md](storage-s3-delivery-caching.md)（已废弃，2026-10-24）：阶段 A/B 曾实现；其目标 2「消除 302」当初由本 Spec 承接，**实际由 [storage-signed-direct-delivery.md](storage-signed-direct-delivery.md) 达成**（本 Spec 未实施即废弃）。签名窗口机制已并入该 Spec 规则 4。
- [storage-s3-backend.md](storage-s3-backend.md)（已实现）：双凭据模型与读分发。
- [file-access-ownership.md](file-access-ownership.md)（已实现）：归属解析单点 `ownership.ts`。
- [canvas-media-resolution-lod.md](canvas-media-resolution-lod.md)（已确认）：`w` 参与缓存键（`rv` 已于 2026-10-24 整体删除，浏览器读路径只带 `?w=`）。

## 目标

1. **浏览器读路径零 302**：`/api/files/*` 直接返回字节（或由边缘缓存命中返回），不再有每图一次的 302 跳转。
2. **URL 永久稳定且不承载凭据**：缓存寿命由 `immutable` 与稳定 URL 决定，不再依赖放大签名窗口；预签名 URL 不出现在浏览器读路径上。
3. **共享缓存安全**：反代 / CDN 只有在**每次请求都通过授权判断**之后才释放缓存字节；未授权请求永远拿不到字节，跨用户不串用。
4. **部署中立**：应用侧只定义一个边缘契约（授权回调 + 可信边缘标记），nginx / Caddy / Serverless Edge / CDN 均按契约实现，不引入供应商 API 或签名格式依赖。

## 范围

1. 应用侧缓存语义：按凭据类型与「是否经由可信边缘」输出 `Cache-Control`（含修正在先的 `public` 缺陷）。
2. 授权回调端点：`GET /api/files/_authz`，供边缘在每次请求（含缓存命中）前调用。
3. 可信边缘标记：`storage.edge.origin_secret` 设置 + `X-Noxrea-Edge` 请求头。
4. 启动校验：可信边缘与 `delivery=redirect` 互斥。
5. 部署契约与 nginx 参考配置（写入 README 部署章节）。

## 非目标

- 独立资产域名（CDN 使用不同 host）。需要前端 `resolveFileUrl` 支持运行时资产基址，另行评估。
- 边缘自校验凭据（signed cookie / token 在边缘直接判定归属），原因见规则 7。
- 直连 bucket 回源（边缘用固定凭据直接访问 S3）：`w=` 派生图需应用按需生成，双源回源复杂度高；本 Spec 统一回源应用。
- 边缘 purge / 删除联动、CDN 供应商配置代码化（Terraform 等）。
- `storage.s3.delivery` 默认值切换（见待确认事项 1）。

## 背景与现状（已验证事实，2026-10-23）

- 302 来源与成本：`storage.s3.delivery=redirect` 下每图每次加载一次 302；单次 p50 17 ms，90 并发整轮 204–344 ms（`stat` 占主要部分），单次加载约 90 KB 头字节。详见 [storage-s3-delivery-caching.md](storage-s3-delivery-caching.md) 的实测表。
- 302 不能改为可缓存：CDP 决定性实验证明 Chrome 的 `<img>` 子资源私有缓存不按 `Vary: Cookie` 分区，缓存 302 会把用户 A 的预签名 Location 交给用户 B（能力凭据泄漏）。同 Spec 规则 2.1。
- `delivery=proxy` 分支已存在：应用以流式方式从后端读取并返回 200（含 Range 206/416），本就没有 302；缺的只是共享缓存语义与授权回调。
- **既有缺陷**：[file-response.ts](../server/http/file-response.ts) 对所有分支统一发 `Cache-Control: public, max-age=31536000, immutable`——会话响应也标 `public`。当前没有共享缓存时无实际后果，一旦部署方在前面加一个不鉴权的反代/CDN，就会把已鉴权字节放进共享缓存并跨用户释放。本 Spec 必须先把缓存头改成「说实话」。
- 归属判定完全由 key 形态决定（`ownership.ts` 单点）：内容键首段、`staging/{userId}/`、派生键内嵌源键。应用可在不触达存储的前提下完成授权。
- **派生 key 的用户前缀不在首段**：`_cache/v2/{tier}/{源键}.webp`、`_posters/v{n}/{源键}`、`_sprite/`、`_proxy/` 均以命名空间开头。这是规则 7 否决「边缘按路径作用域自校验凭据」的决定性事实。

### 行业对照（三项推荐的成熟度依据）

| 做法 | 采用方 / 标准 | 与本方案的关系 |
| --- | --- | --- |
| 应用代理字节（app-proxy）作为默认 | 自托管媒体应用普遍由应用进程读存储并流式返回（Nextcloud 的 X-Sendfile / X-Accel-Redirect、Immich、PhotoPrism）；SaaS 在需要按请求鉴权、且未上 CDN 时同样代理 | 规则 1.3 的方向：无边缘时零 302、URL 稳定；规模化后再由边缘接走字节 |
| 边缘逐请求授权回调（auth subrequest + 共享缓存） | nginx `auth_request`（1.5.4，2013 起）+ `proxy_cache`；Caddy `forward_auth`；Cloudflare Workers / Lambda@Edge 的鉴权子请求 | 规则 3：归属判断留在应用单点，边缘只负责「每次先问」 |
| CDN 原生签名 Cookie / 签名 URL | AWS CloudFront signed cookies（官方定位即「多文件、URL 不变」）、Cloudflare / Akamai 的 token 鉴权 | 成熟，但要求凭据可按路径作用域覆盖该用户全部资产；派生 key 用户前缀不在首段 → 规则 7 否决 |
| 授权结果短 TTL 缓存 | OAuth 令牌自省结果缓存、nginx 对 auth 子请求启用 `proxy_cache`、边缘 JWT 校验缓存 | 规则 3.6；吊销延迟上限 = TTL，授权缓存的键**必须含凭据** |
| 预签名 URL 逐图 302 | 常见于下载、上传与 API 间传递；用于「必须跨会话缓存的页面图片」是少数派 | 上一 Spec 已实测缓存缺陷，本方案移除该形态 |

结论：三项推荐均为成熟做法的组合，不是自创方案。唯一需要说明的是规则 7——边缘自校验凭据同样是成熟方案，本方案不采用是因为**本仓库的 URL 空间（派生 key 无用户前缀）不适配**，不是因为方案不成熟。

## 业务规则

### 1. 读分发：零 302

1.1 可信边缘部署下必须使用 `storage.s3.delivery=proxy`（启动校验见规则 5）。浏览器读路径返回 200 字节或边缘缓存命中，不再出现 302。

1.2 浏览器读路径的 URL 保持 `/api/files/{key}?w=<档位>&rv=<版本>`，**不携带任何凭据**。会话 Cookie / 签名参数仍参与授权判断，但**不进入缓存键**。

1.3 未部署可信边缘的实例保留 `redirect`（302）与 `proxy` 两种既有模式，本 Spec 不改变其行为。`redirect` 仍是「字节出口交给对象存储」的显式选项；`proxy` 是「零 302」的唯一选项。

### 2. 缓存语义（按凭据类型与边缘信任）

2.1 会话凭据、**无可信边缘标记**：`Cache-Control: private, max-age=31536000, immutable`。浏览器私有缓存照常生效；任何共享缓存不得存储。这是对既有 `public` 的安全修正。

2.2 会话凭据、**可信边缘标记有效**：`Cache-Control: public, max-age=31536000, immutable`。共享缓存可以存储，但释放前必须通过规则 3 的授权回调。

2.3 签名 URL（能力凭据，无会话）：`Cache-Control: public, max-age=<expires − now>, immutable`。共享缓存寿命不得超过签名剩余有效期；过期后不再命中。

2.4 非 2xx（401/403/404/416/5xx）：`Cache-Control: no-store`。边缘不得缓存。

2.5 文件响应一律**不得**输出 `Vary: Cookie`，也不得输出 `Set-Cookie`。`Vary: Cookie` 会让共享缓存按 Cookie 分区，等于关闭边缘缓存；`Set-Cookie` 会让 nginx 默认拒绝缓存。

2.6 302 分支保持 `Cache-Control: no-store`（与上一 Spec 规则 2.1 一致）；可信边缘下该分支由规则 5 的启动校验禁止。

### 3. 授权回调端点

3.1 `GET /api/files/_authz`，供边缘对**每一次** `/api/files/*` 请求（含命中缓存的请求）调用。

3.2 目标请求由请求头 `X-Original-URI` 给出：原始请求的 path + query（百分号编码保持原样，如 `/api/files/3/ab/<hash>.webp?w=640&rv=2`）。该端点从其中提取 key 与查询参数，**复用读路由同一份守卫实现**（抽公共函数：会话认证、签名校验、会话归属比对）；不得另写一份判定。

3.3 状态码契约（必须落在 nginx `auth_request` 可透传的集合内）：

| 结果 | 状态码 |
| --- | --- |
| 授权通过 | `204` |
| 无任何凭据（无会话、无签名参数） | `401` |
| `X-Original-URI` 缺失/畸形、签名无效或过期、会话归属不符、key 畸形（fail-closed） | `403` |

不使用 404：nginx `auth_request` 对 2xx/401/403 以外的状态一律转 500。归属拒绝与「key 不存在」在本端点返回同一 403（端点不触达存储，无法也不应区分），不构成存在性预言机。

3.4 端点只做认证 + 归属判断：**不得**调用 `backend.stat/get`、不得触发 `w=` 缩放、不得产生派生产物。响应 `Cache-Control: no-store`。

3.5 端点注册在 `/api/files/*` 通配路由之前（与 `upload-limits` 等既有具体路径相同的注册方式），并有用例锁定不被通配符吞掉。`_authz` 不可能是合法存储 key（内容键以数字开头，派生键以 `_cache/` 等命名空间开头）。

3.6 授权结果允许边缘做短 TTL（建议 ≤ 60 s）缓存以摊薄回源（见待确认事项 3）。**授权缓存的键必须包含凭据本身**（会话 Cookie / Bearer 值或签名参数），不得只用 URI——否则用户 A 的「允许」会被复用于请求同一 URI 的用户 B，等于绕开归属校验。吊销延迟的上限即该 TTL。契约只要求「释放缓存字节前必须持有未过期的授权判断」，具体缓存机制属部署实现。

### 4. 可信边缘标记

4.1 设置 `storage.edge.origin_secret`（`text()`，默认空）。为空时应用**从不**信任任何请求为「经由可信边缘」，会话响应始终 `private`。

4.2 边缘在授权通过后、回源请求上添加 `X-Noxrea-Edge: <secret>`。边缘必须**覆盖或剥离**客户端传入的同名头，防止用户自行伪造。应用以常量时间比较（`crypto.timingSafeEqual`）；密钥不匹配按「无可信边缘」处理（仍走规则 2.1 的 `private`），并记录一条 `warn` 审计事件（stage 固定，含 requestId）。

4.3 应用端口不得直接对公网暴露，只允许边缘网段访问（部署契约，见规则 6.5）。否则绕过边缘的直连请求仍会被应用自身鉴权拦截，但边缘缓存与 `public` 语义均不成立。

### 5. 启动校验

5.1 `backend=s3` + `delivery=redirect` + `storage.edge.origin_secret` 非空 → 启动失败，错误信息同时指明两个键名。理由：302 的 `Location` 是能力凭据，共享缓存下不应存在这条分支。

5.2 `backend=local` + 可信边缘：允许。本地后端同样可被边缘缓存，且不存在窗口问题。

5.3 `storage.edge.origin_secret` 为空：任何后端/分发组合均通过（部署未声明共享缓存）。

5.4 校验落在存储初始化点（与 `assertPresignWindowValid` 同一位置与风格），注册表保持各项独立校验。

### 6. 边缘部署契约（部署方核对项）

6.1 **缓存键**：host + path + 完整查询串（含 `w`、`rv`、`download`、`filename`）；不得包含 Cookie，不得包含 `X-Noxrea-Edge`。

6.2 **逐请求授权**：边缘在返回任何缓存字节（HIT）之前，都必须先执行规则 3 的授权回调；不得用「首次回源时已鉴权」代替。

6.3 **只缓存 2xx**：`404` 等错误不得进入缓存；`206` 默认不缓存（Range 请求回源）。

6.4 **回源合并**：开启请求合并（nginx `proxy_cache_lock`），冷缓存下同一对象的并发请求只回源一次。

6.5 **网络隔离**：应用只接受边缘网段连接；边缘必须覆盖客户端伪造的 `X-Noxrea-Edge`。

6.6 **与上一 Spec 规则 8.1 的关系**：8.1 约束的是「CDN 前置在**预签名 bucket URL** 之前」的旧形态（缓存键忽略 `X-Amz-*`）。本方案中边缘前置在**应用 URL** 之前，浏览器不再接触预签名 URL，且可信边缘下 `redirect` 被启动校验禁止；8.1 的旧形态约束由本 Spec 取代。

6.7 交付物包含 nginx 参考配置（`proxy_cache` + `auth_request` + `proxy_cache_lock`），写入 README 部署章节；Caddy / CDN 以契约描述，不提供逐行配置。

### 7. 否决：边缘自校验凭据（signed cookie / token）

曾评估「边缘用 signed cookie 或路径 token 直接判定归属，回源零鉴权」，不采用，理由：

1. 派生 key 的用户前缀不在首段（`_cache/v2/640/3/<hash>.webp`），Cookie `Path` 作用域无法覆盖该用户全部资产。
2. 边缘要判定「该用户能否读该 key」，必须复刻 `ownership.ts` 的命名空间解析（内容 / staging / 四类派生 / 畸形 fail-closed）。那是同一规则的第二个实现，随 key 形态演进必然漂移，违反「同一业务规则统一实现」。
3. 若边缘只校验「持有有效凭据」而不判定归属，缓存命中会把 A 的字节发给 B——比 302 泄漏更严重。
4. 授权回调把归属判断留在应用单点；回源鉴权是一次无存储 I/O 的认证查询，且可由边缘对结果做短 TTL 缓存（规则 3.6）摊薄，不作为每请求的固定成本。

若未来要求严格零回源鉴权，前提是把派生 URL 改为用户前缀在首段（user-prefixed derived URLs），作为独立 Spec 另行评估。

### 8. 与既有实现的关系

8.1 双凭据模型、归属解析、派生 key 形态、签名 URL 语义均不变；本 Spec 只改变「响应头」与「新增授权端点」，不改变谁能读什么。

8.2 `delivery=proxy` 的流式/Range 行为保持不变；本 Spec 只在其响应上补正确的缓存头。

8.3 上一 Spec 的预签名窗口机制在 `redirect` 下继续有效；可信边缘下不再使用。

## 技术影响

### 服务端

- [server/http/routes/files.ts](../server/http/routes/files.ts)：把「会话认证 + 签名校验 + 会话归属」抽为共享守卫函数（单一实现），读路由与授权端点共同调用；读路由按规则 2 计算 `Cache-Control`，错误路径补 `no-store`。
- 新增授权端点（并入 [files.ts](../server/http/routes/files.ts) 或独立 `files-authz.ts`），注册在通配路由之前；只依赖 `X-Original-URI`，不触达存储。
- [server/http/file-response.ts](../server/http/file-response.ts)：`buildFileResponseHeaders` 接收凭据类型与缓存策略参数，输出规则 2 的头；`X-Noxrea-Edge` 头名与比较逻辑单点在同一模块或新增 `server/http/edge.ts`。
- [server/core/settings/registry.ts](../server/core/settings/registry.ts)：新增 `storage.edge.origin_secret`（`text()`，默认空）。
- [server/services/storage/service.ts](../server/services/storage/service.ts)：新增 `assertEdgeDeliveryValid`（规则 5），与 `assertPresignWindowValid` 同址。
- 授权端点的会话校验沿用 `authenticateRequest`（含 `tokenVersion` 与 `isActive` 的库内校验）；每图一次主键查询是接受的成本，不引入会延迟吊销的认证缓存。

### 前端

无改动。URL 形态、`rv`、LOD 档位派生均不变。

### 数据与持久化

新增一个设置键（播种 + 快照），无数据库结构变更。

## 异常与边界

- **删除后仍命中边缘缓存**：`immutable` 一年，边缘不主动 purge。与浏览器缓存语义一致（浏览器同样不会再请求）；缓存寿命即正确性边界。需要即时失效的部署依赖 `rv` 版本化或边缘 purge 能力（非目标）。
- **签名 URL 经边缘**：共享寿命封顶到签名剩余有效期（规则 2.3）；过期后回源被应用拒绝。
- **冷缓存并发**：90 图同时 MISS 由边缘请求合并收敛；应用侧仍受既有媒体池并发限制（`media.busy` 503/429），不回退原图。
- **视频 Range**：206 默认不进缓存；seek 回源应用，应用透传 Range 到后端。
- **边缘存储容量**：一年 `immutable` 的对象会持续占用边缘存储；由部署方容量策略（LRU/TTL）处理，应用不感知。
- **多实例**：授权端点无状态；缓存键不含用户凭据，多实例结果一致。
- **`X-Original-URI` 被直连调用**：返回与读路由同语义的拒绝（401/403），不新增存在性信息；无存储 I/O。
- **客户端伪造 `X-Noxrea-Edge`**：边缘覆盖；若用户直连应用且猜到密钥，会话响应对其自身浏览器为 `public`——密钥是部署凭据，与 S3 密钥同级，按规则 4.3 的网络隔离兜底。
- **401/403 被缓存**：规则 2.4 禁止；部署核对只缓存 2xx。

## 验收标准

### 静态检查与测试

- 缓存头矩阵：会话直连 `private`；会话 + 可信边缘 `public`；签名 `public` 且 `max-age = expires − now`；错误 `no-store`；任何文件响应不含 `Vary` 与 `Set-Cookie`。
- 授权端点：本人 key `204`；他人 key `403`；无凭据 `401`；有效签名 `204`；过期/伪造签名 `403`；`X-Original-URI` 缺失/畸形 `403`；`_authz` 不被 `/api/files/*` 吞掉；端点执行期间 `backend.stat/get` 零调用（mock 断言）。
- 启动校验：s3 + redirect + secret → 失败并指明两键；s3 + proxy + secret → 通过；local + secret → 通过；secret 为空 → 通过。
- 可信边缘标记：正确密钥 → `public`；错误/缺失 → `private` 且有 warn 事件；比较使用常量时间实现。
- lint、类型检查、相关测试串行通过（Vitest 单 worker）。

### 端到端（本地反代实测，记录数据）

- 最小反向代理脚本（Node）按契约实现授权回调 + 缓存，驱动 90 图项目：首次加载 302 数为 0；再次加载边缘命中、回源 0 次、传输 0 字节。
- 跨用户：用户 B 请求用户 A 的 key → 403，且不产生缓存条目。
- 未携带/错误 `X-Noxrea-Edge` 时回源响应为 `private`（共享缓存不命中）。
- nginx 参考配置在可用环境中走查；若本机无 nginx，记录为未验证。

### 部署

- README 部署章节补边缘契约与 nginx 参考配置；部署核对项：应用端口不直接暴露、边缘剥离客户端 `X-Noxrea-Edge`、只缓存 2xx、缓存键含查询串。

## 待确认事项

（无——三项均于 2026-10-23 由用户按推荐确认，见下方「已确认决策」。）

## 已确认决策（2026-10-23，用户「确认按推荐，实现阶段 C」）

1. **`storage.s3.delivery` 默认改为 `proxy`**：零 302 不依赖边缘；`redirect` 保留为显式选项，与可信边缘互斥。
2. **本期不实现边缘自校验凭据**：归属判断留在应用单点；严格零回源鉴权留给「用户前缀派生 URL」独立 Spec。
3. **允许授权结果的边缘短 TTL 缓存**（建议 ≤ 60 s，吊销延迟上限即该 TTL）；授权缓存键必须包含凭据（规则 3.6）。

## 当前状态

**已废弃（2026-10-24）**，由 [storage-signed-direct-delivery.md](storage-signed-direct-delivery.md) 取代其全部浏览器读路径与共享缓存规则。

废弃原因：本方案的零 302 依赖「应用返回字节 + 边缘前置缓存」，因此必须让应用持续转发全部媒体字节，并引入可信边缘标记、授权回调端点与 `storage.edge.origin_secret` 一套契约；新 Spec 判定这条路径与「S3 下浏览器直连 bucket」相比多一层转发、多一份密钥、多一套边缘实现要求，且把缓存寿命与边缘部署绑死。新方案让浏览器持能力凭据直连对象存储，应用只鉴权与签址，不需要边缘参与。

**实施订正（2026-10-25 核查）**：本方案的应用侧边缘实现**从未进入任何提交**——全历史检索（`git log --all -S`）无 `server/http/edge.ts`、`server/http/routes/files-authz.ts`、`assertEdgeDeliveryValid`、`isTrustedEdge` 与 `FileCachePolicy` 的 `shared` 分支，因此不存在「删除」动作；曾落库并随新 Spec 规则 6.1 删除的设置键只有 `storage.s3.delivery` 与 `storage.s3.signed_url_ttl_seconds`（`storage.edge.origin_secret`、`storage.s3.signed_url_window_seconds` 从未落库）。原文把规划稿当成既有实现，已按事实订正。下方「实现记录」与「已确认决策」仅作历史留档，其中的规则、设置键与代码路径从未落地，不得作为当前实现依据。

历史状态（废弃前）：已确认并完成应用侧实现（2026-10-23，用户「确认按推荐，实现阶段 C」）。状态维持「已确认」——项目规则规定「已实现」只能由用户设置，且实现代码尚未提交、端到端验收未执行。

### 实现记录（已验证）

- 设置：`storage.s3.delivery` 默认值改为 `proxy`；新增 `storage.edge.origin_secret`（`text()`，默认空）。
- 启动校验：`assertEdgeDeliveryValid`（s3 + redirect + 非空 secret → 启动失败并指明两键），与 `assertPresignWindowValid` 同址。
- 授权判定抽为单一实现 [file-read-auth.ts](../server/http/file-read-auth.ts)，读路由与授权端点共用；归属拒绝日志随判定同址。
- 新增 `GET /api/files/_authz`（规划中的 `server/http/routes/files-authz.ts`，注册在通配符之前；**实施订正 2026-10-25：该文件从未落地**）：`X-Original-URI`、204/401/403、零存储 I/O、`no-store`。
- 缓存语义：[file-response.ts](../server/http/file-response.ts) 接收 `FileCachePolicy`；会话默认 `private`，可信边缘 `public`，能力凭据按签名剩余有效期封顶；文件错误响应（含 416）一律 `no-store`。
- 可信边缘：规划中的 `server/http/edge.ts`（**实施订正 2026-10-25：从未落地**）常量时间比较；密钥不符按直连处理并记 warn（分钟级节流；通用节流 `createLogThrottle` 抽自限流日志模块，`createFailureLogThrottle` 行为不变）。
- 文档：README 设置表与「边缘缓存（反向代理 / CDN）」章节（nginx 参考配置）；[storage-s3-backend.md](storage-s3-backend.md) 文首修订注记、设置表与分发规则；[storage-s3-delivery-caching.md](storage-s3-delivery-caching.md) 规则 8 交叉引用。
- 测试（已验证）：server 93 文件 / 1026 用例（1015 通过 + 11 跳过；2 个集成文件按设计跳过）；typecheck 通过；lint 0 error（26 条既有 `<img>` warning）。
- 本机 dev 栈实测（已验证）：`GET /api/files/_authz` 带本人会话 → 204；缺 `X-Original-URI` → 403；他人 key → 403。

### 尚未验证

- 90 图页面经真实边缘（nginx / CDN）的端到端数据（零 302、HIT 回源 0 次）。本机 dev 实例的 `system_settings` 中 `storage.s3.delivery` 仍是早先播种的 `redirect`；设置是启动快照，改为 `proxy` 需重启用户进程，本次未执行，故未测量。
- nginx 参考配置在真实环境的语法与行为（本机未安装 nginx）。
- 授权结果短 TTL 缓存对吊销延迟的实际影响（部署项）。
- 运维注意：已有实例升级后默认值不变（库中已有 `redirect` 行），需手工改为 `proxy` 才获得零 302；若保持 `redirect`，不得配置 `storage.edge.origin_secret`（启动校验会拒绝）。
