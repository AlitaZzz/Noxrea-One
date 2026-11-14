# 画布多选布局（智能 / 宫格 / 水平 / 垂直）

状态：已实现（2026-11-15）

> 本 Spec 是 `specs/canvas-multi-selection-toolbar.md` 的 Phase 2 子 Spec，定义选区级布局。
> 组内布局仍由 `specs/canvas-group-layout.md` 定义；本 Spec 不复制其算法规则，只引用。
> 2026-11-14 已确认；2026-11-15 实现、自动化验证与自动化浏览器走查完成，用户人工走查确认；已提交（6c9144f0），未推送。

## 1. 背景与证据

### 1.1 需求来源

1. 父 Spec `specs/canvas-multi-selection-toolbar.md` 10.1「Phase 2：多选布局」将 Phase 2 归属为本 Spec；本 Spec 将其落成可实现的业务规则、技术影响与验收标准。
2. 2026-11-02 用户已确认的 Phase 2 方向见 8.1；本 Spec 在此基础上细化。
3. 即梦画布的多选工具条已观察到「布局」入口（父 Spec 1.2），但未点击，四种模式的运行时行为未验证。本 Spec 对齐能力，不照搬未验证的行为。

### 1.2 现状（已验证事实，读源码确认）

1. **组内布局算法只服务组内相对坐标**：`web/src/features/canvas/shared/group-layout.ts` 的 `GroupLayoutMode` 与 `arrangeGroup` 以成员 `position`（组内相对坐标）为输入，输出成员相对坐标与组框尺寸；`arrangeGrid` / `arrangeHorizontal` / `arrangeVertical` / `arrangeSmart` 目前是模块私有函数，`toGroupLayout` 把结果归一化到组框原点并绑定组最小尺寸。不能直接用于任意选中节点。
2. **分层核心与坐标空间无关**：`shared/layered-layout.ts` 的 `packLayered` 接受任意坐标空间的 `LayoutBox[]` 与布局单元依赖边，输出同空间左上角坐标；`collectLinks` 负责端点解析、自环与悬空过滤。组内智能布局与画布整理已共用这套实现（`canvas-group-layout.md` 4.10）。
3. **读序与测量已公共化**：`shared/reading-order.ts` 的 `sortBoxesByReading` 是读序唯一实现；`shared/node-size.ts` 的 `measureNode` 提供 `measured > style > 200×120` 的尺寸链。
4. **画布整理已有「组 + 成员」原子块先例**：`shared/tidy-layout.ts` 的 `collectUnits` 把组与成员作为一个 `LayoutUnit`，成员不单独产出位置；`blockLinks` 把成员端点映射到组块；结果使用世界坐标。但画布整理的宫格有 `TIDY_MAX_ROW_WIDTH` 折行，整体包围盒归一到左上角，不是中心锚定，不能直接复用为选区布局。
5. **多选工具条尚无布局入口**：`controls/SelectionToolbar.tsx` 当前只有计数、编组/解组、创建副本、更多；`SelectionChromeBounds` 只有 `count` / `hasGroup` / `bbox` / `containerBbox` / `frameVisible`，没有布局单元数。
6. **`setNodes` 不自压历史**：`stores/canvas-document-store.ts` 的 `setNodes` 只做顺序归一化；编组、解组、组内布局都是先手动 `pushHistory(takeCanvasSnapshot())`，再 `setNodes`，最后 `markDirtyImmediate()`。
7. **组模型约束**：组恒为顶层、组不嵌套组、成员恒为一层嵌套；组节点 `position` 是绝对坐标，成员 `position` 是组内相对坐标；组框包含标题带与 40px body 内边距。组节点本身不可连线（`VALID_CONNECTION_INPUTS` / `VALID_CONNECTION_OUTPUTS` 不含 group），相关边都落在成员上。
8. **选区包围盒包含被单独选中的成员**：`selectionChromeBounds.bbox` 按所有选中节点的绝对坐标与 `measureNode` 求并集；若成员与其父组同时选中，成员会被单独计入并集（并集本身不会重复计算面积，但会包含成员盒）。布局不能直接把这个 bbox 当作布局单元包围盒。

### 1.3 即梦对照与取舍

| 即梦行为 | 本 Spec 是否采用 | 说明 |
| --- | --- | --- |
| 多选工具条提供「整理」入口 | 采用能力与文案 | 本仓库聚合工具条新增「整理 ▾」；组内布局触发器仍为「布局」 |
| 四种模式（智能 / 宫格 / 水平 / 垂直） | 采用 | 与组内布局同一模式集合与语义 |
| 菜单顺序：宫格 → 智能 → 分隔 → 水平 → 垂直 | 采用 | 即梦 `batch-organize` 选项顺序；水平前有分组分隔线 |
| 组作为整体移动 | 采用（本仓库扩展） | 即梦 `ArrangeNodesRequest` 拒绝含组或成员的选区；本仓库按 4.2 把组作为原子单元，能力是超集 |
| 智能布局按连线分层 | 采用能力，算法复用本仓库实现 | 不照搬即梦的 SCC + 最长路径；沿用 `packLayered` |
| 布局后自动调整视口 | 不采用 | 即梦 `arrangeContent` 走 `incrementalReveal`；本仓库保持 8.3-1 已确认口径，以中心锚定保持位置，不 `fitView` |
| 锚点：选区包围盒左上角 | 不采用 | 即梦以 `EX(bounds)` 的 x / y 作为布局原点；本仓库按 8.2-4 使用参与单元并集中心 |
| 含生成中节点时禁用智能布局 | 不采用 | 即梦 flow 在选区含 session 节点时不可用；本仓库按 8.2-8 允许布局，只改位置 |
| 布局动画 | 不采用（2026-11-14 确认） | 组内布局也无动画；避免动画期历史与工具条锚定问题 |
| 避让选区外节点 | 不采用 | 与组内布局、画布整理一致，不做碰撞检测 |
| 自动选择布局方向 | 不采用 | 智能固定 LR；水平 / 垂直是显式模式 |
| 批量下载 / 堆叠 / 对齐分布 | 不采用 | 不在本 Spec 范围 |

### 1.4 本轮调查范围

- 已读：`group-layout.ts`、`layered-layout.ts`、`group-bounds.ts`、`reading-order.ts`、`node-size.ts`、`group-membership.ts`、`tidy-layout.ts`、`canvas-derived.ts`、`SelectionToolbar.tsx`、`canvas-edit-actions.ts`、`canvas-document-store.ts`、`use-group-operations.ts`、相关测试与 i18n。
- 已核对：父 Spec、组内布局 Spec、撤销/重做 Spec、吸附 Spec、拖动会话 Spec 的相关规则。
- 即梦静态证据（2026-11-14，本地已下载 bundle，未执行其运行时）：`canvas-core.js` 的 `arrangeSelection` 可用性检查、`ArrangeNodesRequest` / `ArrangeGroupRequest` 的校验与 `createPlan`、共享布局函数 `W` / `Y` / `H` / `yO` / `RW`、`main.js` 的 `batch-organize` 菜单定义与 `ef` 菜单项工厂、`arrangeContent` 视口策略；详见 8.4 与 10。
- 未验证：即梦布局的点击后运行时观感（仅静态代码与文案 key）；生产构建下的完整动作耗时。用户人工视觉走查已于 2026-11-15 确认（第 9 节）。
- 2026-11-15 实现、自动化验证与自动化浏览器走查完成，用户人工走查确认；性能测量见 4.8.7，走查结果见第 9 节；已提交（6c9144f0），未推送。

