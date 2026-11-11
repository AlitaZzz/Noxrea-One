# 画布系统剪贴板格式与粘贴链路

状态：已实现（2026-11-11）

> 确认依据：用户明确要求「参考即梦的做法，然后实施吧，注意不要抄他的前缀等」。本 Spec 记录该指示下确定的数据契约、浏览器读写策略与验收标准；实现状态见第 10 节。

## 1. 背景与证据

### 1.1 现状（已验证事实，读源码确认）

1. `web/src/features/canvas/shared/canvas-edit-actions.ts` 的 `copySelection()` 把完整节点/连线 JSON 以 `noxrea-nodes:` 前缀写入系统剪贴板 `text/plain`；`pasteFromClipboardContent()` 按该前缀识别并还原节点。
2. 所有可编辑目标（普通输入框、Tiptap 文本节点、生成提示词 `MentionPrompt`、Agent 输入区）都不经过画布粘贴监听，因此会收到 `noxrea-nodes:{...}` 原文。这是「复制节点后到输入框粘贴出 JSON」的直接原因。
3. `duplicateSelection()`（Ctrl+D / 创建副本）当前先调用 `copySelection()`，会连带覆盖系统剪贴板；创建副本不应改变用户剪贴板。
4. 右键菜单「粘贴」在内部剪贴板非空时直接使用内部数据，不读取系统剪贴板。于是「先复制节点、再复制图片、再右键粘贴」会粘出旧节点，而不是后复制的图片。
5. `readSystemClipboard()` 只读取 `image/*` 与 `text/plain`，自定义 MIME 会被静默忽略。
6. `selection-store` 的内部剪贴板只做顶层浅拷贝，嵌套 `data` 与 store 共享引用；没有项目切换清理。

### 1.2 即梦对照（已验证事实，2026-11-11 只读探测）

1. 复制图片节点后，系统剪贴板只写入 Chromium Web Custom Format：`web application/vnd.dreamina.octo-canvas+json`。Windows 剪贴板格式为 `Web Custom Format0` / `Web Custom Format Map` 等，普通应用看不到文本或图片。
2. 复制纯文本节点时，除自定义 MIME 外还会写入 `text/plain`，因此粘到输入框是正常文字。
3. Chrome 157 的原生 paste 事件看不到 Web Custom Format（`clipboardData.types` 为空），画布粘贴必须回退到 `navigator.clipboard.read()`。
4. 即梦的粘贴优先级是：结构化自定义载荷 → 图片 → 文本；自定义载荷存在但非法时拒绝，不降级为文本。

### 1.3 本项目格式的浏览器实测（已验证事实，Chrome 157）

在已登录页面用 `ClipboardItem` 同时写入自定义 MIME、`text/html` 与 `text/plain`：

| 场景 | `navigator.clipboard.read()` | 原生 paste 事件 |
| --- | --- | --- |
| 非文本选择（自定义 + HTML） | 自定义 MIME + `text/html` 都可读 | 只暴露 `text/html`，自定义 MIME 不可见 |
| 纯文本选择（自定义 + HTML + text） | 自定义 MIME + `text/html` + `text/plain` | 暴露 `text/html` + `text/plain`，自定义 MIME 不可见 |

HTML 中写入的 `data-noxrea-canvas-selection` 属性与 `&quot;` 实体在 paste 事件与 `read()` 中都原样保留。由此确定：HTML 镜像可以让键盘 Ctrl+V 免权限同步识别节点载荷；自定义 MIME 作为主格式供 `read()` 与跨标签页使用。

## 2. 目标

