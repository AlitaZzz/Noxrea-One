# Canvas Audio Peaks Cache

状态：已确认（2026-10-27 用户确认全部 7 项待确认事项；实现已完成，第九轮统一改造的浏览器走查与第十至十五轮审查修复已完成，其余验收项与提交待完成，见「当前状态」）

## 目标

音频节点的波形渲染从「wavesurfer 下载整个文件并自行解码」改为「一次 `decodeAudioData` 产出峰值 → 落 IndexedDB → 节点与截取面板共享 → 播放走 URL 直连」：

1. **一次解码**：同一音频文件在一次会话内只解码一次，节点与截取面板共享同一份 peaks。
2. **跨会话复用**：peaks 按内容身份落 IndexedDB，刷新/重开画布不再解码。
3. **播放与波形解耦**：wavesurfer 只负责绘制 peaks 与进度，播放交给独立的 `<audio>` 元素直连访问地址；签名 URL 轮换只改 `src`，不重建实例、不重绘波形、不重新下载。
4. **解码产物最小化**：解码期间不额外持有 Blob 副本（直接读为 `ArrayBuffer`），解码完成后只保留峰值数组，`AudioBuffer` 可回收；长音频的常驻内存从「8kHz 解码缓冲」降为「峰值数组」（1 小时立体声：约 230 MB → 约 450 KB）。

## 现状与动机（已验证事实）

- `AudioWaveform` 以 `url: accessUrl` 创建 wavesurfer（`web/src/features/canvas/nodes/AudioWaveform.tsx:88-104`），wavesurfer 内部 `fetchBlob` 全量下载（`node_modules/wavesurfer.js/dist/wavesurfer.js:321-336`）后 `Decoder.decode` 解码（`:366-371`），解码期间同时持有 Blob 与 arrayBuffer 两份压缩字节；解码结果 `AudioBuffer` 常驻实例（wavesurfer 默认 `sampleRate: 8000`，`wavesurfer.js:29`，立体声约 3.8 MB/分钟，1 小时约 230 MB）。
- **播放必须等整个文件下载完**：wavesurfer 先 `fetchBlob` 再 `setSrc`（`:321-341`），无法像 `<audio src>` 那样按 Range 边下边播。
- 实例重建依赖包含 `accessUrl` 与 `reloadToken`（`AudioWaveform.tsx:136`）：签名 URL 每次轮换都会 `destroy()` 并重新下载、重新解码。
- `AudioClipStripPanel` 另建一个 wavesurfer 实例并再次全量下载解码（`web/src/features/canvas/editing/AudioClipStripPanel.tsx:142-157`，文件头注释已说明「节点内的实例跨组件共享不可行」）。
- React Flow 未开启 `onlyRenderVisibleElements`（全仓库无该配置）：画布上每个音频节点都会下载并解码自己的文件，与是否可见无关。
- `web/src` 目前没有任何 `AudioContext` / `decodeAudioData` / peaks 相关实现。
- 已有 IndexedDB 先例：`web/src/lib/file-access-store.ts`（`idb`，DB `noxrea-file-access`，store `signed`，上限 500 条）。`idb` 已是现有依赖（`web/package.json:41`）。

## 业界对标（liblib.tv，2026-10-27 静态分析）

对 liblib.tv 画布的生产构建做静态分析（136 个 Next.js chunk 解压后检索）得到同构做法，作为方案参照：

- `audioPeaksPrefetcher.ts`：`fetch`（15s 超时）→ `AudioContext({ sampleRate: 8000 }).decodeAudioData`（15s 超时）→ 每 512 采样取绝对值最大、最多 2 声道、保留 4 位小数 → 写 IndexedDB（TTL 30 天、LRU 上限 500、空闲预热、过期清理）；`blob:` / `data:` URL 不落盘；解码队列串行、空闲调度、可整体取消（取消时关闭 AudioContext）。
- 音频组件用 `new Audio()` + `crossOrigin="anonymous"`，并以 `WaveSurfer.create({ media, peaks, duration })` 创建实例——**不传 `url`**，因此渲染波形不产生任何字节请求。
- 画布层按音频节点数在空闲时预热（`min(max(ceil(count*0.5),3), deviceMemory<=4?8:15)` 个）。

未验证：其 wavesurfer 实例池的借用路径未定位，本 Spec 不依赖该部分。

## 前提验证结论（wavesurfer.js 7.12.12 源码核对）

| 前提 | 结论 | 证据 |
| --- | --- | --- |
| 传入 `peaks` + `duration` 时完全跳过下载与解码 | 成立 | `wavesurfer.js:83-96`（`initialUrl \|\| (peaks && duration)` 触发 load）、`:321-336`（`if (!blob && !channelData)` 才 fetch）、`:363-371`（有 `channelData` 走 `createBuffer`） |
| `options.media` 使 wavesurfer 使用外部元素 | 成立 | `player.js:41-43`（`isExternalMedia = true`）、`:165-166`（destroy 时直接返回，不移除元素）、`renderer.js:67-69`（外部元素不追加进 shadow DOM） |
| 有 `peaks` 时 `getDuration()` 可用 | 成立 | `wavesurfer.js:445-451`（media 时长为 0/Infinity 时回退 `decodedData.duration`） |
| `setOptions({waveColor})` 只重绘不重解码 | 成立 | `wavesurfer.js:237-246`（无 `peaks`/`duration` 分支，直接 `renderer.setOptions`）、`renderer.js:233-249` → `:569-579`（`reRender` 用缓存的 `audioData` 重画） |
| peaks 长度与柱数无关（多于柱数时按桶取最大，少于柱数时拉伸） | 成立 | `renderer-utils.js:18`（`barIndexScale = width/spacing/length`）、`:49-92`（按 x 推进累计最大） |
| `Decoder.createBuffer` 要求 `duration > 0` 且声道非空 | 成立 | `decoder.js:45-79`（不满足直接抛错，wavesurfer 转成 `error` 事件） |
| 播放/暂停/seek 走外部媒体元素 | 成立 | `player.js:184-208`（`play`/`pause`/`isPlaying`/`setTime` 全部操作 `media`） |
| 传了 `duration` 时不等待媒体元数据即可渲染 | 成立 | `wavesurfer.js:343-351`（`staticDuration = duration \|\| this.getDuration()` 直接 resolve） |
| 流式后端支持 Range（seek 依赖） | 成立 | `server/http/routes/files.ts:125-161`（206 + `Content-Range`）、`server/http/file-response.ts:41`（`Accept-Ranges`） |

由此确定的硬约束：**peaks 未就绪时不得创建 wavesurfer 实例**。若此时 `<audio>` 已有 `src`，构造时的 `initialUrl` 非空，wavesurfer 会走 `load(url)` 并触发全量下载（`wavesurfer.js:83-96`、`:321-336`），正是本 Spec 要消除的路径。

## 范围

- 新增音频 peaks 服务与 IndexedDB 存储（`web/src/lib/audio-peaks/`，与 `lib/file-access/` 同为无业务语义的共享基础设施）：内存缓存 → IndexedDB → 解码三级取数，单飞与串行解码队列。
- 改造 `web/src/features/canvas/nodes/AudioWaveform.tsx`：wavesurfer 只接收 `media` + `peaks` + `duration`；实例生命周期与访问地址解耦。
- 改造 `web/src/features/canvas/editing/AudioClipStripPanel.tsx`：改走同一 peaks 服务与同一播放方式。
- 视频编辑面板的进度跟随统一到同一 `useMediaProgress`（2026-10-28 用户确认后实施）：`ClipStripPanel` / `FrameStripPanel` 不再各自维护 rAF，时间源抽为 `web/src/features/canvas/hooks/use-video-time-source.ts`（身份稳定，避免每次渲染重启循环）。
- `web/src/features/assets/components/AssetInspector.tsx` 复用 `AudioWaveform`，`web/src/features/canvas/nodes/AudioNode.tsx` 只传 props：两者随组件改造同步更新调用处——检查器仅把属性名改为 `audioRef`（无逻辑改动），节点增加回填时长的等值抑制（规则 4.6）。
- 测试：peaks 服务单测、`AudioWaveform` 与 `AudioClipStripPanel` 用例按新契约改写。

## 非目标

- 服务端生成 peaks 或新增接口（本 Spec 纯前端）。
- 画布虚拟化（`onlyRenderVisibleElements`）、音频节点按可见性预取。
- 音频节点 UI 重设计、波形样式调整。
- 视频/图片的访问与缓存路径（沿用既有 Spec）。
- 不保留 wavesurfer 的 `url` / `fetchBlob` 路径：不传 `url` 后它自然不存在，也不加「有 peaks 就用 peaks、没有就退回 url」的兼容分支——退回即恢复全量下载。

## 业务规则

> 本节已按 2026-10-27 的确认结论定稿，并于 2026-10-28 按根因修复修订规则 1.4 / 2.7 / 3.4 / 4.6 / 4.7（用户已确认，见文末「确认结论」与「与 Spec 的实现偏差」3–7），下文即为实现契约。

### 1. peaks 服务（唯一入口）

