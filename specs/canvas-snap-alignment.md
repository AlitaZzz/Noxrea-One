# 画布吸附与对齐（Snap & Alignment）

状态：已实现

## 背景

### 1. 用户决策

2026-10-30 首次决策：画布只保留一个「吸附网格」开关，其余按对即梦画布的静态分析结论执行。据此确定：

- 对齐吸附常开，不提供独立开关；
- 唯一开关 `snapToGrid` 只控制网格吸附（默认关闭），并继续控制整理布局与方向键微移的网格步进；
- 不做「对齐开关 + 网格开关」的双开关方案。

2026-10-30 第二次决策（用户原话：「改成总开关：磁铁关闭时对齐吸附和网格吸附都关闭」）：首次决策中「对齐吸附常开」与「开关只控制网格」两项被取代。据此确定：

- 唯一开关改为总开关：关闭时对齐吸附与网格吸附同时关闭——不产生对齐关系、不绘制辅助线、不做网格取整，拖动位置等于指针位移；
- 开启时对齐与网格都按本 Spec 规则生效：对齐优先于网格，网格只在无对齐的轴生效并受缩放门槛约束；
- 仍然只有一个开关，不做「对齐开关 + 网格开关」的双开关方案（不变）；
- 开关继续控制整理布局、Agent 整理与方向键微移的网格步进（不变）。

### 2. 当前实现（已验证事实）

- `hooks/use-alignment-guides.ts` 的 `computeAlignment` 是吸附唯一计算入口：阈值以画布单位计（`snapThreshold = 5`），不随缩放归一；无滞回（进入与保持同阈值）；只要关系在阈值内就为每个关系生成辅助线，即使最终吸附偏移并不满足该关系（线不真实）；去重按「同 type + 位置差 < 0.5」只保留第一条，会丢掉不同跨度的同坐标线。辅助线跨度恒为两盒并集。
- `drag/drag-snap.ts` 仅在拖动项 = 1 且 `snapToGrid` 开启时吸附；网格与对齐共用该开关；多选拖动直接使用原始位置，不吸附、无辅助线。
- 吸附候选为 `baseNodes` 中除拖动项外的全部节点，仅做阈值邻近预筛；没有排除拖动组的成员，也没有排除 `hidden` 节点（`drag-preview-session.ts` 的 `captureSnapshot` 会把被拖组的成员放进 `baseNodes`，静态推断拖组时成员可成为自身对齐目标）。
- 阈值/网格设置随 `snapThreshold`、`snapGridSize` 存在 store 中；拖动开始时由 `InfiniteCanvas.tsx:776` 捕获一次。
- 辅助线为屏幕坐标 SVG（`controls/AlignmentGuides.tsx`），渲染在节点之上（`zIndex: 100`），绿色虚线。
- `snapToGrid` 同时被 `use-tidy-animation.ts`、`agent/tools/executors.ts` 与 `canvas-edit-actions.ts` 的方向键微移读取，语义是「按网格步进」。

### 3. 即梦画布静态分析（登录墙限制，未做运行时验证）

对线上 bundle（`canvas-core` 模块 69615 / 66183 / 49190 / 76850 等）的静态阅读：

- 阈值按屏幕像素除以缩放：进入 5px、保持 8px，形成滞回；每轴独立保持当前关系。
- 每轴 3×3 锚点矩阵（start/center/end × start/center/end），按 |offset| → 同锚点 → 主体顺序 → 目标顺序 → 锚点顺序排序。
- 目标按 `parentId` 分组，仅收集可见、未隐藏、未移动节点；多选主体为并集盒 + 每个节点。
- 辅助线只绘制当前偏移下恰好成立的关系；中心对中心取两中心跨度，分离盒取间隙，重叠盒取并集；同坐标重叠线合并。
- `primary` 修饰键旁路吸附；Shift 通过清空某轴主体锚点限制吸附轴。
- 网格吸附独立于对齐，只在无对齐的轴上、按并集左上角取整，并有 `18 × zoom ≥ 8` 的屏幕像素门槛。
- 辅助线渲染在视口门户内、节点之下；缩放会话复用同一吸附引擎。

## 目标

- 吸附由唯一总开关统一控制：开启时对齐吸附生效，阈值随缩放归一（屏幕像素语义），进入/保持双阈值消除临界抖动；关闭时对齐与网格都不生效。
- 辅助线只表达真实结果：只画当前吸附偏移下恰好成立的关系，跨度符合行业惯例（中心连线 / 间隙 / 并集）。
- 多选拖动按并集盒吸附；候选排除移动集与隐藏节点，消除拖组时成员自吸。
- 提供 Ctrl/Meta 旁路与 Shift 轴限吸附。
- 开启时网格与对齐按轴互斥：某轴有对齐结果时不做网格取整，只有无对齐的轴才可能网格取整，并受缩放门槛约束。
- 保持预览与提交同源，所见即所得；不引入兼容层，不保留旧口径。

## 范围

### 改动

