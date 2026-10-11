# Canvas Media Loading Skeleton

状态：已确认

决策记录：2026-10-11 用户确认三项关键决策——骨架显示加 150ms 延迟（防止缓存命中瞬时加载时骨架闪烁）；失败态保持现状（警示图标 + 重试按钮，不引入骨架）；骨架上保留内容类型图标（`placeholderIcon` prop 保留，视频海报继续显示摄像机图标）。同日用户确认 Spec 整体，开始实施。实施中用户报告慢网（4G）下出现「骨架 → 节点空白 → 媒体才显示」三段式，根因定位为探测请求字节被丢弃、渲染 `<img>` 依赖 HTTP 缓存即时绘制（缓存失效即二次全量下载）；用户确认采用「字节单次流转载入」方案（fetch → Blob → object URL），骨架 Spec 随之扩展。2026-10-12 用户提出骨架采用 SkeletonCard 式「有形状的媒体块」而非满铺——节点即卡片，骨架按媒体真实宽高比定形（宽高比未知时回退满铺），随第三次实施确认。同日用户指出不应手写动画 CSS——150ms 延迟淡入改用项目既有 shadcn 官方动画工具库 `tw-animate-css` 的 `animate-in fade-in delay-150 fill-mode-both` 组合实现，手写 keyframes 删除；呼吸效果本身即官方 Skeleton 自带的 `animate-pulse`（shadcn 无扫光变体）。实施中曾按用户要求补充「块内底部骨架线」内容层次，用户评审后决定去掉，最终形态为「形状块 + 图标」。

## 目标

1. 画布节点媒体内容（图片、视频首帧海报）从网络加载期间显示骨架屏（Skeleton），替代当前「图标 + 纯色背景」静态占位，使加载过程有明确的动态视觉反馈。
2. 媒体字节单次流转载入：慢网（如 4G）下骨架覆盖整个加载期，媒体就绪后一帧内绘制，消除「骨架已卸载、`<img>` 重新下载导致节点空白数秒」的中间窗口。

## 背景（调查结论）

- 节点媒体加载的统一入口是 `web/src/features/canvas/shared/CanvasImage.tsx`，底层 `useCanvasImage` + 图片加载调度器已有完整三态机：`pending` / `ready` / `failed`。
- 当前 `pending` 态渲染：`bg-card` 背景占位 span + 居中图标（默认 `PictureOutlined`，视频海报经 `placeholderIcon` 覆盖为 `VideoCameraOutlined`），无任何加载动画。
- 调用方全覆盖：`ImageNode`（上传模糊预览、多图网格卡片、主图）与 `VideoNode`（会话垫底海报、静止态海报）均经 `CanvasImage` 渲染，一处改动即全节点类型生效。
- 既有测试对 pending 占位的契约依赖：`role="img"` + `aria-label`（CanvasImage.test 多处 `getByRole("img", { name })` 在 pending 阶段定位）、`data-image-status="pending"`、`className` / `style` 透传（上传预览的 `blur-sm` / `opacity` 断言）。改造必须保持这些契约。
- `placeholderIcon` prop 仅 `VideoNode` 传入（默认 `PictureOutlined`），测试未断言 pending 图标内容；本方案保留该 prop，调用方零变更。
- **慢网空白窗口的根因**（2026-10-11 调查）：`image-load-scheduler` 的 `prepareImage` 以 `new Image()` 探测（onload + decode 完成才算 ready），随后 `CanvasImage` 才渲染真正的 `<img src={原始URL}>`——探测下载的字节被整体丢弃（仅保留宽高），`<img>` 的即时绘制完全依赖 HTTP 缓存命中。服务端 `/api/files/*` 响应虽带 `Cache-Control: public, max-age=31536000, immutable`（含 `?w=` 海报派生路径），但 DevTools「Disable cache」调试场景或缓存逐出时，`<img>` 会对整张图发起第二次全量下载：骨架已随 ready 卸载，节点空白数秒后媒体才出现，即用户在 4G 下观察到的三段式现象。

## 范围