1.1 输入是**逻辑引用值**（存储 key、托管 URL、外部 `http(s)` URL），不接受已解析的签名地址——缓存键与解码都基于逻辑值，调用方不得先解析再传入。现有调用方传的正是这类值（`AudioNode` 传 `fileRefUrl(src)`、检查器传 `asset.fileKey`），无需改签名。

缓存键复用解析层已有的归一化（`file-access/protocol.ts` 的 `requestOf`：剥片段 → `resolveFileUrl` → `getManagedStorageKey`）：

- 托管值（`requestOf` 非 null）：取 `request.key`（含 `userId` 前缀），同一文件经 key 或托管 URL 引用时命中同一条记录。`requestOf` 同时解析出的 `w` / `download` / `filename` 与音频无关，不进入缓存键。
- 非托管值：再按协议分流——`http(s)` 用原值作键（只进内存，见 3.5）；`blob:` / `data:` 及其他畸形值不缓存、不解码，直接返回不可用（`blob:` 的生命周期绑在创建它的文档上，`data:` 不是可复用的内容身份）。

托管判定单点在 `requestOf`（它内部已经过 `resolveFileUrl` + `getManagedStorageKey`），服务不另写一遍「是不是托管值」的判定；协议分流只在非托管分支发生。

1.2 取数顺序：内存缓存 → IndexedDB → 解码。命中内存或 IndexedDB 时 peaks 路径不发起任何网络请求（包括访问描述请求）；播放路径的请求不受影响。未命中时 peaks 服务与 `useFileAccessUrl` 走同一个描述缓存（`lib/file-access` 的模块级缓存与批处理），同一文件在冷启动时也只产生一次描述请求；一次 `loadAudioSource` 只解析一次地址，元数据探测与字节请求复用同一份解析结果，只有字节请求返回 401/403/404 时才强制重新描述一次（规则 6.2）。

1.3 单飞：同一 key 的并发请求合并为同一个 Promise，节点与截取面板同时打开只解码一次。

1.4 解码串行：全局并发 1，FIFO（按**进入解码队列**的顺序，即取数完成的先后；不按可见性重排）。队列里只有 `decodeAudioData` 与峰值抽取：取址、探测与字节读取是 I/O，在队列外并发，一个慢下载不得把其他文件的波形堵在它后面；单个文件失败不阻断后续任务。解码是 CPU/内存重操作，多节点同时挂载不得并行解码。（2026-10-28 按根因修复调整并经用户确认，修订确认结论 5 的「按挂载顺序」，见「与 Spec 的实现偏差」4。）

1.5 消费者卸载不取消已在执行的解码（结果会入缓存，取消会波及其他消费者）；订阅随组件卸载解除。

### 2. 解码规格

2.1 `new AudioContext({ sampleRate: 8000 })` → `decodeAudioData(arrayBuffer)`，`finally` 中 `close()`（异常路径也必须关闭，避免 AudioContext 泄漏）。8kHz 是内存上界的来源（1 小时立体声解码缓冲约 230 MB，见「现状与动机」）；构造失败按解码失败处理，不回退到更高采样率——回退会让时长上限失去意义。

2.2 峰值抽取：每 512 个采样为一个桶，取桶内绝对值最大；最多取前 2 个声道；结果落在 `[-1, 1]`。

2.3 时长取 `AudioBuffer.duration`；`duration <= 0` 或声道为空按解码失败处理（wavesurfer 的 `createBuffer` 不接受这类输入）。

2.4 峰值以 `Float32Array` 保存。交给 wavesurfer 时传副本（`slice()`），缓存内的数组视为不可变：wavesurfer 的 `createBuffer` 会调用 `normalize`，对越界值**就地**除以最大值（`decoder.js:26-42`）。本 Spec 的峰值天然落在 `[-1, 1]`，该分支不会触发，但副本切断这层隐式耦合，缓存不被渲染层的行为左右。

2.5 两道闸门都必须在**解码前**判定，因为 `decodeAudioData` 一次吃下完整 `ArrayBuffer`，解码期间的内存只由时长与采样率决定，事后判定已经来不及：

- **时长闸门**：取到访问地址后先用一个脱离文档的 `<audio preload="metadata">` 探测时长（只取容器头部，不读全量；与播放同一套编解码支持），超过上限即停止，不读全量字节、不进入解码。探测元素是临时的、用完即弃，与播放元素互不复用（服务不依赖任何消费方的元素），**成功、超限、超时、出错四条路径都必须 `removeAttribute("src")` + `load()` 收尾**，否则探测元素可能在后台继续缓冲。它同样不设 `crossOrigin`：同源请求默认带 cookie（对应 `stream → include`），跨域请求默认不带凭据（对应 `signed → omit`），与规则 6.1 的映射自然一致，无需额外处理。**未验证假设**：各浏览器对 `preload="metadata"` 的实际请求量不同（多数只发一次小 Range），本 Spec 不依赖其字节数，只依赖它不触发全量下载。
- **字节闸门**：流式读取压缩字节并累计，超过上限立即中止、不进入解码（拦住高码率 / 未压缩的短文件——它们过得了时长闸门，但字节数与解码后内存都不小）。响应带 `Content-Length` 时先看长度，超限直接中止、一个字节都不读（stream 路径由 `server/http/file-response.ts:40` 给出该头；S3 对象 GET 按 HTTP 语义也应带，**未在本仓库验证**）。没有该头时退回累计计数。

两道闸门缺一不可：只有字节闸门时，32 kbps 的 3 小时音频仅 43 MB，解码却要约 690 MB；只有时长闸门时，5 分钟的 WAV 就能超过 50 MB。探测得不到有限时长（`NaN` / `Infinity`，如流式容器或头部损坏）按超限处理——宁可没有波形，也不冒解码内存风险；播放不受影响。

2.6 解码成功后立即丢弃 `ArrayBuffer` 与 `AudioBuffer` 引用；只有峰值数组进入缓存。

2.7 超时按阶段设，不用一个总时限盖住下载：下载时长由文件体积与用户带宽决定（48 MB 在 1 Mbps 下要 6 分钟），给下载设总时限会让慢网用户永远看不到波形。

- 取地址（描述请求）：10 秒。描述悬挂会无限期占住该文件的单飞条目，用户重开也等不到结果。
- 元数据探测：10 秒。
- 字节读取：**停滞超时**（默认 20 秒内没有任何新字节即中止），不设总量时限；上限由字节闸门控制。
- 解码：30 秒。

取址超时、探测超时与读取停滞都中止在途请求（`AbortController`）；解码超时则中止等待并关闭 `AudioContext`。四种结果都不缓存，下次打开可重试——与「同一输入重复解码不会改变结果」的失败不同，超时是环境问题。取址超时为 2026-10-28 补充并经用户确认（规则原列举未含取址，原因见「与 Spec 的实现偏差」3）。

### 3. 存储

3.1 独立数据库 `noxrea-audio-peaks`，store `peaks`，主键为存储 key（`{userId}/{hash[:2]}/{hash}{ext}`，内容寻址，同 key 内容恒定）。

3.2 记录形状：`{ key, channels: Float32Array[], duration, savedAt, lastUsedAt }`，索引 `by-used`（`lastUsedAt`）。持久层只按条数 LRU 淘汰（3.4），不记录字节数：内存缓存的字节预算由服务层按峰值数组现算，落盘记录里没有消费方读取该字段（2026-10-28 审查修复移除原 `bytes` 字段，见「与 Spec 的实现偏差」7）。

3.3 与 `noxrea-file-access` 分开建库：两者的生命周期不同（描述是能力凭据、登出清空；peaks 是内容派生物、登出保留），混在一个库里会把两种清空语义绑死。

3.4 容量上限按条数 LRU 淘汰（500 条，与描述缓存同量级）；写入与命中都更新 `lastUsedAt`。不设 TTL：键是内容寻址的，同一 key 的峰值永远不变，过期只由容量淘汰决定。本条约束持久层；内存缓存另设 32 MiB 字节预算（单条峰值最大约 150 KB，500 条满长条目约 75 MB，条数上限挡不住该量级），条数与字节任一超限即淘汰最旧条目。

3.5 只有托管值（存储 key / 托管 URL）落盘。外部 `http(s)` URL 只进内存缓存：URL 不是内容身份，其背后内容可变，按 URL 落盘会把旧波形永久固化。`blob:` / `data:` 不缓存。

3.6 任何 IndexedDB 故障（隐私模式、配额、升级失败）按「无持久化」处理，退化为内存缓存，正确性不受影响。读取时校验记录形状与主键：`channels` 必须是非空的 `Float32Array` 数组，`duration` 必须是有限正数，其余数值字段必须有限；形状不符或主键不一致的记录按未命中处理，交由取数 / 解码路径覆盖。IDB 是外部存储，旧版本、被截断或手工改坏的记录不得进入服务层——否则 `peaksBytes` 之类的纯函数会在 `getAudioPeaks` 内抛出，破坏「服务入口永不抛出」的契约。

3.7 账号切换不清空 peaks：记录以完整存储 key 为主键，天然按账号隔离，且 peaks 不是凭据。

### 4. 波形渲染与播放解耦

