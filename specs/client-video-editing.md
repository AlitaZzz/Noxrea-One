# Client Video Editing（媒体编辑操作客户端化）

状态：已确认（用户 2026-10-14 确认；实现按「管线 + 裁剪 → 截取 → 分离音轨 → 变速」顺序进行）

## 目标

把四个产出新文件对象的媒体编辑操作从服务端 ffmpeg 迁到浏览器：**画面裁剪、片段截取、分离音轨（音轨 + 静音视频）、音频变速**。用 WebCodecs 硬件编解码 + JS 解封装/封装库构建前端管线，产物经既有上传链路入库；服务端同能力路由**保留为兜底**，用于客户端不支持或管线失败的场景。目的：把分钟级的整段重编码从 2 核 2 GB 的 NAS 挪到用户自己的电脑，服务端每个剪辑的剩余工作只剩收文件、哈希去重、落盘与元数据探测（秒级）。

关联：[media-processing-concurrency.md](media-processing-concurrency.md)（并发池与兜底路由的归属；决策 15 的部分翻转）。

## 范围

- 前端媒体管线：Mediabunny 统一承担解封装与封装（含按需 Range 读取），编解码走 WebCodecs（VideoDecoder / VideoEncoder），音频走 AudioDecoder / AudioEncoder / 包级拷贝。
- 音频片段截取（AudioNode 的音频流 copy 截取）同为客户端化对象：Conversion 音频轨裁剪，aac 源拷贝、其余转编 AAC（无编码器 → 回退服务端）。
- 四个操作的客户端实现与 UI 接入（进度、失败回退）。
- 能力探测与降级契约：探测失败或管线异常时自动回退服务端同能力路由。
- 服务端零功能变更（兜底路由、上传链路均为既有实现）。

## 非目标

- 雪碧图、预览代理、海报母版的客户端化（另行评估；雪碧图的 canvas 逐 seek 方案已单独讨论，未纳入本 Spec）。
- 自研音频时间拉伸算法（音频变速用 soundtouchjs）。
- Smart cut 三段拼接（中段流拷贝 + 首尾边界段重编码）——音画对齐与拼接复杂度高，作为后续优化项。
- Web Worker 化管线（v1 主线程异步解码；卡顿明显时再升级）。
- 更换 / 删除服务端兜底路由；不改媒体池与限流。
- 拖动 scrub 引擎（预览代理维持服务端生成）。

## 现状与动机（2026-10-14）

- 四个操作目前全部由服务端 `runFfmpegHeavy` 整段重编码（libx264 veryfast crf20 / aac），4K 素材在 2 核 2 GB 目标环境是分钟级任务，也是 OOM 风险与重型池积压的主要来源。
- 客户端硬件编解码速度通常快于实时，用户本机算力远大于 NAS；浏览器剪辑产品（Clipchamp、CapCut Web、VEED）已验证该架构。
- 服务端上传链路已支持 `?source=derived`（[upload.ts](../server/http/routes/upload.ts)），客户端产物入库零服务端改动；视频上传的完整性体检为 best-effort（1.5s 预算封顶）。

## 业界对标

| 设计点 | 本方案 | 业界通行做法 |
| --- | --- | --- |
| 浏览器剪辑管线 | Mediabunny（解封装 / 封装 / 按需读取 / WebCodecs 衔接一体）+ VideoEncoder / AudioEncoder | Clipchamp、CapCut Web、VEED 均为 WebCodecs（硬件加速）+ JS 解封装/封装，最终产物上传 |
| 兜底 | 能力探测失败 / 管线异常回退服务端 ffmpeg | 渐进增强：支持则本地处理，否则服务端 |
| 音频拷贝 | AAC 包级拷贝（帧边界约 21ms，无感） | 剪辑类产品对兼容编码普遍流拷贝 |
| 进度反馈 | 处理进度比例上报 busy 浮层（口径随操作：Conversion 比例 / 帧包计数 / 分块计数） | 长任务必须有进度与取消（关闭标签页） |

## 业务规则

### 1. 能力探测与兜底契约

1. 打开能力按操作探测其真实所需（打开 = 容器可解析 + 相关轨存在；失败按 1.2 缓存）：
   - 片段截取 / 画面裁剪：视频轨可解码（`VideoDecoder.isConfigSupported`）+ H.264 编码器可用（`canEncodeVideo`）；片段截取的非 AAC 音轨另需可解码（`canDecode()`——codec 未知或不可解码时回退，否则库内静默丢轨产出无声片段）且可编码 AAC（`canEncodeAudio`，非 AAC 转编），画面裁剪的非 AAC 音轨直接回退（包级拷贝-only，见输出规格）。
   - 分离音轨：纯重封装零解码零编码——视频轨仅需容器可给出编码描述（封装 sample entry 的必要输入），不要求解码能力（无硬解的机器也能客户端重封装）；另要求 ISO-BMFF 容器 + AAC 音轨。
   - 音频变速 / 音频片段截取：音频轨可解码；变速另需 AAC 编码器。
2. 探测与打开同体：每个操作都需自己的 `Input` 实例，探测成功结果不独立缓存（缓存无收益）；**探测失败按「探测档位 + 源 URL」会话级缓存**（`unsupportedProbes`），命中即跳过打开、直接走服务端兜底。档位表达探测要求且弱档失败蕴含强档必败：`video-mux`（容器可解析 + 视频轨有编码描述，分离音轨所需）失败封杀全部视频操作；`video-decode`（再加 WebCodecs 解码能力，片段截取 / 裁剪所需）失败**不封杀 mux 档**——描述在、无硬解的源仍可客户端纯重封装；`audio`（容器可解析 + 音频轨可解码）覆盖音频变速与音频截取。
3. 任一探测失败、容器解析失败、管线中途异常 → **自动回退服务端同能力路由**（既有 `crop-video` / `extract-clip` / `detach-audio` / `apply-audio-speed`），调用方 UI 无感（仅进度表现不同）。解封装用 `ALL_FORMATS`（Mediabunny 支持 webm / mkv），裁剪 / 截取不受容器限制；**分离音轨除外**（纯重封装到 mp4 仅支持 ISO-BMFF 源，见输出规格与「分离音轨补充」）。
4. 服务端路由与测试全部保留，不做任何删减；媒体池对兜底路径的限额不变。
5. 回退不循环：客户端失败后走服务端，服务端再失败按既有错误提示，不再尝试客户端。
6. **回退边界（错误分类，2026-10-14 用户确认「上传失败不回退」）**：管线失败按来源分流——
   - 能力不支持、源读取失败（含网络断开）、编码 / 封装中途异常 → `ClientUnsupportedError` → 自动回退服务端；
   - **派生产物上传失败（网络断开 / 租约失效 / 超限等）不回退**：此时本地编码已完成，回退意味着丢弃产物并让服务端重跑全量重编码，与服务端减负的目标相悖——按普通操作失败上报（错误通知 + 手动重试，重试重跑客户端任务）。多产物操作（分离音轨）为**串行独立上传**：任一产物上传失败即整个操作失败、不创建派生节点；已成功上传的产物会残留为无引用的入库文件（相同内容经哈希去重合并，无重复体积，无正确性影响）；
   - 用户取消 → busy 浮层「取消」/ 节点换源 / 节点卸载均可中止管线，产物丢弃、状态复位（不提示、不回退）。

### 2. 客户端管线

1. **输入**：Mediabunny `Input` + `UrlSource` 直连 `/api/files/<key>`——先读容器头（moov / 索引，几十 KB），之后按需以 Range 请求拉取样本数据（服务端文件路由已支持 Range）。片段截取只下载所需片段的字节范围；裁剪覆盖整条时间轴，仍需读取全量数据。
2. **视频解码**：视频轨的 `getDecoderConfig()` 喂 `VideoDecoder`（dts 序），逐帧产出 `VideoFrame`；截取的帧精确性由「解码丢弃起点前帧」天然成立。
3. **处理**：裁剪 = `drawImage` 源矩形到编码尺寸；截取 = 从起点帧开始编码；分离音轨不解码视频；变速只作用于音频轨（见第 5 条），视频不参与。
4. **视频编码**：`VideoEncoder`（avc1，码率策略见「输出规格」——源码率封顶，缺失时 quantizer 自决），硬件编码器优先，`hardwareAcceleration: "prefer-hardware"` 提示。
5. **音频**：裁剪 / 分离音轨 = 音频包级拷贝（不解码；AAC 帧边界误差约 21ms，无感）；变速 = `AudioDecoder` 解码 → soundtouchjs 时间拉伸（保持音调）→ `AudioEncoder` 编码（AAC，平台支持时）。
6. **封装**：Mediabunny `Output`（Mp4OutputFormat，fastStart），产物为 `File` 对象。
7. **音频编码不可用**（无 AAC 编码器等）→ 该操作回退服务端；纯拷贝类操作不受影响。
8. **取消与资源释放**：管线全程接受 `AbortSignal`——busy 浮层的「取消」按钮、节点换源与卸载均可触发（任务在面板确认后才启动，面板关闭 / Esc 并非运行中的取消杠杆）；中止时 `VideoDecoder` / `VideoEncoder` 即刻 `close()`、上传请求中止、产物丢弃、UI 复位。
9. **背压**：视频帧循环（画面裁剪）以 `await videoSource.add(sample)` 逐帧推进——Mediabunny 的 `add()` 返回的 Promise 在编码器队列与写入端有余量时才完成（库文档约定 await 它以遵守 writer 与 encoder 背压），解码快于编码时暂停取下一帧，内存仍有界；不自建 `encodeQueueSize` 阈值。

