# 焦点还原的模态一致性（焦点环与 Tooltip）

状态：已实现

## 目标

浮层（`DropdownMenu` / `Popover`）经指针交互关闭、Radix 把焦点脚本还原到触发器后：

1. 触发器**不显示**焦点环；
2. 触发器上的 **Tooltip 不因焦点还原而打开**。

键盘路径两者保持浏览器默认（焦点环显示、Tooltip 随焦点打开）。彻底消除"刷新后首次操作与 SPA 操作表现不一致"的问题——此前刷新后会出现焦点环和 Tooltip，SPA 进入或点击过其他控件后则不出现。

## 背景（调查结论）

- Radix 在浮层卸载时通过脚本把焦点还原到触发器（焦点始终在按钮上，按 Enter 可再次打开菜单，行为本身正确）。
- 浏览器对"脚本焦点是否命中 `:focus-visible`"采用**文档级输入模态启发式**（键盘 / 鼠标），该模态只在 pointerdown **实际移动焦点**时才切到鼠标：
  - 全新文档（刷新后首次操作）：模态停在初始的键盘判定 → 焦点环显示、Tooltip 打开；
  - SPA 长生命周期文档中发生过真实焦点转移的鼠标点击（如点击项目卡片链接）：模态已是鼠标 → 焦点环不显示、Tooltip 不打开。
  - 额外放大因素：Radix 菜单触发器对 `pointerdown` 调用 `preventDefault()`（阻止焦点转移），菜单项又被 Radix 用脚本聚焦——整条"打开 → 选择"流程都不会翻转浏览器模态，所以"刷新后操作菜单"必然落在键盘误判里。
- 受影响的 UI 决策共两处，根因相同：
  1. `Button` 的 `focus-visible:` 样式（焦点环）；
  2. `TooltipTrigger` 的 onFocus 守卫（`web/src/components/ui/tooltip.tsx`，原实现用 `matches(":focus-visible")` 判定是否阻止 Tooltip 打开）。

## 范围

- `web/src/lib/focus-ring.ts`（新增）：应用侧输入模态追踪（键盘 / 指针）、浮层触发器锚点登记、焦点环抑制标记。
- `web/src/components/ui/dropdown-menu.tsx`：`DropdownMenuContent` 在 ref 回调登记锚点、`onCloseAutoFocus` 触发焦点环抑制判定。
- `web/src/components/ui/popover.tsx`：`PopoverContent` 同上，保证两种浮层行为一致。
- `web/src/components/ui/tooltip.tsx`：`TooltipTrigger` 的焦点打开守卫改用应用侧模态。
- `web/src/styles/globals.css`：`[data-focus-ring-suppressed]:focus-visible` 焦点环抑制规则。
- `web/src/__tests__/lib/focus-ring.test.ts`、`web/src/__tests__/components/Tooltip.test.tsx`、`web/src/__tests__/features/canvas/nodes/NodeToolbar.test.tsx`：回归测试。
- 不改动：触发器的焦点还原行为（Radix 默认）、`Button` 等组件的 `focus-visible:` 样式本身、hover 打开 Tooltip 的路径、各业务组件的菜单 / Tooltip 用法（零变化）。

## 业务规则

1. **指针关闭浮层**：焦点还原到触发按钮后，不显示焦点环、不打开 Tooltip。触发按钮保持焦点（Enter 可再次打开菜单）。
2. **键盘操作浮层**：焦点还原后焦点环显示、Tooltip 随焦点打开（浏览器默认，键盘可达性不回退）。
3. **Tooltip 悬停打开不受影响**：指针悬停（pointermove）打开 Tooltip 的主路径与模态无关，保持现状。
4. **抑制是瞬态的**：焦点环抑制标记在下一次任意输入（pointerdown / keydown）或触发按钮失焦时自动清除。
5. **单一判定源**：焦点环与 Tooltip 的模态判定统一来自 `lib/focus-ring.ts` 的应用侧追踪，任何 UI 决策不得再依赖浏览器 `:focus-visible` 启发式做模态判断。

## 技术影响