4.1 wavesurfer 实例只以 `{ media, peaks, duration }` 创建，**永不传 `url` / `fetchParams`**。`media.src` 在创建前后写入都安全：有 `peaks` 时 `load` 不 fetch（`wavesurfer.js:321`），`setSrc` 遇同地址直接短路（`player.js:134-137`）。

4.2 `<audio>` 元素由组件用 `document.createElement("audio")` 命令式创建并持有（与 wavesurfer 内部自建元素同一形态，不进入 React 渲染树，也不挂进 DOM——`<audio>` 脱离文档仍可播放，wavesurfer 传入 `media` 时也不接管元素归属，`renderer.js:67-69`）：`preload="metadata"`，不设 `crossOrigin`（不读像素、不用 analyser，不引入无谓的 CORS 依赖）。`src` 只经 ref 命令式写入；不得把元素放进 JSX、不得用 `key` 重挂——wavesurfer 的媒体事件监听绑在这个元素上，重挂会让监听失效（`AudioRefCard` 的 `key={reloadToken}` 写法不适用于本组件）。

4.3 挂载地址在三种情况下变化：元素加载失败后重新描述得到新地址、换源、或地址被作用域作废（会话切换 / 登出）。前两种变化只写 `media.src`；会话切换把地址置空（`src → null`）时清空 `src` 并 `load()`，旧账号的音频不得继续留在播放元素上。`reloadToken` 变化且地址未变时调用 `media.load()` 强制重载。三种情况都不重建 wavesurfer 实例、不重新解码、不重绘波形。规则 3.8 的主动刷新按设计不改变挂载地址（只更新缓存与 `proactiveRef`），因此正常 TTL 轮换根本不触碰 `src`，播放不中断。

4.4 实例生命周期由「逻辑源 + peaks 身份」决定：peaks 就绪后创建；换源（peaks 身份变化）时销毁重建；`nodeId` 变化只影响注册表登记。peaks 缺失时渲染占位，不得提前创建实例（见「前提验证结论」的硬约束）。

4.5 **播放由媒体元素直接驱动，wavesurfer 只做渲染**：播放/暂停/定位/当前时间/结束/错误一律读写 `media`，不依赖 wavesurfer 实例是否存在。理由：peaks 不可用时仍要能播放（见「异常与边界」），若播放走 `ws.play()`，波形失败就会连带播放失效；且 `wavesurfer.getCurrentTime()` 本就只是 `media.currentTime` 的转发（`player.js:214-216`），没有额外价值。

组件自己的媒体事件监听（`play` / `pause` / `ended` / `timeupdate` / `loadedmetadata`，节点与面板共用 `useMediaPlaybackMirror` 做事件 → 状态映射，订阅原语是 `useMediaEvents`）驱动的是「必须不依赖波形」的那部分 UI（播放按钮图标、时间文本、竖线位置、时长回填）；`error` 不在这组里——它属于规则 4.7 的重描述路径，由 `useAudioElement` 内部订阅。wavesurfer 侧无需额外接线：它的 player 构造时就订阅了同一个媒体元素的 `timeupdate` / `play` / `pause` / `ended`（`wavesurfer.js:120-148`），实例存在时进度层与 `finish` 事件照常工作；两条监听互不干扰。

进度竖线在播放期间由共享 Hook `useMediaProgress`（`web/src/lib/use-media-progress.ts`）逐帧读取 `media.currentTime` 推进：`timeupdate` 只有约 4Hz，只靠它会让竖线视觉跳步；Hook 只在时间变化超过 0.003s 时回调进度，静止时不启动循环、也不产生渲染。节点与截取面板共用同一实现，面板另用其每帧回调执行循环约束（规则 5.2）。

4.6 三个状态彼此独立，不得互相牵连：

- `accessFailed`：访问描述失败——整组件失败态，沿用现有覆盖层与手动重试（`refresh`）。
- `mediaFailed`：媒体元素 `error`——按规则 4.7 重描述一次，仍失败才进入失败态（现有覆盖层）。
- `peaksStatus`（即 Hook 的 `status`）：`loading` / `ready` / `unavailable`——决定波形区形态（占位沿用现有空白，不加静态占位条）与时长回填的上报时机（落定后上报，规则 4.6），不影响播放按钮与进度光标。

播放按钮的可用条件是「时长已知且媒体未失败」，再叠加现有的 `clipActive` 锁（截取面板打开期间禁用节点播放），波形是否绘制不参与该判断。另有一条硬前置：访问地址必须已就绪（`useAudioElement` 的 `src` 非空）——元素没有 `src` 时 `play()` 只会以 `NotSupportedError` 拒绝，按钮亮着却不出声；截取面板的 `operable` 同样包含这一条。进度光标同样不依赖波形：它与播放按钮共用 `playable`（时长已知、地址就绪、媒体未失败），拖动直接写 `media.currentTime`。「时长已知」只指 peaks 服务已知的时长或播放元素 `loadedmetadata` 所得的时长；节点已存的 `data.duration` 是上一轮回填的显示值，只用于底部时间文本兜底，不作为可播、seek 或进度的依据（它不证明播放元素已加载元数据，据此定位必然落空）。`onReady(duration)` 每个源只回调一次，且在 peaks 状态落定后上报：ready 取 peaks 时长，unavailable 取 peaks 服务已知的探测时长（没有探测结果时再取媒体元数据，尚未到达则等待）；来源优先级见 5.3。「每个源一次」是组件契约：同一实例换源后重新上报，落定时长与 `duration` prop 相等也照常上报；等值写入的抑制属于消费方的写入决策（`AudioNode` 在 `updateNodeData` 前比较），组件不因 prop 已相同而吞掉回调。

4.7 媒体元素加载失败沿规则 3.6 的重描述路径调用 `retrySigned()` 一次，由 `reloadToken` 重载媒体元素。预算按**逻辑源的一个失败回合**计，不按签名地址计——服务端每次都会签出新地址，按地址计会让重试无限循环。`retrySigned()` 返回 `null`（stream / 外部地址 / 其内部按失败地址计的预算已用尽）或重新签出的地址再次失败即进入 `mediaFailed`；`loadedmetadata` 成功（当前地址确定可用）或换源后重新武装一次预算。重描述在途时换源 / 换址 / 重挂的迟到失败不得记到新状态上。

4.8 卸载时组件自行收尾：`ws.destroy()` 对 `options.media` 的外部元素只解绑事件、随后直接返回，**不会暂停也不会移除**（`player.js:157-166`）。因此卸载必须先 `media.pause()`，再 `removeAttribute("src")` + `load()` 中止在途网络请求。遗漏会让节点删除后音频继续播放（与 `AssetCard` 曾出现的「翻页后仍在响」同类）。

### 5. 消费方

5.1 `AudioWaveform`（画布节点、资产检查器）与 `AudioClipStripPanel` 共用 peaks 服务；两者各自持有 wavesurfer 实例与媒体元素（跨组件共享实例不可行，原注释结论不变）。

5.2 截取面板同样只把 wavesurfer 当渲染器：`ready` 改由 peaks 就绪驱动，`duration` 与选区初始化改由 peaks 时长驱动，试听播放、`setTime`、`getCurrentTime`、`isPlaying`、`error` 全部改为直接操作面板自己的媒体元素；循环约束（共享进度 Hook 的每帧回调 + `timeupdate` + `ended`）与 `usePlaybackBlocked` 的语义不变，只是数据源从 wavesurfer 改为媒体元素。进度跟随与循环约束共用同一个 rAF 循环（规则 4.5），不各起一份。播放注册表（`audio-playback-registry.ts`）的契约由 `WaveSurfer` 收窄为最小播放句柄 `{ getCurrentTime(): number; pause(): void }`：节点注册由媒体元素支撑的适配对象，`pauseAudio` / `getAudioPlaybackTime` 的调用方不变。这样注册表不再依赖 wavesurfer，也不再要求波形实例存在。

5.3 节点 `data.duration` 仍由 `onReady` 回填（`skipHistory`），来源优先级：peaks 服务已知的时长 → 媒体元素 `loadedmetadata` 的 `duration` → 0。末位的 0 只是底部时间显示的兜底，不通过 `onReady` 上报——0 表示时长未知，规则 4.6 的「尚未到达则等待」优先。

- 「peaks 服务已知的时长」不只是解码成功时的 `AudioBuffer.duration`：规则 2.5 的元数据探测无论判定为超限还是正常，探测到的时长都随结果返回（`useAudioPeaks` 的 `duration` 在 `status` 为 `unavailable` 时也可能有值）。这样超限降级时不必让播放元素再探测一次。
- 兜底来源 `loadedmetadata` 用的是播放元素自身的元数据（`preload="metadata"` 只取头部，不整文件下载）。

资产检查器的本地 `audioDuration` 同理。缺少时长会让节点标题栏与进度显示退化，不能因波形不可用而丢失。

5.4 截取面板在 peaks 不可用时不可操作（面板的全部交互都建立在波形时长与选区之上）；面板内显示波形不可用提示，而不是让用户对着空白轨道拖动。节点自身的播放不受影响。

### 6. 访问凭据