## 2. 目标

1. 在多选聚合工具条中提供可发现的「布局」入口，支持智能 / 宫格 / 水平 / 垂直四种模式。
2. 复用组内布局的排序、宫格、水平、垂直、分层核心，不产生第二份算法实现。
3. 组节点作为原子单元整体移动；组内成员相对坐标、组框尺寸与组内布局保持不变。
4. 智能布局只使用选区内部单元之间的连线；成员端点按所属组单元映射。
5. 布局结果以参与布局的单元包围盒中心为锚整体平移，不改变视口，一次布局一条历史记录。
6. 明确大选区的性能上限与降级策略；阈值基于实测，不预先拍数字。
7. 不改变画布数据结构、持久化格式、服务端接口或存储格式。

## 3. 范围

### 3.1 包含

- 聚合工具条新增「布局 ▾」下拉与四种模式菜单项。
- 新增选区级布局纯函数：布局单元收集、单元间连线映射、中心锚定、位置结果。
- 从组内布局抽出可复用的排列核心，组内布局改为调用同一核心，行为不变。
- 选区布局动作：读取当前选区与画布数据 → 计算 → 一次历史提交 → 写入位置。
- 聚合工具条实际可渲染时计算布局单元数，用于布局按钮可见性；该派生不进入 `SelectionChromeBounds`。
- 中英文文案复用现有 `node.*Layout`，并新增选区入口文案 `common.organize`（中文「整理」、英文「Organize」，对齐即梦）与超限提示 `common.smartLayoutLimit`（见 8.2-6、4.8.7）。
- 单元测试、选区布局幂等测试、工具条测试、动作历史测试、性能测量与浏览器走查。

### 3.2 不包含

- 组内布局本身的行为、组框尺寸、成员归属、空组清理。
- 组的创建 / 解组 / 嵌套；`parentId` 变更。
- 选区外节点的避让、碰撞检测、自动扩展选区。
- 批量下载、堆叠、对齐、分布、标签。
- 布局动画；布局的 Agent 工具入口；布局快捷键。
- 画布数据结构、数据库、服务端接口、存储格式变更。
- 改变撤销/重做的既有语义（撤销仍会清空选区）。

## 4. 业务规则

### 4.1 入口与可见性

4.1.1 聚合工具条新增「布局 ▾」。按钮在工具条中的顺序由父 Spec `canvas-multi-selection-toolbar.md` 4.8「交互与键盘」定义；本 Spec 不重复该顺序。

4.1.2 菜单四项，按即梦顺序：宫格布局、智能布局、分隔线、水平布局、垂直布局（8.4-1）。点击立即执行，不记忆上次选择，不做自动模式推断。组内布局下拉保持既有顺序，不在本增量调整。

4.1.3 仅当**布局单元数 ≥ 2** 时显示「布局」按钮；不足 2 个单元时隐藏（不是禁用）。布局单元数按 4.2 的规则去重后计算，不等于选中节点数。

4.1.4 菜单打开期间选区发生变化（节点增删、清空、编组 / 解组 / 副本导致选区替换）时关闭菜单，避免对旧选区执行动作；沿用父 Spec 4.5「更多菜单」第 4 条的策略。

4.1.5 选择任一布局项后菜单立即关闭，本次关闭不播放退出动画（`DropdownMenuContent closeAnimation={false}`）。原因与组内布局 `canvas-group-layout.md` 4.6.7 相同：布局改变选区几何，工具条（下拉触发器）会随新包围盒重排；若浮层仍在播放退出动画，portal 会跟随触发器重新定位，出现「内容先排好、菜单再滑走」的闪跳。

4.1.6 Esc 语义沿用父 Spec `canvas-multi-selection-toolbar.md` 4.8「交互与键盘」第 4 条，本 Spec 不新增 Esc 规则。

4.1.7 工具条挂载与菜单打开不自动抢焦点；菜单关闭后焦点回到触发器。布局触发器是文字 + 图标按钮，不使用 `Tooltip`（Radix Tooltip 会吞下一次 Esc，父 Spec 4.8-5 已记录）。

4.1.8 布局动作不新增键盘快捷键，也不进入右键菜单或 Agent 工具；本增量只提供工具条入口。

### 4.2 布局单元

4.2.1 **布局单元**是选区布局的最小移动单位。一次布局只写布局单元自身节点的 `position`，不写其他节点。

4.2.2 选中的组节点 = 一个布局单元。该组的全部成员随组节点整体移动；成员的 `position`（组内相对坐标）保持不变，组框 `style.width/height` 保持不变。

4.2.3 选中的非组顶层节点 = 一个布局单元。顶层指 `parentId` 为空，或 `parentId` 在节点表中不存在 / 对应的节点不是组节点（脏数据按顶层处理，与 `tidy-layout` 的 `collectUnits` 兜底一致）。

4.2.4 选中的非组节点，其父组也被选中 = 不单独成单元。它与父组属于同一个单元，按 4.2.2 随父组移动；不得重复移动，也不得把它当作独立单元参与排序。

4.2.5 选中的非组节点，其父组存在但未被选中 = 不参与布局、不移动、保持选中。原因：移动它必须修改组内相对坐标，或移动一个未被选中的组，二者都违反 8.1 第 2、6 条「组节点作为整体盒子、组内相对坐标不变、不修改组内布局」。该节点仍计入工具条的选中数量，但不计入布局单元数。

4.2.6 组节点没有成员时仍按一个单元处理（正常数据不会出现空组，`pruneEmptyGroups` 负责清理）；布局只移动组节点位置，不删除空组。

4.2.7 单元盒模型：`{ id, x, y, width, height }`，全部使用世界（绝对）坐标。组单元使用组节点自身的 `measureNode` 尺寸与绝对 `position`；顶层节点使用自身 `measureNode` 尺寸与 `position`。组单元不按成员外接再放大，也不修改组框尺寸。

4.2.8 布局单元数 = 4.2.2–4.2.5 去重后的单元数量。它只决定布局入口是否可用，不改变选区本身；布局完成后选区保持不变。

4.2.9 选中组 + 其成员、只选中同一组的多个成员、只选中不同未选中组的成员等场景，按上述规则可能得到 0 或 1 个单元；此时布局按钮隐藏，不执行任何写入。

### 4.3 模式与共享算法

4.3.1 模式联合类型统一为 `CanvasLayoutMode = "smart" | "grid" | "horizontal" | "vertical"`。现有 `GroupLayoutMode` 更名为 `CanvasLayoutMode`，同步更新所有调用方与测试，不保留旧名别名或兼容导出。

4.3.2 四种模式的语义、读序、间距、宫格列数、水平 / 垂直单行单列、智能分层与尾列策略，全部沿用 `specs/canvas-group-layout.md` 4.2「成员顺序（读序）」、4.3「宫格布局」、4.4「水平 / 垂直布局」、4.5「智能布局」与 4.8「参数常量」。本 Spec 不复制这些算法规则。