1. 节点/连线结构化数据只写入独立的 Noxrea 自定义 MIME，不再写入 `text/plain` 的 JSON。
2. 纯文本选择才写可读 `text/plain`；复制文本节点后粘到输入框得到文字，不得到 JSON。
3. 复制任意节点后粘到输入框、Tiptap、Agent 输入区都不产生节点 JSON 文本。
4. 复制/粘贴支持跨标签页、跨项目（同一用户可访问的存储引用），并保留节点内容、生成参数、分组归属与内部连线。
5. 右键粘贴改为系统剪贴板优先、内部剪贴板兜底，修复「后复制的内容被旧内部剪贴板覆盖」。
6. Ctrl+D / 创建副本不写系统剪贴板，也不覆盖内部剪贴板。
7. 系统剪贴板载荷按不可信输入校验，非法载荷整包拒绝，不部分导入、不降级为文本、不修改画布或历史。
8. 浏览器不支持 ClipboardItem/自定义 MIME 时，内部剪贴板仍可用；纯文本选择可用 `writeText` 兜底。

## 3. 非目标

- 不实现即梦的跨项目资源清单、资源导入与授权检查；Noxrea 继续使用现有存储 key / 外部 URL 引用模型。
- 不保留 `noxrea-nodes:` 旧格式的兼容解析。旧格式文本按普通文本处理。
- 不改变「复制图片」动作：单张图片节点仍可通过右键「复制图片」写入 `image/png`。
- 不改变连线外观持久化：粘贴仍由 `createEdge()` 重建默认连线。
- 不在本次引入节点数据字段的完整白名单校验；只做结构、运行时字段与已知引用字段的校验，避免为协议维护一份易漂移的全量 schema。
- 不在本次实现项目切换时清空内部剪贴板；内部剪贴板仍是系统读取失败时的同标签页兜底。

## 4. 格式契约

### 4.1 常量

| 名称 | 值 |
| --- | --- |
| 自定义 MIME（ClipboardItem key） | `web application/vnd.noxrea.canvas-selection+json` |
| 自定义 MIME（Blob.type / read 中的裸 MIME） | `application/vnd.noxrea.canvas-selection+json` |
| 载荷 `kind` | `noxrea.canvas-selection` |
| 载荷 `version` | `1` |
| HTML 标记属性 | `data-noxrea-canvas-selection` |
| 最大序列化字节数 | 4 MiB（UTF-8） |
| 最大节点数 | 2000 |
| 最大连线数 | 4000 |

`web ` 是 Chromium 自定义格式的协议前缀，不是 Noxrea 品牌前缀；`noxrea` / `canvas-selection` 为本项目独立命名，不复用即梦的 `dreamina` / `octo` / `formatVersion` 等命名。

### 4.2 载荷

```json
{
  "kind": "noxrea.canvas-selection",
  "version": 1,
  "nodes": [
    {
      "id": "i-abc",
      "type": "image-node",
      "position": { "x": 0, "y": 0 },
      "style": { "width": 320, "height": 240 },
      "parentId": "g-xyz",
      "data": { "label": "参考图", "src": "uploads/...", "lockAspectRatio": true, "naturalWidth": 1024, "naturalHeight": 768 }
    }
  ],
  "edges": [
    { "id": "e-1", "source": "i-abc", "target": "t-def" }
  ]
}
```

节点顶层字段固定为：`id`、`type`、`position`、`style?`、`parentId?`、`data`。其余顶层字段（`selected`、`dragging`、`measured`、`resizing`、`positionAbsolute`、`positionAbsoluteX/Y`、`width/height`、`zIndex`、`hidden`、`selectable`、`draggable`、`connectable`、`deletable`、`className`、`extent`、`expandParent`、`origin`、`internals`、`handleBounds` 等）一律不进入载荷，导入时也不落库。

`style` 只允许有限的正数 `width` / `height`；没有有效尺寸时可省略。

`data` 至少包含字符串 `label`，并按节点类型包含现有内容字段：

| 类型 | 必需字段 | 说明 |
| --- | --- | --- |
| `text-node` | `content: string`, `plainText: string` | `content` 为 Tiptap HTML，`plainText` 为下游纯文本 |
| `image-node` | `src: string`, `lockAspectRatio: boolean`, `naturalWidth: number >= 0`, `naturalHeight: number >= 0` | `src` 允许空串（占位节点） |
| `video-node` | `src: string`, `naturalWidth: number >= 0`, `naturalHeight: number >= 0` | 同上 |
| `audio-node` | `src: string` | 同上 |
| `group-node` | 仅 `label` | 组不嵌套，组节点不得有 `parentId` |
| `director-node` | 仅 `label` | `directorState` 如存在须为普通对象 |

