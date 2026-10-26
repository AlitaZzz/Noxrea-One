// @vitest-environment jsdom
/**
 * 访问解析服务（specs/storage-signed-direct-delivery.md 规则 3）：
 * 值域分流、同拍批量合并与拆批、批并发上限、缓存、在途去重、形态学习、
 * 过期与 forceRefresh、逐条失败、账号作用域、签名描述持久化。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { makeStorageKey } from "@/__tests__/test-utils/storage-fixtures";

const mocks = vi.hoisted(() => {
  /** 与真实 client 同形的错误：重试判据只看 `status`（0 = 网络层失败） */
  class ApiError extends Error {
    readonly status: number;
    constructor(status: number, message = "api error") {
      super(message);
      this.name = "ApiError";
      this.status = status;
    }
  }
  return { api: vi.fn(), ApiError };
});
vi.mock("@/lib/api/client", () => ({ api: mocks.api, ApiError: mocks.ApiError }));

/** 设备本地缓存（IndexedDB）整体替身：解析层只依赖这四个入口 */
const storeMocks = vi.hoisted(() => ({
  read: vi.fn(),
  write: vi.fn(),
  remove: vi.fn(),
  clear: vi.fn(),
}));
vi.mock("@/lib/file-access-store", () => ({
  readPersistedDescriptors: storeMocks.read,
  writePersistedDescriptors: storeMocks.write,
  deletePersistedDescriptors: storeMocks.remove,
  clearPersistedDescriptors: storeMocks.clear,
}));

import { FILE_ACCESS_BATCH_LIMIT } from "@noxrea/shared/file-access";

import {
  credentialsForDelivery,
  FileAccessError,
  isManagedMediaValue,
  peekMediaAccess,
  type ResolvedMediaUrl,
  resolveMediaAccess,
  resolveMediaUrl,
  resolveMediaUrlString,
  resolveMediaUrlWithRetry,
} from "@/lib/file-access";
import { FILE_ACCESS_BATCH_CONCURRENCY } from "@/lib/file-access/batch";
import { cachedDescriptorOf, MEMORY_ENTRY_LIMIT, resetCache, storeIfNewer } from "@/lib/file-access/cache";
import { changeSession } from "@/lib/session-lifecycle";

const ACCOUNT = "42";
const KEY = makeStorageKey("signed-direct-a", ".png");
const KEY_B = makeStorageKey("signed-direct-b", ".png");
const KEY_C = makeStorageKey("signed-direct-c", ".png");

const nowSeconds = () => Math.floor(Date.now() / 1000);

/** 测试侧收窄：生产侧只暴露带寿命字段的 `peekMediaAccess` */
function peekMediaUrl(value: string | null | undefined): ResolvedMediaUrl | null {
  const access = peekMediaAccess(value);
  return access ? { url: access.url, delivery: access.delivery } : null;
}

/** 合法的 signed 描述：expiresAt 缺省一小时，refreshAt 缺省为寿命 80% 处 */
function signed(
  url: string,
  { expiresAt = nowSeconds() + 3600, refreshAt = expiresAt - 600 }: {
    expiresAt?: number;
    refreshAt?: number;
  } = {},
) {
  return { url, delivery: "signed" as const, expiresAt, refreshAt };
}

interface BatchItem {
  key: string;
  width?: number;
  download?: boolean;
  filename?: string;
}

/** 请求体里的条目（规则 2.1：`{ items: [...] }`） */
function itemsOfCall(index: number): BatchItem[] {
  return (JSON.parse(mocks.api.mock.calls[index][1].body) as { items: BatchItem[] }).items;
}

/** 让每次批量请求都按请求条目返回同一条 signed 描述 */
function respondSigned(url: string, options?: { expiresAt?: number; refreshAt?: number }): void {
  const descriptor = signed(url, options);
  mocks.api.mockImplementation((_path: string, init: { body: string }) => {
    const { items } = JSON.parse(init.body) as { items: unknown[] };
    return Promise.resolve({ items: items.map(() => descriptor) });
  });
}

/** 让每次批量请求都返回 stream 描述（URL 由 key 构造，与真实 local 后端同形） */
function respondStream(): void {
  mocks.api.mockImplementation((_path: string, init: { body: string }) => {
    const { items } = JSON.parse(init.body) as { items: BatchItem[] };
    return Promise.resolve({
      items: items.map((item) => ({ key: item.key, url: `/api/files/${item.key}`, delivery: "stream" })),
    });
  });
}

/** 十个微任务 + 宏任务，足够让批次派发与 Promise 回调全部结算 */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

beforeEach(() => {
  mocks.api.mockReset();
  storeMocks.read.mockReset().mockResolvedValue([]);
  storeMocks.write.mockReset().mockResolvedValue(undefined);
  storeMocks.remove.mockReset().mockResolvedValue(undefined);
  storeMocks.clear.mockReset().mockResolvedValue(undefined);
  // 会话切换即清空缓存/在途/待发批次/持久化（解析服务的唯一重置入口）
  changeSession();
});

