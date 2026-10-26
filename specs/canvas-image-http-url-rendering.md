# Canvas Image HTTP URL Rendering

状态：已确认

决策记录：2026-10-12 用户对三项待确认事项的回复为「按照行业内的处理方法来处理」，据此采纳如下决策（均为行业惯例）：①接受放弃「字节单次流转」，取代骨架 Spec 规则 6–8；②保留结果中的 `url` 字段（任务要求原文即「结果直接携带原 HTTP URL」，且与现有结果形状一致，`CanvasImage` 零改动）；③上传 `blob:` 预览不按 URL scheme 特判，与 HTTP URL 同路径经调度器透传。状态「已确认」由用户设置（用户告知该 Spec 已定稿）。

## 目标

画布图片渲染层由「fetch → Blob → object URL 常驻内存」迁移为「HTTP URL + 浏览器 HTTP 缓存」：

1. 调度器只负责并发上限、中止、超时、解码预热；不再持有图片字节。
2. 渲染 `<img src>` 使用与预热相同的 HTTP URL，字节交给浏览器 HTTP 磁盘缓存管理。
3. 删除调度器链路上全部 object URL 生命周期逻辑（`revokeObjectURL`），消除 settled 图片压缩字节常驻 RAM 的问题。

## 前提验证结论（动手前已完成）

### 前提 1：图片响应可缓存 —— 已验证成立

- 源码：`server/http/file-response.ts:15` 对所有 `/api/files/*` 响应统一设置 `Cache-Control: public, max-age=31536000, immutable`；`server/http/routes/files.ts` 未覆盖该头，`server/http/app.ts` 无全局中间件改写缓存头。
- 实测（本机 dev 服务，2026-10-12）：对 `uploads/` 下真实 PNG 分别经 Hono（:4000）与 Next 代理（:3000）发 GET，原图与 `?w=480`（WebP 派生）四组响应均返回 `cache-control: public, max-age=31536000, immutable`。Next `rewrites` 代理未改写该头。
- 无 `ETag` / `Last-Modified`，但 `immutable` + 一年 `max-age` 下浏览器不会发起条件请求，无需 304 机制；`Vary` 不存在，缓存键即完整 URL（含 `?w=`）。
- 结论：方案前提成立，可继续。

### 前提 2：节点 `data.src` 均为长期可重复请求的 URL —— 已验证成立，附一项边界

- 服务端产出：`server/services/storage/service.ts:36`、`upload.ts:176`、`backends/local.ts:167` 唯一的 URL 构造形态是相对路径 `/api/files/<storageKey>`；`storageKey` 为内容哈希（`<userId>/<hash[:2]>/<hash><ext>`），内容寻址，同 URL 内容不变，`immutable` 语义正确。全服务端未发现签名外链、带过期时间的 URL 或对象存储预签名 URL。
- `?w=` 派生（视频海报 `withManagedFileWidth(src, 480)`）同为同源相对路径，缓存头已验证。
- 非托管/外链：`reference.ts` 中的外链透传仅用于「发给上游模型的参考图」，不写回节点 `data.src`。`shared/url.ts#getManagedFilePathname` 只认站内相对路径 `/api/files/…`（服务端的唯一产出形态）；绝对 URL 一律不是托管值——按 pathname 前缀猜归属会把别的源的同形路径改写成本站地址，令外部引用失效。未发现现行生产路径写入外链图片到节点。
- 边界（不属于时效签名，非阻断）：`ImageNode`/`VideoNode` 的上传预览通过 `CanvasImage` 加载 `data.upload.previewUrl`（`blob:` URL），由 `upload-pipeline.ts` 创建并在成功/回滚/移除时 `revokeObjectURL`。调度器改为透传 URL 后，上传预览 `<img>` 直接引用管道持有的 blob URL（此前调度器 fetch 出独立副本，不受管道撤销影响）。上传管道的撤销时点均在节点预览态结束或被替换之后，见「异常与边界」。

## 范围

- 修改：`web/src/features/canvas/services/image-load-scheduler.ts`
  - `prepareImage`：不再 `fetch`/`Blob`/`createObjectURL`；用探测 `<img>`（`decoding="async"`）加载 HTTP URL，`onload` 后 `decode()` 完成才 resolve `{ url: src, width, height }`；保留 AbortSignal 中止（探测元素 `removeAttribute("src")` 取消在途请求）、60s 超时、`onerror`/`decode` 失败即失败。
  - `ImageLoadScheduler`：删除 `revokeReadyUrl`；`release` 的 job 删除路径、`clear()`、`complete` 早退守卫不再涉及 URL 撤销；并发容量 4（重量单位）、优先级、共享 job、同轮重新认领守卫、重试语义不变。
  - 更新 `PreparedImage` / 模块注释至新语义。
