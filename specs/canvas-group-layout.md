# 画布组内布局（宫格 / 水平 / 垂直 / 智能）

状态：已实现（2026-11-02）

## 1. 背景与证据

### 1.1 现状（已验证事实，读源码确认）

1. **入口与链路**：`nodes/NodeToolbar.tsx` 的组节点下拉「宫格布局 / 水平布局 / 垂直布局」→ `dispatchNodeAction(nodeId, "layout", { mode })` → `use-group-operations.ts` 的 `onNodeAction` → `applyGridLayout` / `applyHorizontalLayout` / `applyVerticalLayout`。
2. **三个算法都在 hook 模块内部**（不导出、无单测；`use-group-operations.test.ts` 只覆盖 `attachNodesToGroup` / `detachGroupMembers`）。
3. **宫格**：`cols = ceil(√n)`，行内游标按成员自身宽度累加、净间距 `LAYOUT_GAP = 60`，行高取该行最高，**成员顶对齐**（`y = cursorY`）；成员顺序 = `groupMembers` 的 store 数组顺序，即创建/粘贴顺序，与成员在画布上的位置无关。
4. **组框尺寸**：`width = max(200, contentW + 80)`，`height = max(120, contentH + 28 + 80)`；原点 `(40, 28 + 40)`（不压标题栏）。
5. **与 GroupNode 的最小尺寸一致**：`GroupNode` 的 `dynMinWidth = max(200, childMaxX + 40)`、`dynMinHeight = max(120, childMaxY + 40)`，其中 `childMaxX = contentW + 40`、`childMaxY = 68 + contentH`，与第 4 条公式恒等。布局收缩后缩放手柄不会立刻允许再缩。
6. **组不可连，但成员之间的连线存在且渲染**：`root/CanvasSurface.tsx` 把 store 的 `edges` 全量交给 ReactFlow（`edges={edges}`），`shared/connection-rules.ts` 不限制成员互连。组内布局当前完全不读连线。
7. **画布级整理有图布局，但不进组**：`shared/tidy-layout.ts` 用 `@dagrejs/dagre` 做 LR 分层，但把「组 + 成员」当作一个原子块，成员内部不参与。
8. **画布整理的宫格模式同样行内顶对齐**：`tidy-layout.ts` 的 `packRows` 写入 `y = cursorY`（行顶），与 1.1-3 的组内宫格是同一缺陷模式，同一份数据在两个入口下的垂直观感不一致。

### 1.2 即梦对照（已验证事实：静态 bundle 分析 + 执行其原函数复算）

对即梦画布 bundle（`canvas-data.*.js` 模块 86158 / 49197）的还原与复算：

1. **两种数据模式**：`mode: "grid" | "flow"`。UI 上的「宫格布局 / 水平布局 / 智能布局」三个标签中，**「水平布局」与「智能布局」是同一个 `flow` 函数**；即梦没有独立的垂直布局模式。
2. **宫格**：`cols = ceil(√n)`、`rows = ceil(n/cols)`；单元格取全体成员的 `max(width) × max(height)`，成员在格内水平与垂直**双轴居中**；间距 80；容器 = 内容 + 160（80 内边距）。
3. **排序**：宫格先按画布位置排**读序**（行聚类，中心 Y 容差 `max(8, 0.6 × 高度)`，行内按 X）；`flow` 按 `(zIndex, id)` 排序。
4. **flow**：Tarjan 求强连通分量 → 缩点 DAG → Kahn 最长路径分层 → 一层一列（左→右）；列宽取该列最宽成员，行间距 48、列间距 220，各列相对最高列垂直居中，列内顶对齐；容器 = 内容 + 2 × 56。
5. **退化**：`flow` 在成员之间没有连线时输出**一列竖排**（执行原函数确认）。
6. **容器**：即梦无标题栏、无最小尺寸，内边距统一 56。
7. **提交**：`arrangeGroup` 只产出成员的 `move-node` 与组的尺寸属性，不移动组外节点，不做碰撞处理。

### 1.3 量化差异

两个成员 600×338（横图）+ 200×356（竖图）：

- 即梦统一格：格 600×356，组宽 `2×600 + 80 + 160` = **1440**；
- 本仓库紧凑排：组宽 `600 + 60 + 200 + 80` = **940**。

素材横竖混排是常态，统一格等于按最宽成员给所有成员付面积。

### 1.4 取舍

| 即梦行为 | 本次是否采用 | 说明 |
| --- | --- | --- |
| 宫格按读序排序后再填格 | 采用 | 规则 4.2 |
| 行内垂直居中 | 采用 | 规则 4.3（组内宫格）与 4.9（画布整理宫格）；只做行内居中，不统一格 |
| 组内按连线分层（智能布局） | 采用能力，算法自实现 | 规则 4.5：用 dagre，不用 SCC + 最长路径 |
| 组内无连线时退化为宫格 | 采用 | 规则 4.5.2 |
| 统一 `max(width) × max(height)` 单元格 | 不采用 | 1.3 的量化差距；紧凑游标保持不变 |
| 去掉水平 / 垂直，两者都叫 flow | 不采用 | 即梦的「水平布局」在无连线时是一列竖排，语义与名字不符；本仓库保留两种显式模式 |
| 容器 = 内容 + 2 × 56、无标题栏、无最小尺寸 | 不采用 | 本仓库组有 28px 标题栏（成员不可压住标题）与 200×120 最小框，见 1.1-4/5 |
| `flow` 按 `(zIndex, id)` 排序、宫格按读序 | 不采用双口径 | 四种模式统一按读序排输入顺序（规则 4.2），只有分层结果由 dagre 决定 |
| 列间距 220 / 行间距 48 | 部分采用：取 120 / 60 | 规则 4.8；220 在组内会让组框明显变宽（三节点链 2320 vs 2120），且与本仓库画布整理的 60 不同量级 |
| 只移动成员与容器、不处理组外重叠 | 沿用 | 现有行为，本 Spec 不引入碰撞避让 |