describe("值域分流", () => {
  it("外部 http(s) / data: / blob: 原样返回且不请求描述接口", async () => {
    for (const value of ["https://cdn.example.com/a.png", "data:image/png;base64,xxx", "blob:https://x/y"]) {
      await expect(resolveMediaUrl(value)).resolves.toEqual({ url: value });
    }
    expect(mocks.api).not.toHaveBeenCalled();
  });

  it("存储 key 与托管 URL 同等对待", async () => {
    respondSigned("https://signed/a");
    await expect(resolveMediaUrl(KEY)).resolves.toEqual({ url: "https://signed/a", delivery: "signed" });
    expect(mocks.api).toHaveBeenCalledTimes(1);
    expect(itemsOfCall(0)).toEqual([{ key: KEY }]);
    expect(isManagedMediaValue(KEY)).toBe(true);
    expect(isManagedMediaValue("https://cdn.example.com/a.png")).toBe(false);
    // 外部源上恰好同形的路径同样不是托管值：托管值只有站内相对路径一种形态
    expect(isManagedMediaValue("https://cdn.example.com/api/files/a.png")).toBe(false);
    await expect(resolveMediaUrl("https://cdn.example.com/api/files/a.png")).resolves.toEqual({
      url: "https://cdn.example.com/api/files/a.png",
    });
    expect(mocks.api).toHaveBeenCalledTimes(1);
  });

  it("媒体片段（#t=0.1）保留在解析结果上，不进入描述请求与缓存键", async () => {
    respondSigned("https://signed/a");
    await expect(resolveMediaUrl(`${KEY}#t=0.1`)).resolves.toEqual({
      url: "https://signed/a#t=0.1",
      delivery: "signed",
    });
    expect(itemsOfCall(0)).toEqual([{ key: KEY }]);
    // 缓存命中同样按调用方输入保留片段，且不同片段共享同一条缓存
    await expect(resolveMediaUrl(`${KEY}#t=0.5`)).resolves.toEqual({
      url: "https://signed/a#t=0.5",
      delivery: "signed",
    });
    expect(isManagedMediaValue(`${KEY}#t=0.1`)).toBe(true);
    expect(mocks.api).toHaveBeenCalledTimes(1);
  });

  it("畸形百分号编码 / 空 key 的托管路径按非托管值直通，渲染期不抛错", async () => {
    for (const value of ["/api/files/%zz", "/api/files/"]) {
      await expect(resolveMediaUrl(value)).resolves.toEqual({ url: value });
      expect(peekMediaUrl(value)).toEqual({ url: value });
      // 判定与解析同源：不判为托管，也就不会发出必然 400 的描述请求
      expect(isManagedMediaValue(value)).toBe(false);
    }
    expect(mocks.api).not.toHaveBeenCalled();
  });

  it("从逻辑 URL 读取 width / download / filename", async () => {
    respondSigned("https://signed/a");
    await resolveMediaUrl(`/api/files/${KEY}?w=640&download=1&filename=a%20b.png`);
    expect(itemsOfCall(0)).toEqual([{ key: KEY, width: 640, download: true, filename: "a b.png" }]);
  });

  it("显式选项覆盖 download / filename；宽度只来自逻辑 URL", async () => {
    respondSigned("https://signed/a");
    await resolveMediaUrl(`/api/files/${KEY}?w=640&download=1&filename=a.png`, {
      download: true,
      filename: "x.png",
    });
    // 宽度没有第二个来源：调用方只能在逻辑 URL 上表达档位，避免两处给同一请求不同宽度
    expect(itemsOfCall(0)).toEqual([{ key: KEY, width: 640, download: true, filename: "x.png" }]);
  });
});

describe("字节请求凭据（规则 3.1）", () => {
  it("按分发形态单点映射：signed → omit，stream → include，外部地址不指定", () => {
    expect(credentialsForDelivery("signed")).toBe("omit");
    expect(credentialsForDelivery("stream")).toBe("include");
    expect(credentialsForDelivery(undefined)).toBeUndefined();
  });
});