4.3.3 共享排列核心：从 `group-layout.ts` 抽出 `arrangeBoxes(boxes, links, mode)`，输入输出使用同一坐标空间（组内相对或世界），输出以排布原点为 (0,0) 的左上角坐标，未做组框归一化或中心平移。组内布局在组内相对坐标调用它，再由 `toGroupLayout` 归一化到组框；选区布局在世界坐标调用它，再由 4.5 做中心锚定。两种布局各自只负责 finalize，不各自实现一套宫格 / 水平 / 垂直 / 分层。

4.3.4 间距沿用 `canvas-group-layout.md` 4.8「参数常量」定义的 `GROUP_LAYOUT_GAP` / `GROUP_LAYOUT_COLUMN_GAP`，不新增选区专用间距常量。这样组内布局与多选布局在相同模式下视觉一致。

4.3.5 选区宫格采用 `canvas-group-layout.md` 4.3「宫格布局」的宫格语义，不采用 `tidy-layout` 的 `TIDY_MAX_ROW_WIDTH` 折行。原因：多选布局与组内布局共享同一「宫格」语义；画布整理是另一个入口，不能把两种宫格行为混在同一模式里。

4.3.6 智能布局沿用 `canvas-group-layout.md` 4.5「智能布局」的固定 LR 方向，不根据选区宽高自动换向；水平 / 垂直沿用 4.4「水平 / 垂直布局」的单行 / 单列语义；宫格按读序逐行填充沿用 4.3「宫格布局」。

4.3.7 幂等：对同一组单元、尺寸与内部边连续执行同一模式两次，单元相对排布必须一致。`arrangeBoxes` 的排列结果沿用 `canvas-group-layout.md` 4.5.6「幂等」；选区布局在排列结果上叠加中心平移，浮点加减可能使第二次执行的坐标出现 ≤ 1e-6 的尾差，因此选区布局按「相对排布一致 + 坐标差 ≤ 1e-6」验收，不要求逐位相等。尾差远小于 `movedCount` 的 0.5px 阈值，第二次执行按无操作处理，不压历史。

### 4.4 智能布局的边映射

4.4.1 建立「节点 id → 布局单元 id」映射：
- 每个布局单元的节点 id 映射到自身；
- 每个选中组单元的全部成员 id 映射到该组单元 id（无论成员是否被单独选中）；
- 其他节点（未选中节点、未选中组的成员、被 4.2.5 排除的选中成员）不进入映射。

4.4.2 8.1 第 3 条所述「智能布局只统计两端都在选中集内的连线」按**布局单元**解释：两端都能解析到单元，且不是同一个单元。成员本身是否被单独选中不影响其所属组单元的边；未选中组的成员不会被解析为任何单元。该口径已按 8.2-2 确认。

4.4.3 用 `collectLinks(edges, resolve)` 构建单元间依赖边。自环、两端映射到同一单元的边、悬空端点被过滤；平行边由 `packLayered` 的邻接集去重。

4.4.4 指向未选中节点、未选中组或选区外的边不参与分层；这些边不改变单元的相对顺序，也不把外部节点拉进布局。

4.4.5 没有任何内部单元边时，智能布局退化为宫格布局（`canvas-group-layout.md` 4.5.2）。

4.4.6 组节点本身不可连线，因此不能假设 `edge.source` / `edge.target` 是组节点；所有相关边都落在成员上，必须经过 4.4.1 的映射。

4.4.7 环内单元、孤立单元与主图的相对关系沿用 `packLayered` 的尾列策略（`canvas-group-layout.md` 4.5.3 第 5 条）。

### 4.5 中心锚定

4.5.1 布局前，计算参与布局的单元包围盒 `before`（世界坐标）：`minX = min(unit.x)`、`minY = min(unit.y)`、`maxX = max(unit.x + unit.width)`、`maxY = max(unit.y + unit.height)`；中心为 `centerX = (minX + maxX) / 2`、`centerY = (minY + maxY) / 2`。

4.5.2 排列核心产出单元新位置后，用同一组单元尺寸计算 `after` 包围盒。

4.5.3 平移量 `dx = before.centerX − after.centerX`、`dy = before.centerY − after.centerY`；把所有单元的新位置整体加上 `(dx, dy)`。

4.5.4 布局结果的单元包围盒中心与 `before` 中心重合。中心取**参与布局的单元并集**，不取完整选中集 `bbox`（可能包含被 4.2.5 排除的成员），也不取工具条锚点 `containerBbox`（它包含 40px / 68px 的视觉留白）。该口径已按 8.2-4 确认。

4.5.5 不做吸附：沿用 `canvas-snap-alignment.md` 10.5「吸附只在拖动会话激活时生效」。不对坐标取整，不改变视口，不调用 `fitView`。

4.5.6 `before` 或 `after` 为空（没有单元或排列结果为空）时不写入；单元数 < 2 时按 4.2.9 隐藏入口，不执行。

4.5.7 不避让选区外节点：布局结果可能与未选中节点重叠。与组内布局、画布整理一致，本增量不引入碰撞检测或自动扩展选区。

### 4.6 提交与历史

4.6.1 一次布局动作 = 一次 `pushHistory(takeCanvasSnapshot())` + 一次 `setNodes` + 一次 `markDirtyImmediate()`。撤销一步回到布局前。

4.6.2 只写布局单元节点的 `position`：选中组节点的 `position`、选中顶层节点的 `position`。不写成员 `position`、组框 `style.width/height`、`data`、`parentId`、`zIndex`、edges 或选区。

4.6.3 `movedCount` 按写入前后位置差（阈值 0.5px，与 `tidy-layout` 同口径）统计。`movedCount = 0` 时不压历史、不标记 dirty、返回 `false`；布局入口按无操作处理，不弹提示。

4.6.4 本增量不做布局动画：所有位置在一次 `setNodes` 中提交，不逐帧写 store。这样不会出现动画中撤销捕获插值中间态的问题，也不需要为动画期工具条锚定另定规则。动画若后续要做，必须单独定义历史、取消与锚定语义（见 8.3-6）。

4.6.5 布局是离散操作，压栈必须绕过 300ms 节流，规则见 `canvas-undo-redo-integrity.md` 业务规则 4「离散操作必定压栈 + 原子批量合并」。只有一次 `setNodes`，不需要 `withHistoryBatch`。

4.6.6 `setNodes` 会强制「组先于成员」的数组顺序；布局不依赖节点数组顺序，也不改变归属。

4.6.7 撤销/重做沿用现有快照恢复：撤销会把快照恢复为当前状态并清空全部选中（`canvas-edit-actions.ts` 的 `restoreSnapshot`），工具条随选区清空卸载。该行为是既有语义，本 Spec 不修改。

4.6.8 布局是外部 store 写入。当前工具条只在 `idle` / `box-selected` 显示，拖动、框选、连线进行中入口不可达；若未来通过其他入口在拖动会话中触发，必须按 `canvas-drag-preview-session.md` 业务规则 7「拖动期外部写入」重建拖动会话，不得直接写位置。

### 4.7 选区与交互

4.7.1 布局不改变选区：所有原选中节点（含被 4.2.5 排除的成员）保持选中；布局后工具条保留，并按新的 `selectionChromeBounds` 重新定位。

4.7.2 组内成员随组移动，成员相对坐标不变；组框宽高不变；组内布局不被触发，也不调用 `refitGroupRects`。

4.7.3 布局入口只在交互稳定态可用：框选手势中、拖动节点中、拖拽连线中工具条隐藏（父 Spec 4.1「可见性」），因此布局不可达；不需要在动作内部再判断拖动会话。

