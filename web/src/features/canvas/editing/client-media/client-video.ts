/**
 * 客户端媒体管线：Mediabunny 解封装 + WebCodecs 编解码，产物经既有上传链路入库
 * （specs/client-video-editing.md）。
 *
 * 契约（Spec 规则 1.6 回退边界）：能力探测失败、源读取失败（含网络断开）或
 * 管线中途异常抛 {@link ClientUnsupportedError}，调用方自动回退服务端同能力
 * 路由（回退不循环）；派生产物上传失败抛 {@link ClientUploadError}——本地编码
 * 已完成，不回退（回退即服务端全量重编码），按普通失败上报、可手动重试；
 * 用户取消原样抛出中止原因，调用方按 `controller.signal.aborted` 静默复位。
 */
import { clampRect,type CropRectPx } from "@noxrea/shared/crop-rect";
import {
  ALL_FORMATS,
  AudioSample,
  AudioSampleSink,
  AudioSampleSource,
  BufferTarget,
  canEncodeAudio,
  canEncodeVideo,
  Conversion,
  EncodedAudioPacketSource,
  EncodedPacketSink,
  Input,
  type InputAudioTrack,
  type InputVideoTrack,
  IsobmffInputFormat,
  Mp4OutputFormat,
  Output,
  Quality,
  UrlSource,
  VideoSampleSink,
  VideoSampleSource,
} from "mediabunny";
import { SoundTouch } from "soundtouchjs";

import { apiUploadWithProgress } from "@/lib/api/client";
import { isUploadResult, type UploadBatchResponse } from "@/lib/utils/upload";

import { isProbeUnsupported, mapFraction, markProbeUnsupported, resolveVideoBitrate } from "./support";

/** 音频包级拷贝时随首个包提供的解码元数据（从源方法签名反解，随库版本走） */
type AudioPacketMeta = Parameters<EncodedAudioPacketSource["add"]>[1];

const noop = () => {};

/** 客户端不支持 / 管线失败：调用方据此回退服务端兜底 */
export class ClientUnsupportedError extends Error {
  constructor(reason: string) {
    super(`Client pipeline unsupported: ${reason}`);
    this.name = "ClientUnsupportedError";
  }
}

/**
 * 派生产物上传失败：本地编码已完成，不回退服务端（Spec 规则 1.6 回退边界，
 * 2026-10-14 用户确认「报错 + 手动重试」）。调用方按普通操作失败上报，不触发
 * 服务端兜底。仅 uploadDerivedFile 抛出，各操作 catch 经 toPipelineFailure
 * 原样放行；cause 保留原始传输错误（status / retryAfter / stack），排查
 * 413 / 网关 / 超时需要它。
 */
export class ClientUploadError extends Error {
  /** 服务端信封返回的错误码：notifyActionFailed 据此走 error.<code> 本地化；传输类失败无码 */
  readonly code?: string;
  constructor(reason: string, options?: { cause?: unknown; code?: string }) {
    super(`Client pipeline upload failed: ${reason}`, options);
    this.name = "ClientUploadError";
    this.code = options?.code;
  }
}

interface ClientVideoSource {
  input: Input;
  videoTrack: InputVideoTrack;
  audioTrack: InputAudioTrack | null;
}

/**
 * 打开源视频并探测（片段截取 / 画面裁剪 / 分离音轨共用，与
 * openAudioSourceOrThrow 同构）：容器可解析 + 视频轨存在且满足操作所需能力，
 * 失败归一为 ClientUnsupportedError（调用方回退）。探测失败（不支持）按 URL
 * 缓存，命中即跳过打开；网络类异常原样向上抛（由调用方 catch 归一回退）。
 * signal 在探测各步骤间检查：取消在步骤边界即生效，不必等整个探测结束。
 * 成功后 Input 归调用方 dispose。
 *
 * 探测按操作所需收口（Spec 规则 1.1）：默认要求视频轨可解码（解码类操作：
 * 片段截取 / 画面裁剪）；`videoMuxOnly` 只要求容器可给出编码描述（纯重封装：
 * 分离音轨不解码视频，无硬解的机器也能重封装）。
 */