## 2. 目标

1. 组内布局的**结果顺序与用户眼前的视觉顺序一致**：点击任一非智能布局后，成员按「从上到下、从左到右」重新排，不再退回创建顺序。
2. 补上**按组内连线分层**的组内布局能力（智能布局），让有链路的组能一键排出上下游。
3. 保持现有的紧凑排布、标题栏留白、最小组框与单次历史提交，不引入即梦的统一单元格与均匀内边距。
4. 组内宫格与画布整理宫格采用同一行内垂直口径，不在两个布局入口之间留下观感差异。

## 3. 范围

### 3.1 包含

- 组内布局算法从 `hooks/use-group-operations.ts` 迁出为纯函数模块，新增读序排序与智能布局。
- 四种模式：宫格、水平、垂直、智能。
- 组工具栏布局下拉新增「智能布局」项与文案。
- 组内布局常量独立于画布级 `LAYOUT_GAP`。
- 画布整理宫格（`tidy-layout.ts` 的 `packRows`）的行内对齐同步改为垂直居中，与组内宫格同一口径（4.9）。
- 画布整理分层模式与组内智能布局共用 `shared/layered-layout.ts`：dagre 只求拓扑层，层内顺序与坐标由读序决定（4.10）。

### 3.2 不包含

- 画布整理的分块单位、读序、行宽折行、列数上限、整体包围盒归一与吸附行为；`packRows` 本次只改行内垂直定位（4.9.2）。分层模式的 dagre 插入顺序变化见 4.10.2。
- 组框位置（布局不改组节点 `position`）、组成员归属、组的边。
- 布局动画、布局的 Agent 工具入口、布局结果的碰撞避让。
- 组外节点与组内成员之间的连线参与分层。

## 4. 业务规则

### 4.1 入口与模式

4.1.1 组工具栏「布局」下拉提供四项：智能布局、宫格布局、水平布局、垂直布局（顺序见 4.1.3）。每项点击立即执行，不做自动选择、不记忆上次选择。

4.1.2 模式标识 `"smart" | "grid" | "horizontal" | "vertical"`，经既有 `dispatchNodeAction(nodeId, "layout", { mode })` 派发；`onNodeAction` 的 `mode` 联合类型同步扩展。

4.1.3 智能布局排在下拉首位（它是唯一按语义排列的模式，其余三种是纯几何排布）；本次不实现「有连线时自动改默认项」——点击即执行、结果可预期，优先于自动推断。

4.1.4 布局只对组节点生效；非组节点的 `layout` 动作忽略（现有守卫保持）。

4.1.5 成员数为 0 时直接返回（空组本不应存在，`pruneEmptyGroups` 负责）；成员数为 1 时按 4.6 归位到布局原点并收缩组框（「归位」是合法语义，不特殊返回）。

### 4.2 成员顺序（读序）

4.2.1 除智能布局的分层结果外，所有模式的输入顺序都是**读序**，按成员在组内的相对盒 `{ x, y, width, height }` 计算。成员 `position` 本身就是组内相对坐标，读序直接在组内空间算，不做绝对坐标换算。

4.2.2 读序算法（共享实现，画布整理与组内布局同一口径）：

- 带高 `bandHeight = max(60, 平均高度 / 2)`；
- 按**垂直中线**（`y + 高度 / 2`）升序扫描，与当前带首元素中线之差 `< bandHeight` 的归入同一带，否则开新带；
- 带内按 x 升序；x 相同保持中线顺序（即自上而下）；再相同保持入参数组顺序（排序稳定）。
- 分带基准必须是中线：各模式的跨轴对齐都是居中（宫格行内、水平 / 垂直跨轴、分层列内），同一行 / 列的成员中线重合。若按顶边分带，高矮混排时矮成员被居中下移会被判成另一行，下一次读序改变填充顺序（宫格、水平布局在两次执行间换位）。中线分带让「居中排出的结果」再次读序恰好还原排布顺序（4.5.6）。

4.2.3 读序实现是全库唯一一份：`shared/tidy-layout.ts` 的 `sortByReading` 改为调用它，不得复制第二份。

4.2.4 读序不参与 dagre 的节点插入顺序：dagre 只求拓扑层，节点按入参数组顺序插入（稳定顺序，rank 只由拓扑与尺寸决定），避免「读序 → 坐标 → 读序」的反馈环。读序只用于层内堆叠与尾列排序（4.5.3）。

### 4.3 宫格布局

4.3.1 `cols = ceil(√n)`，`rows = ceil(n / cols)`；成员按读序逐行填充。

4.3.2 行内用**紧凑游标**：每个成员的 x = 游标位置，游标 += 该成员自身宽度 + `GROUP_LAYOUT_GAP`。不采用统一最大单元格。

4.3.3 行内**垂直居中**：行高 `rowH = 该行成员最大高度`，成员 y = `rowTop + (rowH − 成员高度) / 2`。这是相对现状唯一的位置语义变化；画布整理的同一规则见 4.9。

4.3.4 行间：`rowTop(下一行) = rowTop + rowH + GROUP_LAYOUT_GAP`。

