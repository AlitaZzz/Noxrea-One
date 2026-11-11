# 画布流光层（Canvas Flow Layer）

状态：已实现（2026-11-01 用户确认验收 3 视觉一致性并授权提交；实现提交 `a2588aee`）

## 背景

### 1. 问题（已验证事实）

拖动节点起手第一帧，连线流光出现一次卡顿（用户报告）。上一轮 Spec
（`specs/canvas-selection-chrome-scheduling.md` §5.5）之后的实测：129 节点画布，
起拖音频节点 LoAF 76ms（script 42ms）、起拖文本节点 LoAF 93ms（script 60ms）；
同一画布拖动无连线节点仅 8–14ms（拖动机制本身 6–9ms）。增量集中在
「选中提交 → 边强调态翻转 → 每条边挂载 6 条 SMIL 流光 path」。

已核实的机制：

- `DeletableEdge` 的流光由 `FlowLines` 渲染：每条强调边 6 条 `<path>` + 6 个
  `<animate>`（SMIL）。强调态翻转发生在拖动开始的选中提交里，与拖动首帧落在同一帧。
- SMIL 相位按墙钟推进，不跟随帧：脚本阻塞 400ms 后首帧相位前进 11.99 个归一化单位
  （≈23 帧的位移）；50ms 阻塞 ≈3 帧、16ms ≈1 帧。长任务后相位跳变是「卡一下」的
  第二来源。
- 次生缺陷（代码核实）：`DragPreviewSession.begin()` 在拖动开始回调里先
  `captureDom()`，选中提交的 React 提交在其后；拖动期新挂载的流光 path 不在快照内，
  整段拖动流光停在拖动前几何。

### 2. 决策

用户 2026-10-31 指示「直接做方案 B」：连线流光改为画布级 canvas 图层 + 帧驱动相位。
不采用方案 A（预挂载），因为它只消除挂载成本，SMIL 相位跳变仍然存在。

## 目标

- 起拖帧不再挂载任何流光 DOM/SMIL：强调态翻转只改变注册表与渲染循环。
- 流光相位按帧推进，长任务后不追赶墙钟（单帧最多前进 2 帧 @60Hz）。
- 拖动期流光跟随预览几何（含两端同位移的整段平移）。
- 流光外观（颜色、速度、疏密、拖尾、每边 2 段）与现状一致。

## 范围

- 节点间连线（`DeletableEdge`）的流光迁移到画布层。
- 连接预览（`ConnectionFlowLine`）与待创建预览（`PendingConnectionPreview`）保持
  SVG 流光：它们渲染在节点之上（`.react-flow__connectionline` z-index 1001 /
  `ViewportPortal`），而画布层在节点之下，迁移会改变层叠关系。两者与画布层共用
  同一份流形参数。
- 不改：连线本体颜色与线宽、删除按钮交互、选中/高亮规则、拖动会话的 DOM 预览机制。

## 业务规则

1. 几何同源：`computeEdgePath` 是连线几何唯一实现，返回 SVG `path`、标签锚点、
   三次贝塞尔控制点与弧长；SVG 与画布都由同一组控制点派生。
2. 流形参数唯一实现 `flow-taper.ts`：`buildFlowPattern(length)`；SVG 预览传 100
   （等价原 `pathLength` 归一化），画布传实际弧长。
3. 相位帧驱动：`phase += min(dt, 32ms) / 周期时长`；周期时长 = 3.2s / 段数 2 = 1.6s。
   长任务后最多前进 2 帧，不按墙钟追赶。
4. 图层位置：画布容器插入 `.react-flow__viewport` 内、`.react-flow__nodes` 之前
   → 连线之上、节点之下；删除按钮自带 z-10，仍在流光之上。`.react-flow__edges`
   必须形成独立层叠上下文（`isolation: isolate`）：React Flow 会把连接到父节点内
   子节点的连线抬高到 z-index 1（选中连线再 +1000），未隔离时这些连线 SVG 会越过
   DOM 顺序盖住流光 canvas，把流光头部裁成两侧细边（组内连线看起来偏浅的根因）。
5. 画布盒：CSS 尺寸 = 视口尺寸（px），自身 transform 抵消视口变换
   （`translate(-tx/z, -ty/z) scale(1/z)`）；后备缓冲 = 视口尺寸 × dpr，缩放不重建，
   dpr 变化才重建。
