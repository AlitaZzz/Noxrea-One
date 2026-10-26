# Storage S3 读分发：稳定 URL 与缓存寿命（Storage S3 Delivery Caching）

状态：已废弃（2026-10-24 用户确认；由 [storage-signed-direct-delivery.md](storage-signed-direct-delivery.md) 取代）

> **2026-10-24 废弃说明**：本 Spec 的浏览器读分发前提（302 到预签名）已被 [storage-signed-direct-delivery.md](storage-signed-direct-delivery.md)（已确认）取代——S3 下浏览器经 `POST /api/files/access` 拿预签名 GET 直连 bucket，`GET /api/files/*` 只返回字节、**不再 302**；`storage.s3.delivery`、`storage.s3.signed_url_ttl_seconds`、`storage.s3.signed_url_window_seconds` 三个键已删除，TTL/窗口改为 [signing.ts](../server/services/storage/signing.ts) 常量。
>
> 仍然有效的签名窗口**机制**（epoch 对齐、窗口内 URL 字节一致、能力凭据不继承长窗口）与能力凭据缺省窗口的**实现约束**（缺省不得为「不对齐」，否则探测缓存永久不命中）已**并入**该 Spec 规则 4.1 / 4.4 / 4.6，由该 Spec 承载；本 Spec 其余全部规则（设置键、302 语义、代理模式、阶段 C）随废弃失效，正文只作「302 时代」的历史证据保留，不得作为实现依据。
>
> 废弃理由：整体保留会让「已确认」状态与当前读路径相反，读者需要逐条辨认哪条还生效；机制部分已经被新 Spec 完整承接，不存在失去归属的约束。当时「部分取代」的判断（担心机制失去归属）在把机制并入新 Spec 后不再成立。

上游 Spec：[storage-s3-backend.md](storage-s3-backend.md)（已实现）、[storage-s3-production-cutover.md](storage-s3-production-cutover.md)（已确认）
关联：[canvas-media-resolution-lod.md](canvas-media-resolution-lod.md)（画布 LOD 使单页图片请求数上升，缓存命中率直接影响首屏帧率）

## 目标

> 本 Spec 已废弃（2026-10-24）。以下目标、背景、方案、规则与验收标准全部只作历史记录，不构成任何当前实现要求；当前读路径见 [storage-signed-direct-delivery.md](storage-signed-direct-delivery.md)。

让「浏览器与 CDN 的缓存寿命」由**我们**决定，而不是被预签名 URL 的轮换窗口悄悄截断：

1. 页面内图片资源的 URL 在**跨会话、跨天**范围内稳定，`Cache-Control: immutable` 真正生效。
2. 消除每张图每次加载一次的 302 往返（当前 N 张图 = N 个 302，且 302 本身不可缓存）——阶段 A/B 未达成，且已实测否决在 302 层解决（见规则 2.1 的泄漏实验）。**2026-10-24**：由 [storage-signed-direct-delivery.md](storage-signed-direct-delivery.md) 以「浏览器直连 bucket、应用不参与读路径」达成，而非原设想的阶段 C 边缘鉴权。
3. 保持既有安全边界：未授权请求拿不到字节；能力型凭据（上游 AI 拉取）语义不变。
4. 部署中立：字节不经过应用服务器（保持 redirect 的核心收益）。

## 背景与现状（已验证事实，2026-10-23 实测）

### 当前实现

- `storage.backend=s3`、`storage.s3.delivery=redirect`（[registry.ts](../server/core/settings/registry.ts) 默认值）。
- `/api/files/*` 会话分支返回 **302** 到预签名 GET（[files.ts](../server/http/routes/files.ts) 规则 4），302 带 `Cache-Control: no-store`。
- 预签名签名时间对齐 `window = ttl/4 = 900 s` 的 epoch 绝对窗口（[s3.ts](../server/services/storage/backends/s3.ts)），`expiresIn = ttl + window`；窗口内多实例签出字节一致的 URL。
- 预签名 URL 携带 `ResponseCacheControl: public, max-age=3600, immutable`，字节响应本身可缓存。
- 上游引用（`storage.upstream_ref_delivery=signed-url`）同样走 `presignGet`，属**能力型凭据**，与浏览器读路径共用同一方法。

### 实测数据

CDP 实测（90 张 2000×1200 JPEG、600 px 节点、视口 0.1、headless Chrome 152、本机 dev 栈）：