4.3.5 `contentW = max(各行成员宽度和 + 间距 × (该行成员数 − 1))`；`contentH = ΣrowH + 间距 × (行数 − 1)`。

### 4.4 水平 / 垂直布局

4.4.1 水平：按读序单行排列；x 用紧凑游标累加自身宽度 + `GROUP_LAYOUT_GAP`；y 相对该行最高成员居中。

4.4.2 垂直：按读序单列排列；y 用紧凑游标累加自身高度 + `GROUP_LAYOUT_GAP`；x 相对该列最宽成员居中。

4.4.3 与现状的差异只有输入顺序由 store 数组顺序改为读序。

### 4.5 智能布局

4.5.1 **组内边**：`edges` 中 `source` 与 `target` 都属于本组成员、且 `source !== target` 的边；按 `(source, target)` 去重（由 `packLayered` 的邻接集完成）；组外端点、自环、悬空边忽略。

4.5.2 **无组内边时退化为 4.3 宫格布局**（读序）。「智能」在无链路可依时就是整齐排列，不做一列竖排。

4.5.3 **有组内边时**：

1. 构建有向图，Kahn 拓扑判环；可拓扑排序的部分为**主图**，剩余节点为**环内**。
2. 主图交给 `@dagrejs/dagre`，`rankdir: "LR"`，`nodesep = GROUP_LAYOUT_GAP`，`ranksep = GROUP_LAYOUT_COLUMN_GAP`；节点尺寸取 `measureNode`；**dagre 只用于求 rank**，其层内次序与坐标不使用。节点按入参数组顺序插入（稳定顺序）。上游在左、下游在右。
3. 一个 rank = 一列，按 rank 升序左→右排布；列宽取该层最宽成员，列间距 `GROUP_LAYOUT_COLUMN_GAP`。
4. 层内按**读序**自上而下堆叠，行间距 `GROUP_LAYOUT_GAP`；同列成员左对齐（x 相同）。各列相对最高列垂直居中（`(最高列高 − 本列高) / 2`）。
5. **孤立成员**（入度出度都为 0）与**环内成员**一起进尾列，按读序；尾列排在主图右侧：`x = 主图宽度 + GROUP_LAYOUT_COLUMN_GAP`，整列相对主图垂直居中（`max(0, (主图高度 − 尾列高度) / 2)`）。与画布整理共用 `packLayered` 的尾列策略（4.10.1）。
6. 主图为空（全部是环或孤立）时，尾列从 x = 0 开始，不做垂直居中偏移。

4.5.4 **归一化**：取全部成员新位置的包围盒，整体平移使包围盒左上角等于布局原点（4.6.1）。dagre 的绝对坐标不作直接使用。

4.5.5 同一列内成员的上下顺序由读序决定，不由 dagre 决定：dagre 的层内次序不保证与投喂次序一致，用其输出反推下一次读序会让同层支路来回翻转（周期 2 振荡）。

4.5.6 **幂等**：布局是「拓扑 + 节点尺寸 + 读序」的纯函数，对布局结果再次执行必须得到同一坐标与组框尺寸。rank 只由拓扑与尺寸决定；层内顺序取自读序，而输出的同列成员 x 相同、读序在带内按 x 排序（x 相同时保持中线顺序），因此输出再次读序恰好还原层内堆叠顺序。四种模式（含无连线退化的宫格、水平、垂直）同样必须幂等。

### 4.6 组框尺寸与原点

4.6.1 布局原点即组框原点：内容并集左上角左移 `GROUP_NODE_PADDING`(40px)、上移 `GROUP_BODY_TOP_INSET`(68px)，与原 `LAYOUT_ORIGIN = (40, 68)` 口径等价，保持不变（成员不可压住组标题栏）。

4.6.2 成员最终位置 = 绝对内容坐标 − 组框原点（组内相对坐标）。

4.6.3 组框尺寸：

- `width = max(GROUP_NODE_MIN_WIDTH, contentW + 2 × GROUP_NODE_PADDING)`
- `height = max(GROUP_NODE_MIN_HEIGHT, contentH + NODE_TITLE_HEIGHT + 2 × GROUP_NODE_PADDING)`

4.6.4 该公式必须与 `GroupNode` 的 `dynMinWidth` / `dynMinHeight` 恒等（1.1-5）。这是不变量：布局产出的组框尺寸一旦大于该最小尺寸，缩放手柄就会立刻允许二次收缩；小于则组框容不下内容。两者共用同一组常量，任一侧改动必须同步校验。

4.6.5 布局不修改组节点 `position`（组左上角不动），内容以组框左上角为锚重排。

4.6.6 布局是唯一允许组框收缩的路径（现有语义保持）；拖动、缩放等其他路径不收缩组框。

4.6.7 布局菜单的关闭必须与组框尺寸变更同步。布局在同一次提交中改变组框宽高，组工具栏（下拉的触发器）随组宽变化横移；若下拉浮层此时仍在播放退出动画，portal 会跟随触发器重新定位，表现为「组框先变、菜单再滑走」的闪跳。因此布局菜单选中任一项时，本次关闭不播放退出动画（`DropdownMenuContent closeAnimation={false}`），浮层与尺寸变更同帧卸载。工具栏锚点保持居中（`align="center"`）；改锚点只让触发器不动，浮层仍在退出动画期间存活，不构成修复。

### 4.7 提交与历史

4.7.1 一次布局 = 一次 `pushHistory(takeCanvasSnapshot())` + 一次 `setNodes`（组尺寸与成员 `position` 在同一数组写入）+ `markDirtyImmediate()`。撤销一步回到布局前。