4.7.4 生成中的节点：布局只改位置，不取消、不重试、不改变生成任务绑定；沿用父 Spec 6「异常与边界」第 11 条对生成中节点的既有语义。媒体编辑面板 / 文本编辑态打开时工具条隐藏，布局同样不可达。

4.7.5 菜单打开时选区变化关闭菜单（4.1.4）；布局导致的几何变化不是选区变化，菜单已由 4.1.5 在选项选中时关闭。

4.7.6 布局按钮的可见性随 `layoutUnitCount` 变化；若选区变化使单元数降到 2 以下，按钮在下一次渲染隐藏，不保留旧的打开菜单。

### 4.8 性能与规模

4.8.1 先测量、后定阈值。实现前用合成数据测量纯布局函数在 100 / 500 / 1000 个单元下的耗时，至少覆盖：
- 宫格 / 水平 / 垂直（线性或 O(n log n)）；
- 智能布局（链、宽扇出、菱形、含环与孤立单元），以及全部单元无内部边的退化路径。

另在 129 个单元的合成选区上测量一次完整布局动作的浏览器长任务（含 `arrangeBoxes`、`setNodes` 与 React Flow 重渲染），并与同一选区的一次普通位置写入对照。129 与既有画布性能基线（`canvas-selection-chrome-scheduling.md` 的 129 节点探针）对齐，便于跨 Spec 对照，不代表阈值。测量脚本或基准测试不得进入生产代码；结果回写本 Spec。

4.8.2 设计目标：在 129 个单元、每个单元约 200×120、智能布局有内部链路的合成用例上，纯布局计算不单独构成浏览器长任务（≤50ms），且布局动作相对同一选区的一次普通位置写入不产生新的长任务回归。50ms 是长任务判定边界，不是 4.8.3 的降级阈值；降级阈值仍按 4.8.1 实测回填。该目标是待验证的验收目标，不是已测事实。

4.8.3 阈值按**布局单元数**计算，不按选中节点数（组成员不放大计数）。若 4.8.1 的测量表明智能布局在某个单元数以上会超过预算，则只对该单元数以上的智能布局降级：菜单项置灰或隐藏（按 8.2-6 的实测结果决定），宫格 / 水平 / 垂直仍可用，因为它们不使用 dagre。2026-11-14 实测回填：上限为 180 个布局单元，超过时智能菜单项置灰并显示原因文案，见 4.8.7。

4.8.4 本增量不引入 Worker、异步分片、进度提示或取消机制。若测量表明即使几何模式在极端规模下也不可接受，应另立 Spec，不在本增量内临时加异步。

4.8.5 不复用 `TIDY_MAX_ANIMATED_NODES`：它是画布整理的动画阈值，不是计算阈值；本增量没有动画，二者语义不同。实测后已新增 `SELECTION_LAYOUT_SMART_MAX_UNITS = 180` 到 `lib/constants.ts`，命名明确为选区智能布局的计算上限。

4.8.6 `layoutUnitCount` 只在聚合工具条实际可渲染（`toolbarMode.kind === "aggregate"` 且无媒体 / 文本编辑态）时由 `CanvasSurface` 计算：对 `nodes` 做 O(n) 线性遍历（建立选中组成员索引与顶层单元），不扫描全量 edges。拖动 / 框选 / 连线期间 `toolbarMode` 为 `hidden`；媒体 / 文本编辑态与 `GlobalOverlays` 的工具栏渲染条件一致地被排除；两种情况下都不执行该遍历，因此不进入拖动逐帧路径，也不增加 `selectionChromeBounds` 的派生成本。

4.8.7 实测结果（2026-11-14，实现后回填）：

**纯计算**（Node vitest，5 次中位数，合成 200×120 单元，读序网格排布；单位 ms）：

| 单元数 | 宫格 | 水平 | 垂直 | 智能·链 | 智能·宽扇出 | 智能·菱形 | 智能·环+孤立 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 100 | 0.15–0.19 | 0.11–0.14 | 0.10–0.16 | 19.4–20.0 | 14.2–14.9 | 23.0 | 0.12 |
| 129 | 0.07 | 0.11 | 0.10 | 22.4 | 17.1 | 30.6 | 0.11 |
| 160 | 0.08 | — | — | 29.7 | 22.6 | 39.9 | 0.14 |
| 180 | 0.07 | — | — | 30.6 | 24.0 | 45.6 | 0.16 |
| 190 | 0.07 | — | — | 33.1 | 26.8 | 47.1 | 0.14 |
| 200 | 0.07 | — | — | 34.3 | 26.6 | 51.5 | 0.15 |
| 250 | 0.09 | — | — | 43.3 | 37.8 | 66.2 | 0.24 |
| 300 | 0.11 | — | — | 54.3 | 45.5 | 84.0 | 0.25 |
| 500 | 0.36–0.50 | 0.30 | 0.30–0.32 | 92.8–105.8 | 86.5–94.2 | 165.2 | 0.48 |
| 1000 | 0.55 | 0.49–0.77 | 0.45 | 230.6–236.7 | 271.7–282.4 | 543.1–554.8 | 0.76–0.87 |

无内部边的智能布局退化为宫格：129 单元 0.07ms、1000 单元 0.43ms。环 + 孤立单元走尾列路径，不调用 dagre。几何模式在 1000 单元仍 < 1ms；智能的耗时主要由 dagre 决定，随单元数和边数增长。

**浏览器完整动作**（129 个文本节点 + 128 条链式边的合成项目，dev + StrictMode，预览窗格隐藏；单次采样，绝对值仅作量级对照）：

| 动作 | 结果 |
| --- | --- |
| 普通位置写入（方向键移动 129 个选中节点） | 110ms 长任务；同步派发 2.5ms |
| 宫格布局 | 178ms 长任务 |
| 智能布局 | 222ms 长任务；点击同步段 196.6ms |
| 仅打开再关闭布局菜单（Esc，不执行布局） | 75ms 长任务 |
| 已排好的选区再次智能布局（`movedCount=0`） | 同步计算 35–62ms，无长任务 |

**结论与阈值**：
- 纯计算在 129 单元最坏菱形 30.6ms、180 单元 45.6ms，满足 4.8.2 的 ≤50ms；200 单元菱形 51.5ms 首次越过边界。按 4.8.3 回填 `SELECTION_LAYOUT_SMART_MAX_UNITS = 180`，超过 180 个布局单元时仅禁用智能布局，宫格 / 水平 / 垂直仍可用。
- 129 单元的完整动作中，普通位置写入本身已是长任务（dev / StrictMode / 129 个文本节点）；布局动作相对该基线仍有约 68–112ms 增量，其中菜单关闭约占 75ms，智能纯计算约 22ms。4.8.2 的「布局动作相对普通位置写入不产生新的长任务回归」在本环境未达成；该增量不全归因于布局算法，渲染 / 菜单侧优化超出本增量范围。未据此扩大实现范围；生产构建和人工走查结果待回写。
- 探针项目通过应用内临时项目建立，测后已删除；测量脚本为临时 vitest 文件，未进入提交。

### 4.9 视觉、文案与键盘