| 场景 | 302 数 | 最终 200 | 其中命中浏览器缓存 | 传输字节 |
| --- | --- | --- | --- | --- |
| 首次加载 | 90 | 90 | 0 | 71 KB |
| 立即二次加载 | 90 | 90 | 90 | 0 |
| 0.1→1.4 换档（单个大图） | 1 | 1 | 0 | 1.07 MB |
| 再放大回同一档位 | 1 | 1 | 1 | 0 |

- 302 每次加载都会重新产生：302 响应带 `no-store`，浏览器不复用。
- 预签名 URL 轮换：以固定 `Date.now()` 偏移调用 `presignGet`，偏移 1/5 分钟 URL 相同，10/14/16/30/45/60 分钟均不同 —— **900 s 窗口滚动即换 URL**。
- 浏览器缓存键是完整 URL（含 `X-Amz-Date`、`X-Amz-Signature`），因此 `max-age=3600` 实际最多生效到当前窗口结束。

### 跨窗口对照（CDP 实测，单图项目，同一页面连续三次加载，改动前基线）

| 时点 | 302 数 | bucket 请求 | 命中浏览器缓存 |
| --- | --- | --- | --- |
| 首次加载 | 1 | 1 | 否 |
| 立即重载（同窗口内） | 1 | 1 | **是** |
| 等待 965 s 后重载（跨过 900 s 窗口） | 1 | 1 | **否（重下）** |

单次观测即可区分两种假设：若 URL 稳定，第三次必然命中；实测重下，证明「窗口滚动 → 缓存键变化 → 字节重下」是已发生的事实，不是推断。改动后同一脚本第三次改为命中，见「当前状态」的对照表。

### 行业做法（用于确认方向）

| 做法 | 使用方 | 请求数/图 | 缓存寿命 | 鉴权位置 |
| --- | --- | --- | --- | --- |
| CDN 签名 Cookie | CloudFront signed cookies | 1 | 由 `Cache-Control` 决定 | CDN 边缘 |
| CDN Token 鉴权（`auth_key`/路径 HMAC） | Cloudflare、腾讯云、Akamai | 1 | 同上，缓存键可只取路径 | CDN 边缘 |
| 短 TTL 预签名 URL | 单文件下载、API 间传递、上游拉取 | 1–2 | = 签名寿命 | 对象存储 |
| 应用服务器代理 | 小规模/内网/签名不可达 | 1 | 完整 | 应用 |

AWS 官方指引：需要给「多个文件 / 整站资源」授权且不改变 URL 时用 **signed cookies**；signed URL 适合单个文件。另一条共识是**预签名 URL 不与 CDN 共用**——签名在查询串里，缓存键包含它则命中率归零，忽略它则签名过期后仍返回缓存对象。

结论：预签名 302 是「下载分发」的成熟做法，不是「页面图片资源」的成熟做法。页面资源应走**稳定 URL + 边缘/请求级鉴权**。

## 已确认需求（2026-10-23）

用户要求「按行业方案来」，并先补 Spec 再实现。范围限定为读分发与缓存寿命，不含 CDN 供应商选型落地。

## 方案选择

采用**分阶段收敛到稳定 URL**，每一阶段独立成立、可单独上线：

### 阶段 A（本期必做）：稳定 URL，鉴权从 URL 移到请求

`/api/files/*` 的**会话分支**不再 302，改为：

1. **本地后端（local）**：维持现状（流式转发，URL 已稳定）。
2. **S3 后端 + `delivery=redirect`**：仍然 302 到预签名 URL，**但让 URL 稳定**——浏览器读路径的预签名窗口从 `ttl/4` 改为**独立配置的长窗口**（默认 1 天，见规则 1.3），使同一对象在窗口内签出字节一致的 URL，`expiresIn` 相应放大。
3. **S3 后端 + 新增 `delivery=proxy` 的稳定化**：proxy 模式本就 URL 稳定，无需改动。

**否决**：仅把 302 改成可缓存（`private, max-age=300`）。它只消除 302 往返，不解决「URL 轮换导致图片字节重下」——后者是缓存寿命问题的主因。

**否决**：直接把 `Cache-Control` 从 `immutable` 降级。会同时丢掉本次画布性能目标的前提。

### 阶段 B（本期必做，与 A 同批）：显式声明缓存寿命上限

在 [storage-s3-backend.md](storage-s3-backend.md) 与代码注释中明确记录：**预签名窗口 = 浏览器缓存寿命上限**。避免以后有人只改 `max-age` 却以为缓存能生效更久。