### 3. 产物入库契约

1. 产物经既有 `POST /api/files/upload?source=derived` 上传（复用按用户上传租约、批量与大小限制、哈希去重、元数据探测），节点创建只消费响应的 `key`——派生节点 `data.src` 的持久化值域是存储 key，`url` 是渲染期派生值、不得写入节点（`specs/storage-reference-key-unification.md`）；单产物服务端兜底路径的响应投影统一为 `readEditResultKey`（只取 `data.key`），分离音轨为双产物、统一经 `readDetachAudioResult` 投影（要求 `video.key` 与 `audio.key` 同时存在，缺一按失败提示，不创建半成品节点）。客户端与服务端两条路径共用同一段节点创建代码。
2. 视频产物的服务端完整性体检按上传既有行为执行（best-effort，1.5s 预算），客户端硬件编码产物预期无截断。
3. 相同产物经哈希去重天然合并。

### 4. UI 与进度

1. 节点 busy 浮层显示百分比（混合口径，均单调递进：Conversion 内建比例——片段截取 / 分离音轨 / 音频片段截取；逐帧包计数——画面裁剪；编码分块计数——音频变速。分离音轨为四段单调进度：两路重封装 0–40 / 40–80、两段上传 80–90 / 90–100；其余单产物操作统一「编码段 0–90 / 上传段 90–100」——映射收口在 `mapFraction` 与 `uploadDerivedFile`，百分比口径统一为 0–1 分数投影）。
2. 标签页关闭即中止（无断点续作）：入口按钮在管线运行期间禁用重复触发；不调用 Wake Lock（剪辑时长有限，用户主动等待）。
3. 失败回退服务端时，busy 状态无缝延续（耗时计时连续；客户端管线残留的百分比清除——服务端兜底不上报进度，过期百分比是假信息）。

### 5. 输出规格（对齐服务端产物）

| 操作 | 视频 | 音频 | 输入需求 |
| --- | --- | --- | --- |
| 画面裁剪 | 重编码 avc1 | 包级拷贝 | 全量 |
| 片段截取 | 重编码 avc1（帧精确） | AAC 包级拷贝（非 AAC 转编，无 AAC 编码器 → 回退服务端） | 全量（v1） |
| 分离音轨 | 静音视频 = 视频包拷贝 + faststart | 音轨包拷贝 → m4a（非 AAC 回退服务端） | 全量 |
| 音频变速 | —（纯音频操作，无视频轨） | 解码 + soundtouchjs 时间拉伸（保持音调）+ AAC 编码 | 全量 |

码率策略：重编码无法增加信息，输出码率**以源视频码率为上限**（Mediabunny 解封装时从样本表读出，无需额外探测）；画面因裁剪等操作缩小时按有效像素占比折减（保持每像素质量不变，非压画质），并设 1 Mbps 下限防退化。源码率信息缺失时**不指定码率、不设分辨率分档**：重编码无法增加信息，按分辨率猜码率猜高白涨体积、猜低压画质，两头都不对——正确做法是仅传 quantizer 20 交编码器按画面复杂度自决（用户 2026-10-14 确认，取代原「分辨率分档兜底」方案）。遗留风险：若编码器不支持 quantizer 模式且源码率缺失，无任何码率约束，落到库 / 浏览器默认值（未在真实浏览器验证）。

### 6. 为什么截取 / 裁剪必须重编码（流拷贝不可行）

- **片段截取**：流拷贝的切点吸附关键帧——起点最多提前一整个 GOP（x264 默认 250 帧，30fps 下约 8 秒），结尾同样多包内容；而面板选区是帧精确的。音频包边界（约 21ms）与视频关键帧吸附（数秒）也无法对齐，强行拷贝会产生音画长度不一致。
- **画面裁剪**：每一帧的像素内容都被改变，流拷贝在物理上不成立。容器级的显示裁剪元数据（clean aperture）浏览器支持参差，且缩略图、体检、下游参考素材仍见全幅画面，不是真裁剪。
- **行业对照**：CapCut Web / Clipchamp 等编辑器对这两类操作一律重编码；流拷贝切割是 LosslessCut 这类无损工具的专属形态（Smart cut 三段拼接见「非目标」）。

## 格式覆盖矩阵

| 输入 | 客户端 | 兜底 |
| --- | --- | --- |
| mp4 / m4v / mov / webm / mkv（ISO-BMFF 与 Matroska/WebM 容器） | 解封装 ✔（Mediabunny 支持） | — |
| 解码 | 视编码器支持：H.264 / VP9 / AV1 桌面浏览器全支持；HEVC 依赖硬件（`isConfigSupported` 按机判定） | 解码不可用（如 Firefox + HEVC） |
| avi 等其余容器 | ✘ | ✔ |

输出恒为 mp4（H.264 + AAC，与服务端产物规格一致）。

## 技术影响

- **依赖**（web）：`mediabunny`（MPL-2.0，纯 TypeScript 零依赖，统一承担解封装 / 封装 / 按需读取 / WebCodecs 衔接；npm 已核实 v1.61）与 `soundtouchjs@0.3`。
- **依赖许可证**（2026-10-15 决策，用户授权 Agent 判定）：`soundtouchjs` 为 LGPL-2.1（npm 注册表与随包 LICENSE 已核实），`mediabunny` 为 MPL-2.0；二者均以未修改的 npm 依赖进入前端打包产物，不入库、不改源码，决策 4 的选型保留。替换面很窄：仅 `client-video.ts` 变速管线的拉伸段（全仓唯一的 `import`）与 `web/src/types/soundtouchjs.d.ts`；宽松许可的候选为 `signalsmith-stretch`（MIT，npm 已核实 v1.3.2），替换属选型变更，须修订决策 4 并重新确认，且变速音质需人工听感验证。**对外分发 / 商业化 / 向第三方开放服务之前必须完成**：①为仓库选定 LICENSE（仓库已公开但当前无 LICENSE；LGPL-2.1 §6 要求组合产物的条款允许使用者为自用而修改、并为调试该修改而逆向）；②随产物附 LGPL-2.1 与 MPL-2.0 许可证全文及源码获取方式；③将 `soundtouchjs` 隔离为独立的按需加载 chunk，或完成上述替换。
- **前端新模块**：`web/src/features/canvas/editing/client-media/`——`client-video.ts`（能力探测、四个操作与音频片段截取、产物上传入库的单文件实现）与 `support.ts`（探测失败负缓存、进度区间映射、输出码率决策，均为纯逻辑可单测）；另有编排 Hook `use-media-edit-task.ts`（busy 守卫 / 取消 / 回退语义，VideoNode / AudioNode 共用）。节点 handler（`VideoNode` / `AudioNode`）把「直接调服务端 API」改为「探测 → 客户端管线 → 失败回退服务端」，节点创建代码共用。
- **服务端**：逻辑零变更（兜底路由、上传链路、媒体池全部沿用；仅裁剪矩形钳位契约 `CropRectPx` / `clampRect` 下沉 `@noxrea/shared/crop-rect`，服务端改为从 shared 导入）。客户端产物进入上传链路后，其播放/缩略图/体检走既有服务端路径。
- **并发池影响**：客户端化后服务端重型池负载显著下降；池参数不变（兜底与预览代理仍在池内）。
- **测试**：纯逻辑（时间戳缩放、样本选择、矩形钳位、探测缓存）单测；分离音轨 = 纯重封装，可在 Node 环境用 ffmpeg 生成的 fixture 做集成测试；编解码胶水层依赖浏览器，真实浏览器走查覆盖（jsdom 无 WebCodecs）。

## 异常与边界

- 标签页关闭 / 刷新：管线中止，产物丢弃，无服务端残留；用户重新操作。
- 源文件读取中途失败（网络断开）：管线异常 → 回退服务端。
- 截断视频：容器样本表声明超出实际数据 → 解码到断点报错 → 回退服务端（服务端有截断收敛逻辑）。
- 音频缺轨的片段截取：音频拷贝步骤跳过，产物为纯视频（与服务端行为一致）。
- 大文件：Mediabunny 按需 Range 读取，内存有界（无整文件缓冲）；片段截取只拉取所需片段的字节范围，裁剪 / 变速覆盖整条时间轴仍需读取全量。
- 哈希去重：相同参数产出相同比特流的可能性低（硬件编码器非确定性），去重退化为普通入库，无正确性影响。

## 已知限制