`genSettings`、`multiResultKeys`、`multiResultTotalCount`、`source`、`pendingNaturalSize`、`duration`、`hasAudio`、`fileSize`、`createdAt`、`color`、`directorState` 等现有内容字段按原值保留；`data.taskBinding` 与 `data.upload` 不导出，导入时也剥离（复制品不继承生成任务与上传会话）。`data.upload` 为整字段剥离，包含上传中状态、失败原因与 `previewUrl`；上传失败且没有 `src` 的节点被复制后成为空占位节点，不显示上传失败/重试 UI——重试上下文按原节点 id 保存，副本无法重试。`rotation` / `flipH` / `flipV` 为未渲染字段，导出时剥离。

连线固定为 `{ id, source, target }`。`id` 仅在载荷内唯一；粘贴时全部重建。载荷中的连线必须两端都在 `nodes` 内，禁止自连线、组端点、重复有序端点和违反 `canConnect` / `nodeAcceptsInput` 的连线。

### 4.3 分组与坐标

1. 选中组时自动带上其全部直接成员；组不得为空。
2. 成员的 `parentId` 指向载荷内的组时，保留相对坐标；父组不在载荷内时，导出为世界坐标并删除 `parentId`（成员被单独复制时不再按相对坐标错位）。
3. 顶层节点 `position` 为世界坐标；成员 `position` 为组内相对坐标。
4. 载荷不包含视口、粘贴落点、项目 id 或用户 id。

### 4.4 版本与兼容

- `kind` 或 `version` 不匹配的载荷整包拒绝。
- 旧 `noxrea-nodes:` 文本不识别、不迁移；在画布粘贴时按普通文本创建文本节点。
- 未来字段/语义变更必须提升 `version`，不得在同一版本内静默改变语义。

## 5. 复制与写入

### 5.1 选择快照

`collectSelectionSnapshot()` 是复制与创建副本的唯一选择口径：

1. 读取当前选中节点；选中组自动展开全部直接成员。
2. 捕获任一端在选中集内的全部相关连线（供内部剪贴板与创建副本使用）。
3. 对父组不在选中集的成员，换算为世界坐标并删除 `parentId`。
4. 通过 `sanitizeNodeForClipboard` / `sanitizeEdgeForClipboard` 生成规范节点/连线：只保留第 4.2 节的顶层字段，深拷贝 `data`，剥离运行时与瞬时字段。
5. 内部剪贴板只保存规范快照，不再共享 store 的嵌套引用。

### 5.2 系统载荷

- 系统载荷只包含两端都在节点集内的连线；外部上游连线只保留在内部剪贴板，供 `duplicateSelection` 还原上游关系。
- `text/plain` 仅当规范快照中所有节点都是 `text-node` 时写入，内容为各节点 `plainText` 按节点顺序以空行连接；任一节点不是文本节点则不写 `text/plain`。
- HTML 镜像始终写入：非文本选择为空 `<span data-noxrea-canvas-selection="..."></span>`；纯文本选择在 span 内写入转义后的可读文本（供富文本目标使用）。属性值使用 HTML 实体转义的同一份 JSON。
- 自定义 MIME 仅在 `ClipboardItem.supports("web application/vnd.noxrea.canvas-selection+json")` 明确返回 `true` 时写入；`supports` 不存在、返回 false 或抛错时省略自定义 MIME，只用 HTML 镜像，避免整个 ClipboardItem 因未知类型被拒。
- 写入顺序：先同步更新内部剪贴板，再在同一用户手势调用栈内调用 `navigator.clipboard.write([new ClipboardItem(parts)])`；`write` 调用前不得有 `await`。
- 写入被拒/不可用：不回退写 `text/plain` JSON，不重试；内部剪贴板保持可用，并按第 7 节提示。
- 超过字节/节点/连线上限：跳过系统写入（不截断），内部剪贴板仍更新，提示 `common.copyTooLarge`。