### 阶段 C（已废弃，2026-10-24）：CDN 边缘鉴权

~~CDN 用 signed cookie 或 token 鉴权、回源用固定凭据访问 bucket，缓存键只取路径。~~ **该方向未实施即被取代**：[storage-signed-direct-delivery.md](storage-signed-direct-delivery.md) 以浏览器直连 bucket 达到同等的「无 302、URL 窗口内稳定」效果，且不需要 CDN 选型、边缘契约或部署配置。下方规则 8 的约束只作历史记录。

## 业务规则

### 1. 会话读路径的 URL 稳定性

1.1 `/api/files/*` 的会话凭据分支，对**同一 storage key** 在同一「签名窗口」内必须产出**字节完全一致**的目标 URL（含查询串）。这是 `immutable` 缓存成立的前提。

1.2 **浏览器读路径**的签名窗口从 `ttl/4` 改为**独立配置项** `storage.s3.signed_url_window_seconds`（默认值见 1.3），与 `signed_url_ttl_seconds`（下游有效期）解耦。理由：两者服务不同目标——TTL 是「URL 泄漏后的可用时长」，窗口是「缓存寿命」。当前实现把二者绑成 4:1，导致调大 TTL 才能延长缓存，安全性被缓存需求绑架。能力型凭据（上游引用、媒体工具输入）不传该窗口，沿用 `ttl/4`（规则 3.1）。

1.3 默认值：`signed_url_ttl_seconds = 3600`（不变）、`signed_url_window_seconds = 86400`（1 天）。`expiresIn = ttl + window` 保持现有「窗口内任意时刻签发，剩余有效期 ≥ ttl」的语义，即 90000 s ≈ 25 小时，在 SigV4 7 天上限内。

1.4 窗口必须**锚定 Unix epoch 绝对值**（`floor(now / window) * window`），不得锚定进程启动时间或首次请求时间——多实例部署下各实例必须签出同一 URL。

### 2. 302 的缓存语义

2.1 302 继续带 `Cache-Control: no-store`。**不**改为可缓存：预签名目标 URL 在窗口边界后失效，缓存 302 会把用户导向过期 URL（403）。302 的往返成本（每图每次加载约 1 KB）可接受，且随规则 1 的窗口放大后不再放大。

**2026-10-23 补充实测（否决「把 302 改成可缓存」的直接证据）**：曾考虑用 `private, max-age=<ttl>` + `Vary: Cookie` 消除这 302 跳。CDP 决定性实验（本地两跳服务，`<img>` 子资源，按 Cookie 返回不同 Location 与尺寸不同的 GIF，用 `naturalWidth` 判定实际拿到的字节）结果：

| 时点 | 期望字节属主 | 实际字节属主 | 是否串用 |
| --- | --- | --- | --- |
| 用户 A 首次 | A | A | 否 |
| 用户 A 再次 | A | A | 否（302 被缓存，0 次回源） |
| **用户 B 首次** | **B** | **A** | **是（泄漏）** |
| 用户 A 再次 | A | A | 否 |

即：Chrome 的私有缓存在 `<img>` 子资源场景下**不按 `Vary: Cookie` 分区**（对照实验：同一 Vary 语义用于 200 响应时分区正常）。Location 是能力凭据，跨账号复用等于把 A 的预签名 URL 交给 B。故 302 必须保持 `no-store`；在 302 这一层没有安全解，正解是不让浏览器经应用跳转——2026-10-24 由 [storage-signed-direct-delivery.md](storage-signed-direct-delivery.md) 以浏览器直连 bucket 达成（规则 2 的 302 语义随之失效：读路径已无 302）。

2.2 302 的 `Location` 是唯一被浏览器缓存的 URL；其响应头 `ResponseCacheControl` 保持 `public, max-age=<ttl>, immutable`。

### 3. 能力型凭据不受影响

3.1 上游引用交付（`storage.upstream_ref_delivery=signed-url`）继续用 `presignGet`，TTL 语义不变（短有效期符合「能力凭据」定位）。它与浏览器读路径共用方法，但**不得**因本 Spec 的窗口放大而获得更长有效期——签名时间窗与有效期是两个参数，调用方可各自指定。实现口径：不传窗口时沿用既有 `ceil(ttl / 4)` 窗口（`expiresIn` 与改动前逐字节一致），浏览器读路径显式传长窗口。