- 输出编码器随设备不同（硬件编码器码率效率差异），同一操作不同电脑产物略有差异；源头文件不变。
- 裁剪 / 变速覆盖整条时间轴，需读取全量源数据；只有片段截取享受按需下载（局域网几乎无感，广域网取决于带宽）。
- 主线程管线：解封装大文件解析可能短暂阻塞 UI（后续 Worker 化优化）。
- AAC 包级拷贝重置时间基准后，片段开头可能引入约 40ms 的静音（AAC priming）；派生预览节点无感，实现时经 Mediabunny 时间戳重基核对音画起点。
- 变速的音频时间拉伸用 soundtouchjs，与 ffmpeg atempo 的音质存在差异；不满意可对该操作单独回退服务端。
- 音频变速**输出保持源声道数**（mono → mono、stereo → stereo；行业通行做法：上混双声道输出无增益只翻倍体积，降混则丢信息。soundtouchjs 的 FIFO 硬编码双声道交错，故 mono 源在 DSP 内部以 L=R 拉伸、输出前取回单声道。用户 2026-10-14 确认，取代原「输出恒为双声道」）；超长音频（小时级）解码与拉伸全量驻留内存。

## 验收标准

- 能力探测：支持矩阵内的视频走客户端管线，矩阵外（avi 等其余容器 / 解码不可用）自动回退服务端，探测失败结果按「探测档位 + 源 URL」会话内缓存（成功不缓存）。
- 四个操作在 Chrome / Edge 上产出的 mp4 可被画布加载、可被服务端元数据探测、走 `?source=derived` 入库为 derived 来源。
- 片段截取帧精确（起点与播放器所选帧一致）；裁剪矩形与面板选区一致；变速保持音调、时长按倍数缩放；分离音轨产出音轨 + 静音视频两个文件。
- 管线异常自动回退服务端且 busy 状态无缝延续；服务端兜底路由与测试逻辑零变更（仅裁剪矩形钳位「契约类型 + clampRect 实现」下沉 `@noxrea/shared/crop-rect`，server 旧副本删除）。
- 节点 busy 浮层显示进度；重复触发被既有 busy 守卫拒绝。
- 取消：busy 浮层「取消」/ 节点换源 / 节点卸载均可中止管线，解码器 / 编码器即刻释放，产物丢弃且状态复位。
- 实现第一步验证 Mediabunny `UrlSource` 对 `/api/files/*` 发出 Range 请求（服务端已支持）；不生效则片段截取退化为全量读取并记录于已知限制。
- 纯逻辑单测通过；服务端与前端类型检查、lint、相关测试通过（串行执行）。
- 真实浏览器走查（人工）：矩阵内 / 矩阵外各一例 + 四操作全流程。

## 已确认决策

用户 2026-10-14 确认：

1. **四个编辑操作（裁剪、片段截取、分离音轨、音频变速）全部客户端化**，WebCodecs 管线（非 ffmpeg.wasm）。
2. **服务端同能力路由保留为兜底**，不做删减；媒体池与限流不变。
3. 产物经既有上传链路入库（`?source=derived`），服务端零功能变更。

用户 2026-10-14 确认（「OK，开始实现」）：

4. **音频变速的客户端实现采用 soundtouchjs** 时间拉伸（音调保持）；音质不满意时该操作可单独回退服务端。
5. **实现顺序**：管线 + 裁剪 → 片段截取 → 分离音轨 → 音频变速，每步交付可用功能。
6. **依赖采用 Mediabunny**（用户提议，替代原 mp4box.js + mp4-muxer 组合；见当前状态）。

## 待确认事项

无。

## 当前状态

已确认。实现进行中（2026-10-14）：**阶段 1–4 全部完成**（含音频片段截取，用户浏览器实测后补入）——依赖（mediabunny 1.61 + soundtouchjs 0.3）、能力探测（视频 `openVideoSource` / 音频 `openAudioSourceOrThrow`，失败按「探测档位 + URL」会话缓存，档位格实现于 `support.ts`）、裁剪（`tryCropOnClient`：transform 裁剪 + AAC 包级拷贝）、片段截取（`tryClipOnClient`：Conversion `trim` 原生处理关键帧对齐 / 丢帧 / 时间戳重基 / 音画对齐，视频 quantizer 20 / 源码率封顶重编码，音频 AAC 拷贝 / 转编）、分离音轨（`tryDetachAudioOnClient`：双路 Conversion 纯重封装——音轨 m4a + 静音 mp4，零解码，仅 ISO-BMFF 容器 + AAC 音轨）、音频变速（`tryApplyAudioSpeedOnClient`：AudioSampleSink 全量解码 → soundtouchjs 拉伸 → AudioSampleSource AAC 编码，输出保持源声道数）、音频片段截取（`tryExtractAudioClipOnClient`：音频轨 Conversion 裁剪，aac 源拷贝 / 其余转编）、四者的 `VideoNode` / `AudioNode` 集成（统一编排 Hook `useMediaEditTask`：busy 守卫 / 取消 / 客户端失败切服务端兜底，节点侧零重复骨架）与纯逻辑单测均已落地；类型检查、lint、web 全量测试（126 文件 / 930 用例，2026-10-15 复测）通过，浏览器实测裁剪与片段截取（含 mkv 源）通过。编解码胶水层的真实浏览器走查（分离音轨 / 变速路径、UrlSource Range 行为）待人工执行。转为「已实现」尚缺两项（AGENTS.md 十二.4.4）：上述浏览器走查完成并经用户确认；实现代码提交。

审查修复轮（2026-10-14，代码审查后用户确认全量根因修复）：①**取消契约补全**——上传贯通逐操作 AbortSignal（`apiUploadWithProgress` 新增 signal 参数，XHR 级中止），`Conversion.init` 窗口补显式中止检查，服务端兜底请求同样带 signal；②音频变速边界收口（超双声道、空音频轨拒绝并回退服务端）与**输出声道策略改回保持源声道数**（初版「恒为双声道」的 Spec 决策经行业对标否决，2026-10-14 用户确认翻转）；浏览器实测发现**静音 bug**：给 mediabunny `AudioSample` 传 `subarray` 视图时其 `toAudioData()` 丢弃 byteOffset（1.61.4），每个编码分块都从大缓冲头部读取——产物为开头片段按全长重复，波形呈平线。修复：`data` 一律传独立缓冲（`slice`），该约束已注释在编码段；③中止 / 编码异常路径补样本显式 close；④**裁剪矩形钳位下沉 `@noxrea/shared/crop-rect`**（`CropRectPx` 契约 + `clampRect` 前后端单一实现，面板确认复用同一实现，删除三处重复定义）；⑤回退编排骨架收敛为 `useMediaEditTask`（原 VideoNode / AudioNode 五处重复形状）；AudioNode 变速忙文案按 kind 区分（新增 `speed.processing`）；⑥换源替换中止扩展到全部本地处理任务（原仅抽帧）——旧源的产物不得写入已换源的节点；⑦入档：海报垫底重构为跨模式常驻元素、删除 cropOpen 加载浮层（上一轮裁剪面板简化的配套，Spec 此前未记录）。

审查修复轮二（2026-10-14，三轴复审后用户确认）：①**回退边界契约落库**（规则 1.6）——新增 `ClientUploadError`：派生产物上传失败不再包装为不支持、不回退服务端（用户确认「报错 + 手动重试」），五个操作的 catch 尾经 `toPipelineFailure` 归一分流；②clip / crop / detach 的 `openOrThrow` 移入 try——源读取网络失败按「异常与边界」回退服务端（原实现在 try 外裸抛，跳过兜底）；③分离音轨进度区间重排：两路转换 0–40 / 40–80、两段上传 80–90 / 90–100（原实现上传段 45–90 与转换段重叠，进度 90→45 回退）；④音频变速失败路径补 `output.cancel()`（与其余操作一致，防编码器资源不释放）；⑤`useMediaEditTask` 的 `onAccept` 移入 try（接受动作抛错不再永久卡死 busy）；⑥裁剪前置校验源画面 ≥2px（原 `clamped.width < 2` 守卫恒假——clampRect 已兜底 ≥2，属死分支，其要拦的源画面过小场景反而漏过）；⑦六个 serverTask 在响应返回后检查中止信号——取消落在响应之后不再弹虚假「操作失败」通知。

审查修复轮三（2026-10-14，第二轮复审后用户确认）：①`speed.processing` 忙文案键从 `error` 命名空间迁回顶层 `speed` 块（原键位错致 BusyOverlay 渲染原始 key，中英同错位）；②抽帧 serverTask 收敛为与其余五个同形状——单次防御解析 + 单一中止检查点（覆盖原两处提示分支的检查缺口）；③`ClientUploadError` 保留原始传输错误的 cause 链（排查 413 / 网关 / 超时需要 status / retryAfter / stack）；④`useMediaEditTask` clientTask 成功路径补 post-await 中止复核（与 fallback / 纯服务端路径对称，取消与管线收尾竞态不再写入派生节点）；⑤裁剪面板确认按钮在源尺寸未就绪时禁用（原静默 no-op 无反馈，与「给反馈不静默吞」约定相悖）。规则 1.6 补记：分离音轨双产物为原子操作，任一上传失败两产物均不入库。