- `web/src/features/canvas/hooks/use-alignment-guides.ts`：删除，纯几何迁至 `shared/snap-engine.ts` 与 `shared/alignment-guides.ts`。
- 新增 `web/src/features/canvas/shared/alignment-guides.ts`：`AlignmentGuide` 类型与 `sameAlignmentGuides` 按值比较（从 hooks 迁出，供渲染层与引擎共用）。
- 新增 `web/src/features/canvas/shared/snap-engine.ts`：吸附引擎（锚点关系、排序、滞回、辅助线、网格），纯函数 + 会话状态入参/出参。
- `web/src/features/canvas/drag/drag-snap.ts`：改为引擎适配器（绝对坐标帧构建、移动集排除、偏移应用回相对坐标）。
- `web/src/features/canvas/drag/drag-preview-session.ts`：持有吸附会话状态与修饰键跟踪；多选与单选走同一解析路径；修饰键变化时用最后一帧重算。
- 新增 `web/src/features/canvas/drag/drag-input.ts`：一次读取拖动开始事件的会话初值（修饰键 Ctrl/Meta/Shift 与触屏判定，规则 8.3、8.5）。
- `web/src/features/canvas/controls/AlignmentGuides.tsx`、`drag/preview-guides.ts`：类型来源改到 `shared/alignment-guides.ts`；`AlignmentGuides` 的 React key 改为包含完整线段几何（`type`/`position`/`start`/`end`，全精度），以支持规则 5.4 的同坐标多线段。
- `web/src/features/canvas/controls/CanvasControls.tsx`、`web/src/lib/i18n/zh-CN.json`、`en-US.json`：开关文案改为「吸附开 / 吸附关」（`canvas.snap.on/off`），图标注释同步。
- `web/src/features/canvas/stores/canvas-store.ts`：删除 `snapThreshold`（不再由 store 配置）；开关字段 `snapToGrid` 更名为 `snapEnabled`（动作 `toggleSnapEnabled`），保留 `snapGridSize`。
- 开关字段更名涉及：`project/types`（`CanvasData`）、`project/store`、`project/save-manager`（全量与增量）、`CanvasControls`、`InfiniteCanvas`（拖动开始捕获）、`canvas-edit-actions`（撤销恢复、方向键步进）、`use-tidy-animation`、`agent/tools/executors` 与相关测试。
- `web/src/lib/constants.ts`：新增 `DEFAULT_SNAP_GRID_SIZE`（store 初值与拖动会话初值共用的默认步长，值仍为 20）与 `DEFAULT_SNAP_ENABLED`（吸附总开关默认值 `true`，store 初值、项目恢复与拖动会话初值共用）。
- `web/src/features/canvas/InfiniteCanvas.tsx`：会话开始传入吸附开关与网格设置；拖动开始事件提供初始修饰键状态。
- 测试：新增吸附引擎与适配器单测，更新拖动会话与相关用例。

### 不改动

- 吸附开关对整理布局（`use-tidy-animation.ts`）、Agent 整理（`agent/tools/executors.ts`）与方向键微移（`canvas-edit-actions.ts`）的网格步进语义（关闭时不按网格步进）；仅字段名随更名调整。
- `snapGridSize` 默认值 20、`LAYOUT_GAP` 60。
- 辅助线现有渲染位置与层级（屏幕坐标 SVG、节点之上）；不改为视口门户/节点之下。React key 生成不属于层级调整，按技术影响 1 修正。
- 缩放/旋转手柄（`ResizeHandle.tsx`）不接入吸附。
- 框选外框拖动（`.react-flow__nodesselection`）不接入拖动会话，仍不吸附。
- 组框 refit、归属判定、空组删除、历史与自动保存规则。
- 拖动预览会话的 DOM 预览、边路径、释放时机与外部写入重建机制。

## 业务规则

### 1. 开关模型

1.1 唯一开关是总开关：关闭时对齐吸附与网格吸附都不生效——不产生对齐关系、不绘制辅助线、不做网格取整，拖动位置等于指针位移；开启时对齐与网格都按本 Spec 规则生效。不提供独立的对齐开关或网格开关。

1.2 开关字段 `snapEnabled`（store 动作 `toggleSnapEnabled`），默认开启；开启时拖动按 `snapGridSize` 网格取整（另受规则 6 的按轴互斥与缩放门槛约束），并继续作为整理布局、Agent 整理与方向键微移的网格步进依据。

1.3 开关文案与可访问名称统一为吸附（中：「吸附开 / 吸附关」；英：「Snap on / Snap off」），不得再描述为网格吸附或对齐吸附。

1.4 网格与对齐互斥按轴判定：某轴有对齐结果时该轴不做网格取整；无对齐的轴才可能网格取整。

1.5 Ctrl/Meta 旁路（规则 8.1）等价于「本次拖动临时关闭总开关」：只影响本次拖动，不改变开关状态；开关已关闭时无吸附可旁路。

### 2. 主体、移动集与候选目标

2.1 移动集 = 拖动项 + 被拖动组的全部成员（即会话现有 `affectedIds`）。组不嵌套，成员恒为一层。

2.2 吸附主体 = 移动集所有节点绝对盒的并集。单个拖动项即其自身盒；拖动组时为组框与成员的并集（成员在组框内时等于组框）。多选时同样只产生一个并集主体，不追加逐节点主体。

2.3 候选目标 = 会话基准快照中不属于移动集、且 `hidden !== true` 的节点，包含组框。目标顺序 = store 节点数组顺序。

2.4 目标在拖动会话开始时一次性构建为绝对坐标盒列表；外部写入重建基准时同步重建。目标不随拖动移动。

2.5 空间预筛：仅保留与主体盒在任一轴的距离 ≤ `SNAP_RELEASE_TOLERANCE_PX / zoom + LAYOUT_GAP` 的目标。预筛阈值必须取保持阈值而不是进入阈值，否则处于 5–8px 保持区间的锁定目标会被预筛丢弃、滞回失效。预筛只用于降低开销，不得改变未预筛时的结果。

2.6 盒尺寸沿用拖动吸附既有取值链：显式 `style.width/height` > `measured` > 200×120 兜底（`drag-snap.ts` 的 `nodeBoxSize`），不改为整理布局的取值链。

### 3. 对齐关系与选择

3.1 每轴检查 3×3 锚点重合关系：主体锚点 {start, center, end} 与目标锚点 {start, center, end} 的全部组合，共 9 种。

3.2 保留现有边到边间距关系：主体起始边对齐目标结束边 + `LAYOUT_GAP`，以及主体结束边对齐目标起始边 − `LAYOUT_GAP`（每轴 2 种）。间距关系只吸附，不产生辅助线（规则 5.2）。

3.3 每个关系产生一个偏移量：把主体锚点移动到目标锚点（或间距位置）所需的位移。X、Y 两轴独立选择，允许两轴同时命中。

3.4 每轴选择 |offset| 最小的关系；并列时依次比较：

1. 同锚点类型（start-start / center-center / end-end）优先于异锚点类型；
2. 目标节点在 store 中的顺序；
3. 锚点顺序 start → center → end（主体锚点，再目标锚点）。

3.5 主体只有一个（并集），不参与排序；不得引入逐节点主体顺序。

3.6 阈值判定使用 `≤`（进入阈值），不使用严格小于。

### 4. 阈值与滞回

4.1 阈值以屏幕像素定义，换算到画布单位时除以本次拖动开始时的视口缩放：进入 `SNAP_ENTER_TOLERANCE_PX = 5`，保持 `SNAP_RELEASE_TOLERANCE_PX = 8`。

4.2 会话为每轴保存当前锁定关系（目标 id、目标锚点、主体锚点）。已锁定关系在下一帧：