3.2 签名 URL 双凭据模型（会话 / 应用层 HMAC 签名）不变，见 [file-access-ownership.md](file-access-ownership.md)。

### 4. 归属与鉴权不变

4.1 会话分支的归属强制（`isKeyOwner`）位置不变，仍在 302 之前。
4.2 本 Spec 不引入公开桶、不引入「路径即授权」。

### 5. 代理模式的定位

5.1 `storage.s3.delivery=proxy` 保持为显式备选：URL 稳定、缓存完整，代价是字节经应用服务器。本 Spec 不改变其定位，但在 Spec 中明确记录它与 redirect 在**缓存寿命**上的差异（proxy 无窗口问题）。

### 6. 设置与生效方式

6.1 新增 `storage.s3.signed_url_window_seconds`：整数秒，默认 `86400`，重启生效（与 `storage.s3.*` 同组，不参与热刷新）。单键 schema 只约束自身合法域 `[1, 604800]`；跨项范围 `[ttl, 604800 - ttl]` 是两项的组合约束，在存储初始化点校验（与既有「跨项联合校验放存储初始化点」的约定一致，见技术影响）。
6.2 启动校验（存储初始化点，`backend=s3` 时）：`window < ttl` 与 `ttl + window > 604800` 均启动失败并指明两个设置键——与既有「禁止静默降级」同口径。前者拦「缓存寿命短于 URL 有效期」的无效配置，后者拦 SigV4 7 天上限（超限时 SDK 在首次签名才抛错，等于启动成功、读路径按需 500）。

### 7. 可观测性

7.1 不新增监控依赖。302 命中率可由现有 `logEvent("files", ...)` 或 CDN 日志观测，本 Spec 不要求新增埋点。

### 8. CDN 的前置条件（已废弃，2026-10-24，只作历史记录）

8.0 整节随阶段 C 一并失效：读路径已无 302，不需要 CDN 边缘鉴权，也不存在「窗口 = 缓存寿命上限」的 CDN 前置条件。以下条款不再约束任何实现。

8.1 若将来接入 CDN，**缓存键必须只取 host + path**（忽略 `X-Amz-*` 查询参数），且回源由 CDN 用固定凭据访问 bucket——不得把用户请求里的预签名 URL 透传给 CDN。
8.2 CDN 边缘鉴权优先选 signed cookie 或 token（`auth_key` / 路径 HMAC），使 URL 永久稳定。
8.3 在 CDN 就位前，规则 1 的窗口方案是缓存寿命的上限；不得假设 CDN 会「自动解决」窗口问题。

> **2026-10-24 更新**：阶段 C 的 [storage-edge-cache-delivery.md](storage-edge-cache-delivery.md) 已由用户确认标记「已废弃」，浏览器读路径改由 [storage-signed-direct-delivery.md](storage-signed-direct-delivery.md) 承接——应用不转发字节、不引入边缘契约。规则 8 整节随之失效，只作历史记录。
>
> 历史注记（2026-10-23，已失效）：阶段 C 曾另立 [storage-edge-cache-delivery.md](storage-edge-cache-delivery.md)，把边缘前置在应用 URL 之前并以授权回调替代边缘自校验；8.2 的 signed cookie 方向当时即经评估否决（派生 key 的用户前缀不在首段，边缘须复刻归属解析）。

## 技术影响

### 服务端

- [s3.ts](../server/services/storage/backends/s3.ts)：`presignGet` 的窗口改为**逐调用参数** `windowSeconds`（缺省 `ceil(ttl / 4)`，即既有行为）；对齐时 `signingDate = floor(now / window) * window`，`expiresIn = ttl + window`。`presignPut` 不涉及（上传 URL 一次性使用，不需要稳定性）。
  **缺省值实现中修正过一次**：初版缺省 0（不对齐、`expiresIn = ttl`）会把能力凭据的签名时间变成「每次请求都不同」，而 [media-probe.ts](../server/services/storage/media-probe.ts) 的 `probeVideoMetaCached` / `integrityCache` 以**输入串（S3 下即预签名 URL）为缓存键**——S3 后端下探测缓存将永久不命中，每次探测都多一次 ffmpeg spawn。缺省回到 `ttl/4` 对齐窗口既保住「URL 可作进程内缓存键」，又满足规则 3.1「有效期不变」。