- 新增：`web/src/components/ui/skeleton.tsx`（shadcn 标准 Skeleton 组件）。
- 修改：`web/src/features/canvas/shared/CanvasImage.tsx`（pending 分支替换为延迟骨架 + 图标；ready 分支改用调度器下发的 object URL 渲染；新增可选 `aspect` prop 驱动形状骨架）。
- 修改：`web/src/features/canvas/services/image-load-scheduler.ts`（`prepareImage` 改为 fetch → Blob → object URL；调度器接管 object URL 生命周期）。
- 修改：`web/src/features/canvas/nodes/ImageNode.tsx` 与 `VideoNode.tsx`（主图与海报两处传入已知宽高比；多图副卡、上传预览等未知场景不传，回退满铺）。
- 新增：`web/src/lib/utils/media-utils.ts` 的 `mediaAspect(width, height)`（宽高均 >0 才返回比例）——业务规则「>0 才传」的共享实现，ImageNode / VideoNode 复用。
- 动画复用：150ms 延迟淡入使用项目既有 shadcn 官方动画工具库 `tw-animate-css`（globals.css 已全局引入）的 `animate-in fade-in delay-150 fill-mode-both` 工具类组合，不新增任何自定义 CSS。
- 测试：`CanvasImage.test.tsx` 补充 pending 骨架断言并迁移为 mock fetch + objectURL；`image-load-scheduler.test.ts` 适配新结果形状与 URL 生命周期断言（含探测加载失败 / decode 失败 / 挂起传输超时取消等失败路径）；`VideoNode.test.tsx` 适配 mock 捕获海报 URL + object URL 断言。
- 不改动：失败态 UI、上传进度遮罩、`GeneratingOverlay`、视频 hover 会话加载浮层（spinner + 文案）、`CanvasLoader`、资产库、`useCanvasImage` 状态机与调度器并发/优先级模型、服务端文件路由与缓存头。

## 业务规则

1. **延迟显示**：pending 态进入后 150ms 内保持现有 `bg-card` 空白占位（骨架与图标均不可见）；超过 150ms 骨架与图标一同出现（可带短淡入）。若 150ms 内变为 `ready`，两者从不出现——防止缓存命中瞬时加载时的闪烁。
2. **骨架形状**：SkeletonCard 范式的节点适配——不照搬 `CardHeader` 文字行（`NodeTitle` 为真实数据即时渲染，body 不会出现文字，骨架化会暗示不存在的内容），采纳其「媒体形状块」思路：调用方传入已知媒体宽高比（`aspect`，图片/视频节点的 `naturalWidth/Height`，>0 才传）时，骨架渲染为居中的媒体形状块——用容器查询单位（`cqw`/`cqh`）做完美 contain 约束、Skeleton 默认 `rounded-md` 圆角、`bg-muted` + `animate-pulse`（shadcn 官方呼吸效果），加载完成时块边界与 `object-contain` 图片边界吻合，无形状跳变；宽高比未知（多图副卡、上传预览等）时回退满铺。不硬编码颜色，明暗主题自动适配；内容类型图标（`placeholderIcon`，默认 `PictureOutlined`）居中叠加在骨架之上（这是骨架内唯一的元素，用户评审后明确不加线条等其他内容），沿用现有 `text-muted-foreground` 前景色。
3. **占位契约不变**：pending 占位容器的 `role="img"`、`aria-label`、`data-image-status="pending"`、`className` / `style` 透传行为全部保持（既有测试与上传预览场景依赖）。
4. **图标保留**：内容类型图标继续经 `placeholderIcon` prop 传入（`VideoNode` 传 `VideoCameraOutlined` 不变），从「直接显示」改为「叠加在骨架之上」，随骨架一同延迟出现；prop 签名与默认值不变，调用方零变更。
5. **失败态保持现状**：`role="group"` + 警示图标 + 重试按钮 + `data-image-status="failed"`，一字不动。
6. **ready 态渲染 object URL**：`CanvasImage` 的 ready 分支不再渲染原始 URL，改用调度器下发的本地 object URL——字节已在内存且完成解码，挂载即绘制，不发起第二次网络请求。
7. **字节单次流转载入**：`prepareImage` 以 `fetch`（挂内部 AbortController）下载 → Blob → object URL → 探测 `<img>` 解码出宽高后才算 ready。外部 abort 级联到内部 controller；任意失败路径（网络错误、非 2xx、abort、60s 超时、decode 失败）在 `prepareImage` 内部**先中止残余传输**（不空跑剩余字节）、再撤销 object URL；成功后 object URL 的所有权移交调度器。
8. **object URL 生命周期归调度器**：job 被移除（最后一个 consumer 释放后）或 `clear()` 时，撤销其 settled ready 结果携带的 object URL；共享同一 URL 的多个 consumer 在 job 存续期间共享同一 object URL；重试产生新的 object URL，旧 URL 已在失败路径撤销。
9. **语义边界**：骨架只接管「媒体内容网络加载」这一种等待。上传中（模糊预览 + 进度条）、AI 生成中（`GeneratingOverlay`）、视频 hover 会话加载（spinner + 文案浮层）各有专门反馈语言，不受本次改动影响。下载、全屏预览、资产保存等继续使用节点原始 URL，与 object URL 无关。