async function openVideoSourceOrThrow(
  videoUrl: string,
  signal?: AbortSignal,
  opts: { videoMuxOnly?: boolean } = {},
): Promise<ClientVideoSource> {
  ensureNotAborted(signal);
  // 本次探测的唯一档位：按操作所需收口（Spec 规则 1.1），缓存读写共用
  const probeTier = opts.videoMuxOnly ? "video-mux" : "video-decode";
  // 缓存查询按档位：mux 档失败（无编码描述）蕴含解码必败，同时封杀两类
  // 操作；解码档失败（描述在、无硬解）只封杀解码档，不拦 mux 档操作
  if (isProbeUnsupported(probeTier, videoUrl)) {
    throw new ClientUnsupportedError("视频源此前探测失败（会话缓存命中）");
  }

  const input = new Input({
    source: new UrlSource(videoUrl),
    formats: ALL_FORMATS,
  });
  try {
    if (!(await input.canRead())) {
      throw new ClientUnsupportedError("容器格式不可解析");
    }
    ensureNotAborted(signal);
    const videoTrack = await input.getPrimaryVideoTrack();
    if (!videoTrack) {
      throw new ClientUnsupportedError("视频轨缺失");
    }
    // 解码描述（getDecoderConfig）是封装 sample entry 的必要输入：缺失时
    // 重封装产物不可用，照样交服务端；可解码（canDecode）则额外包含
    // WebCodecs isConfigSupported 判定
    if (opts.videoMuxOnly ? !(await videoTrack.getDecoderConfig()) : !(await videoTrack.canDecode())) {
      throw new ClientUnsupportedError(opts.videoMuxOnly ? "视频轨缺少编码描述" : "视频轨不可解码");
    }
    ensureNotAborted(signal);
    const audioTrack = await input.getPrimaryAudioTrack();
    return { input, videoTrack, audioTrack };
  } catch (err) {
    input.dispose();
    if (err instanceof ClientUnsupportedError) {
      // 只记本次操作的探测档位：mux 模式失败写 mux 键（蕴含解码必败），
      // 解码模式失败写解码键（不封杀 mux 模式）
      markProbeUnsupported(probeTier, videoUrl);
    }
    throw err;
  }
}

/** 客户端裁剪的进度回调：编码阶段 0–90，上传阶段 90–100 */
type ProgressCallback = (pct: number) => void;

interface ClientOperationOptions {
  signal?: AbortSignal;
  onProgress?: ProgressCallback;
}

interface ClientAudioSource {
  input: Input;
  audioTrack: InputAudioTrack;
}

/**
 * 打开并探测音频源（音频变速 / 音频截取共用，与 openVideoSourceOrThrow 同构）：
 * 容器可打开 + 音频轨存在且可解码，失败归一为 ClientUnsupportedError 并按
 * audio 档写负缓存；网络类异常原样向上抛（由调用方 catch 归一回退）。
 * signal 在探测各步骤间检查。成功后 Input 归调用方 dispose。
 */
async function openAudioSourceOrThrow(
  audioUrl: string,
  signal?: AbortSignal,
): Promise<ClientAudioSource> {
  ensureNotAborted(signal);
  if (isProbeUnsupported("audio", audioUrl)) {
    throw new ClientUnsupportedError("音频源此前探测失败（会话缓存命中）");
  }
  const input = new Input({ source: new UrlSource(audioUrl), formats: ALL_FORMATS });
  try {
    if (!(await input.canRead())) {
      throw new ClientUnsupportedError("音频容器不可解析");
    }
    ensureNotAborted(signal);
    const audioTrack = await input.getPrimaryAudioTrack();
    if (!audioTrack || !(await audioTrack.canDecode())) {
      throw new ClientUnsupportedError("音频轨缺失或不可解码");
    }
    return { input, audioTrack };
  } catch (err) {
    input.dispose();
    if (err instanceof ClientUnsupportedError) {
      markProbeUnsupported("audio", audioUrl);
    }
    throw err;
  }
}

function ensureNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
}

/**
 * 管线失败的归一出口（Spec 规则 1.6 回退边界）：上传失败原样放行（调用方按
 * 普通失败上报 + 手动重试，不回退），其余包装为 ClientUnsupportedError 触发
 * 服务端兜底。中止由调用方先行的 ensureNotAborted 处理，不经过这里。
 */
function toPipelineFailure(label: string, err: unknown): Error {
  if (err instanceof ClientUploadError) return err;
  console.warn(`[client-media] ${label}客户端管线失败，将回退服务端`, err);
  return new ClientUnsupportedError(err instanceof Error ? err.message : String(err));
}

/**
 * 非 AAC 音轨的客户端产出前提（片段截取 / 音频截取共用）：能解码出 PCM +
 * 平台有 AAC 编码器。codec 未知（容器未给出）或不可解码时，Conversion 会
 * 静默丢弃音轨——有视频轨时产出无声片段仍报成功，纯音频则零轨 isValid=false
 * 事后才失败——必须按真实能力在此回退服务端，不依赖产物形状的事故。
 */