- [backend.ts](../server/services/storage/backend.ts)：`presignGet` 的 opts 增补 `windowSeconds`（接口层单一来源，调用方各自声明语义）。
- [registry.ts](../server/core/settings/registry.ts)：新增 `storage.s3.signed_url_window_seconds`（`int(86400, 1, MAX_PRESIGNED_URL_SECONDS)`）与导出常量 `MAX_PRESIGNED_URL_SECONDS = 7 天`（SigV4 硬上限的单一来源）。
- [service.ts](../server/services/storage/service.ts)：跨项校验 `assertPresignWindowValid`（`window < ttl` 与 `ttl + window > 7 天` 均启动失败并指明两个键名）。**落点与规则 6.2 的原表述不同**：校验放在存储初始化点而非 `initSettings`，与既有「跨项联合校验放在存储初始化点，注册表维持各项独立校验」的约定一致（`backend=local` 时预签名配置不参与运行，不应对其施加联合约束）。
- [files.ts](../server/http/routes/files.ts)：302 分支显式传 `windowSeconds`，`cacheControl` 继续传 `max-age=<ttl>`；注释写明「窗口 = 缓存寿命上限」。
- 上游引用（[reference.ts](../server/services/resolvers/reference.ts)）与媒体工具输入（[media-source.ts](../server/services/storage/media-source.ts)）：**不传** `windowSeconds`，走缺省的 `ttl/4` 窗口——有效期与改动前完全一致，不继承浏览器读路径的长窗口（规则 3.1）。

### 前端

无改动（当时表述）。2026-10-24 补记：`rv` 令牌已整体删除（[canvas-media-resolution-lod.md](canvas-media-resolution-lod.md) 规则 8.3），档位 URL 只带 `?w=`；前端现由访问解析层产出最终地址。

### 数据与持久化

无数据库结构变更；新增一个设置键（播种 + 快照）。

## 异常与边界

- **窗口边界抖动**：用户在窗口边界前后加载同一页面，会拿到两个不同 URL、各下载一次。放大窗口后该成本从「每 15 分钟」降为「每 1 天」，且只影响跨越边界的那个会话。可接受。
- **签名 URL 泄漏**：窗口放大使泄漏 URL 的可用时长从 15 分钟变为 25 小时。这是本方案的主要安全代价，须在 Spec 中明确记录，由部署方按风险偏好调整 `signed_url_ttl_seconds`（降低 TTL 不影响缓存寿命，这正是规则 1.2 解耦的目的）。
- **SigV4 7 天上限**：`ttl + window` 超过 7 天时启动失败（规则 6.2），不做静默截断。
- **时钟偏移**：多实例时钟偏差超过窗口边界会导致 URL 不一致；现有 epoch 锚定已要求 NTP 同步，本 Spec 不新增要求。
- **proxy 模式**：无窗口问题，但字节过应用服务器；不改。
- **local 后端**：不涉及预签名，URL 本就稳定。

## 验收标准

### 静态检查与测试

- `presignGet` 单测：同窗口内两次调用签名时间一致；跨窗口边界后签名时间按窗口步进；`expiresIn = ttl + window`；不传窗口时沿用 `ttl/4`；同一 ttl 下能力凭据与浏览器读路径的有效期互不影响。
- 设置单测：`ttl + window > 604800` 与 `window < ttl` 均启动失败并指明两个键名；两个边界值（`window = ttl`、`ttl + window = 604800`）通过；`backend=local` 不受联合校验约束；默认值播种正确。
- files 路由测试：302 分支仍带 `Cache-Control: no-store`；`Location` 的 `ResponseCacheControl` 仍为 `public, max-age=<ttl>, immutable`；`windowSeconds` 按设置透传。
- 上游引用测试：调用 `presignGet` 时不传 `windowSeconds`（有效期不因窗口设置而放大）。
- lint、类型检查、相关测试串行通过（Vitest 单 worker）。

### 浏览器实测（CDP，记录数据）

- 90 图项目连续两次加载（间隔 < 1 分钟）：两次 302 数均为 90，第二次 bucket 请求全部命中缓存、传输 0 字节（现状已满足，防回归）。
- **跨窗口验证**：等待超过旧窗口（965 s）后再次加载，bucket 请求仍命中缓存（证明 URL 稳定）；对照组为改动前 900 s 窗口下必然重下。**已验证**，见「当前状态」对照表。
- 302 数不随窗口放大而增加（实测保持 1，见同上）。

### 部署