4.9.1 触发器使用文字 + 图标按钮：`Button size="sm" variant="ghost"`，图标为 `GroupGridIcon`（与组节点工具条的「布局」触发器同源），文字为新增 key `common.organize`（中文「整理」、英文「Organize」，对齐即梦多选入口；组内布局仍用 `common.layout`）。图标 `aria-hidden`，可访问名称由文字提供；不使用 `Tooltip`（4.1.7）。

4.9.2 菜单项复用现有文案与图标，顺序按 4.1.2：
- 宫格布局：`node.gridLayout` + `GridLayoutIcon`
- 智能布局：`node.smartLayout` + `SmartLayoutIcon`
- 分隔线（`DropdownMenuSeparator`）
- 水平布局：`node.horizontalLayout` + `HorizontalLayoutIcon`
- 垂直布局：`node.verticalLayout` + `VerticalLayoutIcon`

4.9.3 图标全部从 `@/components/ui/AppIcon` 获取，使用 `currentColor`；不直接导入 lucide / SVG。颜色、边框、焦点、悬停使用现有主题 token，明暗主题均需验证。

4.9.4 Tab 顺序、Esc、焦点恢复由父 Spec 4.8「交互与键盘」定义；本 Spec 只新增一个可聚焦的「布局」按钮与四个菜单项。菜单使用现有 `DropdownMenu`，不新造浮层、Portal 或 z-index。

4.9.5 若 4.8.3 触发智能布局降级，菜单项使用标准 `disabled` 状态，并提供可访问的原因文案；具体文案与展示方式按 8.2-6 在测量后确定。已按 4.8.7 实测结果落为：`layoutUnitCount > SELECTION_LAYOUT_SMART_MAX_UNITS` 时智能菜单项 `disabled`，菜单内显示 `common.smartLayoutLimit` 的原因文案；不隐藏该项。

## 5. 技术影响

### 5.1 纯函数与模块

- 新增 `web/src/features/canvas/shared/layout-modes.ts`：
  - `export type CanvasLayoutMode = "smart" | "grid" | "horizontal" | "vertical"`；
  - `export function arrangeBoxes(boxes: LayoutBox[], links: Array<[string, string]>, mode: CanvasLayoutMode): Map<string, { x: number; y: number }>`；
  - 内部实现从 `group-layout.ts` 迁出，保留读序、紧凑游标、行内居中、智能退化宫格与 `packLayered` 调用；不依赖 React / store。
- `web/src/features/canvas/shared/group-layout.ts`：
  - 删除私有 `arrangeGrid` / `arrangeHorizontal` / `arrangeVertical` / `arrangeSmart` 与 `LAYOUT_ARRANGERS`；
  - `arrangeGroup` 改为「成员 → `LayoutBox[]` → `collectLinks` → `arrangeBoxes` → `toGroupLayout`」；
  - `GroupLayoutResult` 与 `toGroupLayout` 保持不变；行为不变。
- 新增 `web/src/features/canvas/shared/selection-layout.ts`：
  - `SelectionLayoutUnit`（`id` / `x` / `y` / `width` / `height` / `memberIds`）；
  - `collectSelectionLayoutUnits(nodes, selectedIds: ReadonlySet<string>): SelectionLayoutUnit[]`：O(n) 线性遍历建立选中组成员索引与顶层单元，避免每个组重复扫描全表；按 `nodes` 数组顺序返回，作为 `packLayered` 的稳定插入顺序；
  - `selectionLinks(units, edges): Array<[string, string]>`；
  - `computeSelectionLayout(nodes, edges, selectedIds, mode): { positions: Map<string, { x: number; y: number }>; unitCount: number; movedCount: number }`；
  - 纯函数，无 store / DOM 依赖。
- `web/src/features/canvas/shared/canvas-derived.ts`：不修改 `SelectionChromeBounds` 的字段与派生成本；布局单元数不进入该投影。
- `web/src/features/canvas/root/CanvasSurface.tsx`、`root/CanvasOverlays.tsx`、`root/overlays/GlobalOverlays.tsx`：
  - 在 `toolbarMode.kind === "aggregate"` 且无媒体 / 文本编辑态时用 `useMemo` 计算 `layoutUnitCount = collectSelectionLayoutUnits(nodes, selectedNodeIds).length`，否则为 0；
  - 通过 `CanvasOverlays` / `GlobalOverlays` 传给 `SelectionToolbarLayer`；不新增 store 字段。
- `web/src/features/canvas/shared/canvas-edit-actions.ts`：
  - 新增 `export function arrangeSelection(mode: CanvasLayoutMode): boolean`；
  - 读取当前选中节点 id、nodes、edges；调用 `computeSelectionLayout`；
  - `positions.size === 0` 或 `movedCount === 0` 返回 `false`；
  - 否则 `pushHistory(takeCanvasSnapshot())` → 一次 `setNodes` 写入单元位置 → `markDirtyImmediate()` → 返回 `true`；
  - 不调用 `setEdges`，不写 `data` / `style` / `parentId` / 选区。
- `web/src/features/canvas/controls/SelectionToolbar.tsx`：
  - 展示层 props 增加 `canLayout: boolean` 与 `onLayout: (mode: CanvasLayoutMode) => void`；
  - 在编组/解组与创建副本之间渲染「布局 ▾」`DropdownMenu`；`DropdownMenuContent` 使用 `closeAnimation={false}`；菜单 `key={selectionKey}`，选区变化时重挂载关闭；
  - 容器层 `SelectionToolbarLayer` 接收 `layoutUnitCount`，`canLayout = layoutUnitCount >= 2`；增加 `handleLayout`，调用 `arrangeSelection(mode)`；不直接在展示层访问 store。
- `web/src/features/canvas/nodes/NodeToolbar.tsx`、`web/src/features/canvas/hooks/use-group-operations.ts`、`web/src/__tests__/features/canvas/shared/layout-idempotence.test.ts`：
  - 只把 `GroupLayoutMode` 类型引用迁移为 `CanvasLayoutMode`，行为不变；`CanvasLayoutMode` 从 `layout-modes.ts` 导入，不由 `group-layout.ts` 转发。实现时同步更新 `canvas-group-layout.md` 与 `canvas-multi-selection-toolbar.md` 中对该类型名的引用，并在 `canvas-group-layout.md` 5.1 记录排列核心迁至 `layout-modes.ts`、`arrangeGroup` 只保留 finalize 的模块划分。
- `web/src/lib/constants.ts`：
  - 不新增间距常量；多选布局直接复用现有 `GROUP_LAYOUT_GAP` / `GROUP_LAYOUT_COLUMN_GAP` 的值，本增量不做只为改名的常量迁移；
  - 按 4.8.7 实测新增 `SELECTION_LAYOUT_SMART_MAX_UNITS = 180`，不复用 `TIDY_MAX_ANIMATED_NODES`。

### 5.2 数据与持久化

- 无节点数据结构、持久化字段、数据库、服务端接口或存储格式变更。
- 布局结果只落在组节点与顶层节点的 `position`；成员相对坐标与组框尺寸不变。
- `layoutUnitCount` 是运行时派生字段，不写入画布文档，不落库。

### 5.3 性能

- `computeSelectionLayout` 只在用户点击布局时执行一次，不在拖动 / 渲染路径。
- 复杂度与组内布局一致：读序 O(n log n)，宫格 / 水平 / 垂直 O(n)，智能为 O(V+E) + dagre rank 计算。
- 大选区的真实耗时在实现前按 4.8.1 测量；阈值与降级策略在测量后回填。
- `layoutUnitCount` 只在聚合工具条实际可渲染时计算；拖动 / 框选 / 连线与编辑态不计算。