- 目标仍在候选中，且该轴未被旁路/轴限关闭；
- 主体锚点按当前几何计算出的偏移绝对值 ≤ `8 / zoom`；

则继续使用该关系及其精确偏移（即使同帧存在更近的其他关系）。

4.3 锁定关系不满足 4.2（目标消失、超保持阈值、轴被关闭）时清除，并按进入阈值重新选择。

4.4 拖动开始时 zoom 非有限值或 ≤ 0：本次拖动不吸附（对齐与网格均关闭）。

4.5 `snapThreshold` 从 store 与 `DragSnapSettings` 中删除；阈值只存在于 `shared/snap-engine.ts` 常量中。拖动中修改缩放不影响本次拖动的阈值（沿用开始时的 zoom）。

### 5. 辅助线

5.1 只绘制当前吸附偏移下恰好成立的对齐关系：对每个候选目标、每个 3×3 锚点组合，满足 `|主体锚点坐标 + 该轴偏移 − 目标锚点坐标| ≤ 1e-6` 才生成。不得绘制仅在阈值内、但未被吸附偏移满足的关系。

5.2 间距关系（3.2）不生成辅助线。

5.3 线段跨度按以下规则（`a` = 主体盒按偏移平移后的矩形，`t` = 目标盒）：

- 主体锚点与目标锚点均为 center：沿另一轴连接两中心点（`[min(c_a, c_t), max(c_a, c_t)]`）；
- 否则若两盒在另一轴方向不相交：连接两盒最近的边缘（间隙段）；
- 否则取两盒并集跨度。

5.4 同轴同坐标且跨度重叠的线段合并为一条，跨度为并集；首尾相接（交集为一点）按重叠处理；同坐标但不相交的线段保留为多条。合并后按轴、坐标、跨度起点、跨度终点稳定排序，相同线段不得重复。零长度线段允许存在。

5.5 被旁路的轴、被轴限关闭的轴、以及仅由网格取整的轴不产生辅助线。

5.6 辅助线仍为瞬态数据：不进 store、不进历史、不落库；仍经 `preview-guides` 按值短路后只驱动 `AlignmentGuides`。

### 6. 网格吸附

6.1 网格在某轴生效需同时满足：总开关开启（`snapEnabled`）；该轴无对齐偏移；该轴未被 Ctrl/Meta 旁路、未被 Shift 轴限关闭；`snapGridSize > 0` 且有限。

6.2 网格门槛：`snapGridSize × zoom ≥ 8`（屏幕像素）。不满足时网格吸附整体关闭；该门槛不影响对齐（对齐只受总开关与修饰键控制）。门槛常量为 `SNAP_GRID_MIN_SCREEN_PX = 8`。

6.3 网格取整对象是主体并集盒的左上角：`round(origin / gridSize) × gridSize`；两轴独立；偏移应用到移动集全部节点。

6.4 网格取整结果与原始位置差 < 1e-9 时视为 0，不产生位移。

### 7. 多选

7.1 多选拖动与单选走同一吸附路径：主体为移动集并集盒，同一偏移应用到全部拖动项与随组移动的成员。

7.2 多选不逐节点吸附、不逐节点画线，也不因某个成员更接近目标而单独移动它。

7.3 多选包含组时，组框作为该组在并集中的几何（成员仍在移动集内，但不额外扩大主体，除非成员探出组框，按并集自然纳入）。

7.4 多选阈值、滞回、辅助线、网格、修饰键规则与单选一致。

### 8. 修饰键

8.1 Ctrl 或 Meta 任一按下：旁路本次吸附（对齐 + 网格），清空两轴锁定关系与辅助线；该帧位置等于原始位置。松开后按最后一帧重新计算，可重新获得吸附。总开关关闭时本来无吸附，旁路无额外效果。

8.2 Shift 按下：轴限吸附。每帧以未吸附的原始帧并集原点相对基准原点的位移判断主导轴（`|dx| ≥ |dy|` 取 X，否则 Y），仅主导轴参与对齐与网格；另一轴不吸附、不画线，并清除该轴锁定关系。Shift 不改变指针位移本身，只关闭另一轴的吸附。

8.3 修饰键状态来源：拖动开始事件（`onNodeDragStart` 的鼠标事件）提供初始状态；拖动期间由会话监听 `keydown`/`keyup`（Control/Meta/Shift）更新；窗口失焦时清空全部修饰键状态。`onNodeDrag` 事件可同步当帧修饰键，但不得依赖它决定帧顺序。

8.4 修饰键状态变化时，会话必须用最后一次原始位置帧立即重算并应用预览（含辅助线），不得等待下一次指针移动。没有最后一帧时不做重算。

8.5 触屏拖动无修饰键，不提供旁路与轴限。

8.6 现有快捷键不受影响：方向键微移、Ctrl+方向键、Ctrl+G 等行为不变；Ctrl/Meta 仅在拖动会话激活时参与旁路判断。

### 9. 分组与坐标

9.1 吸附在世界（绝对）坐标计算；成员相对坐标经 `shared/group-bounds.ts` 的 `nodeAbsolutePosition` 同源换算，结果再换回相对坐标。不得在吸附内自行实现父子坐标换算。

9.2 拖动组时，组与其全部成员都在移动集内，均不得成为对齐目标。

9.3 拖动成员时，同组其他成员与组框可以作为目标（不做即梦的父组隔离）；成员自身与随组移动的节点除外。

9.4 组框作为可见节点参与目标集合；不得因它是容器而额外排除。

### 10. 预览、提交与会话状态

10.1 预览帧与终态提交使用同一吸附会话状态与同一解析路径；终态提交沿用会话锁定状态按规则 4 正常更新，不得在提交前清空状态或另起一次无状态计算，避免松手跳变。

10.2 拖动结束（提交或兜底提交后）清空吸附锁定状态与辅助线。

10.3 外部写入触发 `rebuildFromStore` 时：重建目标集合，清空两轴锁定关系（候选已变），保留当前修饰键状态，并用最后一帧重算。

10.4 拖动中切换吸附开关不影响本次会话（沿用开始时捕获的开关状态与网格设置）；拖动中缩放不改变本次会话阈值（沿用开始时 zoom）。

10.5 吸附只在拖动会话激活时生效；非拖动位置帧（`dragging !== true`）仍按既有规则直接提交、不吸附。