- 生产环境确认 `storage.s3.signed_url_window_seconds` 已按部署风险偏好设置并写入部署文档。
- 反向代理/CDN 若存在，缓存键不得包含 `X-Amz-*`（规则 8.1）。

## 实施顺序（确认后）

1. 设置项 `storage.s3.signed_url_window_seconds` + 启动校验 + 播种 + 单测。
2. `presignGet` 窗口可配置（缺省保持 `ttl/4`）+ 单测；能力型凭据调用点不传窗口（有效期不变）。
3. files 路由注释与测试；[storage-s3-backend.md](storage-s3-backend.md) 回写「窗口 = 缓存寿命上限」。
4. 浏览器实测（含跨窗口对照）。
5. 报告验证结果与未覆盖项。

## 待确认事项

（无——三项均于 2026-10-23 由用户按推荐项确认，见下方「已确认决策」。）

## 已确认决策（2026-10-23，用户逐项按推荐确认）

1. **默认窗口取值**：`86400` s（1 天，缓存寿命 1 天，泄漏可用约 25 小时）；否决 `604800 − ttl`（约 6.9 天，泄漏可用 7 天）。
2. **阶段 C（CDN 边缘鉴权）本期不做**：需 CDN 选型与部署配置，另立 Spec；本 Spec 只锁定其前置条件（规则 8）。**2026-10-24 补记：该方向已废弃**，读路径由 [storage-signed-direct-delivery.md](storage-signed-direct-delivery.md) 取代。
3. **上游引用保持现有 TTL**：能力型凭据应短，不随窗口放大（规则 3.1）。**2026-10-24 补记：该决策仍然生效**，已由 [storage-signed-direct-delivery.md](storage-signed-direct-delivery.md) 规则 4.1 / 4.6 承接（TTL 常量 3600 共用，能力型凭据不传窗口）。

## 当前状态

**2026-10-24 读路径改版**：本 Spec 描述的「`/api/files/*` 302 到预签名」读路径已整体由 [storage-signed-direct-delivery.md](storage-signed-direct-delivery.md) 取代——四个 `storage.s3.*`／`storage.edge.*` 读路径设置键删除，TTL/窗口改为 `signing.ts` 常量，`GET /api/files/*` 只返回字节。本节的阶段 A/B 实现与实测数据仅作历史证据保留，当前行为以该 Spec 为准。

**状态决定（2026-10-24，用户按建议确认，最终为「已废弃」）**：最初的判断是「整体不标废弃，只由文首注记界定取代范围」，理由是签名窗口机制仍生效、怕失去归属。该顾虑已通过把机制与能力凭据缺省窗口约束**并入** [storage-signed-direct-delivery.md](storage-signed-direct-delivery.md) 规则 4 消除；据此本 Spec 转为「已废弃」，避免「已确认」状态与当前读路径相反。被取代的范围是全部可执行规则（302 读路径、`storage.s3.*` / `storage.edge.*` 设置键、代理模式、阶段 C）；正文保留为历史证据。

阶段 A + 阶段 B 曾实现（2026-10-23，用户「确认按推荐，实现阶段 A」），验收标准逐条通过；阶段 C 未在当期范围。**当前状态已改为「已废弃」（2026-10-24）**：阶段 A 引入的 `storage.s3.signed_url_window_seconds` 设置键已随读路径改版删除，窗口改由 `signing.ts` 常量承载；本段其余描述只作历史记录。由「画布缩放出现大量 302」的调查引出：确认为 `storage.s3.delivery=redirect` 的既有设计，非 LOD 缺陷；但发现预签名窗口（900 s）截断了 `immutable` 的缓存寿命。

**范围澄清（2026-10-23，用户复测「还是有很多 302」后）**：阶段 A 解决的是「URL 轮换导致图片字节重下」，**不消除 302 本身**。复测确认 90 图项目每次加载仍为 90 个 302（`bucketFromCache` 全部命中、传输 0 字节）。目标 2（消除 302 往返）在 302 层被安全实验否决（规则 2.1）；原计划只能由阶段 C 达成，实际于 2026-10-24 由 [storage-signed-direct-delivery.md](storage-signed-direct-delivery.md) 以浏览器直连 bucket 达成。302 的实际成本已量化：单次 302 p50 17 ms、90 并发整轮约 200–340 ms（其中 `stat` 到 S3 的 HeadObject 占主要部分，presign 纯本地 0.5 ms），字节成本每次加载约 90 KB。