6. 渲染循环只在注册表非空时运行；清空即停止并清除画布。
7. 强调登记：`DeletableEdge` 在 `emphasized` 为真时登记几何、为假或卸载时注销；
   拖动会话以「预览覆盖」发布预览几何，结束/取消清除覆盖，回落到登记几何。
   起手帧的预览可能先于强调登记到达（拖动在选中提交前发布）：未登记的预览按
   原始几何/位移暂存，登记瞬间生效（路径重算沿用相符分层，整段平移叠加到登记
   几何），保证静止拖动也按预览绘制。
8. 颜色：流光固定 `EDGE_FLOW_COLOR`，不随主题变化（`web/AGENTS.md` §九.3）。

## 技术影响

新增 `web/src/features/canvas/flow/`：

- `flow-taper.ts`：流形参数与分层计算（唯一实现）
- `flow-registry.ts`：强调边几何 + 拖动预览覆盖 + 成员变化订阅
- `flow-renderer.ts`：canvas 2D 渲染循环（帧驱动相位、视口同步、dpr 管理）
- `CanvasFlowLayer.tsx`：插入视口图层容器并挂载 canvas

修改：

- `shared/edge-geometry.ts`：控制点、弧长
- `controls/DeletableEdge.tsx`：登记/注销，移除 FlowLines 挂载
- `controls/EdgeFlow.tsx`：改用共享流形参数（仅预览）
- `drag/drag-preview-session.ts`：发布/清除预览覆盖
- `root/CanvasSurface.tsx`：挂载 `<CanvasFlowLayer />`
- `web/src/styles/globals.css`：图层与 canvas 定位规则

删除：`FlowLines` 的 GLOW 死分支、`useEdgePath` 死函数、`REVERSE` 常量（恒 false）。

## 异常与边界

1. 视口尺寸为 0（初始未测量）时不绘制，不报错。
2. dpr 变化（浏览器缩放/跨屏）重建后备缓冲；缩放 0.1–5 不重建。
3. 视口平移/缩放中：循环每帧读取 store transform，画布盒同步，不重影。
4. 边卸载、强调切换、拖动取消、拖动中节点被删除：注销与覆盖清理都幂等；未登记
   边收到的预览暂存到登记时生效（登记前不参与绘制），注销与覆盖清理一并丢弃暂存。
5. 图层容器是 React 之外的 DOM：React Flow 不管理它，卸载时移除；视口子树顺序固定
   （edges → connectionline → edgelabel → nodes → portal），插入点不会与 React
   协调冲突。
6. 单画布假设：注册表是模块级单例；本仓库只挂载一个画布。

## 验收标准

1. 起拖不再新增流光 DOM/SMIL：起拖帧脚本时间不高于无连线节点基线（增量 ≤ 5ms，
   129 节点画布）。
2. 长任务后相位不跳：注入 400ms 阻塞，流光前进 ≤ 32ms 等值位移。
3. 视觉一致：选中/悬停时的颜色、速度、每边 2 段、前粗后细拖尾与现状一致。
4. 拖动期流光跟随预览路径；两端同位移时整段平移；取消拖动后回到基准几何。
5. 明暗两主题、0.1/1/5 缩放、平移与缩放过程中不闪烁、不重影、不遮挡删除按钮。
6. 测试：流形分层参数、弧长精度、控制点路径与 `getBezierPath` 逐字节一致、
   注册表生命周期、拖动预览覆盖。

## 待确认事项

无。

## 当前状态

已确认，实现完成，待用户走查与提交授权。

实现：新增 `web/src/features/canvas/flow/`（`flow-taper` / `flow-registry` /
`flow-renderer` / `CanvasFlowLayer`）；`DeletableEdge` 移除 `FlowLines` 挂载改为登记
几何；`drag-preview-session` 发布/清除预览覆盖；`CanvasSurface` 挂载图层；
`globals.css` 图层定位。

验证环境：生产构建（`next build` + `next start`）的 129 节点 / 124 边探测画布，
未使用用户真实项目与凭据。已验证事实：

- 验收 1：起拖 LoAF 脚本时间 10 次交替重复，8 边节点中位 14ms / 均值 16.9ms，
  无连线节点中位 14ms / 均值 16.3ms，中位差 0ms、均值差 +0.6ms（≤5ms）；起拖帧
  无新增流光 DOM/SMIL。
