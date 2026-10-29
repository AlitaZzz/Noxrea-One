// @vitest-environment jsdom
/**
 * 音频峰值服务（specs/canvas-audio-peaks-cache.md 规则 1–3）：
 * 解码规格、单飞、IndexedDB 命中不发请求、外部 URL 不落盘、403 重描述一次、
 * IndexedDB 故障降级。
 *
 * 持久层整体替身（与 `file-access.test.ts` 对 `file-access-store` 的做法一致）：
 * 环境里没有 fake-indexeddb，IDB 语义由 `store.ts` 自身承载，这里只验证编排。
 *
 * 内存缓存是模块级状态、跨用例存活，因此每个用例使用独立的存储 key。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { makeStorageKey } from "@/__tests__/test-utils/storage-fixtures";

const fileAccess = vi.hoisted(() => ({
  resolveMediaUrlWithRetry: vi.fn(),
  credentialsForDelivery: vi.fn(),
}));

const store = vi.hoisted(() => ({
  read: vi.fn(),
  write: vi.fn(),
  touch: vi.fn(),
}));

vi.mock("@/lib/file-access", () => fileAccess);
vi.mock("@/lib/audio-peaks/store", () => ({
  readPeaks: store.read,
  writePeaks: store.write,
  touchPeaks: store.touch,
}));

import { getAudioPeaks, peekAudioPeaks } from "@/lib/audio-peaks";

/** 真实的 createElement：探测元素必须是真 DOM 节点（要能挂监听并 dispatchEvent） */
const createElement = document.createElement.bind(document);

const MEDIA_URL = "https://signed.example/audio.mp3?sig=1";
const EXTERNAL_URL = "https://cdn.example.com/a.mp3";
/** 每个用例一个独立 key：内存缓存跨用例存活，复用 key 会命中上一条结果 */
const KEYS = {
  spec: makeStorageKey("audio-peaks-spec", ".mp3"),
  tooLong: makeStorageKey("audio-peaks-too-long", ".mp3"),
  noDuration: makeStorageKey("audio-peaks-no-duration", ".mp3"),
  probeError: makeStorageKey("audio-peaks-probe-error", ".mp3"),
  tooBig: makeStorageKey("audio-peaks-too-big", ".mp3"),
  noBody: makeStorageKey("audio-peaks-no-body", ".mp3"),
  idbHit: makeStorageKey("audio-peaks-idb-hit", ".mp3"),
  singleFlight: makeStorageKey("audio-peaks-single-flight", ".mp3"),
  persisted: makeStorageKey("audio-peaks-persisted", ".mp3"),
  resultShape: makeStorageKey("audio-peaks-result-shape", ".mp3"),
  singleResolve: makeStorageKey("audio-peaks-single-resolve", ".mp3"),
  credentials: makeStorageKey("audio-peaks-credentials", ".mp3"),
  reDescribe: makeStorageKey("audio-peaks-re-describe", ".mp3"),
  noReDescribe: makeStorageKey("audio-peaks-no-re-describe", ".mp3"),
  idbDegraded: makeStorageKey("audio-peaks-idb-degraded", ".mp3"),
  remembered: makeStorageKey("audio-peaks-remembered", ".mp3"),
  transient: makeStorageKey("audio-peaks-transient", ".mp3"),
  internal: makeStorageKey("audio-peaks-internal", ".mp3"),
  memoryTouch: makeStorageKey("audio-peaks-memory-touch", ".mp3"),
  resolveHang: makeStorageKey("audio-peaks-resolve-hang", ".mp3"),
  headerHang: makeStorageKey("audio-peaks-header-hang", ".mp3"),
  queueHung: makeStorageKey("audio-peaks-queue-hung", ".mp3"),
  queueFree: makeStorageKey("audio-peaks-queue-free", ".mp3"),
  queueFailed: makeStorageKey("audio-peaks-queue-failed", ".mp3"),
  queueNext: makeStorageKey("audio-peaks-queue-next", ".mp3"),
};

/**
 * 探测元素替身：真元素 + 覆写 `src` 赋值（按给定时长派发 loadedmetadata；
 * `null` 派发 error）。jsdom 的媒体元素不会真的加载，只能这样模拟容器头部解析。
 */