async function ensureAacConvertible(audioTrack: InputAudioTrack): Promise<void> {
  if (audioTrack.codec === "aac") return;
  const decodable = await audioTrack.canDecode();
  if (!decodable || !(await canEncodeAudio("aac"))) {
    throw new ClientUnsupportedError(`音轨编码 ${audioTrack.codec ?? "未知"} 无法转编为 AAC`);
  }
}

/** 音频包级拷贝（不解码）的前提（画面裁剪 / 分离音轨共用）：音轨编码必须是 AAC。 */
function ensureAacCopyable(audioTrack: InputAudioTrack): void {
  if (audioTrack.codec !== "aac") {
    throw new ClientUnsupportedError(`音轨编码 ${audioTrack.codec ?? "未知"} 不支持包级拷贝`);
  }
}

/**
 * 挂中止监听执行管线主体：abort 触发产物 cancel（once 监听），监听器 finally
 * 必清理。挂监听前先显式检查已中止——signal 已 aborted 时监听器不会再触发。
 */
async function runWithAbortCancel(
  signal: AbortSignal | undefined,
  onCancel: () => void,
  execute: () => Promise<void>,
): Promise<void> {
  ensureNotAborted(signal);
  signal?.addEventListener("abort", onCancel, { once: true });
  try {
    await execute();
  } finally {
    signal?.removeEventListener("abort", onCancel);
  }
}

/**
 * 失败路径取消产物：仅当管线仍处活动态（pending / executing / started）时
 * cancel 才有实际效果。mediabunny 在 execute() 失败时已自行 cancel（终态
 * canceled），finalize 完成后是 finalized——对这些终态再调用不会出错，但会打
 * Info 级 warn（纯噪音），故按状态判定跳过。中止路径的取消由 abort 监听负责，
 * 活动态判定天然覆盖（监听已把产物置为 canceled，此处自动跳过），无需再按
 * signal 分叉。
 */
async function cancelIfCancellable(
  pipeline: { state: string; cancel(): Promise<void> } | undefined,
): Promise<void> {
  const ACTIVE_STATES = new Set(["pending", "executing", "started"]);
  if (pipeline && ACTIVE_STATES.has(pipeline.state)) {
    await pipeline.cancel().catch(noop);
  }
}

/**
 * 供调用方上传客户端产物并取回可访问地址；失败统一抛 ClientUploadError（不回退），
 * 用户取消原样上抛。上传进度默认映射到操作总进度的 90–100 尾段（Spec 4.1 统一口径：
 * 编码 0–90 / 上传 90–100）；分离音轨双产物经 progressBase 传参覆盖。
 */
async function uploadDerivedFile(
  file: File,
  opts: ClientOperationOptions & { progressBase?: number } = {},
): Promise<{ url: string; key: string; size: number }> {
  const formData = new FormData();
  formData.append("file", file);
  let batch: UploadBatchResponse;
  try {
    batch = await apiUploadWithProgress<UploadBatchResponse>(
      "/api/files/upload?source=derived",
      formData,
      opts.onProgress && ((pct) => opts.onProgress?.(mapFraction(pct / 100, opts.progressBase ?? 90, 10))),
      opts.signal,
    );
  } catch (err) {
    // 取消原样上抛（中止语义由调用方的 ensureNotAborted 归一），其余归一为上传失败
    if (opts.signal?.aborted) throw err;
    throw new ClientUploadError(err instanceof Error ? err.message : String(err), { cause: err });
  }
  const item = batch.items?.[0];
  // 与拖入上传共用同一份响应契约与校验（lib/utils/upload）；size 即产物字节数——
  // 上传的就是本地 File，无需依赖响应字段
  if (item?.ok && isUploadResult(item.data)) {
    return { url: item.data.url, key: item.data.key, size: file.size };
  }
  const code = (item && !item.ok ? item.error?.code : undefined) ?? "upload.upload_failed";
  // code 即失败标识：message（日志用）与 code（i18n 通道用）在信封错误场景天然同源
  throw new ClientUploadError(code, { code });
}

/**
 * 客户端片段截取：Mediabunny Conversion 按 [start, end] 裁剪（关键帧对齐 + 丢帧 +
 * 时间戳重基 + 音画对齐由库原生处理），视频重编码（quantizer 20 / 源码率封顶），
 * 音频 AAC 拷贝（非 AAC 需可解码转编——codec 未知 / 不可解码或无编码器 → 回退），封装后上传入库。
 * 管线失败抛 ClientUnsupportedError——调用方回退服务端；上传失败抛
 * ClientUploadError——不回退（见文件头契约）。
 */