describe("批量合并（规则 3.3）", () => {
  it("同一事件循环内的多次解析合并为一次批量请求，结果按序对回", async () => {
    mocks.api.mockImplementation((_path: string, init: { body: string }) => {
      const { items } = JSON.parse(init.body) as { items: BatchItem[] };
      return Promise.resolve({
        items: items.map((item) => signed(`https://signed/${item.key}`)),
      });
    });

    const keys = [KEY, KEY_B, KEY_C];
    const results = await Promise.all(keys.map((key) => resolveMediaUrl(key)));

    expect(mocks.api).toHaveBeenCalledTimes(1);
    expect(itemsOfCall(0).map((item) => item.key)).toEqual(keys);
    expect(results.map((result) => result.url)).toEqual(keys.map((key) => `https://signed/${key}`));
  });

  it(`超过 ${FILE_ACCESS_BATCH_LIMIT} 条拆成多批，批次顺序与请求顺序一致`, async () => {
    mocks.api.mockImplementation((_path: string, init: { body: string }) => {
      const { items } = JSON.parse(init.body) as { items: BatchItem[] };
      return Promise.resolve({ items: items.map((item) => signed(`https://signed/${item.key}`)) });
    });

    const keys = Array.from(
      { length: FILE_ACCESS_BATCH_LIMIT + 5 },
      (_, i) => makeStorageKey(`bulk-${i}`, ".png"),
    );
    const results = await Promise.all(keys.map((key) => resolveMediaUrl(key)));

    expect(mocks.api).toHaveBeenCalledTimes(2);
    expect(itemsOfCall(0)).toHaveLength(FILE_ACCESS_BATCH_LIMIT);
    expect(itemsOfCall(1)).toHaveLength(5);
    expect(itemsOfCall(0).concat(itemsOfCall(1)).map((item) => item.key)).toEqual(keys);
    expect(results).toHaveLength(keys.length);
  });

  it(`在途批次不超过 ${FILE_ACCESS_BATCH_CONCURRENCY} 个，其余等待席位`, async () => {
    const pending: Array<(value: unknown) => void> = [];
    mocks.api.mockImplementation((_path: string, init: { body: string }) => {
      const { items } = JSON.parse(init.body) as { items: BatchItem[] };
      return new Promise((resolve) => {
        pending.push(() => resolve({ items: items.map((item) => signed(`https://signed/${item.key}`)) }));
      });
    });

    const keys = Array.from(
      { length: FILE_ACCESS_BATCH_LIMIT * 3 },
      (_, i) => makeStorageKey(`slot-${i}`, ".png"),
    );
    const results = keys.map((key) => resolveMediaUrl(key));
    await flush();
    expect(mocks.api).toHaveBeenCalledTimes(FILE_ACCESS_BATCH_CONCURRENCY);

    // 放行第一个批次：等待席位的第三个批次随即发出
    pending[0](undefined);
    await flush();
    expect(mocks.api).toHaveBeenCalledTimes(FILE_ACCESS_BATCH_CONCURRENCY + 1);

    while (pending.length > 0) {
      pending.shift()!(undefined);
      await flush();
    }
    await expect(Promise.all(results)).resolves.toHaveLength(keys.length);
  });
});