4.7.2 布局不产生动画、不引入新的事务 API、不写 `data` 字段。

### 4.8 参数常量

4.8.1 新增两个组内布局常量到 `lib/constants.ts`：

| 常量 | 值 | 使用者 |
| --- | --- | --- |
| `GROUP_LAYOUT_GAP` | 60 | 宫格 / 水平 / 垂直的净间距；智能布局的列内行间距（dagre `nodesep`）与尾列行距 |
| `GROUP_LAYOUT_COLUMN_GAP` | 120 | 智能布局的列间距（dagre `ranksep`）与尾列横向偏移 |

4.8.2 组内布局不得复用 `LAYOUT_GAP`：该常量同时被吸附间距与画布整理使用，改它会连带改变画布级行为。

4.8.3 读序的带高常量（`min 60`）随读序实现迁入 `shared/reading-order.ts`，不导出。

### 4.9 画布整理宫格的行内居中（同口径）

4.9.1 `shared/tidy-layout.ts` 的 `packRows` 行内定位由「行内顶对齐」（`y = 行顶`）改为「行内垂直居中」：`y = rowTop + (rowH − 块高度) / 2`，与 4.3.3 同一语义。组内宫格与画布整理不得保留两种垂直口径（1.1-8）。

4.9.2 本次只改行内垂直定位。`packRows` 的分块单位、读序、行宽上限折行（`maxRowWidth`）、列数上限（`ceil(√n)`）、行高取行内最高、行间距 `LAYOUT_GAP`、整体包围盒归一与吸附（`snapSize`）全部不变；`computeTidyLayout` 的 `layer` / `auto` 模式的层与链路结果不受影响（dagre 插入顺序的变化见 4.10.2）。行划分由宽度与列数决定、与行内 y 无关，居中不参与折行判定。

4.9.3 行高与行间距不变，因此等高行、单块行、独占一行的超宽块输出与现状一致；只有同一行内高度不等的块产生纵向位移。这是本规则的回归边界，也是验收依据。

4.9.4 4.9 与 4.3 是同一条业务规则在两个布局入口上的落地，不是两套算法：两者共用读序（4.2.3）与居中语义。实现上各自内联一行居中表达式即可，不为此新增公共函数（单行表达式无复用价值，见 AGENTS.md 三.5）。

### 4.10 画布整理分层模式与组内智能布局共用实现

4.10.1 `tidy-layout` 的 `layer` / `auto` 模式与组内智能布局共用 `shared/layered-layout.ts` 的 `packLayered`：dagre 只求拓扑层；层内按读序堆叠、列内左对齐、各列相对最高列垂直居中；Kahn 判环；环内与孤立节点进尾列并相对主图垂直居中。结构与尾列策略由同一实现保证，不再靠两份代码同口径维持。

4.10.2 dagre 的节点插入顺序在两个入口都是**入参数组顺序**（画布整理为块数组：组在前、未分组在后；组内为成员数组顺序），不随节点位置变化；输出只取 rank，层内次序与坐标统一由读序给出（4.5.3）。因此同一张图的同层次序在两个入口一致，且不受 dagre 层内次序左右。2026-11-01「按读序投入 dagre」的决定由本条取代——目标（同层次序贴合视觉顺序、两入口一致）由「层内顺序 = 读序」更直接地满足；拓扑层、链路位置与整体包围盒不变。

## 5. 技术影响

### 5.1 模块

- 新增 `web/src/features/canvas/shared/reading-order.ts`：`sortBoxesByReading<T extends { x: number; y: number; height: number }>(items: readonly T[]): T[]`。画布整理与组内布局共用；按垂直中线分带，带内按 x（4.2.2）。
- 新增 `web/src/features/canvas/shared/layered-layout.ts`：`packLayered`（dagre 只求层，层内按读序堆叠，4.10）、`collectLinks`（连线端点 → 布局单元依赖边）、`LayoutBox`（布局期几何快照）。
- 新增 `web/src/features/canvas/shared/node-size.ts`：`measureNode` / `Size` 从 `tidy-layout.ts` 迁出，节点测量不再依赖布局模块。
- 新增 `web/src/features/canvas/shared/group-layout.ts`：纯函数，无 React / store 依赖。
  - `GroupLayoutMode = "smart" | "grid" | "horizontal" | "vertical"`
  - `arrangeGroup(members, edges, mode): { positions: Map<string, { x: number; y: number }>; width: number; height: number }`
  - `positions` 为组内相对坐标；`width` / `height` 为组框尺寸。
  - 盒子类型复用 `LayoutBox`；组内边经 `collectLinks` 过滤（4.5.1）。
- `web/src/features/canvas/shared/tidy-layout.ts`：`sortByReading` 改为委托 `sortBoxesByReading`，删除本地实现与 `MIN_BAND_HEIGHT`（排序行为与输出不变）；`packRows` 的行内 y 由行顶改为行内居中（4.9）；`packWithDagre` 删除，分层模式改调 `packLayered` 并只保留块级边映射 `blockLinks`；`measureNode` / `Size` 迁出到 `node-size.ts`。
- `web/src/features/canvas/hooks/use-group-operations.ts`：删除 `applyGridLayout` / `applyHorizontalLayout` / `applyVerticalLayout` / `measureMembers`，组框矩形与布局原点由 `group-bounds.ts` 的 `groupRectFromContent` 统一派生（编组创建与组内布局同口径，4.6.1）；`onNodeAction` 改为读 store 的 `edges` 后调用 `arrangeGroup`；`mode` 联合类型扩展为 `GroupLayoutMode`。
- `web/src/features/canvas/nodes/NodeToolbar.tsx`：布局下拉新增「智能布局」项（首位）与图标；选中布局项时本次关闭不播放退出动画（4.6.7）。
- `web/src/components/ui/dropdown-menu.tsx`：`DropdownMenuContent` 新增 `closeAnimation`（默认 `true`）；调用方按动作语义关闭退出动画，避免浮层在触发器几何变更后继续存活。
- `web/src/lib/i18n/zh-CN.json` / `en-US.json`：新增 `node.smartLayout`（中「智能布局」/ 英「Smart Layout」）。
- `web/src/lib/constants.ts`：新增 4.8.1 的两个常量。