6.1 peaks 的字节请求经 `resolveMediaUrlWithRetry` 取地址、`credentialsForDelivery` 取凭据模式（`signed → omit`，`stream → include`），与 `web/src/features/canvas/editing/client-media/client-video.ts:48-52`（`mediaSourceOf`）同一条规则，不另写三元式。

6.2 字节请求返回 401/403/404 时，`forceRefresh` 重新描述一次并重试一次；仍失败进入波形不可用（不影响播放）。其他状态码直接进入波形不可用。重试预算按**一次加载**计：每次 `loadAudioSource` 最多强制重描述一次，重签出的新地址再失败即不可用——与媒体元素「每逻辑源每失败回合一次」同口径；不按地址循环（服务器每次都会签出新地址，按地址计会无限重试）。

这里的 401 与「描述失败」不同：字节请求的 401 只说明这次签名/凭据不被接受，不影响播放路径的尝试，因此不升级为整组件失败态（区别于规则 4.6 的 `accessFailed`）。

## 技术影响

新增 `web/src/lib/audio-peaks/`（与 `lib/file-access/` 同为无业务语义的共享基础设施，符合 `web/AGENTS.md` 八.1 的分层）：

- `index.ts`：取数编排（内存 → IDB → 取数 → 解码）、缓存键（`requestOf` 归一）、单飞表、仅解码的全局串行队列（并发 1）、时长与字节上限、内存缓存（500 条 / 32 MiB，见规则 3.4）。
- `decode.ts`：`loadAudioSource`（取地址（`resolveMediaUrlWithRetry` + `credentialsForDelivery`）→ 元数据探测时长（超限即止）→ 流式读取并累计字节（超限或停滞中止））与 `decodeAudioPeaks`（`decodeAudioData` → 峰值抽取 → 释放缓冲）两段：取数在解码队列外并发，解码是队列内的唯一步骤（规则 1.4）。失败分类：取数链路兜底的非预期异常归为 `internal`（环境类，不进终止记忆；取址边界统一归为 `network` / `timeout`，见「与 Spec 的实现偏差」9），解码阶段归为 `decode_failed`（内容层面的确定失败）。
- `store.ts`：IndexedDB 读写、读取边界的记录形状 / 主键校验与 LRU 淘汰；打开失败退化与游标淘汰走共享 `web/src/lib/idb-cache.ts`（与签名描述缓存同一份实现）；任何 IDB 故障或畸形记录都退化为未命中。
- `use-audio-peaks.ts`：React Hook（`{ peaks, duration, status }`），首帧同步读内存缓存，未命中再异步加载；`duration` 在 peaks 不可用时也可能有值（元数据探测所得，见规则 5.3）。不提供手动 `retry`：终止性失败（`decode_failed` / `too_large`）在同一会话内记在内存失败表——组件重挂不重试、刷新页面即重试（只覆盖托管值；外部 URL 的内容不是内容身份，失败不入记忆、重挂即重试，见「与 Spec 的实现偏差」10）；环境类失败（`network` / `timeout` / `internal`）不进入失败记忆，重挂即重试（见「异常与边界」）。本轮实现无消费方需要手动重试；`error` 原因码没有消费方，不进入 Hook 返回值（见「与 Spec 的实现偏差」5）。
- `web/src/lib/use-media-progress.ts`：节点波形、音频截取面板与视频编辑面板共用的播放进度逐帧跟随（rAF）：时间源以读取函数注入（音频读媒体元素，视频面板读播放注册表），只在时间变化超过 0.003s 时回调进度，可选每帧回调供面板执行循环约束；未激活或时间源未就绪（读取返回 `null`）时不启动循环，卸载取消在途帧；读取函数身份变化视为换源，循环以新源当前值重启。
- `web/src/lib/use-media-events.ts`：节点与截取面板共用的媒体元素事件订阅：监听只挂一次，回调每次渲染更新到 ref（闭包里的时长、选区不会过期）；`play` / `pause` / `ended` / `timeupdate` / `loadedmetadata` 五个事件全部订阅，回调出现或消失不改变订阅表。
- `web/src/features/canvas/hooks/use-video-time-source.ts`：视频两面板共用的进度时间源——把播放注册表读取包成身份稳定的回调交给 `useMediaProgress`；内联箭头函数每次渲染换身份会重启 rAF 循环。
- `web/src/lib/use-media-playback-mirror.ts`：节点与截取面板共用的「媒体事件 → 播放镜像」映射（`playing` / `progress` / `duration`）：哪个事件改哪个字段、非有限时长与 0 不覆盖已知时长、按逻辑源换源作废（`useElementMirror` 身份记账）只写一处；面板额外的循环约束（`timeupdate`）与结束续播（`ended`）通过 `extras` 在同一事件处理的 patch 之后执行（附加回调需要的是事件时机，不是更新后的镜像值）；`reportProgress(time)` 是逐帧进度（`useMediaProgress`）的统一回写入口——与 `timeupdate` 写同一个 progress 维度，规则只在这里定义。

修改：

- `web/src/features/canvas/nodes/AudioWaveform.tsx`：拆成「媒体元素与播放（地址同步、事件监听、卸载收尾）」「wavesurfer 实例（随 peaks 就绪创建，只做渲染）」「主题重绘」三部分；实例创建与主题重绘走共用工厂 `shared/audio-waveform-instance.ts`，「peaks 就绪才创建」这条硬约束与其生命周期由同一模块的 `useAudioWaveformInstance` 收口；移除 wavesurfer 的 `url` / `fetchParams` 选项，组件属性 `url` 更名 `audioRef`（它一直是逻辑引用值，与截取面板同名）；已知时长（可播 / seek / 进度）与显示时长（底部文本兜底）分开，按规则 5.3 的来源优先级；播放进度由 `useMediaProgress` 逐帧跟随，播放态镜像走共享 `useMediaPlaybackMirror`；`onReady` 按源去重且不做等值抑制（规则 4.6）；新增「波形不可用」占位态（不影响播放）。
- `web/src/features/canvas/editing/AudioClipStripPanel.tsx`：同一改造，`ready` 与时长取自 peaks，波形实例走同一工厂与同一 Hook（固定白色）；进度跟随与循环约束共用 `useMediaProgress` 的同一个 rAF 循环；播放镜像走共享 `useMediaPlaybackMirror`，循环约束的 `timeupdate` 后备与 `ended` 续播作为 `extras` 放在同一事件处理内。
- `web/src/features/assets/components/AssetInspector.tsx`：无逻辑改动；`AudioWaveform` 属性更名后调用处同步改为 `audioRef`（值仍是逻辑引用值，与规则 1.1 的输入一致）。
- `web/src/features/canvas/nodes/AudioNode.tsx`：组件契约不变，仅增加消费方写入决策——回填 `duration` 前与当前值比较，等值时跳过 `updateNodeData`，避免无意义的画布重渲染（规则 4.6）。
- `web/src/features/canvas/shared/audio-playback-registry.ts`：注册类型由 `WaveSurfer` 收窄为最小播放句柄（规则 5.2）。
- `web/src/lib/file-access-store.ts`：只做等价替换——本地 `db()` / `trim()` 换成共享 `createCacheDatabase` / `trimOldestEntries`，行为与库名、版本、store / index 定义均不变（第四轮审查消除重复实现）。

测试：

- 新增 peaks 服务单测：解码规格（8kHz / 512 桶 / 2 声道 / 时长）、结果形状只含 `channels` / `duration`、单飞、IDB 命中不发请求、外部 URL 不落盘、正常路径只解析一次地址、403 重描述一次、取数阶段非预期异常归为 `internal` 且不落终止记忆；新增持久层单测：openDB 失败、读 / 写 / 刷新 / 淘汰异常降级、记录形状与主键校验。
- 新增 `use-media-progress` 单测：未激活 / 时间源未就绪（读取返回 `null`）不启动、卸载取消、阈值去重、每帧回调、进度回调先于每帧回调、回调身份变化不重启循环、读取函数身份变化视为换源并以新源当前值重启。
- `web/src/__tests__/features/canvas/nodes/AudioWaveform.test.tsx`：断言创建参数含 `media` / `peaks` / `duration` 且不含 `url`；签名地址变化不重建实例、不重复解码；`reloadToken` 只触发 `load()`；`onReady` 按源一次、换源重报、与 prop 等值仍上报。
- `web/src/__tests__/features/canvas/editing/AudioClipStripPanel.test.tsx`：同一契约。
- `web/src/__tests__/test-utils/audio-fixtures.ts`：组件与 Hook 测试共用的峰值身份、峰值状态（`READY_PEAKS` / `LOADING_PEAKS`）、媒体元素捕获与 jsdom 媒体桩，避免多份测试各自维护。
- `web/src/__tests__/test-utils/file-access-mock.ts`：`mutableFileAccessState(url)` 提供可改写的访问状态（`reset()` 回默认、`set()` 改单项），组件与 Hook 测试不再各自复制默认值。

不新增依赖。

## 与现有 Spec 的关系