## 技术影响

- `components/ui/skeleton.tsx`：shadcn 规范实现（`div` + `bg-muted` + `animate-pulse`），零业务逻辑，依赖方向 features → ui 合规。
- 150ms 延迟采用 shadcn 官方动画工具库 `tw-animate-css` 的声明式组合（`animate-in fade-in delay-150 fill-mode-both`，其 `enter` keyframes + `--tw-animation-delay` + `fill-mode: both` 语义与手写方案等价）：骨架与图标同处一个延迟淡入容器，pending 期间常驻 DOM 但延迟前透明，ready 时整个分支卸载；不引入定时器、不翻转组件状态，StrictMode 双挂载与 src 快速切换（撤销 / 换主图 / 上传替换）下动画随元素挂载自然重置，无清理负担。
- 形状骨架采用容器查询单位（`cqw`/`cqh`）实现完美 contain：reveal 容器声明 `container-type: size`（其尺寸即节点 body），形状块宽度取 `min(100cqw, aspect × 100cqh)`、高度由 `aspect-ratio` 派生——任意 body 比例下块均内切于 body，纯 CSS 无 JS 测量。形状块不覆盖默认 `rounded-md`，与 Skeleton 组件自身语言一致。
- `ImageLoadResult` ready 分支形状变更：由 `{ status: "ready"; size: PreparedImage }` 改为 `{ status: "ready"; url: string; width: number; height: number }`（原 `size` 无业务消费方，仅测试引用）；`PreparedImage` 改为 `{ url: string; width: number; height: number }`。
- `prepareImage` 内部：`fetch(src, { signal: 内部controller })` → 非 2xx 抛错（海报 404 维持失败态契约）→ `blob()` → `URL.createObjectURL` → 探测 `<img>`（onload + decode）→ resolve `{ url, width, height }`；外部 signal abort 经监听级联到内部 controller，`finish` 的失败分支统一执行「中止残余传输、撤销 URL、摘除监听与 handler」（顺序无关紧要，`settled` 守卫杜绝重入），超时不再放任 fetch/blob 空跑剩余字节。
- 调度器 `release` 的 job 删除路径与 `clear()` 增加 revoke；`complete` 的早退守卫（job 已被替换/删除/中止）丢弃 ready 结果时就地撤销其 object URL——不变量为「ready 结果要么被 job 持有、要么已撤销」，无泄漏路径。
- 节点 `data` 形状、store、`NodeProps`、保存/恢复、撤销、SSE 同步均不受影响；`useCanvasImage` 仅透传新形状结果。
- 测试基建：`CanvasImage.test.tsx` 从「stub 全局 Image」扩展为「stub fetch（返回 Blob）+ stub `URL.createObjectURL`/`revokeObjectURL` + 维持 Image stub」；`image-load-scheduler.test.ts` 注入式 mock loader 断言适配新形状。

## 异常与边界