export async function tryClipOnClient(
  videoKey: string,
  range: { start: number; end: number },
  opts: ClientOperationOptions = {},
): Promise<{ url: string; key: string }> {
  ensureNotAborted(opts.signal);
  // openVideoSourceOrThrow 在 try 内：源读取网络失败按 Spec「异常与边界」归入管线异常回退
  // 服务端，而不是作为意外异常跳过兜底
  let source: ClientVideoSource | undefined;
  let output: Output<Mp4OutputFormat, BufferTarget> | undefined;
  let conversion: Conversion | undefined;
  try {
    source = await openVideoSourceOrThrow(`/api/files/${videoKey}`, opts.signal);
    const { input, videoTrack, audioTrack } = source;

    // 编码能力探测：视频 H.264 输出；音频 AAC 拷贝免编码，非 AAC 需可解码且可编码 AAC
    const videoEncodable = await canEncodeVideo("avc", {
      width: videoTrack.displayWidth,
      height: videoTrack.displayHeight,
    });
    if (!videoEncodable) throw new ClientUnsupportedError("无可用的 H.264 视频编码器");
    if (audioTrack) await ensureAacConvertible(audioTrack);

    // 源码率封顶（片段取全幅，像素占比 1）
    const stats = await videoTrack.computePacketStats();
    const bitrate = resolveVideoBitrate(stats.averageBitrate, 1);

    const target = new BufferTarget();
    output = new Output({
      format: new Mp4OutputFormat({ fastStart: "in-memory" }),
      target,
    });

    conversion = await Conversion.init({
      input,
      output,
      trim: { start: range.start, end: range.end },
      video: {
        codec: "avc",
        quality: new Quality({ quantizer: 20, ...(bitrate !== undefined ? { bitrate } : {}) }),
        hardwareAcceleration: "prefer-hardware",
        keyFrameInterval: 2,
      },
      ...(audioTrack ? { audio: { codec: "aac" as const } } : {}),
    });
    if (opts.onProgress) {
      conversion.onProgress = (progress) => opts.onProgress?.(mapFraction(progress, 0, 90));
    }

    // 用户取消：中止信号触发 conversion.cancel()，execute 以取消错误拒绝
    await runWithAbortCancel(
      opts.signal,
      () => void conversion?.cancel().catch(noop),
      () => conversion!.execute(),
    );

    if (!target.buffer) throw new ClientUnsupportedError("封装产物缺失");
    const file = new File([target.buffer], "clip.mp4", { type: "video/mp4" });

    const uploaded = await uploadDerivedFile(file, {
      signal: opts.signal,
      onProgress: opts.onProgress,
    });
    return { url: uploaded.url, key: uploaded.key };
  } catch (err) {
    // 失败路径取消产物（仅活动态，见 cancelIfCancellable）；中止经
    // ensureNotAborted 原样抛出
    await cancelIfCancellable(conversion);
    ensureNotAborted(opts.signal);
    throw toPipelineFailure("片段截取", err);
  } finally {
    source?.input.dispose();
  }
}

/**
 * 客户端裁剪：整段视频按源矩形重编码（H.264，quantizer 20 / 源码率封顶），
 * 音频 AAC 包级拷贝（非 AAC → 回退），封装 mp4（fastStart）后上传入库。
 * 管线失败（含中途异常）抛 ClientUnsupportedError——调用方回退服务端；上传失败
 * 抛 ClientUploadError——不回退（见文件头契约）。
 */