- `specs/storage-signed-direct-delivery.md` 规则 3.1（凭据映射）、3.6（重试闩锁）、3.8（主动刷新不打断已挂载媒体）继续适用；本 Spec 让 3.8 的「不打断」在音频上真正成立（此前重建实例必然打断）。
- `specs/canvas-image-http-url-rendering.md` 的取向（字节交给浏览器缓存，不常驻内存）在音频上的对应实现。

## 异常与边界

| 情况 | 行为 |
| --- | --- |
| 访问描述失败 | 现有失败覆盖层 + 手动重试（`refresh`），与改造前一致 |
| 字节请求 401/403/404（签名过期 / 对象已删） | 强制重新描述一次后重试一次，仍失败进入波形不可用；播放路径独立判定（规则 6.2） |
| 跨域桶未配置 CORS（signed 后端） | peaks 的 `fetch` 失败 → 波形不可用占位；`<audio>` 不带 `crossOrigin`，播放不受影响。波形依赖 CORS 而播放不依赖，这是两条独立路径，不得把播放一起降级 |
| 压缩字节超过上限 | 流式读取中途中止，波形不可用占位，播放保留（规则 2.5 字节闸门） |
| 音频时长超过上限 | 元数据探测后即停止，不读全量字节、不解码，波形不可用占位，播放保留（规则 2.5 时长闸门） |
| 元数据探测失败 / 探测超时 | 不进入解码，波形不可用占位；播放仍由 `<audio>` 自行尝试（规则 2.7） |
| 字节读取停滞超时 | 中止读取，波形不可用占位；结果不缓存，下次打开重试（规则 2.7） |
| 解码超时 | 中止并关闭 AudioContext，波形不可用占位；结果不缓存，下次打开重试（规则 2.7） |
| 解码失败（编码不支持 / 数据损坏） | 波形不可用占位；`<audio>` 仍尝试直连播放（能播则播）。不缓存失败结果，同一会话内不自动重试（重复解码不会改变结果），刷新页面可重试；会话记忆只覆盖托管值——外部 URL 内容可变，失败不入记忆、重挂即重试（见「与 Spec 的实现偏差」10） |
| 取数阶段非预期异常（内部错误） | 归为 `internal`，波形不可用占位；按环境类处理，不进入终止性失败记忆，下次挂载重试。不得伪装成 `decode_failed` 后在会话内永久记忆。取址边界（`resolveWithTimeout`）的异常统一归为 `network` / `timeout`，同为环境类（偏差 9） |
| IndexedDB 不可用 / 记录形状不符 | 故障退化为内存缓存（仅本次会话有效）；形状不符的记录按未命中处理，交由取数 / 解码路径覆盖 |
| 同一文件节点 + 面板同时打开 | 一次解码，两处共享 peaks |
| 画布上多个音频节点同时挂载 | 取数并发，解码串行：按进入解码队列（取数完成）的先后排队，一个慢下载不阻塞其他文件的解码 |
| 组件在解码途中卸载 | 解码继续完成并入缓存；订阅解除 |
| 账号切换 | peaks 保留（按存储 key 隔离），不误用他人内容 |

## 验收标准

1. 打开含 1 个音频节点的画布：波形只产生 1 次完整字节请求（解码用的 `fetch`），外加元数据探测的小 Range 请求；`<audio>` 播放路径只发元数据/Range 请求；不再出现 wavesurfer 的全量下载。
2. 刷新页面（IndexedDB 命中）：波形渲染不产生任何字节请求（访问描述请求与 `<audio>` 的元数据/Range 请求除外）。
3. 节点与截取面板先后打开：`decodeAudioData` 只调用 1 次。
4. 签名地址轮换（TTL 到期重新描述）：不调用 `decodeAudioData`，不重建 wavesurfer 实例，波形不重绘，播放不中断（规则 3.8）。
5. 解码完成后，服务层公开的结果只含峰值数组与时长（不携带压缩字节或 `AudioBuffer`）；字节与解码缓冲在解码函数返回后不再被引用（释放由实现结构保证，GC 时机不属于单测断言范围）。
6. 超过时长上限或字节上限的音频：都不进入解码，显示占位波形且播放可用。
7. 解码失败：显示波形不可用占位，不出现未捕获异常，AudioContext 已关闭。
8. 现有测试通过；新增用例覆盖规则 1–4 的关键路径。

浏览器走查（与既有 Spec 同口径，由用户确认完成）：真实 signed 桶上打开含音频节点的画布，在 DevTools Network 面板核对第 1、2、3 条的实际请求序列；解码失败与超限两种情况用构造文件验证占位与播放可用。

## 待确认事项

无。业务规则、接口契约与技术方案均已确认（见「确认结论」）；验收标准 1–7 的浏览器走查属于验收进度，由用户在「当前状态」中确认完成情况，不是待确认决策。

## 确认结论（2026-10-27）

用户确认全部按 Spec 建议采纳：

1. **峰值规格**：8kHz 解码、512 采样/桶、最多 2 声道——采纳（规则 2.1 / 2.2）。
2. **容量上限**：IndexedDB 500 条 LRU，不额外按总字节淘汰——采纳（规则 3.4）。原「`bytes` 仅作观测」字段已于 2026-10-28 审查中移除：落盘记录没有消费方读取它，内存字节预算由服务层按峰值数组现算（规则 3.2，见「与 Spec 的实现偏差」7；该移除已于 2026-10-28 经用户确认）。
3. **时长/字节上限**：时长 ≤ 20 分钟、压缩字节 ≤ 48 MB，超限降级为「占位波形 + 可播放」——采纳（规则 2.5）。
4. **外部 URL**：peaks 只进内存、不落盘——采纳（规则 3.5）。
5. **解码并发**：全局串行 1，按挂载顺序，不按可见性重排——采纳（规则 1.4）。2026-10-28 按根因修复修订并经用户确认：取数移出队列，排序改为按进入解码队列的顺序（规则 1.4 / 实现偏差 4）。
6. **占位形态**：沿用现有的空白，不加静态占位条——采纳（规则 4.6）。
7. **加载中取消**：消费者全部卸载时不中止在途解码——采纳（规则 1.5）。

## 当前状态

