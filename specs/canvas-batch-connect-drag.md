# 画布批量连线拖拽会话（Batch Connect Drag）

状态：已实现（主体代码随 `ce08456f` 提交、窗口失焦修复随 `8a8eb1fb` 提交、测试补齐随 `d813a1d0` 提交；2026-11-14 用户指示将本 Spec 收口为「已实现」）

## 目标

1. 为 `BatchConnectHandle`（框选外框右缘）与 `GroupConnectRail`（组节点左右缘）
   提供同一套批量连线拖拽语义，避免两处各写一套指针会话。
2. 单击、右键/中键、多指误触不进入 connecting，不触发组表面降透明
   （`[data-connecting]`）。
3. 指针序列异常收尾（失键、非左键 pointerup、pointercancel、窗口失焦）按取消处理，
   不误建边、不误弹创建菜单。
4. 松手建边/弹菜单与拖动中的目标反馈使用同一候选对口径。

## 范围

包含：

- `web/src/features/canvas/controls/use-batch-connect-drag.ts` 的指针会话与提交规则。
- 两个消费者的接线口径：`BatchConnectHandle` 与 `GroupConnectRail` 不复制规则。

不包含：

- 连接轨道/圆点的视觉与显隐（由 `BatchConnectHandle` / `GroupConnectRail` 组件与
  `globals.css` 负责，不属于本 Spec）。
- 单节点 Handle 的连线交互。
- 建边去重、历史记录与 store 写入（由父级 `onConnect` 完成）。
- 空白处创建节点菜单的内容与后续上传语义。
- 组表面拖线降透明的视觉规则（见 `canvas-multi-selection-toolbar.md` 规则 4.10.10
  「组表面与拖线态」）。

## 业务规则

### 1. 起手

1. 只接受主指针（`isPrimary`）且 `button === 0`（左键/主触点）。
2. 接受后调用 `stopPropagation()` 与 `preventDefault()`；被拒绝的指针不拦截默认
   行为，也不启动拖拽。
3. 已有拖拽进行中时忽略第二个 `pointerdown`（重入保护），不叠加第二套 window
   监听。
4. 起手时调用 `getParticipantIds()` 冻结参与集；拖动中组成员/选区变化不改变本次
   参与集。

### 2. 指针身份

1. `dragRef` 记录起始 `pointerId`。
2. 只有同一 `pointerId` 的 `pointermove` / `pointerup` / `pointercancel` 参与本次
   会话；其他指针不驱动、不终止。
3. 始终只注册一套 window 监听；清理时按同一函数引用移除。

### 3. 阈值与 connecting

1. 误触阈值 `DRAG_START_THRESHOLD_PX = 4`；位移按屏幕坐标欧氏距离计算，恰好 4px
   视为越过。
2. 未越过阈值：不进入 connecting、不生成预览束线、不调用 `onDragStart`。
3. 越过阈值：调用一次 `onDragStart` 进入 connecting，并生成预览束线；同一会话只
   进入一次。
4. 预览束线：每个参与节点从近端边缘正中出发（输出方向 = 右缘，输入方向 = 左缘），
   汇到指针的画布坐标。

### 4. 拖动中的反馈

1. 每次越过阈值后的 move 更新预览终点，并调用 `feedbackAt`。
2. `feedbackAt` 用与松手相同的 `buildPairs` + `pairsWouldCreate` 判定命中节点是否
   可连；可连给 `ok` 倾斜，不可连给 `blocked`。
3. 未命中节点或无有效盒时清除倾斜。

### 5. 收尾

1. `pointerup` 只由起始指针触发。
2. 非左键收尾（`button !== 0`）按取消处理，不按落点建边/弹菜单。
3. 位移 `< 4px` 按取消处理（单击 Handle 不弹菜单）。
4. 位移 `>= 4px` 且尚未进入 connecting（快速甩动把位移合并进 pointerup）：先补调用
   `onDragStart`，再立即清理（`onDragEnd`），不生成预览，然后按落点提交，避免丢
   连接。
