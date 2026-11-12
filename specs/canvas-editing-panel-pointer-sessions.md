# 画布编辑面板的 window 指针会话（Editing Panel Pointer Sessions）

状态：待确认（2026-11-12 创建；用户要求根因修复帧序列 / 视频片段 / 音频片段三个编辑面板丢失 `pointerup` 后的失焦残留。主体修复已提交为 `ea0083d9`；审查发现的 Frame 重入 / 挂起 seek 与本轮文档修正为未提交工作区改动；长期契约待用户确认）

## 目标

1. 三个画布编辑面板（`FrameStripPanel`、`ClipStripPanel`、`AudioClipStripPanel`）的
   拖拽会话共用同一套 window 指针收尾语义：`pointerup` 正常提交，`pointercancel`
   与窗口失焦（`blur`）按取消收尾。
2. 失焦后浏览器可能不再派发 `pointerup` / `pointercancel`；会话必须自行结束，
   不得让未按键的 `pointermove` 继续拖动、不得让过期会话在下一次 `pointerup` 上
   按旧落点补提交或补定位。
3. 本契约覆盖的三个面板，其收尾路径（监听注册与按函数身份移除）只写一处，
   避免各面板 / 各会话各自漏掉某条路径。

## 范围

包含：

- 共享原语 `web/src/features/canvas/editing/window-pointer-session.ts`
  （`startWindowPointerSession`）。
- `FrameStripPanel` 播放头拖动会话。
- `ClipStripPanel` 的三个会话：轨道就近手柄、端帽手柄、整段亮带。
- `AudioClipStripPanel` 的 `clipStartDrag` 会话（`in` / `out` / `track` 归一后的
  `in` / `out` / `band`）。
- 上述面板的失焦回归测试与测试助手。

不包含：

- 各面板拖拽的业务提交语义（帧定位、选区钳制、亮带平移、循环播放等）——
  仍由各面板自身与既有 Spec 定义。
- 元素级 pointer capture 的面板（`CropPanel`、`VideoCropPanel`、
  `AnnotationPanel`、`OrbitScene3D` 等）：本轮未审计，不在契约内。
- 批量连线、框选、节点缩放等画布手势：分别由
  `canvas-batch-connect-drag.md`、`canvas-marquee-gesture-session.md`、
  `canvas-resize-gesture-session.md` 定义。
- 指针起始键过滤（`button` / `isPrimary`）的统一改造（见「异常与边界」1）。

## 业务规则

### 1. 会话建立

1. 轨道 / 手柄 / 亮带的 `pointerdown` 在通过各面板自己的可操作守卫与重入守卫后，
   建立**一个** window 指针会话。
2. 会话必须通过 `startWindowPointerSession` 注册 `pointermove` / `pointerup` /
   `pointercancel` / `blur` 四条监听；禁止在面板内手写其中任意子集。
3. `startWindowPointerSession` 返回按函数身份移除全部监听的清理函数；会话结束时
   必须调用，重复调用无副作用。
4. 所有会话过滤 `pointerId`：只有起始指针的 move / up / cancel 参与本次会话；
   其它指针的 up / cancel 不得结束会话。

### 2. 正常收尾

1. `pointerup` 是唯一的正常提交路径：先移除监听与会话引用，再按各面板既有语义
   应用最终位置（帧定位 / 手柄落点 / 亮带平移 / 原地点击定位与恢复试听）。
2. `pointerup` 之后不得再保留任何 window 监听或拖动守卫。

### 3. 取消收尾（`pointercancel` / 窗口失焦）

1. `pointercancel` 与 window `blur` 都按**取消**收尾，复用同一取消函数；
   `blur` 不等待浏览器补发 `pointerup` / `pointercancel`。
2. 取消必须完成：移除四条监听、清空指针与 `dragCleanupRef` 守卫、取消挂起的
   rAF seek、清除拖动视觉状态。
3. 取消不得按指针落点应用最终位置：不 seek 到最后移动位置、不按亮带旧落点
   定位播放头、不重建已取消的拖动。
4. 取消按**拖动前状态**恢复播放：
   - `ClipStripPanel` 三个会话：拖动前在播放（`wasPlayingRef`）则恢复循环播放；
     先取消挂起 rAF 再恢复，避免挂起的 `seekVideo` 把刚恢复的播放在下一帧按停。
   - `AudioClipStripPanel`：`band` 模式在取消时补一次 `resumeIfBlocked()`，
     避免停在「自动播放被拦截」提示；`in` / `out` 模式不额外恢复（按下时已
     经 `resumeIfBlocked`）。
   - `FrameStripPanel`：选帧期间节点本应暂停，取消不恢复播放；挂起的 rAF
     seek 仍按 3.2 取消，避免回到窗口后按最后移动位置 seek。