### 5.2 依赖与数据

- 无新增依赖（`@dagrejs/dagre` 已在 web 依赖中）。
- 无节点数据结构、持久化字段或接口契约变更：布局结果仍落在组节点 `style.width/height` 与成员 `position`，存档格式不变。

### 5.3 性能

- 单组布局的输入规模是组内成员数（通常个位数到几十）；dagre 分层在成员数 < 100 时远低于一帧预算，且只在用户点击时执行一次，不在拖动/渲染路径上。
- 读序抽取对画布整理无额外开销（同一算法，仅函数边界变化）。

### 5.4 测试

- 新增 `web/src/__tests__/features/canvas/shared/group-layout.test.ts`：
  - 宫格：读序输入、行内居中、紧凑列宽、组框尺寸公式；
  - 水平 / 垂直：读序输入、居中；
  - 智能：链式、菱形、环（进尾列）、混合孤立（尾列右侧、垂直居中）、环与孤立成员同列排在主图右侧、无组内边退化为宫格、组外端点与自环被忽略、归一化到布局原点；
  - 单成员归位。
- 新增 `web/src/__tests__/features/canvas/shared/reading-order.test.ts`：中线分带、带内 x、稳定排序、中线对齐同带；并保留 `tidy-layout.test.ts` 原有读序相关断言作为回归。
- 新增 `web/src/__tests__/features/canvas/shared/layout-idempotence.test.ts`：固定形状（链路 + 无连线音频、菱形 + 环 + 孤立、无连线退化宫格的高矮混排、水平 / 垂直高矮混排）与 300 组确定性随机拓扑（含环路、不同尺寸 / 音频成员）× 四种模式，连续执行三次结果一致（4.5.6、验收 10）。
- `tidy-layout.test.ts`：新增行内居中用例（同一行内两块高矮混排，断言行内居中公式）；既有网格用例中唯一受 4.9 影响的是「组成员不参与顶层排序」的同行断言（`pos("g").y === pos("a").y`，块高 300 与 120），改为按居中公式断言以保留「同行」语义；其余网格用例的同行块高度相同或高块独占一行，坐标不变；分层模式用例不受影响。
- `use-group-operations.test.ts`：补 `onNodeAction` 的四种模式分支（组尺寸与成员位置写入、非组节点忽略、成员为 0 忽略）。
- `DropdownMenu.test.tsx`：默认关闭播放退出动画；`closeAnimation={false}` 时 `data-closed` 动画类不输出。`NodeToolbar.test.tsx`：组布局菜单四项分别派发 `layout` 动作并关闭菜单（4.6.7）。

## 6. 异常与边界

| 场景 | 行为 |
| --- | --- |
| 成员尺寸未测量（`measured` 与 `style` 均缺失） | `measureNode` 兜底 200×120 |
| 成员被拖到组框外（`position` 为负或超出组框） | 读序照常，布局后归位到正区间 |
| 组框被手动缩到最小、成员探出 | 按内容重排并收缩/扩张组框 |
| 组内只有 1 个成员 | 归位到布局原点，组框收缩到最小尺寸 |
| 组内无边 | 智能布局退化为宫格（4.5.2） |
| 组内全部成员参与环 | 主图为空，尾列从 x = 0 起按读序单列（4.5.3-5） |
| 成员间双向边（A→B 且 B→A） | 视为环，进尾列 |
| 成员间重复边 | 按 `(source, target)` 去重 |
| 边端点不在本组 | 忽略 |
| 自环 | 忽略 |
| `measured` 为 0 或 NaN | 走 `measureNode` 兜底链 |
| 点在非组节点的 layout 动作 | 忽略 |

## 7. 验收标准

1. 宫格：成员按画布读序排列（点击前后视觉顺序一致）；同行成员垂直居中对齐；列宽紧凑（不出现统一最大格造成的空槽）；组框尺寸符合 4.6.3。
2. 水平 / 垂直：按读序排列，行/列内居中。
3. 智能：链式 A→B→C 输出三列左→右；菱形 A→{B,C}→D 输出正确分层；含环时环内成员不参与主图、进右侧尾列；混合孤立成员进尾列；组内无边时结果与宫格一致。
4. 组框尺寸与 `GroupNode` 的 `dynMinWidth/dynMinHeight` 恒等：布局后拖动缩放手柄不能再缩小，组框不出现滚动或裁切。
5. 一次布局只产生一条历史记录，撤销一步恢复布局前的成员位置与组框尺寸。
6. `LAYOUT_GAP` 未被组内布局修改或复用；吸附（`snapSize`）行为不受影响。
7. 画布整理宫格：同行块垂直居中对齐；等高行、独占一行的超宽块与分层 / 自动模式的输出与改动前一致（测试断言除 5.4 所述一处外不改动）；分层模式的同层上下顺序由读序决定（4.5.3、4.10.2）。
8. 类型检查、改动文件 ESLint、canvas 测试（单 worker）通过。
9. 浏览器手工走查（用户确认）：四种模式各执行一次、读序在成员乱序时成立、智能布局在真实链表上可用、整理画布宫格与组内宫格的垂直对齐一致、明暗主题与组配色下视觉正常。
10. 幂等：同一拓扑与尺寸下连续执行两次，成员坐标与组框尺寸完全一致；覆盖无连线退化为宫格、音频等不同尺寸成员、成环与孤立成员（4.5.6）。固定形状与确定性随机拓扑均有测试（5.4）。
11. 点击组布局菜单、组框尺寸发生变化时，菜单与尺寸变更同帧消失，不出现菜单跟随触发器移动的闪跳（4.6.7）。