export async function tryCropOnClient(
  videoKey: string,
  rect: CropRectPx,
  opts: ClientOperationOptions = {},
): Promise<{ url: string; key: string }> {
  ensureNotAborted(opts.signal);
  // openVideoSourceOrThrow 在 try 内：同片段截取，源读取网络失败回退服务端
  let source: ClientVideoSource | undefined;
  let output: Output<Mp4OutputFormat, BufferTarget> | undefined;
  try {
    source = await openVideoSourceOrThrow(`/api/files/${videoKey}`, opts.signal);
    const { videoTrack, audioTrack } = source;

    // 源码率（平均比特率）与显示尺寸：钳位与码率折减的基准
    const stats = await videoTrack.computePacketStats();
    const srcW = videoTrack.displayWidth;
    const srcH = videoTrack.displayHeight;
    // 源画面不足 2px 时不存在有效裁剪（clampRect 的最小值兜底只作用于矩形本身，
    // 管不住源尺寸）——交服务端按既有语义给出确定结论
    if (srcW < 2 || srcH < 2) {
      throw new ClientUnsupportedError("源画面过小，无法裁剪");
    }
    // 编码能力前置探测（Spec 规则 1.1，与片段截取一致）：无可用的 H.264 编码器
    // 不必等整段解码后才失败
    if (!(await canEncodeVideo("avc", { width: srcW, height: srcH }))) {
      throw new ClientUnsupportedError("无可用的 H.264 视频编码器");
    }
    const clamped = clampRect(rect, srcW, srcH);
    const pixelRatio =
      (clamped.width * clamped.height) / Math.max(1, srcW * srcH);
    const bitrate = resolveVideoBitrate(stats.averageBitrate, pixelRatio);

    const videoSource = new VideoSampleSource({
      codec: "avc",
      quality: new Quality({
        quantizer: 20, // 与服务端 crf20 同语义；不支持时回退 bitrate
        ...(bitrate !== undefined ? { bitrate } : {}),
      }),
      hardwareAcceleration: "prefer-hardware",
      keyFrameInterval: 2,
      transform: {
        crop: {
          left: clamped.x,
          top: clamped.y,
          width: clamped.width,
          height: clamped.height,
        },
      },
    });

    const target = new BufferTarget();
    output = new Output({
      format: new Mp4OutputFormat({ fastStart: "in-memory" }),
      target,
    });
    output.addVideoTrack(videoSource);

    // 音频包级拷贝：不解码，AAC 帧边界误差约 21ms（无感）；非 AAC 回退服务端
    let audioSource: EncodedAudioPacketSource | undefined;
    let audioSink: EncodedPacketSink | undefined;
    let audioMeta: AudioPacketMeta | undefined;
    if (audioTrack) {
      ensureAacCopyable(audioTrack);
      audioSource = new EncodedAudioPacketSource("aac");
      output.addAudioTrack(audioSource);
      audioSink = new EncodedPacketSink(audioTrack);
      const config = await audioTrack.getDecoderConfig();
      audioMeta = config ? { decoderConfig: config } : undefined;
    }

    await output.start();

    const sink = new VideoSampleSink(videoTrack);
    const total = Math.max(1, stats.packetCount);
    let done = 0;
    for await (const sample of sink.samples()) {
      // 中止 / 编码异常时也必须释放已产出的帧（VideoFrame 底层资源只能显式 close）
      try {
        ensureNotAborted(opts.signal);
        await videoSource.add(sample); // await 即背压：编码跟不上时暂停取帧
      } finally {
        sample.close();
      }
      done += 1;
      opts.onProgress?.(mapFraction(done / total, 0, 90));
    }

    if (audioSink && audioSource) {
      for await (const packet of audioSink.packets()) {
        ensureNotAborted(opts.signal);
        await audioSource.add(packet, audioMeta);
        audioMeta = undefined; // decoderConfig 只需随首个包提供
      }
    }

    await output.finalize();
    if (!target.buffer) throw new ClientUnsupportedError("封装产物缺失");
    const file = new File([target.buffer], "crop.mp4", { type: "video/mp4" });

    const uploaded = await uploadDerivedFile(file, {
      signal: opts.signal,
      onProgress: opts.onProgress,
    });
    return {
      url: uploaded.url,
      key: uploaded.key,
    };
  } catch (err) {
    // 失败路径取消产物（仅活动态，见 cancelIfCancellable）
    await cancelIfCancellable(output);
    ensureNotAborted(opts.signal);
    throw toPipelineFailure("裁剪", err);
  } finally {
    source?.input.dispose();
  }
}

interface DetachedAudioClientResult {
  audio: { url: string; key: string; size: number; format: "copy" };
  video: { url: string; key: string; size: number };
}

/**
 * 客户端分离音轨：两路纯重封装（零解码）——音轨包拷贝为 m4a、视频轨包拷贝为
 * 静音 mp4（fastStart）。仅支持 ISO-BMFF 容器 + AAC 音轨（非 AAC / 其他容器 /
 * 无音轨 → 回退服务端）。管线失败抛 ClientUnsupportedError——调用方回退服务端；
 * 上传失败抛 ClientUploadError——不回退（见文件头契约）。
 */
