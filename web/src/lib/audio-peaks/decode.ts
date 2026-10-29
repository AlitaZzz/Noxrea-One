/**
 * 音频取数与解码（specs/canvas-audio-peaks-cache.md 规则 2 / 6）。
 *
 * 分成两段执行：`loadAudioSource` 取址、探测时长、下载压缩字节——在全局解码队列
 * 之外，可与其它文件并发；`decodeAudioPeaks` 执行一次 `decodeAudioData` 并抽取
 * 峰值——CPU/内存重操作，由 `index.ts` 放进全局串行队列（规则 1.4）。
 *
 * 一次 `decodeAudioData` 拿到整段 PCM，抽成「每 512 采样一个桶的最大绝对值」后
 * 立即丢弃 `ArrayBuffer` 与 `AudioBuffer`：常驻内存只剩峰值数组（20 分钟立体声
 * 约 150 KB，而 8kHz 解码缓冲约 77 MB）。
 *
 * 两道闸门都在解码**前**判定——`decodeAudioData` 一次吃下完整 `ArrayBuffer`，
 * 解码期间的内存只由时长与采样率决定，事后判定已经来不及：
 * - 时长闸门：脱离文档的 `<audio preload="metadata">` 只取容器头部探测时长；
 * - 字节闸门：流式读取压缩字节并累计，`Content-Length` 可用时先看长度。
 *
 * 失败一律以 `unavailable` 结果返回、从不抛出：波形不可用不是异常路径，
 * 也不影响播放（规则 4.5）。
 */
import {
  credentialsForDelivery,
  type ResolvedMediaUrl,
  resolveMediaUrlWithRetry,
} from "@/lib/file-access";
import { detachMediaSource } from "@/lib/media-element";

/** 解码采样率：内存上界的来源；构造失败按解码失败处理，不回退到更高采样率（规则 2.1） */
const TARGET_SAMPLE_RATE = 8000;
/** 每个峰值桶的采样数（规则 2.2） */
const BUCKET_SIZE = 512;
/** 最多保留的声道数（规则 2.2） */
const MAX_CHANNELS = 2;
/** 时长上限：20 分钟（确认结论 3） */
const MAX_DURATION_S = 20 * 60;
/** 压缩字节上限：48 MB（确认结论 3） */
const MAX_BYTES = 48 * 1024 * 1024;
/** 元数据探测超时（规则 2.7） */
const PROBE_TIMEOUT_MS = 10_000;
/** 字节读取停滞超时：这么久没有新字节即中止，不设总量时限（规则 2.7） */
const STALL_TIMEOUT_MS = 20_000;
/** 解码超时（规则 2.7） */
const DECODE_TIMEOUT_MS = 30_000;
/** 取地址（描述请求）超时：描述悬挂会无限期占住该文件的单飞条目，同样要有上界（规则 2.7） */
const RESOLVE_TIMEOUT_MS = 10_000;

/**
 * 波形不可用的原因；只用于诊断，不影响降级行为。`internal` 是取数阶段的
 * 非预期异常：按环境类处理，不进入终止性失败记忆（下次挂载仍重试）
 */
type PeaksError =
  | "unsupported"
  | "too_large"
  | "network"
  | "decode_failed"
  | "timeout"
  | "internal";

/** 解码产物：峰值数组（视为不可变，见规则 2.4）与解码时长 */
export interface AudioPeaks {
  channels: Float32Array[];
  /** 来自 `AudioBuffer.duration`（规则 2.3） */
  duration: number;
}

/**
 * 波形不可用的结果形状（取数与解码两个阶段共用，播放不受影响）。`duration` 是
 * 元数据探测所得——超限、字节超限、解码失败时都随结果返回，供调用方回填时长（规则 5.3）。
 */
type UnavailableResult = { status: "unavailable"; duration: number | null; error: PeaksError };

/** 解码结果（服务层原样透传）：解码产物或不可用原因 */
export type AudioPeaksResult = { status: "ready"; peaks: AudioPeaks } | UnavailableResult;

/** 取数产物：通过两道闸门的压缩字节与探测时长，等待进入解码队列 */
type AudioSourceResult =
  | { status: "loaded"; bytes: ArrayBuffer; duration: number }
  | UnavailableResult;