- 视口外节点：图片调度器视口门控不变，远处节点 pending 骨架与现状图标占位一样静默挂着、不可见。
- src 变化：节点经 ready 回到 pending 时骨架按延迟规则重新出现（ready 卸载 reveal 容器，重新挂载即重置 CSS 动画）；pending 期间直接换源（reveal 容器不重挂）时骨架保持可见，避免换源过程闪空白。
- 上传预览场景：骨架容器继承 `blur` / `opacity` 等透传样式，与现状占位行为一致。
- abort / 超时 / 失败：所有失败路径在 `prepareImage` 内先中止残余传输、再撤销 object URL，不泄漏也不空跑；job 删除与 `clear()` 由调度器撤销 settled 结果的 URL，`complete` 守卫丢弃的就地撤销；StrictMode effect 重放场景下 job 在同轮被重新认领时不删除、URL 存活（沿用既有「同轮重新认领」守卫）。
- 内存：settled 图片的 Blob 常驻内存直至节点卸载（此前等量字节由 HTTP 缓存持有），视口门控与并发上限（4）继续约束同时在载/已载规模；节点卸载即随 job 删除释放。
- 非图片内容（200 但非可解码数据）：探测 `<img>` onerror → 失败态，URL 已在失败路径撤销。
- 空 src：`CanvasImage` 不做空源守卫（`pending` 对空 src 会永久骨架），空源守卫是调用方契约——现有 4 处调用方（图片主图 / 视频海报 / 上传预览路径）均以 `hasImage` / `hasVideo` 等条件先行守卫；为不可能的输入加防御属补丁式代码，不做。
- 跨域源：本方案 `fetch` 需要对方 CORS 配合（旧 `new Image()` 显示跨域图不需要）。已核实全库不存在产生跨域图片节点的路径——上传、生成、派生、资产拖入的 src 均为 `/api/files/*` 同源或本地 blob:；`isManagedFileUrl` 对非托管地址的容错只是数据模型的防御，非现行生产路径。若未来出现外链图片需求，正解是服务端代理或对方 CORS，不做前端 fallback。
- 动画偏好：与项目内既有 `animate-pulse` 用法（上传进度条等）保持一致，不单独处理 `prefers-reduced-motion`。

## 验收标准

- 图片与视频海报从网络加载超过 150ms 时骨架与内容类型图标一同出现并有呼吸动画；宽高比已知时骨架为按真实比例定形的居中块，加载完成时与图片边界吻合、无形状跳变；宽高比未知时满铺；缓存命中瞬时完成时不闪烁。
- 慢网 / 禁用缓存场景下，每张图片的媒体字节只发起一次网络请求：ready 后 `<img>` 挂载零二次下载，媒体一帧内绘制，「骨架 → 空白 → 媒体」三段式不再出现。
- 失败态 UI 与现状完全一致（视觉与 DOM 结构均不变）；海报 404 维持失败态契约。
- object URL 无泄漏：失败 / abort / 超时路径、job 删除、`clear()` 均撤销（单测断言 revoke 调用）。
- `CanvasImage.test.tsx` 新增 pending 骨架断言（pending 期骨架元素存在、ready 后不存在，图标契约不变）；调度器与 CanvasImage 全部用例适配后通过。150ms 时序行为以浏览器手动验证（jsdom 不执行 CSS 动画，不做时序断言）。
- 按明、暗两套主题分别验证骨架观感（涉及主题 token 与动画的改动须双主题验证）。
- typecheck、lint、web 全量测试通过。

## 待确认事项

（无——150ms 延迟、失败态保持现状、骨架保留图标、字节单次流转载入四项决策均已由用户于 2026-10-11 确认。）

## 当前状态

- 已实施并通过验证（2026-10-11～12）：骨架占位（150ms 延迟 + 形状化骨架 + 图标叠加）与字节单次流转载入（fetch → Blob → object URL、调度器接管 URL 生命周期、失败先中止传输再撤销）均已落地。受影响测试 50 个全过（调度器 19 + CanvasImage 13 + VideoNode 18），typecheck、lint 通过；web 全量测试失败用例为既有用例间污染抖动（漂移于 MediaPreviewOverlay / HoverCard / Button / AudioWaveform，与无改动基线一致，单跑均过）。经两轮双轴代码审查：首轮发现的超时不中止传输、complete 守卫窄窗口泄漏、双名同物、aspect 同形两份均已根因修复并补失败路径单测；次轮复审确认修复彻底、无现行 bug / 死代码 / 兼容层，空源守卫与跨域边界已回写本 Spec。浏览器双主题实测与禁用缓存单请求验证因工具受阻待补。