5. 取消后回到窗口，未按键的 `pointermove` 不得改变播放头 / 选区 / 播放元素时间；
   同一次取消之后的 `pointerup` 不得产生任何提交。

### 4. 卸载收尾

1. 面板可能在拖动途中卸载；卸载仍通过 `dragCleanupRef` 调用会话的清理函数
   （`ClipStripPanel` / `FrameStripPanel` 存 `cancelDrag`，`AudioClipStripPanel`
   存 `cleanup`），移除监听、清空指针与拖动守卫；存在挂起 rAF seek 的会话同时
   撤销。
2. 卸载路径沿用各面板既有语义：`ClipStripPanel` / `AudioClipStripPanel` 的清理
   函数同时清除拖动视觉状态（组件已卸载时该更新被丢弃），`FrameStripPanel` /
   `AudioClipStripPanel` 不在卸载时补播放恢复；`FrameStripPanel` 的取消函数额外
   撤销挂起 seek。本 Spec 不改变卸载行为。

## 技术影响

- 新增 `web/src/features/canvas/editing/window-pointer-session.ts`：
  `WindowPointerSessionHandlers`（`onMove` / `onUp` / `onCancel` / `onBlur`）与
  `startWindowPointerSession`；四条监听的注册 / 移除只此一处。
- `FrameStripPanel.tsx`：播放头会话改走共享原语，补齐 `pointerId` 过滤与重入
  守卫；`onCancel` / `onBlur` / 卸载均走 `cancelDrag`（摘监听、清指针与拖动
  守卫、撤销挂起 rAF），`pointerup` 只做 cleanup，保留最后一次预览 seek。
- `ClipStripPanel.tsx`：轨道 / 端帽 / 亮带三个会话改走共享原语，
  `onBlur` = 既有 `cancelDrag`。
- `AudioClipStripPanel.tsx`：`clipStartDrag` 会话改走共享原语，
  `onBlur` = 既有 `cancelDrag`（含 band 的 `resumeIfBlocked`）。
- 测试助手 `web/src/__tests__/test-utils/pointer-events.ts`：jsdom 无
  `PointerEvent`，以 `MouseEvent` + `pointerId` 构造指针事件，并提供 window
  事件派发与固定轨道矩形。
- 测试：
  - `web/src/__tests__/features/canvas/editing/window-pointer-session.test.ts`（2 例）
  - `web/src/__tests__/features/canvas/editing/FrameStripPanel.test.tsx`（4 例）
  - `web/src/__tests__/features/canvas/editing/ClipStripPanel.test.tsx`（3 例）
  - `web/src/__tests__/features/canvas/editing/AudioClipStripPanel.test.tsx`
    新增 2 例（文件共 14 例）

## 异常与边界

1. **起始键未统一过滤**：三个面板都未检查 `button` / `isPrimary`，右键或非主
   指针按下仍可建立会话；本轮只补齐 `FrameStripPanel` 的 `pointerId` 过滤与
   重入守卫，避免多指叠加会话。起始键过滤是跨三个面板的交互决策，是否需要
   补齐待确认。
2. **真实窗口失焦未现场复现**：自动化用合成 `Event("blur")` 验证监听路径；真实
   浏览器切标签页 / Alt+Tab 后不再派发指针事件的行为未在本轮现场复现。
3. **取消时的播放恢复**：`ClipStripPanel` 按拖动前状态恢复循环，失焦切到后台后
   可能继续播放声音；这是「取消应还原拖动前状态」的直接结果，与既有
   `pointercancel` 行为一致。
4. **元素级 pointer capture 面板**未审计：它们可能依赖 `setPointerCapture` 自动
   收到 `lostpointercapture`，失焦行为与本契约未对齐前不得假定一致。
5. **测试中的窗口事件为合成事件**：`fireWindowPointerMove` 等直接派发到
   `window`，不经过浏览器命中测试与真实指针序列。
6. **批量连线的监听注册未迁移**：`use-batch-connect-drag.ts` 仍自行注册四条
   window 监听。该手势有独立的 `isPrimary` / `button` / 误触阈值语义，且由
   `canvas-batch-connect-drag.md` 定义；本轮评估后不迁移，避免跨手势契约重构。

## 验收标准