export async function tryDetachAudioOnClient(
  videoKey: string,
  opts: ClientOperationOptions = {},
): Promise<DetachedAudioClientResult> {
  ensureNotAborted(opts.signal);
  // openVideoSourceOrThrow 在 try 内：同片段截取，源读取网络失败回退服务端
  let source: ClientVideoSource | undefined;
  let audioConv: Conversion | undefined;
  let videoConv: Conversion | undefined;
  try {
    source = await openVideoSourceOrThrow(`/api/files/${videoKey}`, opts.signal, { videoMuxOnly: true });
    const { input, audioTrack } = source;

    if (!audioTrack) throw new ClientUnsupportedError("源视频没有音轨");
    ensureAacCopyable(audioTrack);
    const format = await input.getFormat();
    if (!(format instanceof IsobmffInputFormat)) {
      throw new ClientUnsupportedError("容器不是 ISO-BMFF（mp4/mov）");
    }

    // 产物 1：音轨 m4a（视频轨丢弃，音轨包级拷贝）
    const audioTarget = new BufferTarget();
    const audioOutput = new Output({
      format: new Mp4OutputFormat({ fastStart: "in-memory" }),
      target: audioTarget,
    });
    // 串行复用同一 Input（库源码核读：Conversion.execute 不消费 / 不 dispose
    // Input，轨级 sink 每次新建迭代器，两路 execute 互不干扰）
    audioConv = await Conversion.init({ input, output: audioOutput, video: { discard: true } });
    // 产物 2：静音视频 mp4（音频轨丢弃，视频轨包级拷贝）
    const videoTarget = new BufferTarget();
    const videoOutput = new Output({
      format: new Mp4OutputFormat({ fastStart: "in-memory" }),
      target: videoTarget,
    });
    videoConv = await Conversion.init({ input, output: videoOutput, audio: { discard: true } });
    // 进度区间：两路转换 0–40 / 40–80，两段上传 80–90 / 90–100——各段单调
    // 递进不重叠（上传段此前映射 45–90 与转换段重叠，进度会 90→45 回退）
    audioConv.onProgress = (p) => opts.onProgress?.(mapFraction(p, 0, 40));
    videoConv.onProgress = (p) => opts.onProgress?.(mapFraction(p, 40, 40));

    // 用户取消：中止信号触发两路 conversion.cancel()
    await runWithAbortCancel(
      opts.signal,
      () => {
        void audioConv?.cancel().catch(noop);
        void videoConv?.cancel().catch(noop);
      },
      async () => {
        await audioConv!.execute();
        await videoConv!.execute();
      },
    );

    if (!audioTarget.buffer) throw new ClientUnsupportedError("音轨封装产物缺失");
    if (!videoTarget.buffer) throw new ClientUnsupportedError("静音视频封装产物缺失");
    const audioFile = new File([audioTarget.buffer], "audio.m4a", { type: "audio/mp4" });
    const videoFile = new File([videoTarget.buffer], "muted.mp4", { type: "video/mp4" });

    const uploadedAudio = await uploadDerivedFile(audioFile, {
      signal: opts.signal,
      onProgress: opts.onProgress,
      progressBase: 80,
    });
    const uploadedVideo = await uploadDerivedFile(videoFile, {
      signal: opts.signal,
      onProgress: opts.onProgress,
    });
    return {
      audio: { ...uploadedAudio, format: "copy" as const },
      video: { url: uploadedVideo.url, key: uploadedVideo.key, size: uploadedVideo.size },
    };
  } catch (err) {
    // 失败路径取消两路产物（仅活动态，见 cancelIfCancellable）
    await cancelIfCancellable(audioConv);
    await cancelIfCancellable(videoConv);
    ensureNotAborted(opts.signal);
    throw toPipelineFailure("分离音轨", err);
  } finally {
    source?.input.dispose();
  }
}

/**
 * 客户端音频变速：解码全量 PCM → soundtouchjs 时间拉伸（保持音调）→ AAC 编码
 * → m4a 上传入库。纯音频操作（无视频轨）。管线失败抛 ClientUnsupportedError
 * ——调用方回退服务端；上传失败抛 ClientUploadError——不回退（见文件头契约）。
 *
 * 已知限制：soundtouchjs 的 DSP 硬编码双声道交错——mono 源以 L=R 拉伸、
 * 输出还原源声道数（Spec 输出规格：保持源声道数）；超长音频（小时级）
 * 解码与拉伸全量驻留内存。
 */