- 验收 2：注入 400ms 同步阻塞，渲染器 rAF 时间戳差 383.2ms，头层 dashoffset 前进
  54.779 = 0.02 × 周期（2738.95），恰为 32ms 等值（2 帧）；常规帧 16.7ms 对应 28.6。
- 验收 3：参数级等价已核实——6 层宽度 4→0.6、透明度 1→0.6、每边 2 段
  （dash + gap = 弧长/2）、周期 1.6s（3.2s / 2 段）；暗色主题 0.8 / 0.625 / 1 缩放
  采样像素 RGB(199,244,61) = `#c7f43d`（zoom 1 全画布 13,685 个流光像素，alpha
  最高 224+），浅色主题 7/7 采样命中同色（alpha 255）。与现状的视觉一致性待用户走查。
- 验收 4：单节点拖动 8 条强调边全部为路径改写分支，流光起点与预览路径起点逐条一致；
  22 节点框选整段平移分支（`style.translate = "50px 40px"`，路径不变），流光起点 =
  基准 + (50,40)；落点提交后无残留覆盖。
- 验收 5：缩放 0.1 / 1 / 5 画布盒抵消变换与视口一致（zoom 1 时 delta 0/0/0），颜色
  正常；中键平移 8 步视口位移 (144,80)，每步画布变换与视口同步（dx 0、dy −0.0004
  为 React Flow 样式三位小数取整、dz 0）；每帧 `clearRect` 全清（62.4 次/秒），
  无重影；流光画布 `pointer-events: none` 且位于 `.react-flow__nodes` 与节点工具条
  （z-index 1001）之前，不遮挡删除按钮。
- 验收 6：`flow-*` / `edge-geometry` / `drag` / `DeletableEdge` 共 11 个测试文件
  74 项通过；ESLint 无告警；生产构建 TypeScript 通过。

第五轮审查补充（2026-11-01，代码核实 + 回归测试）：

- 起手帧预览先于强调登记到达时会被丢弃，静止拖动会持续绘制拖动前路径。已改为
  未登记预览暂存、登记瞬间生效；拖动会话平移分支改用 `setFlowPreviewOffset`，
  不再自行读取登记几何。新增注册表路径/平移两条暂存测试与拖动会话两条
  「登记后到达」回归测试。`getFlowEdge` 因此不再有生产调用者，已删除；测试改用
  `getFlowDrawable` 读取登记几何。
- 补 `CanvasFlowLayer` 生命周期测试：canvas 插入在节点层之前、卸载时销毁渲染器
  并移除图层；视口或节点层缺失时不创建。主题侧流光颜色固定 `EDGE_FLOW_COLOR`、
  无主题分支（规则 8），明暗两主题采样结果见验收 3。
- 第五轮检查：`tsc --noEmit` 通过；ESLint（工作区全部 72 个改动 TypeScript 文件）
  通过；注册表 / 拖动 / `DeletableEdge` 定向测试 3 文件 / 45 例通过；全量 web
  测试 182 文件 / 1445 例通过（Vitest 单 worker，202.93s）。

- 2026-11-01 用户确认验收 3 视觉一致性并授权提交，实现提交 `a2588aee`，
  状态更新为「已实现」。
- 2026-11-09 六轮评审修复（仅文档）：当前状态中的挂载点由 `InfiniteCanvas` 更正为
  `root/CanvasSurface.tsx`，与实现清单一致；无代码与验收变更，状态保持「已实现」。
- 2026-11-11 组内连线流光偏浅根因修复：React Flow 为端点位于父节点内的连线抬高
  其 `<svg>` 的 z-index（子节点 z=1；选中连线再 +1000），连线层未隔离层叠上下文时
  这些 SVG 会盖住 z-index auto 的流光 canvas，把 4px 的不透明流光头部裁成两侧细边；
  组填充位于流光之上还会带来轻微提亮。修复：`.react-flow__edges` 使用
  `isolation: isolate`，把单条连线的 z-index 关在连线层内（规则 4）；组默认/彩色
  填充降至 4%/6%，框选 `--marquee-bg` 降至 3%，保持「已提交外框 > 拖拽框」的
  可辨认差异。验证：暗/明主题下组内外均可看到不透明头部（组内流光像素 G p90
  190 → 243，组外 244；组内背景 29 / 组外 20 来自组填充），删除按钮与节点层级不变。