## 8. 已确认决策与待确认事项

### 8.1 已确认

1. 2026-11-01 用户指示「写 Spec」，并要求先判断「全部改为即梦的」是否可行；本 Spec 是该判断的落地形态：能力对齐、实现不照搬（取舍见 1.4）。
2. 2026-11-01 用户决定（原话「智能布局要做，其它都按建议」）：
   - **做智能布局**（4.5）：组内按连线分层是本次的核心能力，不是可选项。
   - **列/行间距取 120 / 60**（4.8）：不采用即梦的 220 / 48——三节点链组宽 2120 vs 2320，且与本仓库画布整理的 60 不同量级。
   - **无组内连线时退化为宫格**（4.5.2）：不采用即梦的一列竖排。
   - **智能布局排在首位、不做自动选择**（4.1.3）。
   - **水平 / 垂直也改用读序**（4.4.3），三种几何模式同一排序口径。
3. 2026-11-01 用户决定「一并改」：画布整理宫格的行内对齐同步改为垂直居中（规则 4.9），与组内宫格同一口径，作为同一 Spec 的交付项与验收项。理由：同一份数据在「整理画布」与「组内宫格」下的垂直观感必须一致；保留两种口径会让后续维护反复踩同一个点。
4. 2026-11-01 用户决定：画布整理分层模式改为按读序投入 dagre（4.10.2）。理由：两处布局共用同一实现后，同一张图不能给出两种同层顺序；读序贴近视觉顺序。**2026-11-02 修订**：为修复智能布局非幂等（8.1-5），dagre 改为只求层、层内次序与坐标统一由读序给出；决策目标不变，实现路径调整。
5. 2026-11-02 用户报告两个缺陷：点击布局菜单后组尺寸变化时菜单闪烁；智能布局第一次与第二次结果不同（组内有音频成员）。按 AGENTS.md 四.1 根因修复：读序分带基准由顶边改为垂直中线（4.2.2）、`packLayered` 改为 dagre 只求层 + 读序层内堆叠（4.5.3、4.5.6）、布局菜单关闭与组框尺寸变更同步（4.6.7）。
6. 2026-11-02 用户否决「组工具栏左上角锚定」的规避方案（原话「居左是讨巧，不是根因修复」），要求菜单关闭与组框尺寸变更同步完成。最终方案：布局菜单选中项时本次关闭不播放退出动画，浮层与尺寸变更同帧卸载（4.6.7）；组工具栏恢复居中。

### 8.2 待确认

无。内容决策已全部确定（见 8.1）；用户已于 2026-11-01 明确确认，状态转为「已确认」，进入实现。

### 8.3 前端架构与实现规范

按 `web/AGENTS.md` 八（前端分层与组件边界）、九（核心领域优先保护）执行：canvas 属核心领域，实现前的影响范围见第 5 节；算法纯函数化（无 store / DOM 依赖）、共享实现唯一、常量集中、测试与类型检查覆盖。本次改动不涉及主题、动画与 Canvas 绘制，九.2 的明暗两套主题要求不适用于算法本身，但新菜单项需与既有下拉项视觉一致。

## 9. 当前状态

- 2026-11-01：草拟 Spec，状态「待确认」。尚未修改任何业务代码。
- 2026-11-01：用户确认做智能布局与其余四项决策（8.1-2）。本轮补做「同类问题是否存在于其他模块」排查（AGENTS.md 四.2）：
  - `groupMembers` 共 6 个调用点，除组内布局自身外均与顺序无关：`confirm-selection`（收集为 Set）、`drag-preview-session`（逐成员应用位置）、`group-bounds`（几何极值）、`tidy-layout`（取内容包围）、`GroupConnectRail`（连线参与集，顺序只影响建边先后、不改语义）。结论：根因是「布局把存储顺序当视觉顺序」，不在 `groupMembers`；不修改该原语，避免改变其他调用方语义。
  - `tidy-layout` 的 `packRows` 与组内宫格同为行内顶对齐 → 用户决定一并改（8.1-3、规则 4.9）。
  - `tidy-layout` 的排序口径已正确（`sortByReading` 读序 + `packRows(reading, …)`），同类排序问题只存在于组内布局。
  - `LayoutUnit.offsets` 恒为单个 `dx = 0, dy = 0` 条目，是过一般化的遗留结构；按 AGENTS.md 六.1 不做无关重构，本次只记录不改。
- 2026-11-01：用户决定画布整理宫格一并改（8.1-3）。本轮补充核查该改动的实际回归面（读测试源码确认）：
  - 行划分由 `maxRowWidth` 与 `ceil(√n)` 列数上限决定，与行内 y 无关；居中不参与折行判定，分层 / 自动模式与整体包围盒归一不受影响。
  - `tidy-layout.test.ts` 的网格用例中，同行块高度相同或高块独占一行，行内居中不改变其坐标；唯一受影响的是「组成员不参与顶层排序」用例的 `pos("g").y === pos("a").y`（组 400×300 与节点 200×120 同行），需改为按居中公式断言。
  - 吸附用例（`snapSize: 20`）的块等高，居中后坐标不变，吸附断言保持有效。