export async function tryApplyAudioSpeedOnClient(
  audioKey: string,
  speed: number,
  opts: ClientOperationOptions = {},
): Promise<{ url: string; key: string }> {
  ensureNotAborted(opts.signal);
  // openAudioSourceOrThrow 在 try 内：源读取网络失败与探测失败同归回退路径
  let input: Input | undefined;
  // 失败路径取消 Output：output.start() 之后的编码循环中途失败 / 被取消时，
  // 不 cancel 会让底层 AudioEncoder 资源滞留到页面导航
  let output: Output<Mp4OutputFormat, BufferTarget> | undefined;
  try {
    const audio = await openAudioSourceOrThrow(`/api/files/${audioKey}`, opts.signal);
    input = audio.input;
    const { audioTrack } = audio;
    ensureNotAborted(opts.signal);
    if (!(await canEncodeAudio("aac"))) {
      throw new ClientUnsupportedError("无可用的 AAC 音频编码器");
    }

    const sampleRate = audioTrack.sampleRate;
    const channelCount = audioTrack.numberOfChannels;
    // 超双声道（如 5.1）的上混 / 降混语义未定义，静默丢声道不可接受——交服务端处理
    if (channelCount > 2) {
      throw new ClientUnsupportedError(`不支持超过双声道的音频（${channelCount} 声道）`);
    }

    // 1. 解码全量 PCM：逐样本逐平面拷出 f32
    const sink = new AudioSampleSink(audioTrack);
    const channelChunks: Float32Array[][] = Array.from(
      { length: channelCount },
      () => [] as Float32Array[],
    );
    let inFrames = 0;
    for await (const sample of sink.samples()) {
      // 中止 / 拷贝异常时也必须释放已产出的样本（AudioSample 底层资源只能显式 close）
      try {
        ensureNotAborted(opts.signal);
        for (let ch = 0; ch < channelCount; ch++) {
          const plane = new Float32Array(sample.numberOfFrames);
          // 按 planar 平面逐通道拷取：交错格式下 planeIndex 必须 0，逐通道必须用 planar
          sample.copyTo(plane, { planeIndex: ch, format: "f32-planar" });
          channelChunks[ch].push(plane);
        }
        inFrames += sample.numberOfFrames;
      } finally {
        sample.close();
      }
    }
    // 空音频轨（无有效样本）：产出静音文件没有意义——交服务端按既有语义处理
    if (inFrames === 0) {
      throw new ClientUnsupportedError("音频轨无有效样本");
    }

    // 2. 拼接平面 PCM（soundtouchjs 的 DSP 硬编码交错双声道：mono 源上混仅为
    //    DSP 内部形态，输出段还原源声道数）
    const plane0 = new Float32Array(inFrames);
    const plane1 = new Float32Array(channelCount > 1 ? inFrames : 0);
    for (let ch = 0; ch < channelCount; ch++) {
      const targetPlane = ch === 0 ? plane0 : plane1;
      let offset = 0;
      for (const chunk of channelChunks[ch]) {
        targetPlane.set(chunk, offset);
        offset += chunk.length;
      }
    }
    const mono = channelCount === 1;

    // 3. 时间拉伸：直接驱动 SoundTouch 的 FIFO 管线（putSamples → process →
    //    outputBuffer 排空），输出时长 ≈ 输入 / speed。绕过 SimpleFilter——
    //    其 history-buffer 流式位置语义与离线全量处理冲突（读取位置会钳在
    //    history 窗口上重复消费同一段，产生爆音）
    const st = new SoundTouch();
    // WSOLA 窗口（sequence / seek / overlap）按采样率自调谐，Stretch 构造默认
    // 按 44100 计算：按源真实采样率重设（0 值参数保持库内自动档），48kHz 源的
    // 窗口时长不再偏短约 8%（仅音质；时长换算本不依赖窗口）
    st.stretch.setParameters(sampleRate, 0, 0, 0);
    st.tempo = speed;
    const expectedFrames = Math.ceil(inFrames / speed) + Math.ceil(sampleRate * 0.05);
    const outCap = expectedFrames; // flush 静音推动尾部出产后，多余部分在排水时按上限截断
    const stretched = new Float32Array(outCap * 2); // 交错双声道
    let outFrames = 0;

    const drain = () => {
      for (;;) {
        const available = st.outputBuffer.frameCount;
        if (available <= 0) break;
        const out = new Float32Array(available * 2);
        st.outputBuffer.receiveSamples(out, available);
        const cap = Math.min(available, outCap - outFrames);
        if (cap > 0) stretched.set(out.subarray(0, cap * 2), outFrames * 2);
        outFrames += cap;
        if (outFrames >= outCap) break;
      }
    };

    const feedChunkFrames = 8192;
    for (let offset = 0; offset < inFrames; offset += feedChunkFrames) {
      ensureNotAborted(opts.signal);
      const frames = Math.min(feedChunkFrames, inFrames - offset);
      const chunk = new Float32Array(frames * 2);
      for (let i = 0; i < frames; i++) {
        chunk[i * 2] = plane0[offset + i];
        chunk[i * 2 + 1] = mono ? plane0[offset + i] : plane1[offset + i];
      }
      st.inputBuffer.putSamples(chunk, 0, frames);
      st.process();
      drain();
    }
    // 源耗尽后喂半秒静音，把 Stretch 内部缓冲的尾段推出来（产物按预期时长截断）
    const flushFrames = Math.ceil(sampleRate / 2);
    st.inputBuffer.putSamples(new Float32Array(flushFrames * 2), 0, flushFrames);
    st.process();
    drain();

    // 4. 分块封装为 AudioSample 交给 AAC 编码器（时间戳按输出帧序推进）；
    //    输出保持源声道数（Spec 输出规格，DSP 段的 L=R 上混在此还原）。
    //    data 一律传独立缓冲（新分配 / slice）：mediabunny 1.61.4 的
    //    AudioSample.toAudioData() 会丢弃视图 byteOffset，传 subarray 会让
    //    每个分块都从大缓冲头部读取（产物为开头片段重复，波形呈静音）
    const target = new BufferTarget();
    output = new Output({
      format: new Mp4OutputFormat({ fastStart: "in-memory" }),
      target,
    });
    const audioSource = new AudioSampleSource({
      codec: "aac",
      quality: new Quality({ bitrate: 128_000 }), // 与服务端 -b:a 128k 对齐
    });
    output.addAudioTrack(audioSource);
    await output.start();

    const chunkFrames = 4096;
    for (let offset = 0; offset < outFrames; offset += chunkFrames) {
      ensureNotAborted(opts.signal);
      const frames = Math.min(chunkFrames, outFrames - offset);
      let data: Float32Array;
      if (mono) {
        // 还原单声道：拉伸 DSP 期间 L=R，取交错左声道即可（新缓冲，byteOffset 恒 0）
        data = new Float32Array(frames);
        for (let i = 0; i < frames; i++) data[i] = stretched[(offset + i) * 2];
      } else {
        data = stretched.slice(offset * 2, (offset + frames) * 2);
      }
      const sample = new AudioSample({
        format: mono ? "f32-planar" : "f32",
        sampleRate,
        numberOfChannels: channelCount,
        data,
        timestamp: offset / sampleRate,
      });
      try {
        await audioSource.add(sample);
      } finally {
        sample.close();
      }
      opts.onProgress?.(mapFraction((offset + frames) / outFrames, 0, 90));
    }

    await output.finalize();
    if (!target.buffer) throw new ClientUnsupportedError("封装产物缺失");
    const file = new File([target.buffer], "speed.m4a", { type: "audio/mp4" });

    const uploaded = await uploadDerivedFile(file, {
      signal: opts.signal,
      onProgress: opts.onProgress,
    });
    return { url: uploaded.url, key: uploaded.key };
  } catch (err) {
    // 失败路径取消产物（仅活动态，见 cancelIfCancellable）
    await cancelIfCancellable(output);
    ensureNotAborted(opts.signal);
    throw toPipelineFailure("音频变速", err);
  } finally {
    input?.dispose();
  }
}
/**
 * 客户端音频片段截取：音频轨包级拷贝（aac）或转编（非 AAC 且平台有 AAC 编码器）
 * 按 [start, end] 裁剪——Conversion 原生处理切点与时间戳。管线失败抛
 * ClientUnsupportedError——调用方回退服务端；上传失败抛 ClientUploadError——不回退。
 */