- **模态追踪**（`focus-ring.ts`）：模块加载时即安装 window 捕获阶段监听（`keydown` → keyboard，`pointerdown` → pointer），初始值 keyboard（与浏览器对全新文档的启发式一致）。不能懒安装——首次判断发生在浮层关闭时，此前所有 pointerdown 会丢失。pointerdown 即使被 `preventDefault()` 也会派发，因此追踪不受 Radix 阻止默认行为的影响（这正是它能修正浏览器误判的原因）。
- **锚点登记**：浮层内容元素 → 触发器元素的 WeakMap。两者只在浮层打开期间存在 aria 关联（触发器 `aria-controls` / 内容 `aria-labelledby`），因此必须在 ref 回调（attach）时登记。**禁止放在挂载 effect**——Radix Portal 首帧返回 null，内容在下一轮 commit 才挂载，effect 会跑在 ref attach 之前拿到 null。**禁止在 ref detach 时注销**——Radix 的 `onCloseAutoFocus` 在卸载后的 `setTimeout(0)` 才触发，注销会抢在抑制判定之前；WeakMap 随元素 GC 自动清理。
- **焦点环抑制标记**：指针模态下关闭浮层时，给触发器设置 `data-focus-ring-suppressed`，并通过 `AbortController` 一次性安装清理监听（触发器 `focusout`、window `pointerdown` / `keydown` 捕获）；任一触发即移除标记。CSS 规则（非 layered，优先级高于 Tailwind utilities）抑制 `focus-visible` 下的 border / ring / outline。
- **Tooltip 守卫**：`TooltipTrigger` 的 onFocus 中，指针模态下 `preventDefault()`（Radix 内部 `composeEventHandlers` 因 defaultPrevented 跳过 `onOpen`）；键盘模态不拦截。
- **UI 层接线**：两个共享封装的 `onCloseAutoFocus` 保持既有 `restoreFocus` 语义不变，仅在 `restoreFocus=true`（不拦截 Radix 还焦）时追加焦点环抑制判定。焦点仲裁 handler（`onOpenAutoFocus` / `onCloseAutoFocus`）置于 props 展开之后，运行时不可被业务方绕过——调用方只能通过 `focusOnOpen` / `restoreFocus` 表达意图。

## 异常与边界

- 键盘全路径可用：Tab 到触发器 → Enter 打开 → 方向键导航 → Enter 选中 → 焦点回触发器，焦点环显示、Tooltip 打开。
- 触发器 ref 未登记（如未来新的浮层类型未接线）时，抑制静默跳过，不报错、不改变焦点行为。
- 点击浮层外部关闭：dropdown 在外部点击路径 Radix 不回焦触发器，抑制标记即使被设置也无焦点可作用，下一次输入自动清除；popover 会回焦触发器，由模态判定统一处理。
- "打开 → 选中 → 再打开"循环：模态追踪与标记清理保证每次关闭独立判定。
- jsdom 不实现 `:focus-visible` 启发式，也无法模拟浏览器模态；工具层（模态追踪 / 锚点登记 / 标记生命周期）与 Tooltip 守卫以单测锁定（用真实 keydown / pointerdown 事件驱动模态），可见性由浏览器实测验证。

## 验收标准

- 刷新画布页后鼠标打开缩放菜单并选择菜单项：焦点在触发按钮、无焦点环、Tooltip 不因焦点打开。
- 从项目列表 SPA 进入画布后执行同样操作：与刷新场景表现一致。
- 键盘打开并选择菜单项：焦点回触发按钮，焦点环显示、Tooltip 打开。
- 指针流后脚本聚焦任意 `TooltipTrigger`（等效于焦点还原的 Tooltip 判定）：Tooltip 不打开；键盘事件后再聚焦：Tooltip 打开。
- 抑制显示后点击画布任意位置或按 Tab：标记清除，后续交互不受影响。
- 以上场景通过 `document.activeElement`、`matches(":focus-visible")`、`data-focus-ring-suppressed`、computed `box-shadow`、`role="tooltip"` 存在性断言验证（已实测通过）。

## 已确认决策

- 2026-10-11 用户确认：模态判定暂不推广到 Radix 之外的其他焦点还原场景（如 `tree-select`、`AlertDialog`），当前覆盖共享 `DropdownMenuContent` / `PopoverContent` / `TooltipTrigger`；未来出现同类问题再单独评估。

## 当前状态

- 已按上述设计实现并通过测试与浏览器实测（刷新 / SPA / 键盘三场景 × 焦点环 / Tooltip 两决策点）；2026-10-11 用户已确认。
- 2026-10-26 用户验收确认，状态更新为「已实现」；实现代码已提交入库（`38a35028`）。