describe("缓存与在途去重", () => {
  it("命中缓存不重复请求，peek 同步返回已解析结果", async () => {
    respondSigned("https://signed/a");
    await resolveMediaUrl(KEY);
    await expect(resolveMediaUrl(KEY)).resolves.toEqual({ url: "https://signed/a", delivery: "signed" });
    expect(mocks.api).toHaveBeenCalledTimes(1);
    expect(peekMediaUrl(KEY)).toEqual({ url: "https://signed/a", delivery: "signed" });
  });

  it("resolveMediaAccess / peekMediaAccess 保留 signed 寿命字段（规则 3.8）", async () => {
    const expiresAt = nowSeconds() + 3600;
    const refreshAt = expiresAt - 600;
    const descriptor = { url: "https://signed/rich", delivery: "signed" as const, expiresAt, refreshAt };
    mocks.api.mockResolvedValueOnce({ items: [descriptor] });

    await expect(resolveMediaAccess(KEY)).resolves.toEqual(descriptor);
    expect(peekMediaAccess(KEY)).toEqual(descriptor);
    // 普通消费方入口仍收窄为地址 + 分发形态
    await expect(resolveMediaUrl(KEY)).resolves.toEqual({ url: descriptor.url, delivery: "signed" });
    expect(peekMediaUrl(KEY)).toEqual({ url: descriptor.url, delivery: "signed" });
  });

  it("同一键并发调用共享一个在途条目", async () => {
    let resolveApi!: (value: unknown) => void;
    mocks.api.mockImplementation(() => new Promise((resolve) => { resolveApi = resolve; }));
    const first = resolveMediaUrl(KEY);
    const second = resolveMediaUrl(KEY);
    await flush();
    expect(mocks.api).toHaveBeenCalledTimes(1);
    expect(itemsOfCall(0)).toEqual([{ key: KEY }]);
    resolveApi({ items: [signed("https://signed/shared")] });
    await expect(Promise.all([first, second])).resolves.toEqual([
      { url: "https://signed/shared", delivery: "signed" },
      { url: "https://signed/shared", delivery: "signed" },
    ]);
  });

  it("signed 描述在 refreshAt 失效并重新解析（规则 3.2 / 4.7）", async () => {
    // 已过 refreshAt（寿命 80%），即使 expiresAt 还早也必须重新描述
    mocks.api.mockImplementationOnce(() => Promise.resolve({
      items: [signed("https://signed/old", { expiresAt: nowSeconds() + 600, refreshAt: nowSeconds() - 10 })],
    }));
    await resolveMediaUrl(KEY);
    expect(peekMediaUrl(KEY)).toBeNull();

    respondSigned("https://signed/new");
    await expect(resolveMediaUrl(KEY)).resolves.toEqual({ url: "https://signed/new", delivery: "signed" });
    expect(mocks.api).toHaveBeenCalledTimes(2);
  });

  it("描述缺少 refreshAt 时退化为「失效前 60 秒」", async () => {
    mocks.api.mockImplementationOnce(() => Promise.resolve({
      items: [{ url: "https://signed/soon", delivery: "signed", expiresAt: nowSeconds() + 30 }],
    }));
    await resolveMediaUrl(KEY);
    // 剩余 30s 已在 60s 余量内：视为过期，下一次解析重新描述
    expect(peekMediaUrl(KEY)).toBeNull();
  });

  it("forceRefresh 跳过缓存重新描述", async () => {
    respondSigned("https://signed/one");
    await resolveMediaUrl(KEY);
    mocks.api.mockReset();
    respondSigned("https://signed/two");
    await expect(resolveMediaUrl(KEY, { forceRefresh: true })).resolves.toEqual({
      url: "https://signed/two",
      delivery: "signed",
    });
    expect(mocks.api).toHaveBeenCalledTimes(1);
    expect(peekMediaUrl(KEY)).toEqual({ url: "https://signed/two", delivery: "signed" });
  });

  it("forceRefresh 不并入普通在途请求：必须真正重新描述，不拿旧地址", async () => {
    // 普通请求挂在网关上（模拟同键的另一媒体元素正在描述）
    let resolveStale!: (value: unknown) => void;
    mocks.api.mockImplementationOnce(() => new Promise((resolve) => { resolveStale = resolve; }));
    const stale = resolveMediaUrl(KEY);
    await flush();

    // 此时重试：手上地址已被判定失效，必须另发一次描述
    mocks.api.mockImplementationOnce(() => Promise.resolve({ items: [signed("https://signed/fresh")] }));
    const retried = resolveMediaUrl(KEY, { forceRefresh: true });
    await flush();
    expect(mocks.api).toHaveBeenCalledTimes(2);

    // 旧请求后返回的地址不得覆盖新请求写入的缓存
    resolveStale({ items: [signed("https://signed/stale")] });
    await expect(retried).resolves.toEqual({ url: "https://signed/fresh", delivery: "signed" });
    await stale;
    expect(peekMediaUrl(KEY)).toEqual({ url: "https://signed/fresh", delivery: "signed" });
  });

  it("signed 描述缺少 expiresAt 时明确失败，不按永不过期或永远过期静默处理", async () => {
    mocks.api.mockImplementationOnce(() =>
      Promise.resolve({ items: [{ url: "https://signed/no-expiry", delivery: "signed" }] }));
    await expect(resolveMediaUrl(KEY)).rejects.toThrow(/expiresAt/);
    expect(peekMediaUrl(KEY)).toBeNull();
  });

  it("逐条失败：错误码以 FileAccessError 上抛，且不写入缓存", async () => {
    mocks.api.mockImplementationOnce(() =>
      Promise.resolve({ items: [{ key: KEY, error: "files.file_not_found" }] }));
    const failure = resolveMediaUrl(KEY);
    await expect(failure).rejects.toBeInstanceOf(FileAccessError);
    await expect(failure).rejects.toMatchObject({ code: "files.file_not_found" });
    expect(peekMediaUrl(KEY)).toBeNull();
  });

  it("整批响应与请求条目数不一致时整批失败，不把结果错配给别的条目", async () => {
    mocks.api.mockImplementationOnce(() => Promise.resolve({ items: [signed("https://signed/a")] }));
    await expect(Promise.all([
      resolveMediaUrl(KEY),
      resolveMediaUrl(KEY_B),
    ])).rejects.toThrow(/does not match/);
    expect(peekMediaUrl(KEY)).toBeNull();
  });

  it(`内存缓存有上界：超过 ${MEMORY_ENTRY_LIMIT} 条时按写入顺序丢最旧`, async () => {
    respondSigned("https://signed/bulk");
    const keys = Array.from(
      { length: MEMORY_ENTRY_LIMIT + 1 },
      (_, i) => makeStorageKey(`bound-${i}`, ".png"),
    );
    await Promise.all(keys.map((key) => resolveMediaUrl(key)));

    // 最旧的一条被淘汰，最新一条仍在：失效项本就会在读取时被丢弃，
    // 上界保证的是长期会话的内存占用不随浏览过的对象数无限增长
    expect(peekMediaUrl(keys[0])).toBeNull();
    expect(peekMediaUrl(keys.at(-1)!)).toEqual({ url: "https://signed/bulk", delivery: "signed" });
  });

  it("刷新已有条目会重新计入写入顺序：上界淘汰的是下一条最旧记录", () => {
    const keys = Array.from({ length: MEMORY_ENTRY_LIMIT }, (_, i) => `bound-refresh-${i}`);
    for (const [i, key] of keys.entries()) {
      expect(storeIfNewer(key, 1, signed(`https://signed/${i}`))).toBe(true);
    }

    // 刷新最早写入的条目：序号更大，仍应写回
    expect(storeIfNewer(keys[0], 2, signed("https://signed/refreshed"))).toBe(true);
    // 再写一条触发上界淘汰
    expect(storeIfNewer("bound-refresh-new", 1, signed("https://signed/new"))).toBe(true);

    // 淘汰的是当前最旧的 k-1，而不是刚刷新过的 k-0
    expect(cachedDescriptorOf(keys[0], { evict: false })?.url).toBe("https://signed/refreshed");
    expect(cachedDescriptorOf(keys[1], { evict: false })).toBeNull();
    expect(cachedDescriptorOf("bound-refresh-new", { evict: false })?.url).toBe("https://signed/new");
  });
});