1. 共享原语单测：四条监听各收到一次；清理后全部不再响应。
2. 三个面板的失焦 / 会话隔离回归用例通过（共 9 例）：
   - 帧序列面板：拖动中失焦后，挂起的 rAF seek 被取消、未按键的移动不再 seek，
     正常松手仍提交最后一次 seek；多指并发只建立一个会话，第二根指针的
     move / up 不影响首指针，且可重新起拖。
   - 视频片段面板：轨道 / 端帽 / 亮带三个会话失焦后均不再 seek 或按旧落点
     提交，且可重新起拖。
   - 音频片段面板：亮带原地点击前失焦不执行点击定位与 `resume()`、但补一次
     `resumeIfBlocked`，过期 `pointerup` 无效；拖入手柄失焦后未按键的移动不再
     改播放头，且重新抓取到与残留值不同的位置。
3. 先红后绿：新增的 rAF 取消与多指并发用例在修复前失败（失焦后仍 seek 到 1s、
   第二根指针把播放头带到 9s），修复后 Frame 4 例通过；移除共享原语的 `blur`
   监听后 8 例失败（共享 1、Frame 2、Clip 3、音频 2），恢复后 23 例全部通过。
4. `tsc --noEmit` 与变更文件 ESLint 通过；`editing` 目录 + `SelectionToolbar` +
   `module-boundaries` 共 12 文件 / 91 例通过。
5. 真实浏览器窗口失焦路径未验证（见「异常与边界」2）。

## 待确认事项

1. 是否确认规则 1–4 作为三个编辑面板 pointer 会话的长期契约。
2. 三个面板的起始键过滤（`button` / `isPrimary`）是否补齐（异常 1）。
3. 是否需要补真实浏览器窗口失焦走查（切换标签页 / Alt+Tab / 窗口外松手）。
4. 元素级 pointer capture 面板是否纳入同一契约并单独审计。

## 当前状态

- 状态：待确认。规则 1–4 已实现；主体修复已提交 `ea0083d9`，本轮审查修复
  （Frame 重入 / `pointerId` / 挂起 rAF seek、音频用例可证伪性）为未提交工作区
  改动。自动化验证通过，真实浏览器失焦路径未验证。
- 实现（2026-11-12，用户要求「根因修复编辑面板的同类失焦问题」）：
  - 新增 `window-pointer-session.ts`，四条 window 监听与按函数身份移除只写一处；
    三个面板的 5 个会话全部改用该原语，不再各自维护监听子集。
  - 失焦语义统一为「取消」：复用既有 `pointercancel` 收尾函数；`FrameStripPanel`
    原先没有 `pointercancel` / `blur` 收尾，本次一并补齐；`AudioClipStripPanel`
    的 band 取消保留 `resumeIfBlocked`。
  - 根因：编辑面板的拖拽会话只监听指针事件，窗口失焦后浏览器可能不再派发
    `pointerup` / `pointercancel`；`FrameStripPanel` 的 `dragCleanupRef` 残留会
    挂起节点时间跟随并让未按键移动继续搓擦；`ClipStripPanel` /
    `AudioClipStripPanel` 的 `dragPointerRef` 残留会锁死后续拖动，过期会话还会在
    下一次 `pointerup` 上按旧落点补提交（回归用例已复现）。
  - 审查修复（本轮，未提交）：`FrameStripPanel` 补 `dragPointerRef` 重入守卫与
    `pointerId` 过滤；挂起 seek 的 rAF 句柄收回 `seekRafRef`，取消路径先清用户
    驱动标记再撤销 rAF，正常 `pointerup` 不撤销；卸载改存 `cancelDrag`。音频
    手柄用例的重新抓取点改到 5%，使断言与失焦残留值可区分。
- 测试：共享原语新增 2 例、Frame 4 例、Clip 3 例、音频新增 2 例；先红后绿验证见
  验收 3；定向 4 文件 / 23 例、`editing` 目录 + `SelectionToolbar` +
  `module-boundaries` 12 文件 / 91 例通过；`tsc --noEmit` 与变更文件 ESLint 无错误。
- 遗留：三个面板均未过滤起始键（`button` / `isPrimary`）；批量连线仍自行注册
  四条 window 监听（见异常 6）；元素级 capture 面板未审计；真实窗口失焦与真实
  指针序列未现场验证；本轮审查修复未提交。
- 来源：`client-video-editing.md` 与 `canvas-audio-peaks-cache.md` 的
  2026-11-12 当前状态条目引用本 Spec 规则 1–4「会话建立 / 正常收尾 /
  取消收尾 / 卸载收尾」。