### 5.3 创建副本

`duplicateSelection()` / Ctrl+D 直接使用选择快照调用粘贴引擎，不调用 `copySelection()`，不写系统剪贴板，也不修改已存在的内部剪贴板；仍保留「只还原上游外部连线」的既有语义。创建副本与复制共用同一规范快照，因此同样不继承 `data.upload`：上传失败节点按已落定内容复制（有 `src` 保留 `src`，无 `src` 为空占位节点），不产生上传失败/重试 UI。

## 6. 粘贴与读取

### 6.1 统一内容模型

粘贴入口统一接收：

```ts
interface ClipboardPasteContent {
  payloadJson?: string; // 检测到 Noxrea HTML/自定义标记时存在
  imageFiles: File[];
  text: string;
}
```

固定优先级：

1. `payloadJson` 存在：解析并粘贴节点；解析/校验失败整包拒绝，不降级为图片/文本/内部剪贴板。
2. 图片文件：走现有上传管道建图片节点。
3. 非空文本：创建文本节点。
4. 以上都没有：内部剪贴板兜底。

### 6.2 键盘 Ctrl+V

1. 可编辑目标（`input` / `textarea` / contenteditable / `[role=textbox]`）直接放行浏览器原生粘贴；画布监听不 `preventDefault`、不读取剪贴板。
2. 同步读取 paste 事件：先看 `text/html` 是否有 `data-noxrea-canvas-selection`；有则按载荷处理。再看图片文件；最后看 `text/plain`。
3. 事件没有任何可用标准内容时，`preventDefault()` 后在同一事件调用栈启动 `navigator.clipboard.read()`，用于读取自定义 MIME（Chrome 不向 paste 事件暴露自定义格式）。读取失败或为空时回退内部剪贴板。
4. 未带标记的 `text/html` 不解析；只使用 `text/plain`（与现状一致）。
5. 旧 `noxrea-nodes:` 文本按普通文本创建文本节点。

### 6.3 右键菜单粘贴

- 不再以内部剪贴板非空短路系统读取。点击「粘贴」后立即启动 `readSystemClipboard()`，优先级：自定义 MIME → 带标记 HTML → 图片 → 文本 → 内部剪贴板。
- 读取被拒/不可用且内部剪贴板为空时提示 `common.clipboardReadFailed`；系统内容存在但无法粘贴（含非法载荷）时提示 `common.pasteUnsupported`，不回退内部剪贴板。
- 读取为空且内部剪贴板非空时粘贴内部内容。

### 6.4 HTML 解析

- 仅用 `DOMParser` 解析剪贴板 HTML，再用 `getAttribute` 取载荷；不把剪贴板 HTML 插入活动 DOM。
- 属性值按 HTML 实体解码后交给载荷校验；`DOMParser` 不可用（非浏览器环境）时视为无标记。

## 7. 异常、边界与安全