function stubProbe(duration: number | null): void {
  const element = createElement("audio") as HTMLAudioElement;
  Object.defineProperty(element, "duration", {
    configurable: true,
    value: duration ?? Number.NaN,
  });
  Object.defineProperty(element, "load", { configurable: true, value: vi.fn() });
  Object.defineProperty(element, "src", {
    configurable: true,
    get: () => "",
    set: () => {
      setTimeout(() => {
        element.dispatchEvent(new Event(duration === null ? "error" : "loadedmetadata"));
      }, 0);
    },
  });
  vi.spyOn(document, "createElement").mockImplementation(
    ((tag: string) => (tag === "audio" ? element : createElement(tag))) as typeof document.createElement,
  );
}

interface FakeBuffer {
  duration: number;
  numberOfChannels: number;
  getChannelData(channel: number): Float32Array;
}

function audioBuffer(channels: Float32Array[], duration: number): FakeBuffer {
  return {
    duration,
    numberOfChannels: channels.length,
    getChannelData: (channel: number) => channels[channel],
  };
}

const audioContexts: { sampleRate: number; state: string; close: ReturnType<typeof vi.fn> }[] = [];
let nextBuffer: FakeBuffer;

class FakeAudioContext {
  sampleRate: number;
  state = "running";
  close = vi.fn(async () => {
    this.state = "closed";
  });
  decodeAudioData = vi.fn(async () => nextBuffer);

  constructor(options?: { sampleRate?: number }) {
    this.sampleRate = options?.sampleRate ?? 48_000;
    audioContexts.push(this);
  }
}

/** 响应替身：只实现解码路径用到的部分 */
function responseOf(
  bytes: Uint8Array,
  init: { status?: number; contentLength?: number } = {},
): Response {
  const status = init.status ?? 200;
  const headers = new Map<string, string>();
  if (init.contentLength !== undefined) headers.set("content-length", String(init.contentLength));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
  } as unknown as Response;
}

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("AudioContext", FakeAudioContext);
  vi.stubGlobal("fetch", fetchMock);
  fileAccess.resolveMediaUrlWithRetry.mockResolvedValue({ url: MEDIA_URL, delivery: "signed" });
  fileAccess.credentialsForDelivery.mockImplementation((delivery?: "signed" | "stream") =>
    delivery === undefined ? undefined : delivery === "signed" ? "omit" : "include");
  store.read.mockResolvedValue(null);
  store.write.mockResolvedValue(undefined);
  store.touch.mockResolvedValue(undefined);
  fetchMock.mockResolvedValue(responseOf(new Uint8Array([1, 2, 3])));
  nextBuffer = audioBuffer([new Float32Array(1024)], 0.128);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  audioContexts.length = 0;
});