- 调查范围与证据：
  - 本仓库：`NodeToolbar.tsx`（组下拉）、`use-group-operations.ts`（三算法与提交）、`GroupNode.tsx`（最小尺寸派生）、`tidy-layout.ts`（dagre 与读序）、`group-membership.ts`、`root/CanvasSurface.tsx`（边渲染）、`connection-rules.ts`、`lib/constants.ts`、i18n 文案。
  - 即梦：`canvas-data.*.js` 模块 86158（宫格与读序）、49197（`flow` 分层与容器）、`main.*.js`（布局菜单与 i18n），并对原函数做离线复算（链、菱形、环、孤立成员、无连线）。
  - 未验证：即梦在真实画布上的运行时行为（登录墙，仅静态分析与原函数执行）；即梦组内 flow 对孤立成员的具体摆放分支未逐路径确认，本 Spec 的尾列策略为自有设计（沿用本仓库 `packWithDagre` 的 tail 策略），不以即梦为依据。
- 2026-11-01：按已确认 Spec 完成实现。状态保持「已确认」——验收项 9（浏览器手工走查）待用户确认，代码尚未提交。落地内容：
  - 新增 `shared/reading-order.ts`（读序唯一实现）与 `shared/group-layout.ts`（宫格 / 水平 / 垂直 / 智能四种模式纯函数）；`tidy-layout.ts` 改为复用读序实现。
  - `constants.ts` 新增 `GROUP_LAYOUT_GAP = 60`、`GROUP_LAYOUT_COLUMN_GAP = 120`；布局原点随算法迁入 `group-layout.ts`。
  - `use-group-operations.ts` 删除原三算法与 `measureMembers`，改为调用 `arrangeGroup(members, edges, mode)`，`mode` 缺省 `grid`。
  - `tidy-layout.ts` 的 `packRows` 改为两遍落位：先切行，再按行高做行内垂直居中（规则 4.9）。
  - 新增 `SmartLayoutIcon`、`node.smartLayout` 文案，组下拉首位为智能布局。
  - 验证：`tsc --noEmit` 通过；改动文件 ESLint 通过；canvas 相关 4 个测试文件 49 项通过。web 全量测试两轮分别出现 10 项 / 2 项 media 与 SSE 真实计时器用例抖动，单文件复跑全部通过（与已知基线抖动一致，与本改动无关）。
  - 测试新增：`reading-order.test.ts`、`group-layout.test.ts`、`tidy-layout.test.ts` 行内居中用例、`use-group-operations.test.ts` 的 `onNodeAction` 分支。
- 2026-11-01：代码审查后的根因修复（状态仍为「已确认」，验收项 9 与提交仍待处理）：
  - 新增 `shared/layered-layout.ts`（`packLayered`）：读序投入 dagre、Kahn 判环、环内与孤立节点尾列居中。`tidy-layout` 的 `packWithDagre` 与组内智能布局原本各写一遍同一套流水线，现合并为同一实现；`tidy-layout` 只保留块级边映射 `blockLinks`。规则 4.5.3-4「尾列策略与画布整理一致」由结构保证，不再靠两份代码同口径维持。
  - 有意行为差异：`tidy-layout` 分层模式投入 dagre 的节点顺序由「块数组顺序（组在前、未分组在后）」改为读序，与组内智能布局统一。dagre 对等权候选依赖插入次序，故同层等权节点的相对次序可能变化；拓扑层、链路位置与整体包围不变，`tidy-layout` 既有用例全部通过。
  - `arrangeGroup` 的模式缺省收敛到算法内部（`mode: GroupLayoutMode = "grid"`），hook 不再自带 `?? "grid"`；模式分发改为 `Record<GroupLayoutMode, 排列函数>`，删除可空的查表回退。
  - 删除 `use-group-operations.ts` 中无归属的重复章节头（死代码）。
  - 测试补强：宫格列宽紧凑（不等宽成员，覆盖规则 4.3.2 与验收 1）、尾列垂直居中（主图更高时偏移非零，覆盖 4.5.3-4）、hook 用例改由种子节点推导尺寸与边界，不再硬编码。
  - 验证：`tsc --noEmit` 通过；改动文件 ESLint 通过；`src/__tests__/features/canvas` 93 文件 / 859 项全部通过。
  - 既有问题跟进：`measureNode` / `Size` 已迁至 `shared/node-size.ts`，布局模块不再承担通用测量；新增 `SmartLayoutIcon` 按图标契约接受标准 SVG 属性（`SVGProps<SVGSVGElement>`），既有 120 个图标仍为旧签名，未在本次批量迁移。