1. **非法载荷**：`kind`/`version` 错误、非对象、空节点、重复 id、悬空/非组/嵌套 `parentId`、空组、组带 `parentId`、未知节点类型、非有限坐标、非正尺寸、非法连线（自连、组端点、端点缺失、重复有序端点、连接规则不满足）、超限，整包拒绝；画布、历史、内部剪贴板均不修改。
2. **运行时字段**：导入时重建规范节点，不把解析对象的未知顶层字段展开进 store；`data.taskBinding` / `data.upload` 剥离。`data.upload` 为整字段剥离，包含上传中状态、失败原因与 `previewUrl`；失败原因同样不进入副本，避免副本显示无法重试的失败 UI。
3. **超限**：UTF-8 字节 > 4 MiB、节点 > 2000、连线 > 4000 时系统复制跳过、系统粘贴拒绝；内部剪贴板不受影响。
4. **权限/浏览器**：`navigator.clipboard.read()` 可能要求一次性授权；拒绝后右键与异步键盘粘贴回退内部剪贴板。无 ClipboardItem/write 时纯文本可用 `writeText`，节点载荷仅内部可用。
5. **HTML 兜底不确定性**：剪贴板管理器、富文本清洗器、远程桌面同步可能删除 `data-*` 属性或重排 HTML；缺失/非法标记按普通内容处理，不视为可信状态。自定义 MIME 是主格式，HTML 是同步/跨浏览器镜像。
6. **可读性**：非文本选择的 HTML 不包含任何可见 JSON 文本；纯文本选择只包含 `plainText`。节点 JSON 从不进入 `text/plain`。
7. **引用值域**：`src` / `multiResultKeys` 等继续保存存储 key 或外部 URL，不在复制时解析为签名/展示 URL；跨标签页能否读取由现有文件访问契约决定。
8. **反馈**：超限提示 `common.copyTooLarge`；无 Clipboard API 或写入被拒提示 `common.copySystemUnavailable`（每会话去重一次）。不得出现未处理的 Promise rejection。

## 8. 涉及模块

| 模块 | 变更 |
| --- | --- |
| `web/src/features/canvas/shared/canvas-clipboard-format.ts` | 新增：常量、载荷类型、规范节点/连线、编码、校验、纯文本提取、HTML 构建 |
| `web/src/features/canvas/shared/canvas-system-clipboard.ts` | 新增：ClipboardItem 写入、`read()`/`readText()` 读取、paste 事件内容解析、HTML DOM 解析 |
| `web/src/features/canvas/shared/canvas-edit-actions.ts` | 选择快照、复制/创建副本、粘贴分发、右键读取、移除旧 marker |
| `web/src/features/canvas/node-defaults.ts` | 抽取 `cloneNodeForTransfer`，`duplicateNode` 统一剥离 `taskBinding` / `upload` 等瞬时状态（含上传失败原因） |
| `web/src/features/canvas/hooks/use-canvas-keyboard.ts` | paste 事件同步读取标记 HTML；无标准内容时异步 `read()` |
| `web/src/features/canvas/hooks/use-canvas-clipboard-feedback.ts` | 新增：经 `useAppFeedback` 统一提示系统写入失败，不可用提示每会话去重 |
| `web/src/features/canvas/controls/CanvasContextMenu.tsx` | 右键粘贴系统优先、内部兜底；复制写入结果提示 |
| `web/src/features/canvas/controls/SelectionToolbar.tsx` | 复制入口传递统一写入结果提示 |
| `web/src/lib/i18n/zh-CN.json` / `en-US.json` | 新增复制超限/系统剪贴板不可用文案 |
| `web/src/__tests__/features/canvas/**` | 新增格式/传输/编辑动作用例；补齐键盘、右键菜单系统优先与编辑目标放行用例 |
| `specs/canvas-multi-selection-toolbar.md` | 更新复制验收证据，不再引用旧 `noxrea-nodes:` 载荷 |

## 9. 验收标准