describe("解码规格（规则 2.1 / 2.2 / 2.3）", () => {
  it("以 8kHz 解码、每 512 采样取桶内最大、最多保留 2 声道，并关闭 AudioContext", async () => {
    stubProbe(1);
    const left = new Float32Array(1024);
    left[10] = -0.5; // 桶 0 的最大绝对值
    left[600] = 0.25; // 桶 1 的最大绝对值
    const right = new Float32Array(1024);
    right[0] = 0.75;
    const third = new Float32Array(1024);
    third.fill(0.9);
    nextBuffer = audioBuffer([left, right, third], 0.128);

    const result = await getAudioPeaks(KEYS.spec);

    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.peaks.duration).toBeCloseTo(0.128);
    expect(result.peaks.channels).toHaveLength(2);
    expect(Array.from(result.peaks.channels[0])).toEqual([0.5, 0.25]);
    expect(Array.from(result.peaks.channels[1])).toEqual([0.75, 0]);

    expect(audioContexts).toHaveLength(1);
    expect(audioContexts[0].sampleRate).toBe(8000);
    expect(audioContexts[0].close).toHaveBeenCalledTimes(1);
  });

  it("结果只暴露 channels 与 duration：不夹带压缩字节或 AudioBuffer 引用", async () => {
    stubProbe(1);

    const result = await getAudioPeaks(KEYS.resultShape);

    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(Object.keys(result.peaks).sort()).toEqual(["channels", "duration"]);
  });

  it("时长超过 20 分钟时在解码前停止：不读字节、不创建 AudioContext", async () => {
    stubProbe(20 * 60 + 1);

    const result = await getAudioPeaks(KEYS.tooLong);

    expect(result).toMatchObject({ status: "unavailable", error: "too_large" });
    // 探测到的时长随结果返回：超限降级时调用方不必再探测一次（规则 5.3）
    if (result.status === "unavailable") expect(result.duration).toBeCloseTo(20 * 60 + 1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(audioContexts).toHaveLength(0);
  });

  it("容器解析成功但时长非有限值时按超限处理，不进入解码", async () => {
    stubProbe(Number.NaN);

    const result = await getAudioPeaks(KEYS.noDuration);

    expect(result).toMatchObject({ status: "unavailable", error: "too_large", duration: null });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(audioContexts).toHaveLength(0);
  });

  it("探测元素报错按环境类失败处理（签出地址 / 编码问题下次挂载仍有重试机会）", async () => {
    stubProbe(null);

    const result = await getAudioPeaks(KEYS.probeError);

    expect(result).toMatchObject({ status: "unavailable", error: "network", duration: null });
    expect(fetchMock).not.toHaveBeenCalled();
    // 不入终止性失败记忆：第二次请求仍会重新探测
    const second = await getAudioPeaks(KEYS.probeError);
    expect(second).toMatchObject({ status: "unavailable", error: "network" });
    expect(second).not.toBe(result);
  });

  it("压缩字节超过上限时中止读取，不进入解码", async () => {
    stubProbe(10);
    fetchMock.mockResolvedValue(
      responseOf(new Uint8Array([1]), { contentLength: 48 * 1024 * 1024 + 1 }),
    );

    const result = await getAudioPeaks(KEYS.tooBig);

    expect(result).toMatchObject({ status: "unavailable", error: "too_large" });
    expect(audioContexts).toHaveLength(0);
  });

  it("成功响应没有流式体时按不可用降级，不整段读完（字节闸门与停滞超时都以流式体为前提）", async () => {
    stubProbe(10);
    // 无 body 的 200：退回无上限、无超时的 arrayBuffer() 会让卡住的响应永久占住
    // 该文件的单飞条目（后续请求永远等不到结果）
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => null },
      body: null,
    } as unknown as Response);

    const result = await getAudioPeaks(KEYS.noBody);

    expect(result).toMatchObject({ status: "unavailable", error: "network" });
    expect(audioContexts).toHaveLength(0);
  });

  it("blob: / data: 不解码也不缓存", async () => {
    const blobResult = await getAudioPeaks("blob:https://app.example/123");
    const dataResult = await getAudioPeaks("data:audio/mp3;base64,AAAA");

    expect(blobResult).toMatchObject({ status: "unavailable", error: "unsupported" });
    expect(dataResult).toMatchObject({ status: "unavailable", error: "unsupported" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(fileAccess.resolveMediaUrlWithRetry).not.toHaveBeenCalled();
  });
});