describe("分发形态学习", () => {
  it("首次收到 stream 后，托管值直接由逻辑 URL 构造且不再请求", async () => {
    respondStream();
    await expect(resolveMediaUrl(KEY)).resolves.toEqual({ url: `/api/files/${KEY}`, delivery: "stream" });

    await expect(resolveMediaUrl(KEY_B)).resolves.toEqual({ url: `/api/files/${KEY_B}`, delivery: "stream" });
    expect(mocks.api).toHaveBeenCalledTimes(1);
    expect(peekMediaUrl(KEY_B)).toEqual({ url: `/api/files/${KEY_B}`, delivery: "stream" });
  });

  it("stream 已学习后强制刷新同样不请求描述（规则 3.4）", async () => {
    respondStream();
    await resolveMediaUrl(KEY);

    // 手动重试的 forceRefresh 不能绕过 stream 学习：重新描述不可能改变构造出的地址
    await expect(resolveMediaUrl(KEY_B, { forceRefresh: true })).resolves.toEqual({
      url: `/api/files/${KEY_B}`,
      delivery: "stream",
    });
    expect(mocks.api).toHaveBeenCalledTimes(1);
  });

  it("stream 学习后，等待席位的批次不再发起请求", async () => {
    const pending: Array<(value: unknown) => void> = [];
    mocks.api.mockImplementation(() => new Promise((resolve) => {
      pending.push(resolve);
    }));

    const keys = Array.from(
      { length: FILE_ACCESS_BATCH_LIMIT * 3 },
      (_, i) => makeStorageKey(`stream-slot-${i}`, ".png"),
    );
    const results = keys.map((key) => resolveMediaUrl(key));
    await flush();
    expect(mocks.api).toHaveBeenCalledTimes(FILE_ACCESS_BATCH_CONCURRENCY);

    // 首批返回 stream：等待席位的批次按已学形态直接构造，不再发请求
    pending[0]({ items: itemsOfCall(0).map((item) => ({ url: `/api/files/${item.key}`, delivery: "stream" })) });
    pending[1]({ items: itemsOfCall(1).map((item) => ({ url: `/api/files/${item.key}`, delivery: "stream" })) });
    await flush();

    await expect(Promise.all(results)).resolves.toEqual(
      keys.map((key) => ({ url: `/api/files/${key}`, delivery: "stream" })),
    );
    expect(mocks.api).toHaveBeenCalledTimes(FILE_ACCESS_BATCH_CONCURRENCY);
  });

  it("stream 形态保留媒体片段（存储 key 与托管 URL 两种输入）", async () => {
    respondStream();
    await resolveMediaUrl(KEY);
    await expect(resolveMediaUrl(`${KEY_B}#t=0.1`)).resolves.toEqual({
      url: `/api/files/${KEY_B}#t=0.1`,
      delivery: "stream",
    });
    await expect(resolveMediaUrl(`/api/files/${KEY_B}#t=0.2`)).resolves.toEqual({
      url: `/api/files/${KEY_B}#t=0.2`,
      delivery: "stream",
    });
  });

  it("stream 形态下 download/filename 由逻辑 URL 携带", async () => {
    respondStream();
    await resolveMediaUrl(KEY);
    await expect(resolveMediaUrl(KEY_B, { download: true, filename: "a b.png" })).resolves.toEqual({
      url: `/api/files/${KEY_B}?download=1&filename=a+b.png`,
      delivery: "stream",
    });
  });

  it("stream 形态的宽度同样只来自逻辑 URL", async () => {
    respondStream();
    await resolveMediaUrl(KEY);
    await expect(resolveMediaUrl(`/api/files/${KEY_B}?w=640`)).resolves.toEqual({
      url: `/api/files/${KEY_B}?w=640`,
      delivery: "stream",
    });
    expect(mocks.api).toHaveBeenCalledTimes(1);
  });

  it("下载响应降级为 stream 不改变会话形态学习（规则 4.2 只对这一次下载生效）", async () => {
    respondStream();
    // 下载的查询参数由服务端描述决定，客户端原样使用
    await expect(resolveMediaUrl(KEY, { download: true })).resolves.toEqual({
      url: `/api/files/${KEY}`,
      delivery: "stream",
    });

    // 普通读取仍走描述接口：不能因为一次下载把整个会话的媒体都改走应用流
    await expect(resolveMediaUrl(KEY_B)).resolves.toEqual({
      url: `/api/files/${KEY_B}`,
      delivery: "stream",
    });
    expect(mocks.api).toHaveBeenCalledTimes(2);
  });
});

describe("排队取消", () => {
  it("等待席位的条目在订阅者中止后不再进入请求", async () => {
    const pending: Array<(value: unknown) => void> = [];
    mocks.api.mockImplementation((_path: string, init: { body: string }) => {
      const { items } = JSON.parse(init.body) as { items: BatchItem[] };
      return new Promise((resolve) => {
        pending.push(() => resolve({ items: items.map((item) => signed(`https://signed/${item.key}`)) }));
      });
    });

    // 两批占满席位，第三批等待
    const busyKeys = Array.from(
      { length: FILE_ACCESS_BATCH_LIMIT * FILE_ACCESS_BATCH_CONCURRENCY },
      (_, i) => makeStorageKey(`cancel-busy-${i}`, ".png"),
    );
    const busy = busyKeys.map((key) => resolveMediaUrl(key));
    await flush();
    expect(mocks.api).toHaveBeenCalledTimes(FILE_ACCESS_BATCH_CONCURRENCY);

    const queuedKey = makeStorageKey("cancel-queued", ".png");
    const controller = new AbortController();
    const queued = resolveMediaUrl(queuedKey, { signal: controller.signal });
    await flush();
    controller.abort();
    await expect(queued).rejects.toMatchObject({ name: "AbortError" });

    // 放行前两批：第三批已无订阅者，不发请求
    while (pending.length > 0) {
      pending.shift()!(undefined);
      await flush();
    }
    await Promise.all(busy);
    expect(mocks.api).toHaveBeenCalledTimes(FILE_ACCESS_BATCH_CONCURRENCY);
  });
});