5. 提交：
   - 命中非参与节点 → 按方向构建候选对（输出 `buildFanoutPairs` / 输入
     `buildFanInPairs`）并交 `onConnect`；
   - 命中参与集内节点 → 取消，不建边、不弹菜单；
   - 未命中 → `onConnectToBlank` 携带参与集、画布坐标、屏幕坐标与方向。
6. `pointercancel` 只清理，不按落点提交。
7. 窗口失焦（`blur`）只清理，不按落点提交：失焦后浏览器可能不再派发 `pointerup` /
   `pointercancel`，会话必须自行收尾，避免 `data-connecting` 常驻、重入锁残留与
   过期会话在下次点击时补提交。

### 6. 清理

1. 会话结束（`endSession`）只执行非 React 副作用：按函数身份移除 window 监听
   （`pointermove` / `pointerup` / `pointercancel` / `blur`）、清除倾斜、清空
   `dragRef` 并注销当前会话的结束函数。
2. 事件路径的 `cleanupDrag` = `endSession` + 清空预览状态；预览属于组件本地状态，
   卸载路径不得重置（组件已不存在）。
3. `endSession` 必须幂等：以会话级标记保证重复调用只生效一次；正常事件路径下只
   清理一次。
4. 只有本次会话真正进入过 connecting（`started`）才调用 `onDragEnd`；保证
   `onDragStart` / `onDragEnd` 成对，单击不触发状态往返。
5. 消费者组件卸载时必须结束本次会话：卸载清理只调用 `endSession`，不得更新组件
   本地状态，且不得在卸载后按落点提交。组件卸载后不得继续持有可触发的过期会话。

## 技术影响

- `web/src/features/canvas/controls/use-batch-connect-drag.ts`：唯一实现。
- 会话结束与事件清理分离：hook 用 ref 持有 `endSession`，`useEffect` 卸载时调用；
  卸载路径不触碰组件状态（规则 6.1 / 6.2 / 6.5）。
- `web/src/features/canvas/controls/BatchConnectHandle.tsx`、
  `GroupConnectRail.tsx`：消费者；只负责起手事件与预览渲染。
- `web/src/features/canvas/controls/connection-tilt.ts`：目标反馈复用。
- `web/src/features/canvas/shared/node-hit-test.ts`、`shared/connection-rules.ts`：
  命中与候选对口径。
- 测试：`web/src/__tests__/features/canvas/controls/use-batch-connect-drag.test.ts`
  （32 用例）。

## 异常与边界

1. 右键/中键 `pointerdown`：不进入拖拽，不拦截默认行为。
2. 非主指针（多指触控的第二根手指）：不进入拖拽。
3. 拖拽中第二个 `pointerdown`：忽略，不叠加监听。
4. 其他指针的 move/up/cancel：不参与、不终止本次会话。
5. 左右键和弦后先松左键：move 的 `buttons` 丢失主键位时立即取消；非左键
   `pointerup` 也按取消处理。
6. `pointercancel`（触摸被系统中断）：只清理，不提交。
7. 快速甩动：位移合并进 `pointerup` 时补 connecting 并正常提交，不丢连接。
8. 拖回参与集：取消。
9. 平台边界：`buttons` 位在触控笔/异常平台的真机行为尚未验证；单测用普通对象、
   `MouseEvent` 与 `Event` 模拟指针事件，未使用真实 `PointerEvent`。
10. 窗口失焦 / pointerup 丢失：`blur` 按取消收尾；失焦后返回画布不会恢复原会话，
    需重新起手。该路径由 `blur` 监听保证，不依赖浏览器补发 `pointerup`。

## 验收标准