Spec 已确认（2026-10-27）。实现已完成并通过静态检查与全部自动化测试；「与 Spec 的实现偏差」3–7 已于 2026-10-28 经用户确认并回写规则（其中 4 修订确认结论 5；7 于第三轮审查后确认）；规则 6.2 的重试预算措辞已按实现修正为「每次加载最多一次强制重描述」（2026-10-28 用户确认）。2026-10-28 代码审查修复：取数阶段的非预期异常改归 `internal`（环境类，不落终止记忆），IDB 读取增加记录形状 / 主键校验（畸形记录按未命中），会话切换清空播放元素地址的行为回写规则 4.3。2026-10-28 第三轮审查修复：抽取共享 `useMediaProgress`（节点与面板共用同一个 rAF 进度循环）、持久化记录移除无消费方的 `bytes` 字段（偏差 7，已于 2026-10-28 经用户确认）、`onReady` 的等值抑制下沉到消费方 `AudioNode`、`loadAudioSource` 的探测与字节请求复用同一份地址解析、组件与 Hook 测试改用共享夹具并补充结果形状 / 单次解析 / 等值上报用例。2026-10-28 第四轮审查修复（根因，无补丁）：IDB 打开与游标淘汰骨架抽到共享 `idb-cache.ts`（峰值缓存与签名描述缓存共用，消除本功能引入的重复实现）、`AudioWaveform` 的播放态镜像改用共享 `useElementMirror` + `IDLE_PROGRESS_PLAYBACK`、面板的逐帧跟随只在播放中运行（规则 4.5，暂停时 rAF 不空转）、移除无消费方的 `PeaksError` 再导出、补齐面板侧三条实例契约用例（峰值未就绪不创建 / 地址轮换不重建 / `reloadToken` 只重载元素）、规则 4.6 的时长来源措辞与 5.3 对齐（探测时长优先，无探测结果再取媒体元数据）。2026-10-28 第五轮审查修复（根因，无补丁）：元素事件订阅抽到共享 `use-media-events.ts`（节点与面板的 add / remove 形状逐行相同，订阅语义只写一处）、面板失败态归为一处 `failureKind`（原「失败」判断在可操作性与提示分支各写一遍）、解码失败的归类不再借 `decodeFailureOf` 探值、`PeaksRecord` 导出供测试复用（测试不再复制记录形状）、`PeaksTarget` / `FailedCoordinates` / `reportableDuration` 命名回正、规则 5.3 末位「0」注明只作显示兜底、不通过 `onReady` 上报。2026-10-28 第六轮审查修复（根因，无补丁）：测试里重复的访问状态脚手架抽为 `mutableFileAccessState`（组件与 Hook 测试不再各自复制默认值），峰值状态抽为 `READY_PEAKS` / `LOADING_PEAKS`；「写入后按索引淘汰」抽为 `putAndTrim`（峰值缓存与签名描述缓存共用）；`AudioWaveform` 属性 `url` 更名 `audioRef`（值一直是逻辑引用值，与截取面板同名，`AudioNode` / `AssetInspector` 同步）；规则 4.5 的事件枚举与 4.6 的进度光标条件按实现回写（`error` 由 `useAudioElement` 订阅，光标与播放按钮共用 `playable`）。2026-10-28 第七轮审查修复（根因，无补丁）：实例创建与「peaks 就绪才创建」的硬约束收口到 `audio-waveform-instance.ts` 的 `useAudioWaveformInstance`（两个组件的 effect 逐行同构，生命周期语义只写一处）；取数阶段的失败归类抽为 `sourceFailureOf`，与解码阶段的 `decodeFailureOf` 对称（未预期异常不再在 `loadAudioSource` 两处内联重复）；持久层读取与刷新使用时刻共用 `isUsableRecord`（「什么算命中」只写一处）；`useAudioPeaks` 的卸载用例改为断言可证伪的契约（不传中止信号、只取数一次、迟到结果照常落定），原用例只断言 Promise 已落定、无法证伪其声称的行为；针对审查提出的 A→B→A 换源竞态补回归用例（实测未复现：`entry.source` 只在结果落定或内存命中时才被置为该源，切回未就绪的源时 effect 会重新订阅）；补齐「待确认事项」章节。2026-10-28 第八轮审查修复（根因，无补丁）：`useAudioWaveformInstance` 的视觉选项改为按值参与依赖（原 `optionsRef` 只在挂载时取一次，按值变化的选项会被静默忽略），工厂与选项类型收回模块内（仅 Hook 与视觉选项类型对外）；`getAudioPeaks` 的取数链路加边界 `catch`，以结构兑现「入口永不抛出」（探测等未预期异常按 `internal` 返回，不写终止性记忆）；`AudioClipStripPanel` 的 `failed` 更名 `loadFailed`（只表示地址 / 媒体加载失败，与峰值不可用区分）；`AudioWaveform` 用例补齐「波形不可用时仍可播放且照常注册播放句柄」（规则 4.5 / 5.2）；偏差 8 记录等待响应头同样计入停滞超时；范围行按实际改动回写（`AudioNode` 等值抑制、`AssetInspector` 仅更名）。2026-10-28 第九轮（用户确认的跨面板统一，非审查发现）：视频 `ClipStripPanel` / `FrameStripPanel` 的 rAF 进度循环统一到 `useMediaProgress`——Hook 的时间源由媒体元素引用泛化为稳定的读取函数（音频读媒体元素，视频读播放注册表），循环回跳走每帧回调、拖动挂起走写入守卫，语义与改造前逐条等价（回跳同帧最终值一致；拖动结束不再回写拖动前位置，由落地的 seek 收敛）。`use-media-progress` 单测由 6 例增至 8 例（时间源未就绪不启动、进度先于每帧回调、读取函数身份变化以新源重启），全量 155 文件 / 1237 例通过；视频两面板仍无组件级测试，回跳与拖动不拽依赖浏览器走查。2026-10-28 第九轮浏览器走查（用户预览）：视频 `ClipStripPanel` 的播放中折回与播放中拖出点、`FrameStripPanel` 的播放头跟随 / 拖动写入守卫 / 结束收敛、音频节点波形播放与进度光标、音频截取面板的打开自动试听 / 带内点击试听 / 播放中拖动出点，均按预期工作。走查发现并修复一个真实缺陷：开发态 StrictMode 双挂载会由 `useAudioElement` 重建 `<audio>` 元素，而选区初始化的一次性守卫只按逻辑源记账，活着的新元素既没有起点也不会自动试听（页面级 `createElement` 埋点：两次创建相隔 9ms，第二个元素 `paused`、`currentTime` 0）。修复为按「逻辑源 + 元素」记账：同源换代沿用当前选区（用户可能已调整），只有源变化才按打开位置重算；回归用例在 `AudioClipStripPanel.test.tsx`（StrictMode 下断言活元素拿到起点并再次发起试听），并做了变异验证（去掉元素判断后该用例在活元素断言处失败）。修复后复核：web 全量 155 文件 / 1238 例通过（`--maxWorkers=1`），`tsc --noEmit` 无错误，改动文件 ESLint 无告警。2026-10-28 第十轮审查修复（根因，无补丁）：时间读取函数收口——`useAudioElement` 暴露身份稳定的 `readTime`（音频节点与截取面板不再各复制一份 `currentTime ?? null`，读取语义只在元素持有者处定义），视频两面板的注册表读取抽为 `useVideoTimeSource`（内联箭头函数会让 `useMediaProgress` 每次渲染都重启循环）；`idb-cache` 的 `trimOldestEntries` 收回模块内（唯一调用方是同文件的 `putAndTrim`，无外部消费方）；规则 1.4 补回归用例「前一任务解码失败不阻断队列」（先让一个文件以空声道解码失败，再断言后续文件仍解码为 ready，并指明响应体是一次性流、每次请求各取一个新响应）；测试脚手架去重（`AudioWaveform.test.tsx` 的元数据到达抽为 `admitMetadata`，`AudioClipStripPanel.test.tsx` 的峰值入参断言抽为 `expectPeaksRequestedWith`）。该回归用例锁的是结果层面的「失败不阻断」：`decodeAudioPeaks` 从不抛出，失败是 `unavailable` 结果而非任务拒绝，因此变异验证时把 `queueTail` 改回裸 `run` 用例仍通过——`run.catch(() => undefined)` 防的是任务拒绝（未来若任一任务抛出，裸队尾会让模块级队列永久拒绝、后续解码全部失败），作为队列原语的不变量保留。第十轮复核：web 全量 155 文件 / 1239 例通过（`--maxWorkers=1`），`tsc --noEmit` 无错误，改动文件 ESLint 无告警。第十轮审查提出的主题规范冲突（截取面板在固定黑轨上使用固定白波形，与 `web/AGENTS.md` 九.2 原「音频波形跟随当前主题计算并在切换时更新」不一致）已于 2026-10-28 由用户决定按标准侧收敛：`web/AGENTS.md` 九.2 增补「固定在深色轨道上时波形前景固定为白色、不随明暗主题重绘」的例外，实现保持不动。2026-10-29 第十一轮审查修复（根因，无补丁）：媒体事件 → 播放镜像的映射抽到共享 `use-media-playback-mirror.ts`（节点与面板原先各写一份五事件 setState 序列；面板也因此获得按身份记账的换源作废语义，此前只有节点有），面板的循环约束与结束续播改走其 `extras`；`PeaksError` / `AudioSourceResult` 收回模块内（无外部消费方）；`AudioWaveform` 的上报时长改用显式 `null` 哨兵（0 是合法时长，不能兼作「不上报」）；面板的峰值不可用提示改用独立文案 `clip.peaksUnavailable`，不再与音频加载失败共用 `clip.unavailable`。第十一轮复核：web 全量 156 文件 / 1243 例通过（`--maxWorkers=1`），`tsc --noEmit` 无错误，改动文件 ESLint 无告警。2026-10-29 第十二轮审查修复（根因，无补丁）：`useMediaPlaybackMirror` 增加 `reportProgress` 回写入口（节点与面板原先各包一层 `patch`，逐帧进度与 `timeupdate` 写同一维度的规则只留一处），返回值改为具名对象；修正面板失败归类注释（峰值已有独立文案）；Spec 范围补记视频两面板的进度统一与 `use-video-time-source.ts`，取址边界的异常归类记为偏差 9。第十二轮复核：web 全量 156 文件 / 1244 例通过（`--maxWorkers=1`），`tsc --noEmit` 无错误，改动文件 ESLint 无告警。2026-10-29 第十三轮审查修复（根因，无补丁）：媒体元素收尾（`removeAttribute("src")` + `load()`，规则 4.8）从探测元素、播放元素的换源与卸载三处重复实现收敛到 `web/src/lib/media-element.ts`；解码结果与取数结果共用的不可用形状收敛为 `UnavailableResult`；实例视觉选项类型不再对外导出（与本 Spec 定稿一致）；签名描述缓存恢复「空批不打开 IndexedDB」的惰性打开约定（共用骨架的空判断发生在连接之后，覆盖不到）。第十三轮复核：web 全量 156 文件 / 1244 例通过（`--maxWorkers=1`），`tsc --noEmit` 无错误，改动文件 ESLint 无告警。2026-10-29 第十四轮审查记录：终止性失败记忆只覆盖托管值的实现与「异常与边界」原文的未加限定表述不一致——判定实现正确（外部 URL 不是内容身份，内容可变），补记为偏差 10 并在两处规则引用中标明适用边界（2026-10-29 经用户确认）；面板暂停态进度来源的注释修正为「timeupdate 回填」（拖动只写 currentTime，seek 完成后的 timeupdate 才更新进度）。2026-10-29 第十五轮审查（测试可证伪性修复）：「地址未就绪不初始化选区、不发起 play」用例断言的 `HTMLMediaElement.prototype.play` 在 `usePlaybackBlocked` 被整体 mock 后不可能被面板触达，属于空断言；改为断言 mock 的 `resume` 未被调用，用例才可证伪其声称的行为（AGENTS.md 四.5）。该轮两轴其余无发现。验收标准 1–7 中依赖真实桶字节序列、超长 / 损坏文件与明暗主题的项目仍待用户确认，代码提交也仍待确认，因此**尚未标记「已实现」**。