export async function tryExtractAudioClipOnClient(
  audioKey: string,
  range: { start: number; end: number },
  opts: ClientOperationOptions = {},
): Promise<{ url: string; key: string }> {
  ensureNotAborted(opts.signal);
  // openAudioSourceOrThrow 在 try 内：源读取网络失败与探测失败同归回退路径
  let input: Input | undefined;
  let conversion: Conversion | undefined;
  try {
    const audio = await openAudioSourceOrThrow(`/api/files/${audioKey}`, opts.signal);
    input = audio.input;
    const { audioTrack } = audio;
    ensureNotAborted(opts.signal);
    await ensureAacConvertible(audioTrack);

    const target = new BufferTarget();
    const output = new Output({
      format: new Mp4OutputFormat({ fastStart: "in-memory" }),
      target,
    });
    conversion = await Conversion.init({
      input,
      output,
      video: { discard: true },
      ...(audioTrack.codec === "aac" ? {} : { audio: { codec: "aac" as const } }),
      trim: { start: range.start, end: range.end },
    });
    if (opts.onProgress) {
      conversion.onProgress = (p) => opts.onProgress?.(mapFraction(p, 0, 90));
    }

    // 用户取消：中止信号触发 conversion.cancel()，execute 以取消错误拒绝
    await runWithAbortCancel(
      opts.signal,
      () => void conversion?.cancel().catch(noop),
      () => conversion!.execute(),
    );

    if (!target.buffer) throw new ClientUnsupportedError("封装产物缺失");
    const file = new File([target.buffer], "audioclip.m4a", { type: "audio/mp4" });

    const uploaded = await uploadDerivedFile(file, {
      signal: opts.signal,
      onProgress: opts.onProgress,
    });
    return { url: uploaded.url, key: uploaded.key };
  } catch (err) {
    // 失败路径取消产物（仅活动态，见 cancelIfCancellable）；中止经
    // ensureNotAborted 原样抛出
    await cancelIfCancellable(conversion);
    ensureNotAborted(opts.signal);
    throw toPipelineFailure("音频片段截取", err);
  } finally {
    input?.dispose();
  }
}