/** 解码链路上的失败：携带原因码，出口统一转成 `unavailable` 结果 */
class PeaksFailure extends Error {
  readonly code: PeaksError;

  constructor(code: PeaksError) {
    super(`Audio peaks failed: ${code}`);
    this.name = "PeaksFailure";
    this.code = code;
  }
}

/**
 * 解码链路上的失败归类：`PeaksFailure` 保留原因码；其他异常属于解码器 / 数据层面
 * 的确定失败，归为 `decode_failed`（进入终止性记忆）。取数阶段不使用本函数——
 * 那里的非预期异常是 `internal`，不能伪装成内容不可解码。
 */
function decodeFailureOf(error: unknown): PeaksError {
  return error instanceof PeaksFailure ? error.code : "decode_failed";
}

/**
 * 取数阶段的失败归类：`PeaksFailure` 保留原码，其余未预期异常归为环境类 `internal`
 * ——不能伪装成 `decode_failed` 写进终止性记忆，把一次内部故障永久记成内容问题。
 */
function sourceFailureOf(error: unknown): PeaksError {
  return error instanceof PeaksFailure ? error.code : "internal";
}

/**
 * 带超时的取地址。取数不在解码队列里，但挂住的描述请求会一直占住该文件的单飞
 * 条目，并在用户重新打开时无限期等待，因此同样要有上界。失败统一归为环境类
 * （`network`），只有自身超时归为 `timeout`——两者都不进终止性失败记忆。
 * 超时中止发生在 `resolveMediaUrlWithRetry` 的重试判断之前，不会超时后再等一轮。
 */