审查修复轮四（2026-10-14，第四轮复审后用户确认）：①删除 `file-api.ts` 对 `CropRectPx` 的兼容再导出，VideoNode 直接从 `@noxrea/shared/crop-rect` 导入（AGENTS 三.4 禁止兼容层）；②回退服务端时清除客户端管线残留的过期百分比，`ClientUploadError` 携带的服务端错误码（`upload.<code>`）接入 `error.<code>` 本地化通道；③能力探测全程贯通 AbortSignal（探测各步骤间检查，取消在步骤边界即生效，不再等探测结束）；④VideoNode / AudioNode 的 busy kind→文案映射收敛为 `useMediaEditTask` 的共享 `resolveBusyLabelKey`；⑤清理孤儿 i18n 键 `media.loading`；⑥补 `useMediaEditTask` 编排语义回归测试（成功 / 回退 / 上传失败不回退 / 成功后中止丢弃产物 / busy 互斥）。Spec 同步：规则 1.2（探测缓存如实描述）、1.6（分离音轨串行上传的残留文件语义）、4.1 / 4.3（进度文案与回退进度行为）、技术影响模块清单改为实际文件。

审查修复轮五（2026-10-14，第五轮复审后用户确认全量修复）：①删除两处重复的 `ensureNotAborted` 相邻调用（音频变速 / 音频片段截取，轮四 replace_all 与逐函数编辑叠加引入）；②删除 soundtouchjs 的冗余 `st.rate = 1`（构造默认值即 1）；③画面裁剪补编码能力前置探测（`canEncodeVideo("avc")`，与片段截取一致，规则 1.1 的 fail-fast 语义）；④五个操作的失败路径产物取消统一为无条件 `cancel()`（mediabunny 各状态均安全幂等，不再各自维护状态判断，与分离音轨同形态）；⑤产物写入竞态守卫收敛：`useMediaEditTask` 新增 `expectSource(expectedSrc)`（源一致性检查），抽帧的内联守卫改用之，分离音轨 / 片段截取 / 画面裁剪与 AudioNode 两个 onSuccess 补齐同守卫——长任务跨越「换源 / 删除节点」后旧源产物一律不写；⑥Spec 同步：验收标准探测缓存措辞、4.1 进度口径（当时误概括为「Conversion 比例，非帧数估算」）、服务端「零变更」措辞（钳位契约 import 下沉 shared）。

审查修复轮六（2026-10-14，第六轮复审后用户确认全量根因修复）：①**分离音轨探测放宽**——打开探测不再要求视频轨可解码（`canDecode()` 含 WebCodecs 解码能力判定），纯重封装只要求容器可给出编码描述（`getDecoderConfig()`，封装 sample entry 的必要输入）；规则 1.1 改写为按操作探测真实所需，消除与「分离音轨不解码视频」的规则内矛盾——无硬解的机器现在也能客户端重封装 ISO-BMFF+AAC 源；②**双路 Conversion 共用同一 Input 补证**——库源码核读 `Conversion.execute()` 不消费 / 不 dispose Input、轨级 sink 每次新建迭代器，串行两路 execute 安全（注释已记于实现处，浏览器走查分离音轨路径时一并复核）；③**音频变速补 SoundTouch 采样率**——Stretch 构造默认按 44100 自调谐 WSOLA 窗口，改为按源采样率 `setParameters`（0 值参数保持库内自动档），48kHz 源的窗口时长不再偏短约 8%（仅音质；时长换算本不受影响）；④`runWithAbortCancel` 收敛三处重复的「挂监听前检查已中止 + once 监听 + finally 清理」取消脚手架；⑤`readEditEnvelope`（file-api）收敛五处 serverTask 信封解析（防御解析 + 响应后中止复核 + 失败通知 + Retry-After 附注），抽帧保留双分支实现（200 但载荷缺 url 是无错误码的独立失败模式）；⑥删除 `tryCropOnClient` 无消费方的 `width` / `height` 返回字段；⑦节点元数据探测缺失时由会话元素回填 `naturalWidth` / `naturalHeight`（skipHistory，同 duration 回填先例；服务端探测值是权威、不覆盖）——元数据从未回填的源裁剪入口不再永久禁用；⑧Spec 同步：1.1 按操作探测、4.1 进度口径改为混合口径（修正轮五的过度概括）、业界对标行同步。

审查修复轮七（2026-10-14，用户实测 mkv 片段截取失败 + 兜底产物落空，全量根因修复）：①**`resolveVideoBitrate` 返回值恒取整**——mediabunny `averageBitrate = 8×字节数/时长` 是浮点，原实现 `Math.min(sourceBitrate, raw)` 在 ratio=1（片段截取）时把未取整的源码率原样作为上限返回，`Quality` 校验「must be a positive integer」抛 TypeError（画面裁剪因 pixelRatio<1 返回的是折减后的整数而侥幸通过，形成「能裁剪不能截取」的表象）；②**轮六回归：serverTask 信封投影**——轮六的 `readEditEnvelope<T>` 返回信封 `data` 对象本身，而片段截取 / 画面裁剪 / 音频截取 / 变速四处的 `data` 形状为 `{ url }`，对象被直接当作 url 传给节点创建（`src=[object Object]` 空节点；服务端产物实际已正常落盘，属纯前端投影错误）；改为调用点显式投影 `?.url`，分离音轨（data 为完整对象）与抽帧路径不受影响；③补 `resolveVideoBitrate` 整数保证回归测试。教训入档：`readEditEnvelope<string>` 的泛型是对运行时形状的未校验断言，data 的形状投影必须在调用点显式写出。（2026-10-22 补注：本段 `?.url` 为当时实现的如实记录；存储引用值域统一后四处投影已收敛为 `readEditResultKey` 的 `?.key`，见轮十七。）

审查修复轮八（2026-10-14，第八轮复审后用户确认全量根因修复）：①**探测负缓存档位化**——缓存键从裸 URL 改为「探测档位 + URL」（`unsupportedProbes`：video-mux / video-decode / audio 三档，弱档失败蕴含强档必败、强档失败不封杀弱档操作），修复「无硬解 HEVC 源试过片段截取后，分离音轨的 mux-only 弱探测被缓存命中错杀」的轮六放宽失效；②**音频操作纳入缓存与探测收敛**——音频变速 / 音频截取的自建 Input 探测块抽为 `openAudioSourceOrThrow`（与 `openOrThrow` 同契约：audio 档负缓存 + 步骤间中止检查 + 失败归一），两处逐字重复的探测块收敛、Spec 1.2 的缓存覆盖补全；③`resolveVideoBitrate` 补 `Number.isFinite` 守卫——`computePacketStats` 在时长为 0 时给出 `Infinity`（8×bytes/0），原 `<= 0` 守卫拦不住，`Quality({bitrate: Infinity})` 抛错且该 URL 进负缓存后客户端编辑永久回退；④**取消路径跳过二次 cancel**——带 abort 监听的三个操作（片段截取 / 分离音轨 / 音频截取）的 catch 在 `signal.aborted` 时不再重复 cancel（abort 监听已取消，二次调用安全但 mediabunny 会对已取消状态打 warn，纯噪音），非取消失败仍统一取消；⑤`apiUploadWithProgress` 的四处 `xhr.abort()` 统一为 `abortXhr()`（部分浏览器对已完成请求 abort 会抛错，原三处 try/catch 一处裸调不一致）；⑥删除 file-api 死类型 `ExtractedClipInfo`（HEAD 既有无消费者）；⑦BusyOverlay 头注释补音频节点消费方；⑧Spec 同步：1.1 的 canEncodeAudio 限定为片段截取（裁剪非 AAC 直接回退）、1.2 缓存档位语义、补回归测试（Infinity/NaN → undefined）。

审查修复轮九（2026-10-14，第九轮复审后用户确认根因修复）：①**探测负缓存下沉 `support.ts` 并补单测**——档位格（`ProbeLevel` / `BLOCKING_LEVELS` / `isProbeUnsupported` / `markProbeUnsupported`）从 client-video.ts（混在编解码胶水里无法单测）迁出为纯逻辑，`support.test.ts` 补档位格用例（mux 封杀 decode、decode 不封杀 mux、audio 独立、URL 隔离），兑现技术影响「探测缓存单测」声明；②`resolveVideoBitrate` 补 `Number.isFinite(pixelRatio)` 守卫——NaN 会穿透 `min/max` 钳位直达输出，`Quality({bitrate: NaN})` 抛错；非有限比例按整幅处理（保留源码率上限信息），补回归测试；③**失败路径产物取消改按活动态判定**（`cancelIfCancellable`：仅 pending / executing / started 时 cancel）——mediabunny 在 `execute()` 失败时已自行 cancel（库源码 conversion.js 失败路径 `void this.cancel()`），finalize 完成后是 finalized，对这些终态再调用只打 Info 级 warn 纯噪音；此单一机制同时取代轮五「无条件 cancel」与轮八「abort 守卫」两种特设条件（abort 监听取消后产物即终态，活动态判定天然跳过），轮八注释「避免 warn」对非取消失败路径不成立的偏差修正；④裁剪面板 `displaySize` 由挂载一次性测量改为 `ResizeObserver` 跟踪（元数据回填改变节点主体大小时比例锁定换算不再用过期尺寸）；⑤Spec 同步：验收标准与当前状态的缓存措辞（档位 + URL）、2.4 的 `hardwareAcceleration: "prefer-hardware"`（原 `preferHardware: true` 是不存在的 API 形状）、技术影响 support.ts 职责清单。