### 5.4 测试

新增或补充：

- `web/src/__tests__/features/canvas/shared/selection-layout.test.ts`：
  - 单元收集：组 + 成员、组 + 顶层节点、只选成员、成员 + 未选中父组、脏 `parentId`；
  - 单元数：2 个顶层节点 = 2；2 个组 = 2；组 + 其成员 = 1；只选同一组两个成员 = 0；成员 + 未选中父组 = 0；脏 `parentId` 按顶层 = 1；
  - 边映射：组成员边 → 组单元、跨组边、组内边、指向选区外、自环、重复边；
  - 四种模式：宫格 / 水平 / 垂直 / 智能；无内部边退化为宫格；
  - 中心锚定：布局前后单元包围盒中心一致；
  - `movedCount`：已排好的选区再次执行返回 0；
  - 幂等：同一输入连续执行两次相对排布一致、坐标差 ≤ 1e-6。
- `web/src/__tests__/features/canvas/shared/layout-idempotence.test.ts`：
  - 现有组内布局用例保持通过；
  - 新增选区布局的固定形状与随机拓扑幂等用例（如果测试结构允许，抽公共断言）。
- `web/src/__tests__/features/canvas/shared/canvas-edit-actions.test.ts`：
  - `arrangeSelection` 只写单元位置；一次历史；撤销/重做；`movedCount=0` 不压栈；选区不变；不写 `style` / `data` / edges。
- `web/src/__tests__/features/canvas/controls/SelectionToolbar.test.tsx`：
  - 现有展示层 harness 补 `canLayout` / `onLayout`；`canLayout=false` 时旧按钮顺序不变；
  - 布局按钮在 `canLayout=false` 时隐藏，`true` 时显示；
  - 菜单位置与四项顺序；
  - 选择布局项调用 `onLayout(mode)` 并关闭菜单；
  - 超过 `SELECTION_LAYOUT_SMART_MAX_UNITS` 时智能菜单项 `disabled` 且显示原因文案，点击不触发 `onLayout`；容器层同样按单元数传禁用态；
  - `closeAnimation={false}`；
  - Tab 顺序符合父 Spec 4.8-3（含新增的「布局」项）；
  - Esc 语义保持；
  - 容器层用例补 `layoutUnitCount` prop，覆盖 `< 2` 时不渲染布局按钮。
- 回归：`group-layout.test.ts`、`layout-idempotence.test.ts`、`use-group-operations.test.ts`、`tidy-layout.test.ts` 保持通过，证明抽出 `arrangeBoxes` 未改变组内布局与画布整理行为。
- 执行顺序遵循 `AGENTS.md` 五.4：lint、类型检查、测试等高内存 Node 任务串行执行；资源受限时 Vitest 使用单 worker。web 测试在 `web/` 目录下单独执行（root vitest 只跑 server）。

## 6. 异常与边界

| 场景 | 行为 |
| --- | --- |
| 只选中 1 个顶层节点 | 聚合工具条本身不出现，布局不可达 |
| 选中 2 个顶层节点 | 2 个单元，布局可用 |
| 选中 2 个组 | 2 个单元，布局可用；只改两个组节点位置，组内成员相对坐标不变 |
| 选中组 + 其成员 | 1 个单元，布局按钮隐藏；若程序化执行，成员随组移动，相对坐标不变 |
| 只选中同一组的多个成员 | 0 个单元，布局按钮隐藏；不写入 |
| 只选中不同未选中组的成员 | 0 个单元，布局按钮隐藏；不写入 |
| 选中 2 个顶层节点 + 某未选中组的成员 | 2 个单元，布局可用；被选中的成员不移动、保持选中 |
| 选中组 A + 组 B + A 的成员 | 2 个单元，布局可用；A 的成员随 A 移动，不单独参与 |
| `parentId` 指向不存在的节点或非组节点 | 按顶层节点处理，可作为单元 |
| 智能布局无内部边 | 退化为宫格 |
| 智能布局有环 / 孤立单元 | 沿用 `packLayered` 尾列策略 |
| 边端点不在布局单元映射中 | 忽略该边 |
| 自环 / 重复边 | 自环忽略；重复边由 `packLayered` 去重 |
| 布局结果与未选中节点重叠 | 允许，不做碰撞避让 |
| 布局后内容超出视口 | 不 `fitView`；参与布局的单元包围盒中心不变，用户自行平移 |
| 布局坐标未对齐网格 | 不吸附；沿用 `canvas-snap-alignment.md` 10.5 |
| 已排好的选区再次布局 | `movedCount=0`，不压历史、不标记 dirty |
| 生成中的节点被布局 | 只改位置，不取消任务 |
| 媒体编辑 / 文本编辑态 | 工具条隐藏，布局不可达 |
| 拖动 / 框选 / 连线进行中 | 工具条隐藏，布局不可达 |
| 撤销布局 | 恢复布局前位置；既有 `restoreSnapshot` 会清空选区，工具条卸载 |
| 大选区超过智能阈值 | 智能菜单项禁用或隐藏（按 8.2-6）；几何模式仍可用 |
| 组框历史脏数据、成员探出组框 | 组单元尺寸仍取组框；不修正组框，不调用 refit；可能与外部节点重叠 |

## 7. 验收标准

1. 选中 2 个顶层节点：聚合工具条出现「整理 ▾」；菜单按 宫格 / 智能 / 分隔 / 水平 / 垂直 排列；分别执行后单元位置符合 `canvas-group-layout.md` 4.3 / 4.4 / 4.5 的语义。
2. 选中 2 个组：布局可用；执行后只改变两个组节点的 `position`，所有成员 `position` 与两个组框的 `style.width/height` 不变；撤销一步恢复两个组位置。
3. 选中组 + 其成员：布局按钮隐藏；若通过程序化方式调用动作，单元数为 1，不产生任何写入。
4. 选中 2 个顶层节点 + 未选中组的成员：布局可用；两个顶层节点按布局移动，被选中的成员位置不变且保持选中。
5. 智能布局：顶层链 A→B→C 输出三列左→右；选中组的成员边映射为组单元之间的边；指向选区外的边被忽略；无内部边时结果与宫格一致。
6. 中心锚定：布局前后参与布局的单元包围盒中心一致（浮点误差 ≤ 1px）；视口不变，不 `fitView`，不吸附。
7. 历史：一次布局只产生一条可撤销记录；撤销恢复全部单元位置，重做恢复布局结果；`movedCount=0` 不产生历史。
8. 数据：布局只写单元节点的 `position`；不写成员 `position`、`style`、`data`、`parentId`、edges、选区；`setNodes` 后节点顺序仍为「组先于成员」。
9. 幂等：同一选区、同一模式连续执行两次，相对排布一致、单元坐标差 ≤ 1e-6（浮点误差），且第二次不产生历史；四种模式均覆盖。
10. 性能：按 4.8.1 记录 100 / 500 / 1000 单元的纯计算耗时与 129 单元的浏览器长任务（结果见 4.8.7：129 单元最坏 30.6ms、180 单元 45.6ms、200 单元 51.5ms）；阈值回填为 180，超过阈值的智能布局按 4.8.3 禁用并显示原因，几何模式仍可用。纯计算目标满足；4.8.2 的完整动作「相对普通位置写入不产生新的长任务回归」在本环境未达成，已作为已知限制记录。
11. 工具条：「整理」按钮在 `layoutUnitCount < 2` 时隐藏；菜单顺序为 宫格 / 智能 / 分隔 / 水平 / 垂直；选中项后立即关闭且无退出动画；Tab 顺序符合父 Spec 4.8-3（含新增的「整理」项）；Esc 第一次关菜单、第二次清空选区；布局后工具条按新包围盒重新定位。
12. 视觉与文案：中英文均使用新增 `common.organize`（整理 / Organize）与现有 `node.*Layout` 文案；图标来自 `AppIcon`；明暗主题下按钮、菜单、焦点、悬停对比度正常。
13. 回归：组内布局四种模式行为不变；画布整理行为不变；`group-layout`、`layout-idempotence`、`use-group-operations`、`tidy-layout`、`canvas-derived`、`SelectionToolbar`、`canvas-edit-actions` 相关测试通过；类型检查与变更文件 ESLint 通过。
14. 浏览器手工走查（用户确认）：真实选区下四种模式、组原子性、混合选区、撤销/重做、菜单关闭观感、明暗主题；走查结论回写“当前状态”。