describe("取数顺序与缓存（规则 1.2 / 1.3 / 3.5）", () => {
  it("IndexedDB 命中时不发任何网络请求，并刷新使用时刻", async () => {
    store.read.mockResolvedValue({
      key: KEYS.idbHit,
      channels: [new Float32Array([0.1, 0.2])],
      duration: 3,
      savedAt: 1,
      lastUsedAt: 1,
    });

    const result = await getAudioPeaks(KEYS.idbHit);

    expect(result).toMatchObject({ status: "ready", peaks: { duration: 3 } });
    expect(store.read).toHaveBeenCalledWith(KEYS.idbHit);
    expect(fileAccess.resolveMediaUrlWithRetry).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(store.touch).toHaveBeenCalledWith(KEYS.idbHit, expect.any(Number));
  });

  it("内存命中同样刷新使用时刻：LRU 按「最近用过」而不是「最近解过」淘汰", async () => {
    stubProbe(1);
    await getAudioPeaks(KEYS.memoryTouch);
    store.touch.mockClear();

    // 第二次走内存缓存：不发请求、不读 IndexedDB，但仍刷新使用时刻（规则 3.4）
    const result = await getAudioPeaks(KEYS.memoryTouch);

    expect(result.status).toBe("ready");
    expect(store.read).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(store.touch).toHaveBeenCalledWith(KEYS.memoryTouch, expect.any(Number));
  });

  it("内存缓存同时受字节预算约束（条数上限只约束持久层，规则 3.4）", async () => {
    // 每条 150 KB：20 分钟立体声峰值的上限；32 MiB 预算下约 224 条，条数上限 500 不触发
    const channels = [new Float32Array(18_750), new Float32Array(18_750)];
    store.read.mockImplementation(async (key: string) => ({
      key,
      channels,
      duration: 1200,
      savedAt: 1,
      lastUsedAt: 1,
    }));

    const keys = Array.from({ length: 230 }, (_, index) =>
      makeStorageKey(`audio-peaks-byte-cap-${index}`, ".mp3"));
    for (const key of keys) await getAudioPeaks(key);

    // 条数远未到 500，淘汰只能来自字节预算：最早写入的条目被淘汰，最新的仍在
    expect(peekAudioPeaks(keys[0])).toBeNull();
    expect(peekAudioPeaks(keys[keys.length - 1])).not.toBeNull();
  });

  it("同一 key 的并发请求只解码一次（单飞）", async () => {
    stubProbe(1);

    const [first, second] = await Promise.all([
      getAudioPeaks(KEYS.singleFlight),
      getAudioPeaks(KEYS.singleFlight),
    ]);

    expect(first.status).toBe("ready");
    expect(second).toBe(first);
    expect(audioContexts).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("外部 http(s) URL 只进内存，不读写 IndexedDB", async () => {
    stubProbe(1);

    const result = await getAudioPeaks(EXTERNAL_URL);

    expect(result.status).toBe("ready");
    expect(store.read).not.toHaveBeenCalled();
    expect(store.write).not.toHaveBeenCalled();
  });

  it("托管值解码成功后写入 IndexedDB，记录只含峰值与时间戳", async () => {
    stubProbe(1);

    await getAudioPeaks(KEYS.persisted);

    // 完整对象比对：多写字段（例如已移除的字节数）会直接失败
    expect(store.write).toHaveBeenCalledWith({
      key: KEYS.persisted,
      channels: expect.any(Array),
      duration: 0.128,
      savedAt: expect.any(Number),
      lastUsedAt: expect.any(Number),
    });
  });
});

describe("字节请求的凭据与失败重试（规则 6.1 / 6.2）", () => {
  it("正常路径只描述一次地址：探测与字节请求复用同一份解析结果", async () => {
    stubProbe(1);

    await getAudioPeaks(KEYS.singleResolve);

    expect(fileAccess.resolveMediaUrlWithRetry).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(MEDIA_URL, expect.anything());
  });

  it("按分发形态取凭据：signed → omit", async () => {
    stubProbe(1);

    await getAudioPeaks(KEYS.credentials);

    expect(fetchMock).toHaveBeenCalledWith(
      MEDIA_URL,
      expect.objectContaining({ credentials: "omit" }),
    );
  });

  it("字节请求 403 时强制重新描述一次并重试一次，仍失败则波形不可用", async () => {
    stubProbe(1);
    fetchMock.mockResolvedValue(responseOf(new Uint8Array(), { status: 403 }));

    const result = await getAudioPeaks(KEYS.reDescribe);

    expect(result).toMatchObject({ status: "unavailable" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // 重试前必须强制重新描述：同一签名地址重签不会改变结果
    expect(fileAccess.resolveMediaUrlWithRetry).toHaveBeenLastCalledWith(
      KEYS.reDescribe,
      expect.objectContaining({ forceRefresh: true }),
    );
    expect(audioContexts).toHaveLength(0);
  });

  it("401/403/404 之外的状态码不重描述", async () => {
    stubProbe(1);
    fetchMock.mockResolvedValue(responseOf(new Uint8Array(), { status: 500 }));

    const result = await getAudioPeaks(KEYS.noReDescribe);

    expect(result).toMatchObject({ status: "unavailable" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fileAccess.resolveMediaUrlWithRetry).not.toHaveBeenCalledWith(
      KEYS.noReDescribe,
      expect.objectContaining({ forceRefresh: true }),
    );
  });
});

describe("取数阶段上界（悬挂请求必须自行退出）", () => {
  it("一个文件的下载悬挂不阻塞另一个文件的解码（取数不占用解码队列）", async () => {
    stubProbe(10);
    vi.useFakeTimers();
    fetchMock
      .mockImplementationOnce(
        (_url: string, options?: { signal?: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            options?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          }),
      )
      .mockResolvedValueOnce(responseOf(new Uint8Array([1, 2, 3])));

    const hung = getAudioPeaks(KEYS.queueHung);
    const free = getAudioPeaks(KEYS.queueFree);

    // 推进两次探测的 setTimeout(0)：另一个文件一路走到解码完成
    await vi.advanceTimersByTimeAsync(0);
    await expect(free).resolves.toMatchObject({ status: "ready" });

    // 悬挂的那个仍卡在下载上，由停滞超时自行退出
    await vi.advanceTimersByTimeAsync(20_000);
    await expect(hung).resolves.toMatchObject({ status: "unavailable", error: "timeout" });
  });

  it("等待响应头超过停滞时限即中止，结果为超时", async () => {
    stubProbe(10);
    vi.useFakeTimers();
    fetchMock.mockImplementation(
      (_url: string, options?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );

    const pending = getAudioPeaks(KEYS.headerHang);
    await vi.advanceTimersByTimeAsync(20_000);
    const result = await pending;

    expect(result).toMatchObject({ status: "unavailable", error: "timeout" });
    expect(audioContexts).toHaveLength(0);
  });

  it("描述请求悬挂时按超时退出，结果为环境类失败", async () => {
    vi.useFakeTimers();
    fileAccess.resolveMediaUrlWithRetry.mockImplementation(
      (_value: string, options?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );

    const pending = getAudioPeaks(KEYS.resolveHang);
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await pending;

    expect(result).toMatchObject({ status: "unavailable", error: "timeout", duration: null });
    // 取址失败即退出：不探测、不解码，也不构造 AudioContext
    expect(audioContexts).toHaveLength(0);
  });
});

describe("解码串行（规则 1.4）", () => {
  it("前一任务解码失败不阻断队列：后续文件照常解码", async () => {
    stubProbe(1);
    // 两次请求各要一个响应：响应体是一次性流，复用同一 Response 会在第二次取 reader 时抛错
    fetchMock.mockImplementation(async () => responseOf(new Uint8Array([1, 2, 3])));

    // 第一个源解码失败（空声道 → decode_failed，与终止性失败用例同一入口）
    nextBuffer = audioBuffer([new Float32Array(0)], 1);
    expect(await getAudioPeaks(KEYS.queueFailed)).toMatchObject({
      status: "unavailable",
      error: "decode_failed",
    });

    // 队列尾部已被失败任务占用：后续任务仍必须入队并解码成功
    nextBuffer = audioBuffer([new Float32Array(1024)], 0.128);
    expect(await getAudioPeaks(KEYS.queueNext)).toMatchObject({ status: "ready" });
  });
});

describe("会话内的失败记忆（异常与边界「同一会话内不自动重试」）", () => {
  it("终止性失败（解码失败 / 超限）重挂载时直接返回同一结果，不再探测与下载", async () => {
    stubProbe(1);
    nextBuffer = audioBuffer([new Float32Array(0)], 1);

    const first = await getAudioPeaks(KEYS.remembered);
    expect(first).toMatchObject({ status: "unavailable", error: "decode_failed" });
    const requests = fetchMock.mock.calls.length;

    const second = await getAudioPeaks(KEYS.remembered);

    expect(second).toBe(first);
    // 不再有字节请求，也不再构造 AudioContext：结果来自记忆，不是又跑了一遍解码
    expect(fetchMock).toHaveBeenCalledTimes(requests);
    expect(audioContexts).toHaveLength(1);
  });

  it("环境类失败（网络 / 超时）不入记忆，下次请求仍重试", async () => {
    stubProbe(1);
    fetchMock.mockRejectedValueOnce(new TypeError("network down"));

    expect(await getAudioPeaks(KEYS.transient)).toMatchObject({ status: "unavailable", error: "network" });

    fetchMock.mockResolvedValue(responseOf(new Uint8Array([1, 2, 3])));
    expect(await getAudioPeaks(KEYS.transient)).toMatchObject({ status: "ready" });
  });

  it("取数阶段的非预期异常归为 internal，不进入终止性记忆", async () => {
    stubProbe(1);
    // 访问响应头即抛错：不是 PeaksFailure，也不是内容层面的解码失败
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: {
        get: () => {
          throw new Error("unexpected");
        },
      },
      body: null,
    } as unknown as Response);

    const first = await getAudioPeaks(KEYS.internal);
    expect(first).toMatchObject({ status: "unavailable", error: "internal", duration: 1 });

    // 不是终止性失败：下一次请求仍走完整取数路径
    fetchMock.mockResolvedValueOnce(responseOf(new Uint8Array([1, 2, 3])));
    expect(await getAudioPeaks(KEYS.internal)).toMatchObject({ status: "ready" });
  });
});

describe("持久层未命中（规则 3.6）", () => {
  it("持久层未命中时照常解码并尝试落盘，正确性不受影响", async () => {
    stubProbe(1);
    store.read.mockResolvedValue(null);

    const result = await getAudioPeaks(KEYS.idbDegraded);

    expect(result.status).toBe("ready");
    expect(store.write).toHaveBeenCalledTimes(1);
  });
});