审查修复轮十（2026-10-14，第十轮复审后用户确认全量根因修复）：①`resolveVideoBitrate` 补 `cap === 0` 守卫——亚 0.5bps 病态源 `Math.round(0.4)=0` 使原实现返回 0（违反「返回值恒为正整数」契约，`Quality({bitrate: 0})` 抛错回退）；语义归入既有「源码率信息不可用 → undefined 交由编码器自决」分支，补回归测试；②**serverTask 上下文收窄为 `{ signal }`**——原注入的 `onProgress` 无一消费方且 Spec 4.3 明文「服务端兜底不上报进度」，属死能力，类型层面即约束（六个调用点全部只解构 `signal`，零实现改动）；③四个无消费方的命名类型取消导出（`ProbeLevel`、`MediaEditBusy`、`MediaEditTaskContext`、`MediaEditTaskOptions`——调用点全靠结构推断，导出仅为未使用的表面 API）；④删除 VideoNode.test.tsx 残留的未使用 `useState` 导入（lint error 级）；⑤五个操作 catch/finally 收尾同形**维持现状**（审查代理同判：共享件已抽取，再包 `runPipeline` 与 AGENTS 三.5 过度抽象约束相悖）；⑥首帧 NaN 窗口与 `videoSize` 运行时 undefined 两项不补防御分支（实际不可达，叠加特殊判断违反 AGENTS 一.2）；⑦Spec 同步：验收标准的 webm 括注为 mp4box.js 时代遗留（webm 在格式覆盖矩阵内），改为「avi 等其余容器 / 解码不可用」；media-processing-concurrency.md 第六轮条目归位第四/五轮之后（轮次倒序）。

审查修复轮十一（2026-10-14，第十一轮复审后用户确认全量根因修复）：①**上传进度映射收口 `uploadDerivedFile`**——四处逐字重复的 `mapProgress(pct, 90, 10)` 投影改为上传助手默认映射到 90–100 尾段（Spec 4.1 统一口径：编码 0–90 / 上传 90–100），分离音轨双产物经 `progressBase` 传参覆盖（80–10）；②serverTask 纯服务端分支局部变量 `only` → `serverValue`（名称表意）；③`readEditEnvelope` 的 `onErrorCode` 回调类型放宽为 `string | undefined`（原空串哨兵表示「无码」不诚实，消费方比对具体码不受影响）；④删除 VideoNode.test.tsx 冗余别名 `const broken = video`；⑤删除 soundtouchjs.d.ts 无消费方的 `rate` 声明（该文件自订契约「仅声明本项目用到的面」）。

审查修复轮十二（2026-10-15，第十二轮复审后用户确认根因修复）：①**片段截取音轨能力守卫补全**（P2）——原守卫只拦「非 AAC 且平台无 AAC 编码器」；codec 未知（容器未给出，mediabunny `InputAudioTrack.codec` 可为 null）且平台有编码器时放行，库内对未知 codec 静默丢弃音轨（有视频轨时 isValid 仍真）→ 产出无声片段报成功。改为：非 AAC 音轨转编前提是 `canDecode()`（codec 未知不可解码 → 回退服务端保留音频）+ AAC 编码器；音频片段截取同形改写（原本依赖「零轨 isValid=false 事故」回退，改为按真实能力直接回退）；②**裁剪面板未就绪守卫修正**——轮十曾判 videoSize 运行时缺失「历史脏数据、不可达」，轮十二 Spec 轴指出轮六⑦明确允许元数据运行时缺失（按设计可达），原 `undefined < 2 === false` 使确认按钮可点并派发 NaN 矩形；修正：`videoSize` prop 类型诚实化为可选（VideoNode 仅在 `naturalWidth/Height` 就绪时传入），未就绪时确认禁用、尺寸显示「– × –」占位；③BusyOverlay 取消按钮补 `onPointerDown` stopPropagation（与 VideoControls 控件同一约定——按下后移动不再被 React Flow 接管为节点拖拽而吞掉 click）；④**编码段 0–1 分数进度投影收口 `mapFraction`**（support.ts，段内钳位）——clip / crop / 变速 / 音频截取四处 `Math.min(90, Math.round(f × 90))` 与分离音轨两处 0–40 / 40–80 变体共六处收口，补单测；⑤Spec 同步：验收标准的「仅契约类型 import 下沉」措辞改为「契约类型 + clampRect 实现下沉」。

审查修复轮十三（2026-10-15，第十三轮复审后用户确认全量根因修复）：①**进度投影归一到 `mapFraction` 单一原语**——删除 `mapProgress`（0–100 口径仅剩上传一处调用），上传百分比由调用方 /100 换算（测试用例并入 mapFraction 块）；②`apiUploadWithProgress` 的**四处 abort 收口 `abortWith`**——watcher 超时 / onOffline / onSessionAbort / onOperationAbort 同形的 settle→abortXhr→reject 收口为单一助手（轮八的 `abortXhr` 是其内层）；③**`computePacketStats` 非空契约清理**——d.ts 声明 `Promise<PacketStats>` 非空，删除两处冗余 `stats?.… ?? null` 防御；④VideoNode.test.tsx 的 MockVideoCropPanel 替身类型诚实化（`videoSize?` 可选，未就绪渲染「–」占位，与真实 prop 对齐）；⑤VideoCropPanel 的 `toPx` 模块级投影助手——确认换算与尺寸展示共用同一「比例→像素」投影；⑥**`readEditEnvelope` 通知入口裁定维持现状**：React 上下文实例显式下传是 web/AGENTS 七.2 统一入口的延伸而非旁路（实例源自 `useAppFeedback()`、去重与封装未绕过；showGlobal* 为无 React 上下文场景设计），轮六⑤用户确认设计入档；⑦**clip 的 `computePacketStats()` 全量扫描记录为已知权衡**（未实测的性能项：mkv 源元数据爬取 O(文件)，换取源码率封顶精度；crop 需 packetCount 作进度分母不受影响）——待实测数据再决定是否改有界采样，不盲改估码率策略；⑧Spec 4.1 补单产物操作「编码段 0–90 / 上传段 90–100」的明文口径与 mapFraction / uploadDerivedFile 收口说明。

审查修复轮十四（2026-10-15，第十四轮复审后用户确认根因修复）：①**裁剪进度分母防御链清理**——轮十三③非空契约清理的漏网一处：`stats?.packetCount ?? 1` 改为直接取 `stats.packetCount`（d.ts 声明 `Promise<PacketStats>` 非空；外层 `Math.max(1, …)` 保留——空视频轨 packetCount 可为 0，进度除法分母仍需 ≥1）；②**未知 codec 错误消息插值统一**——裁剪「音频编码 X 不支持包级拷贝」与分离音轨「音轨编码 X 不支持客户端拷贝」两处 `${audioTrack.codec}` 直接插值，codec 为 null 时消息呈现字面量 "null"，与片段截取 / 音频截取既有 `?? "未知"` 口径对齐；③**视频源打开两层合并**——null 返回的 `openVideoSource` + 归一包装 `openOrThrow`（Middle Man）合并为单一 `openVideoSourceOrThrow`，与音频侧 `openAudioSourceOrThrow` 同构：探测各步直接抛具体失败原因（容器格式不可解析 / 视频轨缺失 / 视频轨不可解码 / 视频轨缺少编码描述），缓存命中抛「视频源此前探测失败（会话缓存命中）」，catch 内 dispose + 记负缓存 + 原样上抛；clip / crop / detach 三处调用点与注释同步改名，轮八②的「同契约」表述更新为「同构」。本轮为内部结构收敛，规则 1.1 / 1.2 / 1.6 与验收标准语义不变。