- 修改：`web/src/features/canvas/hooks/use-canvas-image.ts` 与 `shared/CanvasImage.tsx`：仅注释/类型随结果语义调整；`CanvasImage` ready 分支继续渲染 `result.url`（此时即 HTTP URL）。
- 测试：`image-load-scheduler.test.ts`（删除全部 revoke/object URL 用例，改写 `prepareImage` 用例至探测 `<img>` 语义，新增中止取消在途请求、超时、失败重试用例）；`CanvasImage.test.tsx`（删除 fetch/objectURL 桩及 `sourceOf` 映射，断言 `<img>` src 即原 URL）；`VideoNode.test.tsx` 中 `blob:poster` mock 改为普通 URL 字面量（仅语义清理，行为不变）。
- 对 `specs/canvas-media-loading-skeleton.md`：业务规则 6–8、技术影响中 fetch/Blob/object URL 条目、「内存」「跨域源」两条边界被本 Spec 取代，已回写（见 `canvas-media-loading-skeleton.md` 的历史说明与对应条款）。
- 不改动：`upload-pipeline.ts` 等上传管道 blob 预览机制；服务端文件路由与缓存头；骨架 UI（延迟淡入、形状块、图标）；失败态 UI；调度器优先级/并发模型；导出、标注、裁剪等使用节点原始 `data.src` 的路径。

## 下游消费方排查（已验证事实）

调度器结果的全部消费方：

- `useCanvasImage` → 仅 `CanvasImage` 调用（`VideoNode.test.tsx` 以 mock 替换该 hook）。
- `CanvasImage` ready 分支仅把 `result.url` 作为 `<img src>`；`onLoad` 透传给 `ImageNode.handleMainImgLoad`，该函数读取 `event.currentTarget.naturalWidth/Height` 并与 `data.src` 比对，不依赖 URL 形态。
- 导出、标注（`AnnotationPanel`）、裁剪（`CropPanel`/`VideoCropPanel`）、网格拆分、下载、预览浮层均使用节点 `data.src` / 原始 URL 自行加载，不读取调度器结果，也未发现读取 `<img>.src`/`currentSrc` 并假设为 `blob:` 的逻辑。
- 结论：无任何下游依赖「结果必须是本机 object URL」；结果 `url` 现等于 job 的 `src`，语义由「本机副本」变为「同一 HTTP 资源」。

## 业务规则

1. 调度器 ready 结果 `{ url, width, height }` 中 `url` 恒等于请求的 `src`；调度器不持有、不撤销任何 URL。
2. 预热成功判定：探测 `<img>` `onload` 且 `decode()` resolve；宽高取探测元素 `naturalWidth/Height`。
3. 取消：外部 abort 或 job 失去全部兴趣时，探测元素移除 `src` 并摘除 handler，浏览器取消在途请求；已完成并入缓存的字节不受影响。
4. 超时：60s 未完成视为失败（同样取消在途请求）。
5. 失败：网络错误、非图片内容、decode 失败统一进入 `failed`；仅用户点击重试时重新预热，无自动重试。
6. 容量 4（以**重量单位**计，见 [canvas-media-resolution-lod.md](canvas-media-resolution-lod.md) 规则 7：档位 ≤1280 计 1、≥1920 计 2、托管原图计 3）、优先级调度、同 URL 共享 job、StrictMode 同轮重新认领守卫保持不变。容量不是「最多 4 个 job」：4 个原图 job 只会有 1 个同时在载，12 个轻档 job 也最多 4 个同时在载。
7. 渲染 `<img src>` 与预热使用同一 URL 字符串，命中浏览器 HTTP 缓存；缓存键一致性依赖调用方对同一资源始终传相同 URL（现有 `withManagedFileWidth` 生成稳定查询串，满足）。
8. 画布图片的显示 URL 由 LOD 派生（[canvas-media-resolution-lod.md](canvas-media-resolution-lod.md)）：逻辑引用 `data.src`（存储 key）不变，显示 URL 为 `fileRefUrl(src)` 加 `?w=<规范档位>`，或在该节点需要原图时不加参数。规则 1/7 的「同一 URL」约束落在**同一次档位选择**内：预热与 `<img src>` 使用同一档位 URL；档位变化即视为换资源，走 stale-while-revalidate（旧图保留到新档位就绪），不回退本 Spec 的缓存命中语义。派生版本段内嵌在服务端对象 key（`_cache/v2/`），不进客户端 URL；`rv` 击穿参数已整体删除，`stream` 形态的版本失效边界见 [storage-signed-direct-delivery.md](storage-signed-direct-delivery.md) 规则 6.5。