## 8. 已确认事项

### 8.1 已确认（2026-11-02）

以下为 2026-11-02 已确认的 Phase 2 决策，本 Spec 作为这些决策的权威落点并细化：

1. 多选布局作为 Phase 2，入口在聚合工具条，提供智能 / 宫格 / 水平 / 垂直四种模式。
2. 组节点作为整体盒子移动；组内成员不单独参与布局；组内相对坐标保持不变。
3. 智能布局只统计两端都在选中集内的连线；指向选区外的边不参与。
4. 布局结果以选区包围盒中心为锚点整体平移；一次布局一条历史记录。
（上述方向的最终细化口径见 8.2 已确认项。）
5. 大选区性能阈值基于实测确定，不预先拍数字。
6. 多选布局不修改组框内部布局；组内布局仍走组节点工具条。

### 8.2 已确认（2026-11-14）

用户按本稿建议确认，并补充「尽量靠齐即梦」。以下为最终口径：

1. **混合选区中的“孤立成员”**：采用 4.2.5。选中成员但其父组未被选中时，不移动、保持选中、不计入布局单元；布局按钮按单元数 < 2 隐藏。不选择「存在孤立成员就隐藏整个入口」的备选。
2. **智能布局的“选中集”口径**：采用 4.4.2 的布局单元口径。选中组的全部成员都映射到该组单元，无论成员是否被单独选中；未选中组的成员不映射。
3. **组单元尺寸**：采用 4.2.7。取组节点自身 `measureNode` 尺寸，不按成员外接再放大，不修改组框；历史脏数据中成员探出组框时仍以组框为准。
4. **锚点口径**：采用 4.5.4。取参与布局的单元并集中心，不取完整选中集 `bbox`，也不取工具条 `containerBbox`。
5. **动画与性能降级**：采用 4.6.4、4.8.3。本增量不做布局动画，单次提交；大选区只对智能布局按实测阈值降级，宫格 / 水平 / 垂直始终可用。
6. **性能阈值与降级 UI**：接受「先测量、后回填」。阈值确认前不实现智能布局的超限分支；测量后若需要降级，再按实测阈值确定菜单项置灰或隐藏及原因文案。2026-11-14 实测后采用：阈值 180 个布局单元（4.8.7）；超过时智能菜单项置灰并在菜单内显示 `common.smartLayoutLimit` 原因文案，不隐藏该项。
7. **按钮位置**：采用编组/解组之后、创建副本之前；与父 Spec 4.8-3 一致。
8. **生成中节点**：允许布局。只改位置，不取消、不重试、不改变生成任务绑定。

### 8.3 其他已确认默认

1. 布局不做吸附、不取整、不 `fitView`、不改变视口（4.5.5）。
2. 布局不避让选区外节点，允许重叠（4.5.7）。
3. 布局不新增快捷键、右键菜单项或 Agent 工具入口（4.1.8）。
4. 布局完成后保持选区不变（4.7.1）。
5. 布局菜单项复用 `node.*Layout` 文案与现有图标，不新增 i18n（性能降级提示除外）。
6. 布局动作不做动画；若后续要做，另立增量（4.6.4）。

### 8.4 即梦对齐（2026-11-14 补充静态调查）

以下为从本地已下载即梦 bundle 静态还原的已验证事实（未执行其运行时）：

1. **入口与菜单**：多选工具条（selection context toolbar）有一个 `batch-organize` 菜单，多选时触发器文案 key 为 `octo_canvas_selection_context_toolbar_organize_label`（英文 fallback「Organize」，中文按「整理」）；单选一个组时同一入口文案 key 为 `..._layout_label`（「Layout」/「布局」）。菜单选项按 `grid` → `flow` → `horizontal`（带 `startsSection` 分隔）→ `vertical` 排列。本增量采用：多选入口用「整理」，菜单按宫格 → 智能 → 分隔 → 水平 → 垂直。
2. **选区资格**：`ArrangeNodesRequest.check` 要求 `nodeIds.length >= 2`、无重复、每个目标 `parentId === undefined` 且类型不是 `group` / `stack`；工具条 `arrangeSelection.getState` 对含组选区返回 `selectionContainsGroup`，对成员返回 `unsupportedSelection`。即梦多选布局只排顶层非组节点；含组或成员的选区不提供该动作。
3. **锚点**：`ArrangeNodesRequest.createPlan` 用选中节点包围盒 `EX(bounds)` 的 `x / y` 作为布局原点，`W(graph, boxes, bounds.x, bounds.y, mode, true)` 输出的位置以旧包围盒左上角为锚，不是中心。
4. **模式与降级**：模式集合为 `grid / flow / horizontal / vertical`；`flow` 在选区含 session（生成中）节点时不可用（`unsupportedSelection`），其余模式可用。默认参数为 `grid`。
5. **组布局**：`ArrangeGroupRequest` 只接受根级组、至少 2 个直接成员、成员不能是组 / stack、storyboard 组不可排；`flow` 按成员 `layout.zIndex` 再按 id 排序，其他模式按读序；宫格 / 水平 / 垂直的容器内边距为 80（container = 内容 + 160），flow 为 56（container = 内容 + 112）。这与本仓库 `canvas-group-layout.md` 的组框模型不同，本增量不改组布局。
6. **分层面板**：`flow` 的孤立节点在 `flag=true`（`ArrangeNodes`）时先按宫格排到主图左侧，`ArrangeGroup` 使用 `flag=false` 的尾列策略；本仓库统一使用 `packLayered` 尾列，不区分入口。
7. **视口**：布局执行成功后调用 `viewport.begin({scenario:"arrangeContent"})` → `present({kind:"nodes"})`，策略为 `geometry:"incrementalReveal", motion:"auto"`，即按需把新内容柔和带入视口；失败时 `cancel()`。
8. **历史**：`ArrangeNodesRequest` 是一笔 `canUndoRedo: true` 的本地变更，只为位置确实变化的节点生成 move transition；`NodeLocation` 相等时不出现在 plan 中。

与本 Spec 已确认口径的关系：