describe("账号作用域", () => {
  it("会话切换清空缓存，旧作用域结果不写入新作用域", async () => {
    respondSigned("https://signed/one");
    await resolveMediaUrl(KEY);
    changeSession();
    expect(peekMediaUrl(KEY)).toBeNull();
    respondSigned("https://signed/two");
    await expect(resolveMediaUrl(KEY)).resolves.toEqual({ url: "https://signed/two", delivery: "signed" });
    expect(mocks.api).toHaveBeenCalledTimes(2);
  });

  it("会话切换时在途描述结果被丢弃", async () => {
    let resolveApi!: (value: unknown) => void;
    mocks.api.mockImplementation(() => new Promise((resolve) => { resolveApi = resolve; }));
    const inFlight = resolveMediaUrl(KEY);
    await flush();
    changeSession();
    resolveApi({ items: [signed("https://signed/stale")] });
    await expect(inFlight).rejects.toMatchObject({ name: "AbortError" });
    expect(peekMediaUrl(KEY)).toBeNull();
  });

  it("等待持久化载入期间会话切换：本次解析中止，不在新会话里重新发起请求", async () => {
    let settleRead!: (records: unknown[]) => void;
    storeMocks.read.mockImplementationOnce(() => new Promise((resolve) => {
      settleRead = resolve;
    }));
    changeSession(ACCOUNT);

    const resolving = resolveMediaUrl(KEY);
    changeSession();
    settleRead([]);

    await expect(resolving).rejects.toMatchObject({ name: "AbortError" });
    expect(mocks.api).not.toHaveBeenCalled();
  });

  it("会话切换立即结算等待席位的条目与在途批次，不悬挂 Promise", async () => {
    const pending: Array<(value: unknown) => void> = [];
    mocks.api.mockImplementation(() => new Promise((resolve) => { pending.push(resolve); }));
    const busy = Array.from(
      { length: FILE_ACCESS_BATCH_LIMIT * FILE_ACCESS_BATCH_CONCURRENCY },
      (_, i) => resolveMediaUrl(makeStorageKey(`reset-busy-${i}`, ".png")),
    );
    await flush();
    expect(mocks.api).toHaveBeenCalledTimes(FILE_ACCESS_BATCH_CONCURRENCY);

    // 第三批等待席位，会话切换必须立即拒绝它而不是永久悬挂
    const queued = resolveMediaUrl(makeStorageKey("reset-queued", ".png"));
    changeSession();

    await expect(queued).rejects.toMatchObject({ name: "AbortError" });
    await expect(Promise.all(busy)).rejects.toMatchObject({ name: "AbortError" });
    expect(mocks.api).toHaveBeenCalledTimes(FILE_ACCESS_BATCH_CONCURRENCY);

    // 迟到的响应不写入新作用域
    for (const resolve of pending) resolve({ items: [signed("https://signed/stale")] });
    await flush();
    expect(peekMediaUrl(KEY)).toBeNull();
  });
});