1. 定向测试 32 用例通过：扇出/扇入建对、空白弹菜单、`<4px` 误触、拖回参与集取消、
   pointercancel（阈值前后）、窗口失焦（阈值前后、失焦后重入）、4px 边界只进入一次、
   其他指针隔离（move / up / cancel）、非左键 pointerup 取消、失键 move 取消、快速
   甩动补判、拖拽中卸载清理（含阈值前与会话结束后幂等）、重入保护、右键/非主指针
   不拦截、输出/输入左右锚点、可连/不可连 × 输出/输入四种倾斜组合、每次越过阈值
   后的 move 重新反馈、参与集冻结（命中与空白落点）。测试只断言 `applyConnectionTilt`
   的调用参数与 `nodeEdgeAnchor` 的方向/返回值透传，不覆盖二者的样式与几何实现，
   见第 4 条。
2. 现场验证（2026-11-12，dev，向组连接轨道派发 JS `PointerEvent` 驱动真实 React
   处理器）：主键 pointerdown 后不进入 connecting、组背景保持不透明；位移 2px 不
   进入；8px 后 `data-connecting=true`、组背景降到 20%；其他指针的 cancel/move/up
   不改变 connecting；左键松开（buttons 只剩右键位）与右键 pointerup 均取消并恢复
   背景；结束时 133 节点 / 66 边不变、无菜单。本次现场只覆盖 `GroupConnectRail`；
   `BatchConnectHandle` 的组件级现场验证见第 6 条。
3. 回归：`tsc --noEmit`、`npm run lint`（0 error，6 个既有
   `@next/next/no-img-element` warning）、web 全量 226 文件 / 1841 用例通过
   （2026-11-14，单 worker，249.81s）；全量中的已知满载抖动用例须隔离运行确认。
4. 自动化测试仍不覆盖（走查 / 真机项，不阻断收口）：
   - 输入方向（扇入）与拖动中 `ok` / `blocked` 倾斜的现场断言（走查只覆盖输出方向，
     未在 Escape 前截取 connecting 态）；
   - 触控笔/异常平台 `buttons` 真机；
   - `connection-tilt` 的样式实现与 `nodeEdgeAnchor` 的几何计算（单测 mock，只锁定
     调用契约与方向 / 参数透传）。
5. 规则 6.5（已验证）：拖拽中卸载消费者会结束会话——移除 window 监听、清除倾斜、
   置空 `dragRef`，已进入 connecting 时调用一次 `onDragEnd`；卸载路径只执行非 React
   副作用，不更新组件本地状态；卸载后同一指针的 `pointerup` 不再调用 `onConnect` /
   `onConnectToBlank`。回归用例覆盖拖拽中卸载、阈值前卸载与会话结束后卸载（清理
   幂等、副作用只发生一次），并已确认无卸载清理时前两条用例会失败。
6. 现场验证（2026-11-12，dev 由 `.claude/launch.json` 启动的 3000，headless Chrome
   经 CDP 派发真实指针事件；一次性账号 + 临时项目，1920×1080）：创建 4 个文本节点，
   框选上排两个后右侧出现 `.batch-connect-handle`；正常拖到第三个节点，边数 0 → 2；
   重新框选后拖起（已越过 4px 阈值），拖至中途按 Escape → 选区清空、
   `BatchConnectHandle` 卸载，继续移动到第四个节点上方并松手，边数保持 2、未弹创建
   菜单（无过期会话提交）；再次框选并正常拖到第四个节点，边数 2 → 4，卸载场景后正常
   路径仍可用；全程无页面异常与 console error。临时项目已删除，未触碰用户既有项目。
   附带验证：框选误含目标节点时拖到该节点上松手，边数与菜单均不变化（规则 5.5
   「拖回参与集取消」）。

## 待确认事项

1. 规则 1–6 作为长期契约：随用户 2026-11-14 指示将本 Spec 收口为「已实现」视为确认。
2. 触控笔/异常平台的 `buttons` 真机验证：未纳入本轮收口，保留为已知覆盖缺口。
3. 拖拽中卸载清理（规则 6.5）：按用户 2026-11-12 指示实现并补回归用例，随第 1 条
   一并视为确认。