### 实现产物

新增：

- `web/src/lib/audio-peaks/decode.ts`：两段式——`loadAudioSource`（取地址（`resolveMediaUrlWithRetry` + `credentialsForDelivery`，10s 超时）→ 元数据探测时长（10s 超时）→ 流式读取并累计字节（等待响应头与读取停滞各 20s 超时），在解码队列外并发）与 `decodeAudioPeaks`（`decodeAudioData`（30s 超时，`finally` 关闭 AudioContext）→ 512 采样/桶取绝对值最大、最多 2 声道 → 释放 `ArrayBuffer` 与 `AudioBuffer`，是队列内的唯一步骤）。
- `web/src/lib/audio-peaks/store.ts`：`noxrea-audio-peaks` / `peaks`，`by-used` 索引，500 条 LRU 淘汰，任何 IDB 故障退化为仅内存；读取与刷新使用时刻共用同一「可用记录」判定（形状正确且主键一致）；打开与淘汰骨架由 `web/src/lib/idb-cache.ts` 与签名描述缓存共用。
- `web/src/lib/audio-peaks/index.ts`：内存 → IDB → 解码三级取数（解码阶段先取数再解码）、`requestOf` 归一缓存键、单飞表、仅解码的全局串行队列（并发 1，FIFO）、内存缓存 500 条 / 32 MiB 字节预算；取数链路在入口边界兜底 `catch`，以结构兑现「入口永不抛出」（未预期异常按环境类 `internal` 返回，不写终止性记忆）。
- `web/src/lib/audio-peaks/use-audio-peaks.ts`：渲染期同步读内存缓存（命中不闪占位），未命中异步加载；换源即作废旧源结果。
- `web/src/lib/use-audio-element.ts`：节点与截取面板共用的播放元素生命周期（命令式创建、地址同步、失败记账、卸载收尾、按逻辑源失败回合计一次 `retrySigned`）。
- `web/src/lib/media-element.ts`：媒体元素收尾的共用实现 `detachMediaSource`——`removeAttribute("src")` + `load()` 才真正中止在途请求（规则 4.8）；探测元素收尾与播放元素的换源 / 登出 / 卸载清空共用这一份，调用方需要停止播放时先自行 `pause()`。
- `web/src/lib/use-media-progress.ts`：节点波形、音频截取面板与视频编辑面板共用的播放进度逐帧跟随（rAF、0.003s 阈值、可选每帧回调）；时间源以稳定读取函数注入，身份变化即换源重启，未就绪（`null`）不启动。
- `web/src/features/canvas/hooks/use-video-time-source.ts`：视频两面板共用的时间源读取函数（身份稳定，替换会让 `useMediaProgress` 每渲染重启循环）。
- `web/src/lib/use-media-events.ts`：节点与截取面板共用的媒体元素事件订阅（只挂一次、回调取最新闭包）。
- `web/src/lib/idb-cache.ts`：IndexedDB 缓存的公共骨架——打开失败退化为无持久化、写入后按索引游标做条数淘汰（`putAndTrim`）、淘汰本身失败只多留条目（峰值缓存与签名描述缓存共用）。
- `web/src/__tests__/test-utils/audio-fixtures.ts`：音频组件与 Hook 测试共用的峰值身份、峰值状态（`READY_PEAKS` / `LOADING_PEAKS`）、媒体元素捕获与 jsdom 媒体桩。
- `web/src/__tests__/test-utils/file-access-mock.ts`：`mutableFileAccessState(url)` 提供可改写的访问状态（`reset()` 回默认、`set()` 改单项），组件与 Hook 测试不再各自复制默认值。
- `web/src/features/canvas/shared/audio-waveform-instance.ts`：节点与截取面板共用的 wavesurfer 实例工厂——只收 `{ media, peaks, duration }`，固定色（面板）或跟随容器主题前景色并在根 class 变化时重绘（节点）；同模块的 `useAudioWaveformInstance` 收口「peaks 就绪才创建」的硬约束与实例生命周期（换 peaks 重建、地址轮换不触碰），两个组件不再各写一份 effect；工厂与选项类型不对外导出（只有本模块的 Hook 消费），视觉选项按值参与依赖——调用方传模块常量不触发重建，按值变化则重建，不会静默沿用旧选项。

修改：

- `web/src/features/canvas/nodes/AudioWaveform.tsx`：wavesurfer 改以 `{ media, peaks, duration }` 创建，永不传 `url` / `fetchParams`，组件属性 `url` 更名 `audioRef`；播放、定位、进度全部直连媒体元素；峰值未就绪不创建实例；播放进度由 `useMediaProgress` 逐帧跟随；播放态镜像走共享 `useMediaPlaybackMirror` + `IDLE_PROGRESS_PLAYBACK`（与视频节点同一份空闲态与换源作废语义，事件 → 状态映射与截取面板共用）；峰值落定后按源只上报一次时长（规则 4.6 / 5.3）。
- `web/src/features/canvas/editing/AudioClipStripPanel.tsx`：同一改造；`ready` 与选区初始化改由 peaks 时长驱动；进度跟随与循环约束（`timeupdate` / `ended`）数据源改为媒体元素，共用同一个 rAF 循环，且循环只在播放中运行（暂停时不启动，规则 4.5）；播放镜像与节点波形共用 `useMediaPlaybackMirror`，循环约束与结束续播走其 `extras`；失败态归为一处 `failureKind`（描述失败 → 媒体加载失败 → 峰值不可用）；键盘微调与拖动共用同一个带末尾钳制的 `clipSeek`。
- `web/src/features/canvas/shared/audio-playback-registry.ts`：注册类型由 `WaveSurfer` 收窄为 `{ getCurrentTime(): number; pause(): void }`，`pauseAudio` / `getAudioPlaybackTime` 调用方不变。
- `AudioNode.tsx`：增加消费方等值抑制（回填时长与当前值相同时不写 `updateNodeData`）；`AssetInspector.tsx` 无逻辑改动，仅随属性更名改传 `audioRef`。

新增测试（100 例）：

| 文件 | 覆盖 |
| --- | --- |
| `web/src/__tests__/lib/audio-peaks.test.ts` | 8kHz/512 桶/2 声道与上下文关闭、结果形状只含 `channels`/`duration`、两道闸门、`blob:`/`data:` 不可用、IDB 命中不发请求、单飞、外部 URL 不落盘、正常路径只解析一次地址、401/403 重描述一次、持久层未命中、取数不占解码队列（慢下载不阻塞其他文件）、解码失败不阻断后续任务（规则 1.4）、内存字节预算淘汰、取数阶段非预期异常归为 `internal` 且不落终止记忆 |
| `web/src/__tests__/lib/audio-peaks-store.test.ts` | openDB 失败时读 / 写 / 刷新全部降级且只尝试一次、读取 / 写入 / 刷新 / 淘汰异常不抛出、形状正确记录原样返回、形状不符或主键不一致按未命中、畸形记录刷新时不回写 |
| `web/src/__tests__/lib/use-audio-peaks.test.ts` | 渲染期缓存命中、加载→就绪、换源立即作废旧结果、A→B→A 切回未就绪的源会重新订阅并落定（不永久停在 loading）、卸载不取消在途取数（不传中止信号、迟到结果照常落定）、unavailable 仍带探测时长 |
| `web/src/__tests__/lib/use-audio-element.test.ts` | 脱离文档元素、卸载暂停+清空+load、新地址只写 src、`reloadToken` 触发一次 load、失败回合只重描述一次（新地址再失败即置位）、`loadedmetadata` 收敛失败态、重描述在途换源的竞态、同源地址作废（会话切换）清空 `src` 并 `load()` |
| `web/src/__tests__/features/canvas/nodes/AudioWaveform.test.tsx` | 创建参数含 `media`/`peaks`/`duration` 且不含 `url`/`fetchParams`、peaks 未就绪不创建、地址轮换只改 `src`、主题重绘、失败态、节点已存时长只作底部显示（规则 5.3：媒体元数据到达才可播）、`onReady` 在 peaks 落定后每源只上报一次、与 prop 等值仍上报、换源重报、波形不可用时仍可播放并照常注册播放句柄（规则 4.5 / 5.2） |
| `web/src/__tests__/features/canvas/editing/AudioClipStripPanel.test.tsx` | 同一创建契约（固定白 / barWidth 3 / barGap 2）、峰值按逻辑引用值取、峰值不可用即不可操作、峰值未就绪不创建实例、地址轮换只改 `src` 不重建、`reloadToken` 只重载元素、StrictMode 双挂载后活元素仍被初始化（起点写入 + 自动试听，按「源 + 元素」记账） |
| `web/src/__tests__/lib/use-media-progress.test.ts` | 未激活 / 时间源未就绪（读取返回 `null`）不启动循环、卸载取消在途帧、0.003s 阈值去重、`onFrame` 每帧回调且位于进度回调之后、回调身份变化不重启循环、读取函数身份变化视为换源并以新源当前值重启 |
| `web/src/__tests__/lib/use-media-events.test.ts` | 挂载即订阅 / 卸载摘除、元素未就绪不抛错、订阅只建立一次且用最新闭包、后出现的回调不需要重新订阅、无回调的事件不抛错 |
| `web/src/__tests__/lib/use-media-playback-mirror.test.ts` | play 同步位置、timeupdate 跟随、pause / ended 收尾、非有限时长与 0 不覆盖已知时长、换身份回到初始值、附加回调只在对应事件执行、`reportProgress` 回写与 timeupdate 同维度 |