## 与即梦的对齐取舍

| 即梦行为 | 本次是否采用 | 说明 |
| --- | --- | --- |
| 屏幕像素阈值 + 5/8 滞回 | 采用 | 规则 4 |
| 3×3 锚点矩阵 + 排序 | 采用 | 规则 3；去掉主体顺序（单主体） |
| 辅助线只画真实关系、中心/间隙/并集跨度、重叠合并 | 采用 | 规则 5 |
| 多选并集吸附 | 采用（仅并集） | 规则 7.1；不追加逐节点主体 |
| 候选排除移动节点与隐藏节点 | 采用 | 规则 2.3 |
| Ctrl/Meta 旁路、Shift 轴限 | 采用 | 规则 8 |
| 网格独立、无对齐的轴才取整、屏幕像素门槛 | 采用 | 规则 6 |
| 对齐吸附无开关（常开） | 不采用（2026-10-30 第二次决策） | 本仓库提供唯一总开关：关闭时对齐与网格都关闭；开启时对齐优先、网格只在无对齐的轴 |
| 目标按 `parentId` 隔离（成员只对同组兄弟吸附） | 不采用 | 本仓库组只有一层、且组框是可见目标；全局候选更符合现有模型 |
| 多选追加每个节点为主体 | 不采用 | 保持单一主体，结果可预测，避免同一帧多个主体竞争 |
| 固定 18px 网格 | 不采用 | 保留 `snapGridSize = 20` 设置与现有整理/微移语义 |
| 0 间距贴边 | 不采用 | 保留 `LAYOUT_GAP = 60` 间距关系 |
| 目标 64 上限、诊断埋点 | 不采用 | 当前无遥测需求；候选预筛已足够 |
| 目标排序索引/二分查找 | 暂不采用 | 先保留每帧 O(n) 预筛；规模证据不足再引入索引 |
| 视口门户内、节点之下渲染辅助线 | 暂不采用 | 保留现有屏幕 SVG 与层级；单独评估视觉效果 |
| 缩放/旋转手柄共用吸附引擎 | 暂不采用 | 本次只处理拖动；手柄吸附另行立项 |
| 目标索引、快照诊断、会话 owner 机制 | 不采用 | 单画布单会话，无多 owner 场景 |

## 技术影响

### 1. 模块与接口

- `shared/snap-engine.ts`（新增）：
  - 常量：`SNAP_ENTER_TOLERANCE_PX`、`SNAP_RELEASE_TOLERANCE_PX`、`SNAP_GRID_MIN_SCREEN_PX`、`SNAP_EPSILON`；
  - 类型：`SnapTarget`（id、绝对盒、order）、`SnapSessionState`（每轴锁定关系）、`SnapModifiers`、`SnapSettings`（总开关/步长）；`AlignmentGuide` 类型在 `shared/alignment-guides.ts`；
  - `resolveSnap(frame)`：纯函数，`frame.state` 为上一帧每轴锁定关系，返回每轴偏移、新状态、辅助线；不读写 store/DOM。
- `drag/drag-snap.ts`：`buildSnapFrame(...)` + `applySnapOffset(...)` 适配层；会话提供移动集基准绝对盒与原始位移，适配层构建并集主体、目标集合与吸附帧，引擎结果按世界坐标偏移应用回拖动项相对位置。
- `drag/drag-preview-session.ts`：持有 `SnapSessionState`、目标列表、修饰键跟踪与最后一帧；`computeFrame` 改为统一走适配层（删除 `single` 分支）；`begin` 构建目标列表；`rebuildFromStore` 重建；`reset` 清空。
- `hooks/use-alignment-guides.ts` 删除；`AlignmentGuide`、`sameAlignmentGuides` 迁至 `shared/alignment-guides.ts`，由 `preview-guides`、`AlignmentGuides` 与 `snap-engine` 共同引用。
- `controls/AlignmentGuides.tsx`：React key 编码完整线段几何（`type-position-start-end`，不取整）。规则 5.4 允许同坐标多条不相交线段，仅按坐标生成 key 必然重复；回归用例 `controls/AlignmentGuides.test.tsx` 与引擎用例共同固定该约束。

### 2. 数据结构与持久化

- store 删除 `snapThreshold`（非持久化字段，`restoreFromProject` 未读取）；开关字段由 `snapToGrid` 更名为 `snapEnabled`，`snapGridSize` 保持不变。
- 持久化：`CanvasData.snapEnabled` 取代 `snapToGrid`；已保存项目里的 `snapToGrid` 不再读取，按默认值处理；不做数据迁移（AGENTS.md 一.1 不需要向后兼容）。无节点数据结构与接口契约变更。
- `DragSnapSettings` 收敛为 `{ snapEnabled: boolean; snapGridSize: number }`；`SnapSettings` 的 `gridEnabled` 与总开关同源，收敛为 `{ enabled: boolean; gridSize: number }`，引擎在 `enabled === false` 时直接返回零偏移、无辅助线与空锁定。

### 3. 性能

- 目标盒在会话开始时构建一次，拖动期只做预筛与邻近关系计算；不再每帧对所有节点做绝对坐标换算。
- 辅助线枚举只发生在有对齐的轴上，且仅对预筛后的目标；数量通常为个位数。
- 保持拖动期不写受控 store、每帧最多一次 DOM 预览的既有约束；吸附计算仍在 rAF 预览路径内完成。

### 4. 文档与测试

- 更新 `specs/canvas-drag-preview-session.md`：
  - 规则 3.1 由本 Spec 取代（总开关、网格按轴互斥、多选吸附、候选排除）；
  - 规则 1.6 改为「吸附开关与网格设置（`snapEnabled`、`snapGridSize`）取会话开始时设置；对齐阈值按屏幕像素/zoom 常量」；
  - 验收标准 3 改为按本 Spec 验收；
  - 「现状与动机 4」标注为当时实现事实，已被本 Spec 取代。
- 新增 `web/src/__tests__/features/canvas/shared/snap-engine.test.ts` 与 `drag/drag-snap.test.ts`；扩展 `drag-preview-session.test.ts`。

## 异常与边界