审查修复轮十五（2026-10-15，第十五轮复审后用户确认根因修复）：①**音频轨 AAC 守卫按业务规则抽成对助手**——四处同形守卫收口为 `ensureAacConvertible`（转编前提，片段截取 / 音频截取共用：非 AAC 需可解码出 PCM + 平台有 AAC 编码器；轮十二①「codec 未知静默丢轨、不依赖产物形状事故」的理由并入助手注释）与 `ensureAacCopyable`（包级拷贝前提，画面裁剪 / 分离音轨共用：音轨编码必须是 AAC）；同规则错误消息归一（控制台日志口径，不涉 UI 文案：片段「音频编码」→「音轨编码」、音频截取「无法拷贝或转编」→「无法转编为 AAC」消息头统一为「音轨编码」、分离音轨「不支持客户端拷贝」→「不支持包级拷贝」）；②`openVideoSourceOrThrow` 的探测档位三元式收敛为 `probeTier` 局部量（缓存读写共用，表达「每次调用一个逻辑档位」）；③**取消触发方式 Spec 措辞修正**——取消规则、规则 8 与验收标准三处原写「面板关闭 / Esc 可中止」，实际任务在面板确认后才启动、二者在管线运行中不可达，按真实杠杆改写为「busy 浮层『取消』/ 节点换源 / 节点卸载」；④**i18n 历史遗留修复**——en-US `common` 块补 `play`/`stop`（AssetCard / AudioRefCard 消费，此前英文环境经 fallbackLng 显示中文），删除 en-US `crop.play`/`crop.stop` 死键（零消费者，历史迁移残留）；⑤Spec 轴「三个范围外测试文件」经 git ls-files 核验为 HEAD 既有提交内容，发现不成立，无处置。

审查修复轮十六（2026-10-15，未提交改动代码审查后，用户指示按根因修复）：①**`expectSource` 对已删除节点抛 TypeError**——`(node?.data as { src?: string }).src`：类型断言抹掉了 `undefined`，括号又截断可选链，节点查不到时 `(undefined).src` 抛错而不是判不一致（轮五⑤的本意是「换源 / 删除节点」都不写旧源产物）；断言改为保留 `| undefined` 并以 `?.` 取值，今后漏写 `?.` 由 tsc 直接拦截；同类写法 `DirectorNode` 一并修正；补 `expectSource` 回归测试（一致 / 换源 / 节点已删除）；②**会话失败浮层补回裁剪态「取消」**——轮十二⑦删除 cropOpen 加载浮层时，同一浮层里的取消按钮一并丢失，而失败态下裁剪面板让位、其自带关闭键随之不可见，退出裁剪态只剩点击画布空白；失败浮层在裁剪态下恢复「取消」，与裁剪面板关闭键共用 `closeCrop`；补回归测试（并断言非裁剪态失败浮层没有取消）；③**上传响应契约单一来源**——删除 client-video 自行声明的 `UploadEnvelope`，复用 `lib/utils/upload` 导出的 `UploadBatchResponse` 与 `isUploadResult`（与拖入上传同一份契约与校验）；`size` 取本地 `File.size`（产物即上传对象）；④Spec 订正：规则 2.3 去掉与 2.5 矛盾的「变速 = 时间戳缩放」（变速只作用于音频轨）、规则 2.9 背压机制改为如实描述 `await add()`（Mediabunny 约定，非 `encodeQueueSize` 阈值）；media-processing-concurrency.md 规则 6 与第六轮条目补记「源文件删除时 `deleteDerivedArtifacts` 遍历全部分组一并清除旧分组产物」（原表述「代码只访问档位路径 / 不自动清理」与 `local.ts` 不符）。以上两处措辞订正（2.3 对齐决策 4 与规则 2.5，2.9 对齐实现与库约定）不改变任何已确认决策、接口契约或验收标准，2026-10-15 经用户授权由 Agent 判定为订正，无需另行确认；依赖许可证的处置见技术影响「依赖许可证」。

审查修复轮十七（2026-10-22，音频截取产物 404 与派生节点生成参考 422 的根因修复）：①**音频截取面板按引用值域派生访问 URL**——`AudioClipStripPanel` 把节点的 `audioSrc` 原样交给 wavesurfer，而持久化值域是存储 key（wavesurfer 只接受 URL）：浏览器把 key 按当前页面解析成 `/canvas/{key}` 请求而 404。面板内以 `fileRefUrl(audioSrc)` 统一派生（key → `/api/files/{key}`，外部 URL 透传），wavesurfer 与重建依赖改用派生值。②**派生节点持久化值域统一为存储 key**——编辑接口响应同时携带 `key` 与展示 `url`，四条单产物编辑路径（音频截取 / 变速、视频截取 / 裁剪）的 serverTask 按 `data` 形状投影 `?.url`，客户端管线也投影 `.url`，派生节点 `data.src` 因此落成 `/api/files/...` 展示 URL——该值不在持久化值域内，作为下游生成参考会被服务端 file-ref 校验拒绝（422，值域约定见 `specs/storage-reference-key-unification.md`）。新增 `readEditResultKey`（`readEditEnvelope<{ key }>` 的单一投影，只取 `?.key`；信封成功但缺 `key` 按失败提示，与抽帧「200 缺字段」同形，不静默丢弃任务；信封上下文类型同时提取为 `EditEnvelopeContext`，两条投影共用），四条路径的 serverTask 统一经其投影；客户端管线的 `clientTask` 改取 `.key`，`onSuccess` 形参更名 `url → key`；抽帧改为要求响应携带 `frame_key`（原判 `url`），分离音轨改用 `video.key` / `audio.key`。③**派生节点创建 helper 按引用值域更名**——`createNodeFromUrl` / `createAudioNodeFromUrl` / `createVideoNodeFromUrl` → `createImageNodeFromRef` / `createAudioNodeFromRef` / `createVideoNodeFromRef`，参数 `url → ref`（存储 key 或外部 URL），VideoNode / AudioNode / DirectorViewport 的调用点全部同步迁移（上传派生 sink 直接构建节点并已写 `src: result.key`，不在更名范围），函数注释写明展示 URL 不得写入节点。④**回归测试与源码防线**——`readEditResultKey` 单测（key 优先于 url / 成功缺 key 按失败提示 / 失败按 errorKey 通知 / 中止丢弃且不通知）；音频截取 / 变速 / 视频截取 / 裁剪 / 分离音轨五条路径的客户端与服务端兜底均断言派生节点收到存储 key；抽帧断言 `frame_key` 交给 `createImageNodeFromRef`；AudioClipStripPanel 断言波形 URL 为 `fileRefUrl` 派生的托管 URL；新增 web 侧源码断言 `web/src/__tests__/architecture/storage-key-write-contract.test.ts`（节点创建调用实参不含 `url` 标识符、节点数据 `src` 写入不来自 URL 表达式、编辑信封不按 `{ url }` 声明、上传写入层不做引用值 → URL 派生；含函数定义排除、调用点计数与历史回归形态自检）。静态扫描不穷举解构别名等形态，运行期由五条路径的客户端 / 服务端回归测试补充，不宣称覆盖全部写入形态。⑤Spec 同步：规则 3.1 明确节点创建只消费 `key`（`url` 为渲染期派生值，分离音轨按双产物信封消费各自 `key`），轮七补注投影已由 `?.url` 收敛为 `?.key`。⑥审查处置（记录理由）：编辑任务的 `clientTask` / `serverTask` / `onSuccess` 三元组重复属既有结构，各调用点参数、标签与产物节点不同，抽公共助手需传 8 个以上参数（AGENTS 三.5 过度抽象约束），维持现状；`frame_key` 与 `data.key` 的命名差异属服务端既有契约，不在本轮更名。

审查修复轮十八（2026-10-22，第五轮未提交代码审查后用户指示根因修复）：
①**web 源码绊线改用 TypeScript AST**——原文本扫描不剥注释（注释中的历史形态误报、注释内括号会破坏实参配对）且只能靠前缀猜函数定义（生成器 / 方法简写会被计为调用点），并留有 `data.src = fileRefUrl(key)` 这类 helper 派生值的盲区。改为 `ts.createSourceFile` + AST 遍历：注释与字符串天然不参与匹配，定义不是 `CallExpression`，URL 值判定覆盖 `.url` / url 结尾标识符 / `fileRefUrl` 等六个派生 helper（含 `withManagedFileWidth`）/ 托管路径字面量，递归覆盖条件、数组、对象、箭头函数表达式体与 `map(...)` 等间接形态。扫描面从「节点 `data.src`」扩展到全部持久化引用字段（`src` / `ref` / `fileKey(s)` / `refImages|Audios|Videos` / `multiResultKeys` / `resultKeys` / `avatarKey` / `coverKey`），对对象字面量与 `*.data.<field>` 赋值同时生效；节点创建调用改查第 2 参（引用形参）。上传写入层的 token 禁令保留（helper 标识符 + `/api/files/` 字面量）。调用点基线固定为 23，helper / 工厂更名或扫描器失明时直接失败。静态扫描仍不穷举 helper 别名与间接派发，该限制写入测试头注释与 Spec，运行期回归为准。派生 helper 注释恢复「`/api/files/` 展示 URL」的准确措辞（AST 不再把注释当代码）。
②**分离音轨双产物补缺 key 守卫**——`readDetachAudioResult` 对 `readEditEnvelope<DetachAudioResult>` 要求 `audio.key` 与 `video.key` 同时存在，缺一即按失败提示并触发 `onErrorCode(undefined)`（与 `readEditResultKey` 同一联动契约），不再把 `undefined` 当 `src` 创建节点；`readEditResultKey` 的缺 key 提示同批补齐 `retryAfterOf(res)` 实参。补 `file-api` 投影单测（双 key 优先 / 任一缺失属契约破坏）与 VideoNode 集成回归（服务端 200 缺 `audio.key` 时不创建任何派生节点）。
③测试夹具 `jsonResponse(body, ok)` 的布尔控制参数拆分为 `jsonResponse` / `errorResponse`，消除控制标志。
④审查处置（记录理由，不改代码）：`createVideoNodeFromRef` 的 10 个位置参数为既有 API 形状，本批未新增参数且改名属于跨调用方的无关重构（AGENTS 六.1），维持现状；`StorageRef` 品牌类型是可选的领域类型强化，但当前值域校验已在服务端 schema 与运行期回归双层覆盖，改名会扩散到本 Spec 范围外，暂不引入；`clearAllMocks` 不清 `mockResolvedValueOnce` 队列是既有测试卫生风险，本批用例未在队列中留残留，不新增全仓级夹具改造。