describe("签名描述的设备本地持久化（规则 3.2）", () => {
  it("signed 描述写入持久化：账号作用域 + 寿命 + 逻辑键", async () => {
    changeSession(ACCOUNT);
    respondSigned("https://signed/persisted", { expiresAt: nowSeconds() + 3600 });
    await resolveMediaUrl(KEY);
    await flush();

    expect(storeMocks.write).toHaveBeenCalledTimes(1);
    const [records] = storeMocks.write.mock.calls[0];
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ scope: ACCOUNT, url: "https://signed/persisted" });
    expect(records[0].cacheKey).toContain(KEY);
  });

  it("落盘记录不填补缺失的 refreshAt：跨会话命中仍按「失效前 60 秒」判死", async () => {
    // 服务端没给建议时刻：落盘必须保留「没有」这件事，用 expiresAt 填补会把 URL 用到最后一刻
    changeSession(ACCOUNT);
    mocks.api.mockImplementationOnce(() => Promise.resolve({
      items: [{ url: "https://signed/no-refresh", delivery: "signed", expiresAt: nowSeconds() + 3600 }],
    }));
    await resolveMediaUrl(KEY);
    await flush();

    expect(storeMocks.write).toHaveBeenCalledTimes(1);
    const [records] = storeMocks.write.mock.calls[0];
    expect(records[0]).not.toHaveProperty("refreshAt");

    // 下一次会话载入同一条记录（此刻已进入 60s 余量）：必须判死并重新描述
    storeMocks.read.mockResolvedValueOnce([{
      cacheKey: `${KEY}\u0000`,
      scope: ACCOUNT,
      url: "https://signed/no-refresh",
      expiresAt: nowSeconds() + 30,
      savedAt: Date.now(),
    }]);
    changeSession(ACCOUNT);
    await flush();
    expect(peekMediaUrl(KEY)).toBeNull();
    // 载入判定与命中判定共用同一个还原函数：缺 refreshAt 的条目在余量内被清盘
    expect(storeMocks.remove).toHaveBeenCalledWith([`${KEY}\u0000`]);
  });

  it("stream 与下载描述不落盘", async () => {
    changeSession(ACCOUNT);
    respondStream();
    await resolveMediaUrl(KEY);
    expect(storeMocks.write).not.toHaveBeenCalled();

    respondSigned("https://signed/download");
    await resolveMediaUrl(KEY_B, { download: true, filename: "a.png" });
    expect(storeMocks.write).not.toHaveBeenCalled();
  });

  it("首屏解析等待持久化载入完成：载入未结算前不发描述请求", async () => {
    let settleRead!: (records: unknown[]) => void;
    storeMocks.read.mockImplementationOnce(() => new Promise((resolve) => {
      settleRead = resolve;
    }));
    changeSession(ACCOUNT);

    const resolving = resolveMediaUrl(KEY);
    await flush();
    expect(mocks.api).not.toHaveBeenCalled();

    settleRead([{
      cacheKey: `${KEY}\u0000`,
      scope: ACCOUNT,
      url: "https://signed/hydrated",
      expiresAt: nowSeconds() + 3600,
      refreshAt: nowSeconds() + 3000,
      savedAt: Date.now(),
    }]);
    await expect(resolving).resolves.toEqual({ url: "https://signed/hydrated", delivery: "signed" });
    expect(mocks.api).not.toHaveBeenCalled();
  });

  it("旧描述后返回不覆盖持久化副本：落盘与内存缓存同一写入定序", async () => {
    changeSession(ACCOUNT);
    let resolveStale!: (value: unknown) => void;
    mocks.api.mockImplementationOnce(() => new Promise((resolve) => {
      resolveStale = resolve;
    }));
    const stale = resolveMediaUrl(KEY);
    await flush();

    respondSigned("https://signed/fresh");
    await expect(resolveMediaUrl(KEY, { forceRefresh: true })).resolves.toEqual({
      url: "https://signed/fresh",
      delivery: "signed",
    });
    await flush();
    expect(storeMocks.write).toHaveBeenCalledTimes(1);

    resolveStale({ items: [signed("https://signed/stale")] });
    await stale;
    await flush();

    // 旧响应既不能改内存缓存，也不能借落盘路径写回旧地址
    expect(storeMocks.write).toHaveBeenCalledTimes(1);
    expect(peekMediaUrl(KEY)).toEqual({ url: "https://signed/fresh", delivery: "signed" });
  });

  it("会话开始时载入本账号条目：命中后不再请求描述接口", async () => {
    storeMocks.read.mockResolvedValueOnce([{
      cacheKey: `${KEY}\u0000`,
      scope: ACCOUNT,
      url: "https://signed/hydrated",
      expiresAt: nowSeconds() + 3600,
      refreshAt: nowSeconds() + 3000,
      savedAt: Date.now(),
    }]);
    changeSession(ACCOUNT);
    await flush();

    expect(peekMediaUrl(KEY)).toEqual({ url: "https://signed/hydrated", delivery: "signed" });
    await expect(resolveMediaUrl(KEY)).resolves.toEqual({
      url: "https://signed/hydrated",
      delivery: "signed",
    });
    expect(mocks.api).not.toHaveBeenCalled();
  });

  it("载入时丢弃其他账号与已过 refreshAt 的条目，并从磁盘删除", async () => {
    storeMocks.read.mockResolvedValueOnce([
      {
        cacheKey: `${KEY}\u0000`,
        scope: "other-account",
        url: "https://signed/other",
        expiresAt: nowSeconds() + 3600,
        refreshAt: nowSeconds() + 3000,
        savedAt: Date.now(),
      },
      {
        cacheKey: `${KEY_B}\u0000`,
        scope: ACCOUNT,
        url: "https://signed/expired",
        expiresAt: nowSeconds() + 600,
        refreshAt: nowSeconds() - 10,
        savedAt: Date.now(),
      },
    ]);
    changeSession(ACCOUNT);
    await flush();

    expect(peekMediaUrl(KEY)).toBeNull();
    expect(peekMediaUrl(KEY_B)).toBeNull();
    expect(storeMocks.remove).toHaveBeenCalledWith([`${KEY}\u0000`, `${KEY_B}\u0000`]);
  });

  it("载入是合并而非替换：读取期间写入的条目保留，快照里的同 key 旧记录也不删盘", async () => {
    let settleRead!: (records: unknown[]) => void;
    storeMocks.read.mockImplementationOnce(() => new Promise((resolve) => {
      settleRead = resolve;
    }));
    changeSession(ACCOUNT);

    // forceRefresh 不等载入：磁盘读取还在途，新描述已写入内存副本并落盘
    respondSigned("https://signed/fresh");
    await resolveMediaUrl(KEY_B, { forceRefresh: true });
    await flush();
    expect(storeMocks.write).toHaveBeenCalledTimes(1);

    settleRead([
      // 同 key 的旧记录已过期：整表替换会把新副本一起丢掉，stale 删除还会抹掉刚落盘的记录
      {
        cacheKey: `${KEY_B}\u0000`,
        scope: ACCOUNT,
        url: "https://signed/old",
        expiresAt: nowSeconds() - 10,
        savedAt: Date.now() - 7_200_000,
      },
      // 他账号条目：照常清盘
      {
        cacheKey: `${KEY_C}\u0000`,
        scope: "other-account",
        url: "https://signed/other",
        expiresAt: nowSeconds() + 3600,
        savedAt: Date.now(),
      },
    ]);
    await flush();

    // 内存缓存清空后仍由持久化副本命中：载入结果没有替换掉载入期间的写入
    resetCache();
    expect(peekMediaUrl(KEY_B)).toEqual({ url: "https://signed/fresh", delivery: "signed" });
    // 删除名单只有快照里的他账号条目；同 key 的过期旧记录已被新记录覆盖，不得删除
    expect(storeMocks.remove).toHaveBeenCalledWith([`${KEY_C}\u0000`]);
  });

  it("会话切换清空持久化条目", async () => {
    changeSession(ACCOUNT);
    storeMocks.clear.mockClear();
    respondSigned("https://signed/one");
    await resolveMediaUrl(KEY);

    changeSession();
    expect(storeMocks.clear).toHaveBeenCalled();
    expect(peekMediaUrl(KEY)).toBeNull();
  });
});