| 场景 | 行为 |
| --- | --- |
| zoom 非有限或 ≤ 0 | 本次拖动不吸附，原始位置；按下点补偿除数回退 1 |
| 没有候选目标 | 仅网格（若总开关开启且满足门槛） |
| 目标 `hidden` | 不进入候选 |
| 目标尺寸显式为 0/NaN | 按 `nodeBoxSize` 兜底链取尺寸；仍无有效尺寸则跳过 |
| 主体盒宽或高 ≤ 0 | 不吸附（无法定义锚点关系），原始位置 |
| 拖动组且成员在组框内 | 主体等于组框；成员不成为目标 |
| 拖动成员 | 同组其他成员与组框可作为目标 |
| 锁定目标在拖动中被外部删除 | `rebuildFromStore` 清空锁定并重建 |
| 锁定关系超过保持阈值，但存在另一关系在进入阈值内 | 清除旧锁定并按进入阈值重新选择，可能锁定到另一关系 |
| 两轴同时命中 | 各自独立吸附；两轴辅助线同时存在 |
| 网格开启但 `snapGridSize × zoom < 8` | 网格关闭；对齐正常 |
| Ctrl/Meta 与 Shift 同时按下 | 旁路优先：两轴都不吸附 |
| 拖动开始时已按住修饰键 | 由 `onNodeDragStart` 事件初始化，首帧即生效 |
| 拖动中窗口失焦 | 清空修饰键，恢复两轴吸附 |
| 拖动中缩放 | 阈值仍按开始 zoom 计算 |
| 拖动中切换吸附开关 | 本次会话沿用开始设置 |
| 触屏 | 无修饰键；吸附规则不变 |
| 提交帧无最后一帧（异常路径） | 以提交帧自身计算，清空锁定与辅助线 |

## 验收标准

1. 单节点拖动：屏幕阈值随缩放归一（zoom 0.5 时进入阈值 = 10 画布单位，zoom 2 时 = 2.5）；进入 5px、保持 8px 的滞回可复现；跨过保持阈值后重新选择。
2. 辅助线只出现在当前偏移下恰好成立的关系上；中心对中心、间隙、并集三种跨度与重叠合并符合规则 5；间距关系不画线。
3. 多选拖动按并集盒吸附，同一偏移应用到所有选中节点；单选与多选结果一致；多选不出现逐节点辅助线。
4. 拖动组时组与成员都不成为目标；拖动成员时同组成员与组框可作为目标；`hidden` 节点不参与。
5. Ctrl/Meta 拖动无吸附、无辅助线，松开后恢复；Shift 仅主导轴吸附，另一轴不吸附不画线；两者同时按下时全部旁路。
6. 总开关关闭时无对齐、无辅助线、无网格，落点等于指针位移；开启且 `20 × zoom ≥ 8` 时仅无对齐的轴按左上角取整；网格轴不产生辅助线；开关对整理与方向键微移的既有行为不变。
7. 预览帧与提交帧的落点、辅助线完全一致；提交后辅助线清空；撤销/重做、自动保存、组归属与组框 refit 不受影响。
8. 单元测试覆盖：总开关关闭时无对齐/无辅助线/无网格、阈值与滞回、锚点排序、辅助线真实性与跨度/合并、网格门槛与按轴互斥、多选并集、移动集/隐藏排除、修饰键旁路与轴限、成员相对坐标换算、提交一致性。
9. `web` 类型检查、改动文件 ESLint、canvas 测试通过（单 worker）。
10. 浏览器手工走查（用户确认）：单节点/多选/组/成员拖动，缩放 50%/100%/200%，总开关关闭时对齐与网格都关闭，Ctrl 旁路，Shift 轴限，低缩放门槛，拖动中松键/按键，编辑面板打开时拖动，拖入组高亮与松手归属。

## 已确认决策

- 2026-10-30 用户确认（首次）：只保留一个「吸附网格」开关；对齐吸附常开，不提供对齐开关；默认关闭网格吸附；其余按本 Spec 建议执行。
- 2026-10-30 用户决定（第二次，取代首次的开关语义）：磁铁改为总开关——关闭时对齐吸附和网格吸附都关闭；仍只保留一个开关。
- 2026-10-30 用户确认（第三次，实现口径，原话「确认这版 Spec，按建议口径实现」）：默认开启；开关字段 `snapToGrid` 更名为 `snapEnabled`（动作 `toggleSnapEnabled`），`snapGridSize` 不变；旧数据不迁移，已保存项目的 `snapToGrid` 忽略、按默认值处理；开关文案「吸附开 / 吸附关」（英文「Snap on / Snap off」）；整理布局、Agent 整理与方向键微移继续受总开关控制（关闭时不按网格步进）。

历史记录（2026-10-30 首次确认，开关语义部分已被第二次决策取代，其余仍有效）：规则 1–10、验收标准 1–10 及技术影响中的实现口径，含 Ctrl/Meta 旁路与 Shift 轴限、辅助线只画真实关系、多选并集、网格门槛、阈值常量化、不接入手柄吸附。验收 10 走查中的归属顺序缺陷修复已按根因完成并并入 `specs/canvas-shared-module-convergence.md` 业务规则 1；本 Spec 的规则 2.3/3.4 顺序口径不变。

## 待确认事项

无。

## 当前状态