- 2026-11-01：第二轮代码审查后的根因修复（状态仍为「已确认」，验收项 9 与提交仍待处理）：
  - Spec 回写：4.10 记录画布整理分层模式与组内智能布局共用 `packLayered`，以及用户确认的读序插入顺序（8.1-4）；同步修订 3.1 / 3.2 / 4.5.1 / 4.5.3-4 / 4.9.2 / 验收 7，消除「分层模式输出不变」与实现的自相矛盾。
  - 消除重复：`MemberBox` 与 `LayeredItem` 合并为 `LayoutBox`；`blockLinks` 与 `intraGroupLinks` 的「端点映射 + 自环 / 悬空过滤」收敛为 `layered-layout.collectLinks`。
  - `measureNode` / `Size` 迁出 `tidy-layout.ts` 到 `shared/node-size.ts`，`canvas-derived` / `group-bounds` / `marquee-geometry` / `use-group-operations` / `group-layout` 同步改引用；节点测量不再经由布局模块。
  - `SmartLayoutIcon` 改为接受 `SVGProps<SVGSVGElement>`（图标契约「新增图标应支持标准 SVG 属性」）。
  - `finalize` 更名为 `toGroupLayout`（说明它产出的是组内布局结果，而不是泛化的「收尾」）。
  - 测试补强：环内成员与主图并存时整列排在主图右侧（4.5.3-3/4、验收 3）。
  - 未采纳（评估后维持现状）：`arrangeGrid` 与 `packRows` 的行内居中各自内联——Spec 4.9.4 已明确不为此新增公共函数；`arrangeHorizontal` / `arrangeVertical` 保持转置对称实现，抽轴参数会降低可读性。
  - 未处理：`dispatchNodeAction` 的 detail 仍是 `Record<string, unknown>`，非法 `mode` 会在查表时报错（旧实现会静默退回宫格）；根因是把动作通道做成判别联合，属独立改造，不在本次范围。
- 2026-11-02：用户报告两个缺陷（布局菜单闪烁、智能布局非幂等），根因修复（状态仍为「已确认」，验收 9（浏览器走查）与提交仍待处理）：
  - **非幂等根因（已验证）**：`packLayered` 先把读序喂给 dagre，再直接采用 dagre 的层内次序与坐标；dagre 的层内次序不保证与投喂次序一致，布局结果再次读序会得到不同顺序，同层支路在两次执行间来回翻转（固定随机种子 269 复现周期 2 振荡；300 组随机拓扑中大量失败）。另有一处同类问题：无连线时智能布局退化为宫格，宫格行内垂直居中会把矮成员下移超过按顶边计算的带高，下一次读序把它判成另一行，宫格 / 水平布局同样换位（修复前 300 组随机拓扑中 5 组失败，全部是 `edges = 0` 的宫格退化）。
  - **非幂等修复**：`packLayered` 改为 dagre 只求 rank；层内按读序自上而下堆叠，同列 x 相同，各列相对最高列垂直居中；dagre 插入顺序固定为入参数组顺序（规则 4.5.3、4.5.6、4.10.2）。`sortBoxesByReading` 分带基准由顶边改为垂直中线，与各模式的跨轴居中同基准（规则 4.2.2）。
  - **菜单闪烁根因（代码路径已验证，浏览器未复验）**：布局在 `onSelect` 中同步改变组框宽高，组工具栏（下拉触发器）随之横移 `Δw / 2`；Radix 下拉内容 portal 到 body 且带 100ms 退出动画，动画期间浮层仍然存活，floating-ui 在触发器移动后重新定位，表现为「组框先变、菜单再滑走」的闪跳。初版曾把组工具栏改为 `align="start"` 规避，用户指出属取巧、要求同步关闭，已回退为居中。最终修复：`DropdownMenuContent` 新增 `closeAnimation`（4.6.7）；布局菜单选中项时本次关闭不播放退出动画，Radix `Presence` 检测不到退出动画，在同一提交内卸载浮层，与组框尺寸变更同帧消失。
  - 测试：新增 `layout-idempotence.test.ts`（固定形状 + 300 组随机拓扑 × 四模式 × 连续三次一致）；`reading-order.test.ts` 补中线分带用例；`DropdownMenu.test.tsx` 覆盖 `closeAnimation` 的默认 / 禁用类输出；`NodeToolbar.test.tsx` 覆盖四项布局动作派发与菜单关闭。修复前随机拓扑 300 组 × 四模式有 5 组失败，修复后 0 组；canvas 套件 94 文件 / 870 项、`DropdownMenu.test.tsx` 13 项、`NodeToolbar.test.tsx` 11 项全部通过；`tsc --noEmit` 与改动文件 ESLint 通过。
  - 待用户走查：验收 11（菜单与组框尺寸变更同帧消失、无闪跳）与布局菜单关闭观感；验收 9 的其余项。
- 2026-11-02：用户确认验收完成（含浏览器走查），状态更新为「已实现」。实现代码随 `17cd1e08` 提交（仅本地，未推送）。
- 2026-11-03：组框矩形口径收敛，已提交 `247d6515`。`group-bounds.ts` 新增 `groupRectFromContent`：成员内容并集 → 组框矩形，body 左右/底部内缩 `GROUP_NODE_PADDING`、顶部内缩 `GROUP_BODY_TOP_INSET`（标题带 + body 内边距）；编组创建（`use-group-operations`）与组内布局（`group-layout`）改为共用此函数，`group-layout` 删除本地 `LAYOUT_ORIGIN` 与重复的宽高计算。行为不变（`GROUP_BODY_TOP_INSET = NODE_TITLE_HEIGHT + GROUP_NODE_PADDING`，与原 `(40, 68)` 口径一致）；`computeFittedGroupRect` 的顶部扩张同步改用同一常量。单测 `group-layout.test.ts`、`layout-idempotence.test.ts`、`use-group-operations.test.ts` 通过。
- 2026-11-08 引用校正（仅文档）：根组件拆分后，边渲染归属为 `root/CanvasSurface.tsx`（`edges={edges}`）；1.1-6 与调查范围中的 `InfiniteCanvas.tsx` 已同步。状态保持「已实现」。