审查修复轮十九（2026-10-22，第六轮未提交代码审查后用户指示根因修复）：
①**抽帧信封解析收敛**——`VideoNode` 的抽帧 `serverTask` 仍手写「防御解析 → 中止检查 → `!res.ok` 通知 → 缺字段通知」，与 `readEditResultKey` 已封装的契约重复且已随本次改动被触及。新增 `readCapturedFrame`（`readEditEnvelope<CapturedFrameInfo>` + `frame_key` 缺失守卫），调用点只剩请求 + 投影两行；200 缺 `frame_key` 仍按失败提示（轮六保留独立实现的理由由共享投影承接），补回归用例锁定「不创建节点 + 有提示」。
②测试夹具去重：`detachedMedia` 移入 `storage-fixtures`，VideoNode 与 file-api 测试共用，删除两份同形构造。
③审查处置（记录理由，不改代码）：`readEditResultKey` 的「undefined 表示已中止或已按 ctx 提示失败」经复核无过度声明——`readEditEnvelope` 对 200 缺 `data` / 非 JSON 同样先走失败通知再返回 undefined；`NODE_CREATION_CALLS` 基线耦合为有意的扫描面绊线，非缺陷。

审查修复轮二十（2026-10-22，第七轮未提交代码审查后用户指示根因修复）：
①**编辑信封持久化投影收敛**——`readEditResultKey` / `readDetachAudioResult` / `readCapturedFrame` 三处重复的「读信封 → 缺 key 拒绝」骨架收敛为 `readPersistedEnvelope(res, signal, ctx, hasPersistedKey)` 基座，差异只剩必填字段判定，失败提示与联动契约单点维护。
②**抽帧投影去掉渲染期 url**——`readCapturedFrame` 返回 `CapturedFrameRef { key, time, width, height }`（服务端 `CapturedFrameInfo` 的 `url` 不进入投影），调用方在类型层面无从把展示 URL 写入节点，与 `readEditResultKey` 的 key 值域对称。
③**视频回归夹具改用 key 值域**——VideoNode 测试的源节点 `data.src` 由 `/api/files/test.mp4` 改为 `storageKey(...)`；播放源与海报断言改为组件派生的 `/api/files/{key}`，编辑接口入参断言为存储 key。五条编辑路径的回归自此以生产实际持久化形态（存储 key）行使，轮十七的值域前提在测试层闭环。
④**测试助手去重**——新增 `expectDerivedAudioNode` 补齐视频 / 音频断言对称；`stubNode` 收口六处派生工厂占位节点字面量。
⑤验证：typecheck、lint:web（0 error，26 条既有 img 警告）、定向 46 用例、web test（130 文件 / 959 用例）串行通过；server 代码未改动，未重跑 server 测试套件。

审查修复轮二十一（2026-10-22，第八轮未提交代码审查后用户指示根因修复）：
①**删除 `toFileKey` 兼容层**——持久化值域统一为存储 key 后，`toFileKey` 的 `/api/files/` 前缀剥离与查询串剥离只服务于已不存在的旧 URL 值域；节点编辑动作（抽帧 / 分离音轨 / 视频截取 / 裁剪 / 音频截取 / 变速）直接把节点 `src` 交给客户端管线与服务端接口，雪碧图与代理请求以 `isStorageKey` 判定（服务端接口只接受 key，外部 URL / 本地预览地址不再发起必然失败的请求，与两处面板注释的既有契约一致）。全部 9 个调用点同步迁移，不保留别名或兼容 wrapper。
②**单产物投影命名表意化**——`readEditKey` → `readEditResultKey`，测试夹具 `editKeyResponse` → `editResultResponse`（旧名读作「编辑 key」易误解为 key 本身的编辑；投影语义是编辑结果里的持久化 key，与 `readDetachAudioResult` 对称）。
③**测试脚手架去重**——新增 `web/src/__tests__/test-utils/canvas-node.ts`：`nodeViewProps` 收口 VideoNode / AudioNode 编辑测试的 React Flow 静止态 props 组装，`flushMicrotasks` 收口两份相同的 8 轮微任务冲洗；`stubNode` 形参改用 Vitest `Mock` 类型，删除手写结构类型。音频测试再以 `openNode` 收口「挂载 + 首帧冲洗」。
④**夹具值域与投影覆盖补齐**——`AudioClipStripPanel.test.tsx` 默认夹具由托管 URL 改为 `storageKey(...)`（生产值域），并补外部 URL 原样透传用例；`file-api.test.ts` 补 `readCapturedFrame` 直接单测（成功投影只含 key / time / width / height，展示 url 不暴露；200 信封成功但缺 `frame_key` 按失败提示并触发 `onErrorCode(undefined)`）。
⑤审查处置（记录理由，不改代码）：`expectDerivedVideoNode` / `expectDerivedAudioNode` 保持独立——两种派生工厂的位置参数顺序不同（视频为 key + 宽高 + 标签 + store，音频为 key + 标签 + store + position），合并只能共享 `(sourceId, key)` 前缀并把尾参拼成数组，反而隐藏各工厂的实参位置，违反 AGENTS 三.5；两项工厂共享的创建契约已由 `deriveWrites` 等既有 helper 与各自断言注释表达。
⑥验证：typecheck、lint:web（0 error，26 条既有 img 警告）、定向 49 用例、web test（130 文件 / 962 用例）串行通过；server 代码未改动，未重跑 server 测试套件。

审查修复轮二十二（2026-10-22，第九轮未提交代码审查后用户指示根因修复）：
①**引用值 → key 归一收口 `storageKeyOf`**——`isStorageKey(x) ? x : null` 的三元式在 FrameStripPanel / ClipStripPanel / use-frame-sprite 各写一份，属同一条「媒体接口只接受存储 key」门控规则的多处独立实现，后续任何一处改判都会漂移。`shared/url.ts` 新增 `storageKeyOf(value): string | null` 单点归一（严格 key 原样返回，外部 http(s) / data: / blob: / 空值一律 null），三处调用点与六个编辑处理函数（VideoNode 抽帧 / 分离音轨 / 片段截取 / 画面裁剪，AudioNode 音频截取 / 变速）统一经它判定并以归一后的 key 作为接口入参。
②**编辑入口按 key 值域门控**——媒体编辑接口只接受存储 key，对非 key 源发起请求必然失败，故 NodeToolbar 的抽帧 / 片段截取 / 裁剪 / 分离音轨 / 音频截取 / 变速按钮在 `storageKeyOf(assetSrc)` 为 null 时禁用；外部 URL 节点的播放、下载、预览、收藏、反推等不需要 key 的入口保持可用。这是接口能力的如实表达（[storage-reference-key-unification.md](storage-reference-key-unification.md) 规则 3.1），而非对特定来源的特判。
③**面板确认键同域门控**——FrameStripPanel / ClipStripPanel / AudioClipStripPanel 的确认键在无 key 时禁用，处理函数同步早退；VideoNode 的抽帧 / 裁剪处理函数在无 key 时关闭对应面板，避免留下无响应的确认入口（面板只能由工具栏打开，此为纵深防御）。
④**属性命名如实化**——`AudioClipStripPanel` 的 `audioSrc` → `audioRef`，与 VideoNode / DirectorViewport 的引用值域命名一致（值可以是存储 key 或外部 URL，不是可直接播放的 src）；VideoNode 调用点同步。
⑤**测试**——`file-api.test.ts` 的共享可变 `ctx` 改为 `makeCtx(overrides)` 工厂：`NotificationApi` 完整实现（四通道 `vi.fn()`），`t` 诚实断言为 `TFunction`；抽帧 / 分离音轨断言改用各自调用点的真实兜底 key（`error.capture_frame.capture_failed` / `detach.failed`，原断言误用 `error.clip.extract_failed`，锁定的是测试自己的假设）；`server/__tests__/shared/url.test.ts` 补 `storageKeyOf` 值域用例（key 原样返回；外部 URL / data: / blob: / 空值 → null）。
⑥审查处置（记录理由，不改语义）：`nodeViewProps` 的 `as unknown as ComponentProps<T>` 双重断言保留并注释——React Flow 运行时注入的 handle bounds 等字段测试无法构造，节点组件也不读取；`flushMicrotasks` 的固定 8 轮提为 `MICROTASK_TURNS` 常量并注释理由——编辑管线每个 `await` 消耗一轮微任务，且部分用例在 fake timers 下调用，不能用宏任务冲刷。
⑦验证：typecheck、lint:web（0 error，26 条既有 img 警告）、定向 49 web 用例 + 9 个 server shared url 用例、web test（130 文件 / 962 用例）串行通过；server 仅新增 url 契约测试，未改动业务代码，未重跑 server 全量套件。