- 2026-10-30：草拟 Spec，状态「待确认」。
- 2026-10-30：用户确认，状态转「已确认」，开始实现。
- 2026-10-30：实现完成（已验证事实）：新增 `shared/alignment-guides.ts`、`shared/snap-engine.ts`、`drag/modifier-keys.ts`（第六轮并入 `drag/drag-input.ts`）；`drag/drag-snap.ts` 改为引擎适配层；`drag/drag-preview-session.ts` 持有目标集合、基准绝对盒、每轴锁定与修饰键跟踪；删除 `hooks/use-alignment-guides.ts` 与 store `snapThreshold`；开关文案改为「网格吸附」；`specs/canvas-drag-preview-session.md` 规则 1.6、3.1、验收标准 3 已同步。
- 2026-10-30：修复辅助线重复 React key（已验证事实）：原 key 为 `type + position.toFixed(1)`，隐含「同坐标只有一条线」的假设；但规则 5.4 允许同坐标不相交线段保留多条，且取整会让相邻坐标碰撞，运行时报 `Encountered two children with the same key`。现 key 改为 `type-position-start-end`（全精度完整几何）；新增 `web/src/__tests__/features/canvas/controls/AlignmentGuides.test.tsx` 回归用例，覆盖同坐标 4 条不相交线段渲染且无 same key 报错。
- 2026-10-30：检查结果（已验证事实）：`cd web && npx tsc --noEmit` 通过；改动文件 ESLint 通过（`simple-import-sort` 自动修复后复跑）；`cd web && npx vitest run --maxWorkers=1 src/__tests__/features/canvas` 通过（74 文件 / 689 例）；源码与测试中无 `snapThreshold` / `use-alignment-guides` 残留。未运行完整 web 测试套件。
- 2026-10-30：开发服务器运行时复核（已验证事实）：浏览器取回的 controls chunk 已包含新 key 表达式、不含旧 `toFixed(1)` key；控制台留存的同 key 报错为修复前的历史记录。尚未在页面上重新触发同坐标多辅助线场景。
- 2026-10-30：`/code-review` 复核与根因修正（已验证事实）：`shared/snap-engine.ts` 导出 `shiftBounds`、新增 `forEachAnchorPair`，删除适配层重复的 `shiftBox`，并让关系选择与辅助线生成共用同一 3×3 锚点枚举；`SnapAnchor`、`SnapLock`、`snapAnchorValue` 收回模块私有；`drag-preview-session.ts` 的 `dragDeltas`/`deltas` 更名为 `rawDeltas`/`finalDeltas`；Spec 的「范围」与「不改动」两处表述与 key 变更对齐。补充回归：规则 5.4 引擎用例、提交终态辅助线与预览一致的断言、窗口失焦清空修饰键用例。
- 2026-10-30：复核后检查结果（已验证事实）：改动文件 ESLint 与 `cd web && npx tsc --noEmit` 通过；`cd web && npx vitest run --maxWorkers=1 src/__tests__/features/canvas` 通过（74 文件 / 691 例）。
- 2026-10-30：第二轮 `/code-review` 复核与根因修正（已验证事实）：触屏拖动按规则 8.5 关闭修饰键（新增 `isTouchDragEvent`；会话在触屏拖动不挂键盘监听并忽略初值）；阈值比较去掉多余的 `SNAP_EPSILON`，ε 仅用于规则 5.1 的恰好对齐与合并；`MovingBox` 删除未使用的 `id`；会话网格设置初值对齐 store 默认 20；`AlignmentGuides` 两轴分支合并为一套坐标映射。新增回归：多选并集与单选同几何一致、触屏修饰键无效、首尾相接辅助线合并。
- 2026-10-30：第二轮检查结果（已验证事实）：改动文件 ESLint 与 `cd web && npx tsc --noEmit` 通过；`cd web && npx vitest run --maxWorkers=1 src/__tests__/features/canvas` 通过（74 文件 / 694 例）。
- 2026-10-30：第三轮 `/code-review` 复核与根因修正（已验证事实）：`DEFAULT_SNAP_GRID_SIZE` 统一 store 初始值与会话初值（`lib/constants.ts`），消除两处手抄 20；二维值类型 `Point` 收敛到 `snap-engine`，`drag-snap` 与拖动会话复用，不再各自声明 `{ x; y }`；`SnapLock`/`SnapRelation` 的 `gap` 更名 `isGap`，避免被读作间距值；删除 `nodeBoxSize` 的测试专用导出与 `buildSnapTargets` 的测试专用默认参数，测试显式传节点索引；`stop()` 两条分支重复的辅助线/锁定清理合并为单出口；`AlignmentGuides` 起止点映射收敛为 `toFlowPoint`；图标与 `CanvasControls` 注释同步为「网格吸附」；补验收 4 成员拖动目标集回归（同组成员与组框可为目标）；`canvas-drag-preview-session.md` 调查记录标注 `use-alignment-guides.ts` 已删除。
- 2026-10-30：第三轮检查结果（已验证事实）：改动文件 ESLint 与 `cd web && npx tsc --noEmit` 通过；定向 4 文件 / 49 例通过；`cd web && npx vitest run --maxWorkers=1 src/__tests__/features/canvas` 通过（74 文件 / 695 例）。
- 2026-10-30：第四轮 `/code-review` 复核与修正（已验证事实）：`snap-engine` 四个阈值常量收回模块私有（无外部消费者）；`DragBeginOptions.preThresholdOffset` 改用共享 `Point`；补异常表「拖动开始时已按住修饰键」非触屏首帧旁路/轴限回归，以及规则 4.3「锁定超出保持阈值、另一关系在进入阈值内」的接管重选回归。`applySnapOffset` 将世界偏移直接叠加到相对坐标，与规则 9.1 等价（拖动中父节点静止或与成员同偏移移动，不涉及父子原点换算，不自行实现换算）。
- 2026-10-30：第四轮检查结果（已验证事实）：改动文件 ESLint 与 `cd web && npx tsc --noEmit` 通过；定向 2 文件 / 43 例通过；`cd web && npx vitest run --maxWorkers=1 src/__tests__/features/canvas` 通过（74 文件 / 697 例）。
- 2026-10-30：第五轮 `/code-review` 复核与修正（已验证事实）：网格取整的 `1e-9` 魔法值命名 `GRID_ZERO_EPSILON`；`nodeBoxSize` 注释标明规则 2.6 的取值链选择（吸附沿用 style-first，不改 tidy-layout 的 measured-first，避免后续审查重复误报）；新增 `modifier-keys` 单测（Ctrl/Meta 旁路、Shift 轴限、触屏判定）；补规则 10.3「外部写入重建清空两轴锁定」会话回归与验收 1 的 zoom 0.5 字面断言；Spec「范围」补充 `lib/constants.ts` 条目。
- 2026-10-30：第五轮检查结果（已验证事实）：改动文件 ESLint 与 `cd web && npx tsc --noEmit` 通过；定向 4 文件 / 54 例通过；`cd web && npx vitest run --maxWorkers=1 src/__tests__/features/canvas` 通过（75 文件 / 701 例）。
- 2026-10-30：第六轮 `/code-review` 复核与修正（已验证事实）：`modifier-keys.ts` 的两个读取函数在调用点总是成对使用、模块名不覆盖触屏职责，合并为 `drag/drag-input.ts` 的 `dragInputFromEvent`（返回 `{ modifiers, touch }`），调用方一次取齐；`captureSnapshot` 更名 `rebuildBaseline`（同时重建目标集与清空锁定，与规则 10.3「重建基准」措辞一致）；`computeFrame` 两处相同位移公式收敛为私有 `deltaFrom`；补规则 10.3「重建保留修饰键状态」会话回归；修正 `specs/canvas-drag-preview-session.md` 调查记录中已删除 hook 的并入位置（`shared/alignment-guides.ts`）。
- 2026-10-30：第六轮检查结果（已验证事实）：改动文件 ESLint 与 `cd web && npx tsc --noEmit` 通过；定向 2 文件 / 34 例通过；`cd web && npx vitest run --maxWorkers=1 src/__tests__/features/canvas` 通过（75 文件 / 702 例）。
- 2026-10-30：第七轮 `/code-review` 复核与修正（已验证事实）：`buildGuides` 的偏移参数改用共享 `Point`；网格原点取整改走 `snapAnchorValue(subject, axis, "start")`，轴翻转统一到锚点取值；`reset()` 补清 `modifiersEnabled`，与会话其余瞬态字段一致；`finalDeltas` 注释标明由最终位置反推、预览与提交同源；Spec 文档修正（`AlignmentGuide` 归属 `shared/alignment-guides.ts`；实现记录标注 `modifier-keys` 第六轮并入 `drag/drag-input.ts`）。
- 2026-10-30：第七轮检查结果（已验证事实）：改动文件 ESLint 与 `cd web && npx tsc --noEmit` 通过；定向 2 文件 / 45 例通过；`cd web && npx vitest run --maxWorkers=1 src/__tests__/features/canvas` 通过（75 文件 / 702 例）。
- 2026-10-30：第八轮 `/code-review` 复核与修正（已验证事实）：修饰键判定（Ctrl/Meta 旁路、Shift 轴限）只保留 `drag-input.ts` 的 `dragModifiersFromEvent` 一处，拖动期键盘监听改走同一读取函数；`DragBeginOptions` 改为 `extends Partial<DragInput>`，与事件输入同源，字段分歧触发类型错误；`drag-snap.test.ts` 改用公共 `buildNodeIndex`，删除本地索引构造。判断类提示未采纳并记录理由：`SnapRelation` 三处字面量抽取为六参辅助函数并不优于显式字段；`{ x: null, y: null }` 共享常量有可变对象别名风险；`MagnetIcon` 命名不在本次范围（Spec 仅要求注释同步）。
- 2026-10-30：第八轮检查结果（已验证事实）：改动文件 ESLint 与 `cd web && npx tsc --noEmit` 通过；定向 3 文件 / 41 例通过；`cd web && npx vitest run --maxWorkers=1 src/__tests__/features/canvas` 通过（75 文件 / 702 例）。
- 2026-10-30：第九轮 `/code-review` 双轴复核（已验证事实）：Standards 轴无文档规范违规，Spec 轴无缺失、越界或实现错误，两轴均无发现。随后仅做三处非行为清理：`drag-preview-session.ts` 的 import 逗号空格；`drag-snap.ts` 私有哨兵 `ZERO_BOUNDS` 更名 `EMPTY_MOVING_BOUNDS` 并注明「零尺寸无法通过校验，等价于本次不吸附」；删除会话 `attachModifierListeners`/`detachModifierListeners` 中不可达的 `typeof window === "undefined"` 守卫（监听只在拖动事件路径挂载与摘除）。判断类提示未采纳并记录理由：`dragModifiersFromEvent` 的 `unknown` 判空/对象检查是类型收窄本身，不是可删防御；`begin` 的 `options = {}` 表达「无修饰键、无阈值前位移」的自然初值，与第三轮删除的「内部推导索引」默认参数性质不同。
- 2026-10-30：第九轮检查结果（已验证事实）：改动文件 ESLint 与 `cd web && npx tsc --noEmit` 通过；定向 3 文件 / 41 例通过；`cd web && npx vitest run --maxWorkers=1 src/__tests__/features/canvas` 通过（75 文件 / 702 例）。
- 2026-10-30：验收 10 走查发现并根因修复归属顺序缺陷（已验证事实，超出本 Spec 范围，按规则单独记录）：从组内拖出成员后，保存位置相对预期偏移恰好一个组原点（本次为 600px），落点错位并按顶层节点提交。根因：`parentId` 归属写入后节点数组把成员排在组之前，React Flow 解析不到父节点、按顶层计算绝对坐标，后续拖动据此产生错误位置帧；store 写入边界没有维护「父先于子」顺序不变量。修复：`shared/group-membership.ts` 新增 `orderGroupsBeforeMembers`（组全部前置，顺序已合法时原引用返回，幽灵 `parentId` 与非组父不构成顺序约束），在 `canvas-store` 的 `setNodes` / `addNodes` / `restoreFromProject` 统一归一化，覆盖拖入组、粘贴、撤销/重做与历史数据加载。影响：规则 2.3 的目标顺序与规则 3.4.2 的并列比较都取 store 数组顺序；归一化只在顺序不合法时触发，触发时把全部组前置（其余节点保持原有相对顺序），未触发时保持原顺序。因此组与其成员的相对顺序恒为组在前，组与其他节点的先后取决于该数组是否触发过归一化；并列比较按归一化后的实际顺序进行。回归：`group-membership.test.ts` 新增 5 例、`canvas-store.test.ts` 新增 4 例、`canvas-edit-actions.test.ts` 新增 1 例（撤销恢复旧快照时归一化）。
- 2026-10-30：验收 10 浏览器走查已验证事实（暂存画布 `/canvas/mvubeirp5219lc`）：刷新后历史保存的错误顺序经 `restoreFromProject` 自动归正（store 顺序 `[g1,t1,t2,t3,t4,m1,m2]`，`t2` 归属 `g1`、相对坐标 `(20,40)`）；成员拖出落点等于「起始绝对坐标 + 指针位移」（两次复测分别落在 `(920,340)`、`(930,340)`，600px 偏移消失）；拖入组时拖动中出现 `.node-drag-over` 高亮，松手保存 `parentId = g1`、相对坐标 `(20,40)` / `(30,40)`，store 顺序保持组前置；编辑面板打开时拖动节点，面板与工具栏锚定节点，提交位移精确等于指针位移（+100,+100）；控制台无 React Flow 父节点告警，仅有两条改动前已存在的资源 404。
- 2026-10-30：验收 10 未覆盖项（环境限制，未验证）：Browser 面板 `document.visibilityState === 'hidden'`，`requestAnimationFrame` 不触发，拖动中的预览位移与辅助线无法观测；Ctrl 旁路、Shift 轴限、网格开关与低缩放门槛、拖动中松键/按键的拖动中视觉，以及明暗两套主题的辅助线渲染，均需用户在可见页面手工确认。
- 2026-10-30：本轮修复后检查结果（已验证事实）：改动文件 ESLint 与 `cd web && npx tsc --noEmit` 通过；定向 9 文件 / 124 例、7 文件 / 109 例通过；`cd web && npx vitest run --maxWorkers=1 src/__tests__/features/canvas` 通过（75 文件 / 711 例）。`/code-review` 双轴复核发现项已全部根因修复：`addNodes` 未归一化（粘贴路径）、判定与修复对非组父口径不一致、测试辅助函数重复、`applySnapOffset` 快路径被多余 Map 复制抵消、`SnapRelation` 与 `SnapLock` 字段重复。
- 2026-10-30：第十轮 `/code-review` 双轴复核（已验证事实）：Standards 轴无代码级硬违规；两条为验证/确认缺口——`web/AGENTS.md` 九.2 的明暗主题走查（已列未验证项）与越界根因修复需用户确认（已列入待确认事项）。Spec 轴无缺失、越界或实现错误；指出并列影响的表述过宽（已按实际顺序改写）与验收 7 撤销/重做归属链路缺集成断言（已补 `canvas-edit-actions.test.ts` 用例）。判断类提示未采纳并记录理由：`orderGroupsBeforeMembers` 每次 `setNodes` 建索引 Map——store 写入发生在拖动提交与离散操作边界，O(n) 建表远小于 React Flow 自身节点 diff，且数组含组时无法省去；两测试文件的节点工厂重复——两处 `group`/`member` 形状不同（store 用例的组带尺寸），跨文件抽取需增加选项参数，无真实复用价值；`SnapRelation` 三处字面量与 `{ x: null, y: null }` 维持第八轮记录的理由。
- 2026-10-30：第十轮检查结果（已验证事实）：改动文件 ESLint 与 `cd web && npx tsc --noEmit` 通过；`cd web && npx vitest run --maxWorkers=1 src/__tests__/features/canvas` 通过（75 文件 / 712 例）。
- 2026-10-30：用户确认验收 10 走查通过（含拖动中预览/辅助线、修饰键、网格门槛与明暗主题渲染）；验收标准 1–10 全部通过。状态保持「已确认」，待代码提交后转「已实现」。
- 2026-10-30：诊断「吸附开关没有用了」（已验证事实，暂存画布 `/canvas/mvubeirp5219lc`）：开关状态、文案、按下样式与立即保存均正常；三次 A/B（单节点两次、组一次）证明网格吸附随开关变化（单节点 `(253,230)+(13,27)`：开 → `(260,257)`、关 → `(273,284)`；组 `(732,113)+(13,27)`：开 → `(740,140)`、关 → `(753,167)`），视口未移动。观感无效的根因是「对齐吸附常开」与网格缩放门槛叠加：靠近其他节点时对齐优先、开关只影响网格，缩放低于 40% 时网格整体关闭。
- 2026-10-30：用户决定改为总开关（「磁铁关闭时对齐吸附和网格吸附都关闭」）。Spec 按新语义改写规则 1、6.1、6.2、8.1、10.4 与目标、范围、决策表、技术影响、验收 6/8/10；状态由「已确认」转「待确认」，等待用户确认后实现。代码仍为旧语义（磁铁只控制网格），本次未改动实现文件。
- 2026-10-30：用户确认总开关 Spec（「确认这版 Spec，按建议口径实现」），状态转「已确认」，开始实现：开关字段更名 `snapEnabled`、默认开启、引擎在总开关关闭时短路、文案「吸附开 / 吸附关」、旧数据不迁移。
- 验收标准 1–5、7–8 的核心行为由单测覆盖；验收标准 6 的网格规则由单测覆盖，`snapToGrid` 在整理布局与方向键微移中的路径未改动（diff 核对）；验收标准 9 由上述检查覆盖。验收标准 10（浏览器手工走查）已由用户确认通过（2026-10-30）。以上结论对应旧开关语义；第二次决策把开关改为总开关后，状态转「待确认」，新语义实现并重新验收、提交后转「已实现」。
- 2026-10-30：总开关语义实现完成。全链路更名 `snapToGrid` → `snapEnabled`（canvas store、项目 `CanvasData` / delta / 历史快照、server schema 与 delta 合并、工具栏、测试夹具）；默认值统一取 `DEFAULT_SNAP_ENABLED`（`true`）；`resolveSnap` 在总开关关闭时短路为零偏移、无辅助线、空锁定（`emptySnapState()` 工厂）；文案改「吸附开 / 吸附关」；旧存档的 `snapToGrid` 不迁移，忽略后落到默认开启。整理布局、Agent 整理与方向键微移按决策 5 受总开关控制（关闭时方向键按 5px 步进）。
- 验证（已验证事实）：web 与根目录 `tsc --noEmit` 通过；改动文件 ESLint 通过；web canvas + project 82 文件 / 783 用例、server canvas 33 用例全部通过，含新增「总开关关闭时引擎与拖动会话均无吸附、锁定清空」回归用例。浏览器 A/B（测试画布 mvubeirp5219lc，zoom 1）：关闭时拖动 +13px 落点 (273,297)，为原始位移、拖动中无辅助线、不取整；开启后拖动 +6px，拖动中出现辅助线，落点 (280,300)（y 对齐 300、x 网格取整 280）；开关状态刷新后保持；旧存档打开画布为吸附开启。
- 复审修复：`CanvasControls` 头注释由「网格吸附开关」改为「吸附总开关」（旧描述把总开关说成仅网格）；三处 `{ x: null, y: null }` 字面量收敛为 `emptySnapState()`；`DEFAULT_SNAP_ENABLED` 补入「范围」；`specs/canvas-shared-module-convergence.md` 因 `orderGroupsBeforeMembers` 修复尚未提交，状态由「已实现」暂回「已确认」。
- 当前状态说明：实现已提交并推送（be612033，2026-10-30），验收标准 1–10 的单测、检查与浏览器 A/B 走查均已完成；用户于 2026-10-30 要求转为「已实现」，状态转「已实现」。