### 实现与验证记录（2026-10-23）

**代码（已验证）**

- 新增设置 `storage.s3.signed_url_window_seconds`（默认 86400，`int(86400, 1, MAX_PRESIGNED_URL_SECONDS)`）+ 导出常量 `MAX_PRESIGNED_URL_SECONDS`（SigV4 7 天上限的单一来源，与键定义同址）。
- `S3Backend.presignGet` 的窗口改为逐调用参数 `windowSeconds`（缺省 `ceil(ttl / 4)`，即既有行为），epoch 锚定保留；`presignPut` 不变。
- `files.ts` 302 分支显式传窗口；`reference.ts` / `media-source.ts` 不传（能力凭据沿用 `ttl/4`，`expiresIn` 与改动前一致）。
- 跨项校验 `assertPresignWindowValid`（`window < ttl`、`ttl + window > 7 天` 均启动失败并指明两个键名）。
- 文档回写：本 Spec、[storage-s3-backend.md](storage-s3-backend.md)（设置表 + 规则 4「窗口 = 缓存寿命上限」）、README 设置表、[storage-s3-production-cutover.md](storage-s3-production-cutover.md) 中 `X-Amz-Expires=4500` 的历史证据加注。

**测试（已验证）**

- server 全量 90 文件 / 996 用例通过（新增：窗口内两次调用签名时间一致、跨窗口边界变化、不传窗口时沿用 `ttl/4`、能力凭据与浏览器读路径有效期互相独立、路由层 `windowSeconds=86400` 透传、上游引用不传窗口、`window < ttl` / `ttl + window > 7 天` / 两个边界值启动校验、播种默认值）。
- typecheck 通过；lint 0 error（26 条既有 `<img>` warning）。

**浏览器实测（已验证，本机 dev 栈 + NAS MinIO，CDP 同一脚本前后对照）**

- 302 `Location` 参数：`X-Amz-Date=20261023T000000Z`（对齐到 1 天窗口的 epoch 边界）、`X-Amz-Expires=90000`（= ttl 3600 + window 86400）、`response-cache-control=public, max-age=3600, immutable`；同一 key 两次请求 Location **字节一致**。
- 跨窗口对照（同一页面三次加载：首次 → 立即重载 → 等待 965 s 后重载）：

  | 版本 | 等待后那次加载的 bucket 请求 | 结论 |
  | --- | --- | --- |
  | 改动前（900 s 窗口） | 未命中，重新下载 | 窗口滚动即换 URL |
  | 改动后（86400 s 窗口） | **命中浏览器缓存，0 字节传输** | URL 跨旧窗口保持稳定 |

  965 s 已越过旧窗口边界，因此这一对照直接证明「缓存寿命不再被 15 分钟窗口截断」，且 302 数保持 1（未随窗口放大而增加）。

- 90 图项目复测（用户「还是有很多 302」后）：两次加载各 **90 个 302**，`bucketFromCache=90/90`、`bucketBytes=0`——302 仍在，但每次加载不再下载图片字节。与改动前的区别不在 302 数量，而在「跨窗口后是否重下」。
- 302 成本量化（本机 dev 栈，NAS MinIO）：单次 302 p50 17 ms / p90 26 ms；90 并发整轮 204–344 ms。拆分：`stat`（HeadObject 到 S3）p50 3.5 ms、90 并发 65 ms；`presignGet` 纯本地 p50 0.5 ms、90 并发 24 ms；两者合并 90 并发 91 ms（其余为 HTTP/框架开销）。

**尚未验证**

- 跨 86400 s（1 天）真实窗口的边界滚动：需等一天，本次未覆盖（单元测试已覆盖签名时间对齐与跨边界步进）。
- 生产环境（真实 CDN / 反向代理 / 公网 bucket）下的缓存行为。
- 多实例时钟偏差对窗口一致性的影响（依赖既有 NTP 前提，未做多机实测）。
- ~~部署项：生产 `storage.s3.signed_url_window_seconds` 设置与 CDN 缓存键约束~~：该设置键已删除（常量承载），CDN 约束随规则 8 一并失效（2026-10-24）。
- ~~消除 302 本身~~：2026-10-24 已由 [storage-signed-direct-delivery.md](storage-signed-direct-delivery.md) 达成——读路径改为浏览器直连 bucket，应用不再跳转（不是在 302 层解决，规则 2.1 的结论仍然成立）。