## 技术影响

- 删除 object URL 生命周期后，调度器不变量由「ready 结果要么被 job 持有、要么已撤销」简化为「结果只是数据」，`complete` 的早退守卫仅需防止过期结果通知。
- 不再使用 `fetch`：跨域限制消失（`new Image()` 显示跨域图无需 CORS），骨架 Spec 中「跨域源需对方 CORS」边界随之失效。
- 内存：settled 图片不再由应用层持有压缩字节；字节由浏览器 HTTP 缓存（磁盘为主）管理。渲染 `<img>` 的位图解码仍由浏览器内存管理。
- 节点 `data`、store、保存/恢复、撤销、SSE 同步均不受影响。

## 异常与边界

- **缓存被禁用或逐出（风险，已知取舍）**：探测下载的字节只靠 HTTP 缓存传递给后续 `<img>`。DevTools「Disable cache」、隐私模式缓存受限或缓存被逐出时，`<img>` 会对整张图二次全量下载，慢网下会重现 2026-10-11 骨架 Spec 记录的「骨架 → 空白 → 媒体」三段式。这是用户选定的行业主流取舍，本 Spec 不引入补丁；正常缓存环境（含生产）下 `immutable` 保证命中。
- 中止与竞态：release 后同轮重新认领不删除 job；abort 后迟到的 load/decode 回调经 `settled` 守卫忽略；`complete` 守卫保证被替换/删除/中止 job 的结果不通知。
- 失败重试：失败结果不缓存（4xx/5xx 无缓存头）；损坏图片字节若已 `immutable` 缓存，重试仍命中同一损坏缓存，与此前 `fetch` 默认缓存行为一致，不属本次回归。
- 上传 blob 预览：`previewUrl` 经调度器透传，`<img>` 直接引用管道持有的 blob URL。管道只在上传结束（节点切换为托管 URL）、回滚或节点移除时撤销；撤销后节点已不再渲染该预览。已加载的 `<img>` 撤销后位图保留；若撤销后 job 因 StrictMode/重新挂载重新预热将失败，但该时点节点已离开预览态，不暴露给用户。实现后补回归断言覆盖「blob: URL 透传可加载」。
- 空 src：沿用调用方守卫契约（见骨架 Spec），不新增防御。
- 动画/骨架/失败态：不变。

## 验收标准

- `prepareImage` 不再调用 `fetch`、`URL.createObjectURL`、`URL.revokeObjectURL`；`image-load-scheduler.ts` 与 `use-canvas-image` 链路中无任何 `revokeObjectURL`（`upload-pipeline.ts` 等上传模块保持原样）。
- ready 结果 `url === src`；`CanvasImage` 渲染的 `<img src>` 等于传入 `src`。
- 容量 4（重量单位）、abort 取消在途探测（`removeAttribute("src")`）、60s 超时、decode 完成才算 ready、失败不自动重试、重试恢复所有共享 consumer —— 均有单测。
- 浏览器实测（正常缓存）：同一 URL 第二次渲染 `<img>` 不产生新的网络请求（Network 面板 from disk/memory cache）。
- 全库 `grep revokeObjectURL` 仅剩上传管道、`AssetCreateDialog`、`text-export` 等与本链路无关的既有用法。
- lint、类型检查、相关测试串行通过（Vitest 单 worker）。

## 待确认事项

（无——接受取舍并取代骨架 Spec 规则 6–8、保留 `url` 字段、`blob:` 预览透传不特判三项均已决策，见顶部决策记录。）

## 当前状态

已确认。已实施：`prepareImage` 改为探测 `<img>` 预热 + 结果携带原 URL，调度器链路删除全部 object URL 生命周期；测试按新语义改写；骨架 Spec 相关条款已回写。

2026-10-23 随画布 LOD 实现补充规则 8（显示 URL 由档位派生），并完成本 Spec 的浏览器实测：同一档位 URL 第二次加载命中浏览器缓存（CDP 实测第二轮 90 个请求、`encodedDataLength` 合计 0 字节，首轮 71 KB）；缩小手势中止在途档位请求（`Network.loadingFailed` canceled）。2026-10-24 按用户决策删除 `rv`（从未进入提交），规则 8 改为只带 `?w=`。