审查修复轮二十三（2026-10-22，第十轮未提交代码审查后用户指示根因修复）：
①**预览代理加载收口 `useVideoProxy`**——`ClipStripPanel` 与 `FrameStripPanel` 各有一份同形的 `fetchVideoProxy` effect（中止、外部 URL 跳过、失败归类、手动重试），本次 diff 同时改了两份，属典型 shotgun 形状。新增 `web/src/features/canvas/hooks/use-video-proxy.ts`：暴露 `status / url / duration / error / retry / markFailed`；`ClipStripPanel` 与 `FrameStripPanel` 只消费返回值，删除各自的代理状态、重试计数与请求 effect，顺带消除 `[videoSrc, videoKey, proxyAttempt]` 里由 `videoSrc` 派生的冗余依赖。
②**换源失效改为派生状态**——hook 内部以「来源 + 重试代数」标识已定论结果，输入不一致即派生为 pending：换视频源或点击重试时旧代理地址立即失效，不会在新源上继续沿用；不在 effect 体内同步 `setState`（react-hooks 规则的 error 级约束，也避免级联渲染）。`markFailed` 承接「代理可下载但浏览器解码不了」的上报（无 error：重试同一份缓存产物不会成功）。
③**测试夹具命名去歧义**——`storageKey(seed, ext)` → `makeStorageKey`（它是构造器，与 shared/url 的 `isStorageKey` / `storageKeyOf` 谓词家族区分），四个测试文件的导入与调用同步；新增 `use-video-proxy.test.ts`（4 用例：key 发起请求 / 外部 URL 不请求 / 失败码与重试 / 换源失效与 markFailed）。
④**信封基座精确判定**——`readPersistedEnvelope` 的 `if (!data)` 改为 `if (data === undefined)`：只有「已中止 / 已按 ctx 提示」走该分支，泛型 T 若为原始值（0 / ""）是合法载荷，不应被 falsy 判断吞掉。
⑤**存量脏数据盘点**——对当前启用的 server 模式 PG 只读审计画布节点 `data.src`：4 个项目、349 个严格存储 key、0 个 `/api/files/` 展示 URL、3 个空值；缺陷窗口未留下脏行，无需改写。明细与结论见 [storage-reference-key-unification.md](storage-reference-key-unification.md) 第十三轮。
⑥验证：typecheck、lint:web（0 error，26 条既有 img 警告）、定向 49 + 4 用例、web test（131 文件 / 966 用例）、server 全量（89 文件 / 977 用例通过、11 skip）串行通过。

审查修复轮二十四（2026-10-22，第十一轮未提交代码审查后用户指示根因修复）：
①**非 key 源的定论语义显式化**——`useVideoProxy` 新增 `NO_PROXY` 常量（`ready` + `url: null`：没有代理可用，且不是请求失败，无处重试），替代 `{ ...PENDING, status: "ready" }` 这种「把 pending 展开成 ready」的写法。旧 ClipStripPanel 内联实现用 `"error" in outcome` 判别，会把非 key 源归类为 `failed`；统一后语义为「已定论、无代理」。面板可操作性判定不变（仍要求 `proxyUrl !== null`），且外部 URL 节点的编辑入口已在轮二十二禁用，不存在可达的 UI 回归。区分两种「无 url」：非 key 源是设计内定论；**key 请求成功却缺 `url` 属响应契约破坏**，归类为 `failed`（无错误码、重试无意义），与编辑响应缺 key 的判定同形。
②**测试夹具去投机参数**——`makeStorageKey(seed, ext, userId = 1)` 无调用方传 `userId`，删除该参数并在注释声明测试固定用户 1。
③**InfiniteCanvas 重复取值收敛**——音频截取面板的 `key` 与 `audioRef` 各写一遍同一 `src` 取值，抽为 `audioClipRef` 局部量共用。
④**文档引用修正**——`use-video-proxy.test.ts` 头部引用的轮次由二十二改为二十三（hook 抽取所在轮）。
⑤验证：typecheck、lint:web（0 error，26 条既有 img 警告）、定向 5 + 49 用例、web test（131 文件 / 967 用例）串行通过；本轮未触碰 server 代码，server 全量沿用轮二十三结果。

审查修复轮二十五（2026-10-22，第十二轮未提交代码审查后用户指示根因修复）：
①**信封「缺失」判定统一为 undefined**——`readEditEnvelope` 原用 `!json?.data` 拒绝任何 falsy 载荷，与轮二十三 `readPersistedEnvelope` 的 `data === undefined` 形成两套互相矛盾的「缺失」定义（前者的注释声称保护原始值载荷，实际在信封层已被拦掉）。两处统一为「缺失 = undefined」，泛型 T 为原始值时 0 / "" 是合法载荷；`readEditEnvelope` 仅被同文件投影使用，取消导出（死导出面）。
②**InfiniteCanvas 取值重复收敛**——帧序列 / 片段截取 / 音频截取三个面板的 `key` 与媒体 prop 各自重复写同一 `src` 取值，抽为 `frameStripRef` / `clipStripRef` / `audioClipRef`，源变化时 key 与 prop 必然一致。
③**测试 mock 卫生统一**——`AudioNode.edit.test.tsx` 与 `VideoNode.test.tsx` 的收尾由 `vi.clearAllMocks()` 改为 `vi.resetAllMocks()`（清掉未消费的 Once 队列与实现），与 `use-video-proxy.test.ts` 一致；默认实现仍在各文件 `beforeEach` 重新建立。
④**措辞对齐**——NodeToolbar 注释「隐藏编辑入口」改为「禁用编辑入口」，与 Spec 规则 3.1 及轮二十二的实现一致。
⑤审查处置（记录理由，不改代码）：`NO_PROXY` 的 `ready + url: null` 保留——为非 key 源引入第四种状态只会给不可达 UI 路径增加分支（AGENTS 三.5），语义已由常量名与注释表达；`storageKeyOf` 的单行委托由三.3 单点规则覆盖；10 参数工厂、`ref: string`、AST 绊线计数均为前轮已记录的设计处置。
⑥验证：typecheck、lint:web（0 error，26 条既有 img 警告）、定向 50 用例、web test（131 文件 / 967 用例）串行通过；本轮未触碰 server 代码，server 全量沿用轮二十三结果。

审查修复轮二十六（2026-10-22，第十三轮未提交代码审查后用户指示根因修复）：
①**引用值命名全族统一**——轮二十二④只把 `AudioClipStripPanel` 的 `audioSrc` 改为 `audioRef`，同一值域的 `FrameStripPanel` / `ClipStripPanel` 的 `videoSrc`、`useFrameSprite` / `useVideoProxy` 的形参仍是旧名。全部改为 `videoRef`，`InfiniteCanvas` 两处调用点同步；与「值可以是存储 key 或外部 URL，不是可直接播放的 src」的约定一致，不保留别名。
②**死导出清理**——`retryAfterOf` 最后一个外部导入方（VideoNode）已随本轮改动消失，取消导出，仅同文件使用。
③**无代理提示如实化**——`ClipStripPanel` 在 `ready` 且 `proxyUrl === null` 时原先落入「缓冲中」分支；改为显示「代理不可用」。该状态在工具栏门控下不可达（非 key 源编辑入口已禁用），但兜底提示不应把「已定论、无代理」表达成永久等待。
④审查处置（记录理由，不改代码）：`markFailed` 在 pending 时为 no-op——swap effect 只在 `proxyUrl` 非空（即已就绪）时运行，报告不可能先于定论到达；保守守卫也避免迟到的解码失败覆盖更新的 ready。`InfiniteCanvas` 三个面板的取值三元式形式相同但各自绑定不同宿主，抽 helper 仅为三行赋值增加间接层（AGENTS 三.5），保留。
⑤验证：typecheck、lint:web（0 error，26 条既有 img 警告）、定向 54 用例、web test（131 文件 / 967 用例）串行通过；本轮未触碰 server 代码，server 全量沿用轮二十三结果。

分离音轨补充：静音视频输出容器 = MP4 封装（扩展名 .mp4，与源扩展名可能不同）；webm / mkv / avi 容器与非 AAC 音轨 → 回退服务端（服务端沿用「copy 失败转 PCM wav」的既有回退）。

依赖说明：原 Spec 的 mp4box.js + mp4-muxer 组合已按用户提议换为 **Mediabunny 单库**（同 mp4-muxer 作者的整合升级，原生按需 Range 读取使「片段截取只拉所需范围」成为默认行为，并支持 Matroska/WebM 解封装），Spec 相应章节已更新。裁剪面板同步简化：裁剪框直接叠加在会话视频上，删除快照链路（慢网络纯黑问题的根因修复）。