1. 复制含非文本节点的选择后，系统剪贴板没有 `text/plain` 节点 JSON，也没有 `noxrea-nodes:` 文本；粘到任意 input/textarea/contenteditable 不出现节点 JSON，不创建画布节点。
2. 复制节点后在画布粘贴（同标签页与授权后的跨标签页）恢复全部节点类型、新 id、重映射的组父级、仅内部连线与一条撤销记录；`selected`/`measured`/`taskBinding`/`upload`（含 `previewUrl` 与失败原因）等运行时状态不存在，粘贴节点不出现生成中/上传重试 UI。
3. 复制组自动包含全部成员；父组不在复制范围内的成员按世界坐标展平，不留下悬空 `parentId`；空组不被产生或接受。
4. 纯文本选择在 `text/plain` 与 HTML 镜像中提供可读 `plainText`；粘到输入框是可读文字，粘到画布是文本节点内容，不含 JSON。
5. 实现中不存在旧 `noxrea-nodes:` 前缀识别；该文本按普通文本粘贴，永不还原为节点（保留一条回归用例覆盖旧文本按文本处理）。
6. Chrome/Edge 通过 `navigator.clipboard.read()` 完成自定义 MIME 往返；无自定义 MIME 的浏览器通过带标记 HTML 完成粘贴；读取被拒/失败回退内部剪贴板并给出明确提示，不降级为 JSON 文本。
7. 右键粘贴为系统优先、内部兜底：后复制的跨标签页内容被采用；读取为空/被拒时使用内部；非法 Noxrea 内容提示 `pasteUnsupported` 且不粘旧内部内容。
8. Ctrl+D / 创建副本不修改系统剪贴板与内部剪贴板，同时保持既有上游外部连线语义。
9. 非法、伪造、版本不匹配、超限载荷整包拒绝：不产生部分节点/连线、不进撤销栈、不改内部剪贴板、不降级为文本节点。
10. 无 Clipboard API/ClipboardItem、写入被拒、超限时内部复制粘贴仍可用，不出现未处理 rejection，并按第 7 节给出提示。
11. 六类节点往返保留内容字段（`genSettings` 引用顺序、`multiResultKeys`、`source`、`pendingNaturalSize`、`directorState`、组颜色等），引用值仍在存储 key / 外部 URL 值域。
12. 类型检查、Lint、相关 Vitest 用例串行通过；真实 Chrome 至少走查：复制图片节点 → 粘贴到普通输入框无 JSON；复制文本节点 → 粘贴到输入框为文字；跨标签页粘贴节点；右键系统优先；Ctrl+D 不覆盖剪贴板。

## 10. 当前状态

- 2026-11-11：已实现；实现、测试与 Spec 更新提交为 `a6efc1dd`。上传失败节点复制语义已确认并统一为整字段剥离。
- 2026-11-11：用户确认实机走查结果并授权提交；按用户指示将状态更新为「已实现」。
- 已验证事实（实现与检查）：
  - 上传失败节点的 `data.upload` 整字段剥离（含失败原因、`previewUrl`、`uploading`）：复制、创建副本、跨标签页粘贴与 Agent `duplicate_node` 一致；有 `src` 保留已落定内容，无 `src` 成为空占位节点，不产生上传失败/重试 UI。
  - `npx tsc --noEmit` 通过；`npm run lint` 0 error（仅 6 条既有 `<img>` warning）。
  - 相关 8 个 Vitest 文件 147 用例通过；canvas + architecture 121 个文件 1165 用例通过（`--maxWorkers=1 --minWorkers=1`）。
- 已验证事实（Chrome 157 实机，localhost:3000，临时空白项目验证后已删除）：
  - 复制图片节点后 `clipboard.read()` 只返回 `web application/vnd.noxrea.canvas-selection+json` + `text/html`，无 `text/plain`；HTML 属性内为转义 JSON，可见正文为空；粘贴到普通 input 不产生文本，画布节点数不变。
  - 复制文本节点后返回自定义 MIME + `text/plain` + `text/html`；`readText()` 为 81 字可读文本；粘到 input 与跨标签页 textarea 均得到同一文字，无 JSON。
  - 跨标签页画布粘贴：在临时项目第二标签页 Ctrl+V 得到 1 个选中文本节点，内容与复制源一致。
  - 右键粘贴：内部剪贴板仍有旧文本节点、系统剪贴板为新纯文本时，菜单粘贴创建的是新纯文本节点（节点数 1→2），未使用旧内部快照。
  - Ctrl+D：节点数 2→3，系统剪贴板仍为 `text/plain` 的 `SYSTEM_CLIPBOARD_MARKER`，未被覆盖。
- 未验证/待确认：
  - Firefox/Safari 的 ClipboardItem 类型支持与 `read()` 行为未在本机实测；HTML 兜底在剪贴板管理器/远程桌面下的属性保留情况未实测。用户已确认本次以 Chrome 157 走查为验收依据，上述作为后续兼容性验证项。