### 验收结果

已验证事实（自动化）：

- 验收 8：`web` 156 个测试文件 / 1244 例全绿（`npx vitest run --maxWorkers=1`，2026-10-29 第十二轮审查修复后复核；第三轮起同批波及 `file-access-store.ts`，其 49 例签名描述缓存用例同批通过）；根目录服务端套件 100 文件通过 / 3 跳过（1174 例通过 / 14 跳过，服务端未改动）。`tsc --noEmit` 无错误；本次改动文件 ESLint 无告警。
- 验收 3、4、5 的关键路径已由单测锁定：单飞与 IDB 命中（只解码一次）、地址轮换不重建实例且不重复解码、公开结果只含 `channels` / `duration`（不携带压缩字节或 `AudioBuffer`；字节与解码缓冲的释放由实现结构保证，GC 时机不由单测断言）。
- 浏览器走查（2026-10-28，用户预览，非自动化）：视频 `ClipStripPanel` 播放中循环折回、播放中拖出点不中断；`FrameStripPanel` 播放头跟随、拖动期间不写回、松手后收敛；音频节点播放 / 暂停与进度光标；音频截取面板打开自动试听、带内点击试听与循环折回、播放中拖动出点。首次走查发现的 StrictMode 初始化缺陷已按根因修复并补回归用例（见「当前状态」）。

待用户走查确认（验收 1、2、6、7，以及 3、4 的真实请求序列）：

- 真实 signed 桶上打开含音频节点的画布，在 DevTools Network 核对「1 次完整字节请求 + 探测小 Range」「刷新后波形零字节请求」「节点与面板各开一次只 decode 一次」。
- 用构造的超时长 / 超字节 / 损坏文件验证占位形态与「播放仍可用」。
- 明暗两套主题下的波形颜色与切换重绘（画布 Canvas 不随 CSS 自动重绘，已由既有用例覆盖 `setOptions` 路径）。

待用户确认：代码提交（第六章）。

### 已知边界

- 波形依赖 CORS（peaks 走 `fetch`），播放不依赖（`<audio>` 不带 `crossOrigin`）；跨域桶未配 CORS 时波形占位而播放正常，这是设计内行为。
- 探测元素 `preload="metadata"` 的实际字节量因浏览器而异，Spec 只依赖它不触发全量下载（未验证假设，见规则 2.5）。
- 视频侧两个面板（`ClipStripPanel` / `FrameStripPanel`）的播放头跟随已统一到 `useMediaProgress`（2026-10-28，用户确认后实施）：时间源改为读取函数（读视频播放注册表），`ClipStripPanel` 的选区折回走每帧回调（进度写入之后执行，回跳值胜出），`FrameStripPanel` 的拖动挂起走写入守卫（拖动中不写；读注册表无副作用）。两面板在暂停时仍保持 rAF 循环——视频播放注册表没有位置 / 播放态订阅通道，改为事件驱动会让暂停拖动跳步；这是已知取舍，不属于本 Spec 的规则。

### 与 Spec 的实现偏差

3–7 为解决审查发现而引入的契约调整，已于 2026-10-28 经用户确认并回写规则（7 为第三轮审查修复，同日确认）；8 为按规则字面补充的记录，未改变已确认契约。

1. `useAudioPeaks` 不提供 `retry`（「技术影响」原列 `{ peaks, duration, status, error, retry }`）。规则 4.6 / 6.2 的手动重试入口只有地址描述失败（`refresh`，由 `useAudioElement` 暴露），峰值失败按「不缓存、不自动重试、重开即重试」处理；没有消费方需要重试峰值本身，加上它即是无人调用的接口。
2. 播放元素的生命周期抽成独立 Hook `web/src/lib/use-audio-element.ts`（原计划写在两个组件各自内部）。节点与面板的地址同步、失败记账、卸载收尾逐行同构，留在两处即两份实现；抽成 Hook 后 react-hooks 规则无需任何豁免。
3. 取址阶段增加 10s 超时（`resolveWithTimeout`）。原规则 2.7 只列举探测 / 读取停滞 / 解码三处超时；取数虽已移出解码队列，但悬挂的描述请求会无限期占住该文件的单飞条目，用户重开时也一直等不到结果，因此给同一失败类补上界。失败归为环境类（`timeout` / `network`），不进终止性失败记忆，不影响播放路径。该条超出规则 2.7 的原始列举范围，已于 2026-10-28 回写规则 2.7 并经用户确认。
4. 取数移出全局串行队列（规则 1.4 修订）：队列里只保留 `decodeAudioData` 与峰值抽取，取址 / 探测 / 下载在队列外并发；FIFO 因此变为「进入解码队列的顺序」（就绪顺序），而不是「按挂载顺序」。原因：把 I/O 一起串行会让一个慢下载阻塞所有其他文件的波形，而规则 1.4 的原始目的是限制 CPU / 内存重操作的并发。该条修订确认结论 5，已于 2026-10-28 经用户确认。
5. `useAudioPeaks` 的返回值移除 `error` 字段（原「技术影响」写的是 `{ peaks, duration, status, error }`）。原因码只用于服务层内部诊断，节点、截取面板与检查器都没有消费方；不可用状态由 `status === "unavailable"` 表达，保留无人读取的字段只会扩大 Hook 契约。
6. 内存缓存由条数上限扩展为「500 条 + 32 MiB」双上限。规则 3.4 的条数上限与确认结论 2 都只针对 IndexedDB；但 500 条 20 分钟音频峰值约 75 MB，内存常驻不可接受，两种淘汰独立生效。
7. 持久化记录移除 `bytes` 字段（原规则 3.2 / 确认结论 2 的「仅作观测」）。该字段写入后没有任何读取方，属于投机字段；内存缓存的字节预算由服务层按峰值数组现算，不需要落盘副本。移除会改变已确认的记录形状，已于 2026-10-28 经用户确认，规则 3.2 与确认结论 2 保持移除后的形状（2026-10-28 第三轮审查）。
8. 字节停滞计时从发起请求开始，等待响应头同样计入 20s（规则 2.7 的条目名为「字节读取」）。等待响应头期间同样没有新字节，挂住的请求会无限期占住该文件的单飞条目，与取址超时同一类上界；响应到达后由读取阶段按新字节重新计时，下载总量仍不设时限。按规则 2.7「20 秒内没有任何新字节即中止」的字面执行，不改变已确认契约（2026-10-28 第八轮审查补充记录）。
9. 取址边界（`resolveWithTimeout`）的异常统一归为环境类 `network` / `timeout`，而非 `internal`：该边界只能观察到 `resolveMediaUrlWithRetry` 的失败，无法区分网络故障与内部错误；两者行为一致（不进终止记忆、下次挂载重试），诊断码差异不影响降级，`internal` 仍由 `loadAudioSource` 的兜底 catch 产出。2026-10-29 第十二轮审查补充记录，不改变已确认契约。
10. 终止性失败记忆只覆盖托管值（`requestOf` 非 null）：`getAudioPeaks` / `peekAudioPeaksFailure` 不读写外部 `http(s)` URL 的 `decode_failed` / `too_large` 条目（`audio-peaks/index.ts`）。「异常与边界」原表述未区分键形态，但「重复解码不会改变结果」的前提是内容寻址（规则 3.5 已说明外部 URL 不是内容身份，其内容可变）；记住外部 URL 的失败会在内容被替换后仍把该源锁在不可用态直到刷新。代价是外部 URL 解码失败后组件重挂会重新下载一次（仅成本，不影响正确性）。2026-10-29 第十四轮审查发现并记录，同日经用户确认（确认结论：外部 URL 解码失败不入会话记忆，重挂即重试）。

### 调查记录（实现前，只读）

- wavesurfer.js 7.12.12 源码逐条核对（「前提验证结论」9 项，行号均按当前安装版本核对）。
- 现有链路通读：`AudioWaveform`、`AudioClipStripPanel`、`AudioNode`、`AssetInspector`、`audio-playback-registry`、`useFileAccessUrl`、`lib/file-access/*`、`lib/file-url.ts`、`shared/url.ts`、`server/http/routes/files.ts`、`server/http/file-response.ts`。
- liblib.tv 生产构建静态分析（业界对标一节）。

### 本 Spec 一并消除的既有问题

- 音频节点的播放必须等整文件下载完（wavesurfer 先 fetch 再 setSrc），与视频的边下边播不一致。
- 签名 URL 轮换会销毁并重建 wavesurfer 实例，播放被强制中断；规则 3.8「主动刷新不打断已挂载媒体」在音频上实际未成立。
- 截取面板对同一文件重复全量下载与解码。
- 画布上所有音频节点（无论是否可见）都会下载并解码。