async function resolveWithTimeout(value: string, forceRefresh = false): Promise<ResolvedMediaUrl> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RESOLVE_TIMEOUT_MS);
  try {
    return await resolveMediaUrlWithRetry(value, { forceRefresh, signal: controller.signal });
  } catch {
    throw new PeaksFailure(controller.signal.aborted ? "timeout" : "network");
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 取地址 → 时长闸门 → 字节闸门。产物是压缩字节与探测时长，本身不做解码：
 * 这段可以与其它文件并发，只有 `decodeAudioPeaks` 进全局串行队列（规则 1.4）。
 * `value` 是逻辑引用值（存储 key / 托管 URL / 外部 http(s) URL），与规则 1.1 一致。
 */
export async function loadAudioSource(value: string): Promise<AudioSourceResult> {
  let access: ResolvedMediaUrl;
  try {
    access = await resolveWithTimeout(value);
  } catch (error) {
    // 取址失败是环境类（不进终止记忆）
    return {
      status: "unavailable",
      duration: null,
      error: sourceFailureOf(error),
    };
  }

  const probed = await probeDuration(access.url);
  // 探测不到有限时长（NaN / Infinity，如流式容器或头部损坏）：闸门同样不放行——
  // 宁可没有波形，也不冒险解码一个时长未知的容器（规则 2.5「按超限处理」）。
  // 这是内容层面的确定结果，与时长超限同码（`too_large`），进终止性失败记忆
  if ("error" in probed) {
    return { status: "unavailable", duration: null, error: probed.error };
  }
  if (probed.duration > MAX_DURATION_S) {
    return { status: "unavailable", duration: probed.duration, error: "too_large" };
  }

  try {
    return { status: "loaded", bytes: await fetchBytes(value, access), duration: probed.duration };
  } catch (error) {
    // 取数失败同样按环境类处理：未预期异常不是「内容不可解码」（见 sourceFailureOf）
    return {
      status: "unavailable",
      duration: probed.duration,
      error: sourceFailureOf(error),
    };
  }
}

/**
 * 解码已取回的压缩字节并抽取峰值（规则 2.1–2.3）。这是全局串行队列里唯一执行的
 * 步骤：CPU/内存重操作，多节点同时挂载不得并行（规则 1.4）；耗时只由
 * `decodeAudioData` 决定，与网络无关。
 */
export async function decodeAudioPeaks(source: {
  bytes: ArrayBuffer;
  duration: number;
}): Promise<AudioPeaksResult> {
  try {
    const decoded = await decodeBuffer(source.bytes);
    const peaks = extractPeaks(decoded);
    if (!peaks) return { status: "unavailable", duration: source.duration, error: "decode_failed" };
    return { status: "ready", peaks };
  } catch (error) {
    return { status: "unavailable", duration: source.duration, error: decodeFailureOf(error) };
  }
}

/** 探测结果：拿到有限时长，或失败原因（错误码决定是否进会话内失败记忆） */
type ProbeOutcome = { duration: number } | { error: PeaksError };

/**
 * 时长闸门：脱离文档的 `<audio preload="metadata">` 只取容器头部。
 *
 * 不挂进 DOM（与 `new Audio()` 同形态）：媒体元素设置 `src` 即开始加载，与是否
 * 在文档中无关，因此不必留下一个瞬态 DOM 节点。
 * 不设 `crossOrigin`：同源请求默认带 cookie（对应 stream → include），跨域请求
 * 默认不带凭据（对应 signed → omit），与规则 6.1 的映射自然一致。
 * 成功、超限、超时、出错四条路径都经 `detachMediaSource` 卸下地址收尾，
 * 否则探测元素可能在后台继续缓冲。
 */
function probeDuration(src: string): Promise<ProbeOutcome> {
  return new Promise((resolve) => {
    const audio = document.createElement("audio");
    audio.preload = "metadata";

    let settled = false;
    const done = (outcome: ProbeOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // 必须卸下地址：否则解码器仍持有连接，探测元素继续缓冲
      detachMediaSource(audio);
      resolve(outcome);
    };
    // 声明在 done 之后、只在它内部使用：真正调用时早已初始化，不存在 TDZ 问题
    const timer = setTimeout(() => done({ error: "timeout" }), PROBE_TIMEOUT_MS);
    audio.addEventListener("loadedmetadata", () => {
      const duration = audio.duration;
      // 容器解析成功却给不出有限时长：内容层面的确定结果，按规则 2.5「按超限处理」，
      // 与时长超限同码——两者都是「这段内容不允许解码」
      done(Number.isFinite(duration) && duration > 0 ? { duration } : { error: "too_large" });
    });
    // 媒体元素的 error 分不清「签名过期 / 404」与「编码不支持」（浏览器对 4xx 也常报
    // SRC_NOT_SUPPORTED），按环境类处理：探测只是一次头部请求，下次挂载重试成本很低，
    // 不能因为一次探测失败把它记成终止性失败
    audio.addEventListener("error", () => done({ error: "network" }));
    audio.src = src;
  });
}

/**
 * 字节闸门 + 读取（规则 2.5 / 6.2）：首次请求复用 `loadAudioSource` 已拿到的地址，
 * 一次加载只描述一次；只有 401/403/404 才强制重新描述一次并重试一次，重签出的
 * 新地址再失败即不可用（按地址计会无限重试）。
 */
async function fetchBytes(value: string, initialAccess: ResolvedMediaUrl): Promise<ArrayBuffer> {
  let access = initialAccess;
  let forceRefresh = false;
  for (;;) {
    // 首次复用探测所用地址；强制刷新只在重描述重试时发生
    if (forceRefresh) access = await resolveWithTimeout(value, true);
    const controller = new AbortController();

    // 停滞计时从发起请求开始：等待响应头同样没有新字节；挂住的请求会一直占住该
    // 文件的单飞条目（与无流式体同一类问题）。响应到达后由读取阶段按新字节重新
    // 计时，下载本身不设总量时限
    const headerStall = setTimeout(() => controller.abort(), STALL_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(access.url, {
        credentials: credentialsForDelivery(access.delivery),
        signal: controller.signal,
      });
    } catch {
      // 跨域桶未配置 CORS、网络中断、等待响应头超时都走这里：波形不可用，播放不受影响
      throw new PeaksFailure(controller.signal.aborted ? "timeout" : "network");
    } finally {
      clearTimeout(headerStall);
    }

    if (response.ok) return readBounded(response, controller);
    // 丢弃响应体，释放连接
    void response.body?.cancel().catch(() => {});
    if (forceRefresh) throw new PeaksFailure("network");
    if (response.status !== 401 && response.status !== 403 && response.status !== 404) {
      throw new PeaksFailure("network");
    }
    forceRefresh = true;
  }
}

/**
 * 流式读取并累计字节：`Content-Length` 可用时先看长度，超限一个字节都不读；
 * 没有该头时退回累计计数。读取期间无新字节超过 `STALL_TIMEOUT_MS` 即中止。
 */
async function readBounded(response: Response, controller: AbortController): Promise<ArrayBuffer> {
  const rawLength = response.headers.get("Content-Length");
  const declared = rawLength === null ? Number.NaN : Number(rawLength);
  if (Number.isFinite(declared) && declared > MAX_BYTES) {
    void response.body?.cancel().catch(() => {});
    throw new PeaksFailure("too_large");
  }

  const body = response.body;
  // 流式体是字节闸门的前提：没有它就只能整段读完再判长度，既不设上限也不受停滞
  // 超时约束，一次卡住的响应会永久占住该文件的单飞条目。支持的浏览器对成功响应
  // 一律给出流式体，这里只按不可用降级（不缓存，播放不受影响）
  if (!body) throw new PeaksFailure("network");

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let stalled = false;
  let stall: ReturnType<typeof setTimeout> | undefined;
  const armStall = () => {
    clearTimeout(stall);
    stall = setTimeout(() => {
      stalled = true;
      controller.abort();
    }, STALL_TIMEOUT_MS);
  };

  try {
    armStall();
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch {
        throw new PeaksFailure(stalled ? "timeout" : "network");
      }
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > MAX_BYTES) {
        void reader.cancel().catch(() => {});
        throw new PeaksFailure("too_large");
      }
      chunks.push(chunk.value);
      armStall();
    }
  } finally {
    clearTimeout(stall);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes.buffer;
}