describe("resolveMediaUrlWithRetry / resolveMediaUrlString 的瞬时故障重试（规则 3.6 非元素形态）", () => {
  it("保留 delivery：需要按分发形态取凭据的调用方与只要地址的调用方共用同一条重试规则", async () => {
    mocks.api.mockRejectedValueOnce(new mocks.ApiError(0, "network unreachable"));
    mocks.api.mockImplementationOnce(() => Promise.resolve({ items: [signed("https://signed/retried")] }));
    await expect(resolveMediaUrlWithRetry(KEY)).resolves.toEqual({
      url: "https://signed/retried",
      delivery: "signed",
    });
    expect(mocks.api).toHaveBeenCalledTimes(2);
  });

  it("网络层失败（status 0）重新描述一次后成功", async () => {
    mocks.api.mockRejectedValueOnce(new mocks.ApiError(0, "network unreachable"));
    mocks.api.mockImplementationOnce(() => Promise.resolve({ items: [signed("https://signed/retried")] }));
    await expect(resolveMediaUrlString(KEY)).resolves.toBe("https://signed/retried");
    expect(mocks.api).toHaveBeenCalledTimes(2);
  });

  it("5xx 瞬时故障重新描述一次后成功", async () => {
    mocks.api.mockRejectedValueOnce(new mocks.ApiError(500, "internal"));
    mocks.api.mockImplementationOnce(() => Promise.resolve({ items: [signed("https://signed/retried")] }));
    await expect(resolveMediaUrlString(KEY)).resolves.toBe("https://signed/retried");
    expect(mocks.api).toHaveBeenCalledTimes(2);
  });

  it("逐条 files.signing_failed 视为瞬时故障，重新描述一次", async () => {
    mocks.api.mockImplementationOnce(() =>
      Promise.resolve({ items: [{ key: KEY, error: "files.signing_failed" }] }));
    mocks.api.mockImplementationOnce(() => Promise.resolve({ items: [signed("https://signed/retried")] }));
    await expect(resolveMediaUrlString(KEY)).resolves.toBe("https://signed/retried");
    expect(mocks.api).toHaveBeenCalledTimes(2);
  });

  it("重试仍失败时上抛，且总共只请求两次", async () => {
    mocks.api.mockRejectedValue(new mocks.ApiError(500, "boom"));
    await expect(resolveMediaUrlString(KEY)).rejects.toBeInstanceOf(mocks.ApiError);
    expect(mocks.api).toHaveBeenCalledTimes(2);
  });

  it("终态失败不重试：404 / 401 / 429 / 503 过载 / 逐条 404 码 / 非 ApiError 均只请求一次", async () => {
    const cases: unknown[] = [
      new mocks.ApiError(404, "not found"),
      new mocks.ApiError(401, "unauthorized"),
      new mocks.ApiError(429, "too many requests"),
      new mocks.ApiError(503, "media busy"),
      new Error("unexpected"),
    ];
    for (const error of cases) {
      mocks.api.mockReset();
      mocks.api.mockRejectedValueOnce(error);
      await expect(resolveMediaUrlString(KEY)).rejects.toBe(error);
      expect(mocks.api, String(error)).toHaveBeenCalledTimes(1);
    }

    // 逐条错误码中的终态：对象不存在 / 过载都不是「再试一次」能解决的
    for (const code of ["files.file_not_found", "media.busy", "media.user_busy"]) {
      mocks.api.mockReset();
      mocks.api.mockImplementationOnce(() => Promise.resolve({ items: [{ key: KEY, error: code }] }));
      await expect(resolveMediaUrlString(KEY)).rejects.toMatchObject({ code });
      expect(mocks.api, code).toHaveBeenCalledTimes(1);
    }
  });
});