- **采用**：入口文案（多选「整理」）、菜单顺序与分隔线、四项模式集合、智能按内部连线分层、一次历史、选区不变。
- **保持本 Spec 已确认口径，不采用即梦**：组 / 成员作为布局单元（4.2，能力超集）、中心锚定（8.2-4）、不改变视口（8.3-1）、生成中节点允许布局（8.2-8）、共享 `packLayered` 尾列与组布局间距（4.3）。
- 理由：上述五项均由用户在 2026-11-14 明确确认；即梦行为作为对齐参考，不覆盖已确认决策。若后续要改为即梦口径，需先更新本 Spec 并重新确认。

## 9. 当前状态

- 2026-11-14：起草本 Spec 并完成只读调查；用户确认 8.2 全部建议并补充「尽量靠齐即梦」，状态更新为「已确认」。随后完成即梦 bundle 静态对齐调查（8.4）：多选入口文案改为「整理」、菜单顺序改为即梦顺序；其余冲突项保持已确认口径。
- 2026-11-15：实现完成。新增 `layout-modes.ts`、`selection-layout.ts`、`arrangeSelection`、`layoutUnitCount`、工具条「整理」入口、`SELECTION_LAYOUT_SMART_MAX_UNITS = 180` 与超限禁用 / 原因文案；组内布局改为复用 `arrangeBoxes`，行为不变；补充选区布局、工具条、动作历史与幂等测试。相关测试、类型检查与变更文件 ESLint 通过。
- 已验证（2026-11-15）：纯计算 100 / 129 / 500 / 1000 单元与智能多拓扑的耗时；129 单元浏览器完整动作长任务（dev + StrictMode，合成探针项目，测后已删除）。结果与限制见 4.8.7。已提交（6c9144f0），未推送。
- 2026-11-15 浏览器走查（自动化，临时项目已删除）：临时项目含 2 个组（600×400 / 400×300，各含成员）+ 3 个顶层文本节点，8 个节点全选（5 个布局单元），经「整理」菜单依次执行宫格 / 水平 / 垂直 / 智能：
  - 四种模式的单元位置符合读序 / 分层语义；布局前后单元并集中心恒为 (1379, 865)，视口未改变；
  - 两个组框尺寸与全部成员相对坐标（60,80 / 320,80 / 60,80）在四种模式下不变，仅组节点与顶层节点位置变化，选中数保持 8；
  - 撤销恢复上一模式位置，重做恢复布局结果；撤销后选中数变为 0，属既有 `restoreSnapshot` 清空选区行为（第 6 节表格），非本次回归；
  - 菜单顺序为 宫格布局 / 智能布局 / 分隔线 / 水平布局 / 垂直布局；点击后菜单在 8.4ms 内从 DOM 移除（MutationObserver 实测，`closeAnimation={false}`，无退出动画）；
  - 仅选中 1 个顶层节点时「整理」不渲染；8 节点全选时渲染；
  - 明暗主题下菜单计算色分别为近黑底 / 近白字与白底 / 近黑字；主题通过切换根元素主题类模拟，未做视觉截图。
- 走查限制：Browser 面板 `document.visibilityState === 'hidden'`，无法评估悬停 / 焦点观感、菜单关闭的视觉顺滑度与截图；隐藏页下合成 Shift 多选未激活 React Flow 的 `multiSelectionActive`，2 单元混合选区的浏览器路径改由单元 / 组件测试覆盖；超过 180 单元的智能菜单禁用态由组件测试覆盖，未在浏览器构造大选区。上述视觉与真实交互项已由用户人工走查覆盖。临时项目 `LayoutWalkthrough` 已删除，项目列表恢复为原有 7 个。
- 2026-11-15 用户人工走查确认：四种模式、组原子性、混合选区、撤销/重做、菜单关闭观感、明暗主题均无问题。验收标准 14 的人工确认项完成。
- 未验证：生产构建下的完整动作耗时。4.8.2 的「完整动作相对普通位置写入不产生新的长任务回归」在本环境未达成，已记录为已知限制，未扩大实现范围。
- 2026-11-15：实现代码已提交（6c9144f0），用户人工走查确认无问题；状态更新为「已实现」。未推送。

## 10. 调查证据（文件与规则）

- 组内布局：`web/src/features/canvas/shared/group-layout.ts`（`GroupLayoutMode`、`arrangeGroup`、私有排列函数、`toGroupLayout`）；`web/src/features/canvas/shared/layered-layout.ts`（`LayoutBox`、`collectLinks`、`packLayered`）；`web/src/features/canvas/shared/reading-order.ts`；`web/src/features/canvas/shared/node-size.ts`。
- 组模型与坐标：`web/src/features/canvas/shared/group-membership.ts`；`web/src/features/canvas/shared/group-bounds.ts`；`web/src/features/canvas/types.ts`。
- 画布整理：`web/src/features/canvas/shared/tidy-layout.ts`（`LayoutUnit`、`collectUnits`、`blockLinks`、`packRows`）。
- 选区与工具条：`web/src/features/canvas/shared/canvas-derived.ts`；`web/src/features/canvas/controls/SelectionToolbar.tsx`；`web/src/features/canvas/root/CanvasSurface.tsx`；`web/src/features/canvas/root/overlays/GlobalOverlays.tsx`。
- 动作与历史：`web/src/features/canvas/shared/canvas-edit-actions.ts`；`web/src/features/canvas/stores/canvas-document-store.ts`；`web/src/features/canvas/hooks/use-group-operations.ts`；`web/src/features/canvas/nodes/NodeToolbar.tsx`。
- 规则来源：`specs/canvas-multi-selection-toolbar.md`（4.1 可见性、4.5 更多菜单、4.8 交互与键盘、4.9 历史与状态、10.1 Phase 2）；`specs/canvas-group-layout.md`（4.2 读序、4.3 宫格、4.4 水平/垂直、4.5 智能、4.5.6 幂等、4.6 组框、4.8 常量、4.10 共用实现）；`specs/canvas-undo-redo-integrity.md` 业务规则 4「离散操作必定压栈 + 原子批量合并」；`specs/canvas-snap-alignment.md` 10.5「吸附只在拖动会话激活时生效」；`specs/canvas-drag-preview-session.md` 业务规则 7「拖动期外部写入」。
- 测试证据：`web/src/__tests__/features/canvas/shared/group-layout.test.ts`、`layout-idempotence.test.ts`、`tidy-layout.test.ts`、`group-bounds.test.ts`、`reading-order.test.ts`、`use-group-operations.test.ts`、`canvas-edit-actions.test.ts`、`SelectionToolbar.test.tsx`、`canvas-derived.test.ts`。
- 即梦静态证据：`.claude/jimeng-chunks/canvas-core.js`（`arrangeSelection` 可用性、`ArrangeNodesRequest` / `ArrangeGroupRequest`、`W` / `Y` / `H` / `yO` / `RW`、`arrangeContent` 策略）、`.claude/jimeng-chunks/canvas-data.js`（`ArrangeNodesRequest.check` / `createPlan`、`ArrangeGroupRequest`、`EX` 包围盒、`iv` 组 / stack 排除）、`.claude/jimeng-chunks/main.js`（`batch-organize` 选项、`ef` 工厂、`organize_label` / `layout_label` 文案 key）。未执行即梦运行时。
- 未覆盖：即梦布局点击后的运行时观感；真实浏览器中的工具条重排与菜单关闭观感；性能阈值。