/** 解码（规则 2.1）：8kHz 构造，`finally` 中关闭——异常路径也必须关闭，避免 AudioContext 泄漏 */
async function decodeBuffer(buffer: ArrayBuffer): Promise<AudioBuffer> {
  let context: AudioContext;
  try {
    context = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE });
  } catch {
    // 构造失败按解码失败处理，不回退到更高采样率——回退会让时长上限失去意义
    throw new PeaksFailure("decode_failed");
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const decoding = context.decodeAudioData(buffer);
    // 超时后 close() 会让解码 Promise 拒绝：先挂处理器，避免未处理的拒绝
    decoding.catch(() => {});
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new PeaksFailure("timeout")), DECODE_TIMEOUT_MS);
    });
    return await Promise.race([decoding, timeout]);
  } catch (error) {
    // 本函数只抛一种分类：超时。保留它，其余（解码器拒绝、上下文异常）都是内容层面的确定失败
    throw error instanceof PeaksFailure ? error : new PeaksFailure("decode_failed");
  } finally {
    clearTimeout(timer);
    if (context.state !== "closed") await context.close().catch(() => {});
  }
}

/** 峰值抽取（规则 2.2 / 2.3）：每桶取绝对值最大，最多 2 声道，结果落在 [-1, 1] */
function extractPeaks(buffer: AudioBuffer): AudioPeaks | null {
  const { duration, numberOfChannels } = buffer;
  // 空声道或零时长会被 wavesurfer 的 createBuffer 拒绝（规则 2.3）
  if (!(duration > 0) || numberOfChannels <= 0) return null;

  const channels: Float32Array[] = [];
  for (let channel = 0; channel < Math.min(numberOfChannels, MAX_CHANNELS); channel += 1) {
    const samples = buffer.getChannelData(channel);
    if (samples.length === 0) return null;
    const buckets = Math.ceil(samples.length / BUCKET_SIZE);
    const peaks = new Float32Array(buckets);
    for (let bucket = 0; bucket < buckets; bucket += 1) {
      const start = bucket * BUCKET_SIZE;
      const end = Math.min(start + BUCKET_SIZE, samples.length);
      let max = 0;
      for (let i = start; i < end; i += 1) {
        const value = Math.abs(samples[i]);
        if (value > max) max = value;
      }
      peaks[bucket] = max;
    }
    channels.push(peaks);
  }
  return { channels, duration };
}