4. 窗口失焦取消（规则 5.7）：按用户 2026-11-12 指示根因修复并补回归用例，随第 1 条
   一并视为确认。

## 当前状态

- 状态：已实现（2026-11-14 用户指示）。规则 1–6 均已实现，自动化验证通过（定向
  32 用例），现场验证已覆盖 `GroupConnectRail` 与 `BatchConnectHandle` 组件级；
  主体代码随 `ce08456f` 提交、窗口失焦修复随 `8a8eb1fb` 提交、测试补齐随
  `d813a1d0` 提交。剩余走查项见「验收标准」第 4 条，保留为已知覆盖缺口。
- 组件卸载清理（2026-11-12，用户要求修复）：hook 以 `endSessionRef` 持有会话结束
  函数（只做非 React 副作用），`useEffect` 卸载时调用；事件路径 `cleanupDrag` =
  `endSession` + 清空预览，卸载路径不触达组件状态。`endSession` 以会话级标记保证
  幂等，避免 pointerup / pointercancel / 卸载多路径重复 `onDragEnd`。新增 3 条
  回归用例，并验证去掉卸载清理后其中 2 条会失败。
- 现场走查（2026-11-12，`BatchConnectHandle` 组件级）：正常批量连线 0 → 2；拖拽中
  Escape 卸载后松手到目标节点不建边、不弹菜单；卸载后重新拖线 2 → 4；无页面异常。
  证据见验收 6，临时项目已删除。
- 窗口失焦收尾（2026-11-12，用户要求根因修复丢失 `pointerup`）：原会话只依赖
  `pointerup` / `pointercancel` 收尾；窗口失焦（切标签页、Alt+Tab、窗口外松手）后
  浏览器可能不再派发这两个事件，导致 connecting（`data-connecting`）常驻、重入锁
  残留，且过期会话会在下一次 `pointerup` 时按落点补提交（回归用例已复现误提交）。
  修复为监听 window `blur` 并按取消收尾，与 marquee 的失焦取消一致；批量连线的
  提交即建边，落点语义不可信，不做 resize 式的末帧提交。新增 3 条回归用例
  （阈值后失焦、阈值前失焦、失焦后重新起手），并确认修复前 3 条均失败、修复后通过。
  本次修复已随 `8a8eb1fb` 提交（2026-11-12）；修复后复跑 canvas controls 11 文件 /
  64 用例与 `GroupNode` 3 用例通过；真机窗口失焦路径未现场复现（单测用合成
  `Event("blur")` 验证）。
- 实现：`use-batch-connect-drag.ts` 作为唯一实现；`BatchConnectHandle` 与
  `GroupConnectRail` 共用。
- 测试补齐（2026-11-14）：新增 11 条用例，覆盖此前验收 4 列出的四项自动化缺口——
  输出/输入锚点方向、可连/不可连 × 输出/输入四种倾斜组合、每次越过阈值后的 move
  重新反馈、参与集冻结（命中与空白落点）、其他指针 `pointercancel`。新增断言另经
  3 组实现变异验证（倾斜按方向绑定、仅首次 move 反馈、空白落点重读参与集），均按
  预期失败后还原实现。
- 验证：定向 32 用例、`tsc --noEmit`、`npm run lint`（0 error，6 个既有 warning）
  通过；web 全量 226 文件 / 1841 用例通过（2026-11-14，单 worker，249.81s）。此前的
  历史记录：web 全量 219 文件 / 1770 用例三轮分别 1759、1768、1759 通过，失败集中在
  与本次改动无关的媒体/URL 真实计时器用例（隔离运行均通过），批量连线用例无失败；
  dev 现场验证见验收 2 / 6（2026-11-12）。未覆盖项见「验收标准」第 4 条。
- 来源：`canvas-multi-selection-toolbar.md` 2026-11-12「组表面拖线预览对齐即梦」
  条目中的审查根因修复记录。
