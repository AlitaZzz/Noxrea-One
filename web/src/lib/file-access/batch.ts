/**
 * 描述请求的批次调度（specs/storage-signed-direct-delivery.md 规则 3.3 / 3.4 / 3.6）。
 *
 * 一次解析的三件事在这里完成：同一事件循环内的请求合并成批量（每批 ≤ 50 条）、
 * 在途批次有界并发（2 个席位）、同一键的去重与取消；响应按条结算时统一走
 * 缓存定序与持久化。缓存内容与落盘格式在 `cache` / `persisted`，协议在 `protocol`。
 */
import { FILE_ACCESS_BATCH_LIMIT } from "@noxrea/shared/file-access";

import { api } from "@/lib/api/client";

import { abortError } from "./abort";
import { storeIfNewer } from "./cache";
import { persistDescriptor } from "./persisted";
import {
  type AccessRequest,
  type FileAccessDescriptor,
  FileAccessError,
  parseDescriptor,
  streamDescriptorOf,
} from "./protocol";
import { currentScope, isStreamLearned, learnStreamDelivery, nextRequestSeq } from "./state";

/** 在途批量请求上限（规则 3.3）：等价于最多 100 条描述在途 */
export const FILE_ACCESS_BATCH_CONCURRENCY = 2;

interface Job {
  cacheKey: string;
  request: AccessRequest;
  scope: number;
  /** 发起序号：缓存写入按它定序（见 cache.storeIfNewer） */
  seq: number;
  /** 所属在途表：取消与结算时从同一张表移除自己 */
  registry: Map<string, Job>;
  subscribers: number;
  /** 仍在待发批次中（可被取消） */
  queued: boolean;
  /** 已进入某次批量请求（结果不再撤回） */
  started: boolean;
  cancelled: boolean;
  promise: Promise<FileAccessDescriptor>;
  resolve: (descriptor: FileAccessDescriptor) => void;
  reject: (error: unknown) => void;
}

const jobs = new Map<string, Job>();
/**
 * 强制刷新的在途请求：与 `jobs` 分开存放。`jobs` 的去重语义是「同一键共享，
 * 结果可复用」；强制刷新要的恰恰相反——它判定手上地址已失效（403/404），
 * 必须真正再发一次描述，不能搭上别人的旧地址。
 */
const refreshJobs = new Map<string, Job>();
/** 待发批次（同一事件循环内累积，规则 3.3 的 DataLoader 式合并） */
const pending: Job[] = [];
let flushScheduled = false;
let activeBatches = 0;
const slotWaiters: Array<() => void> = [];

/**
 * 登记到待发批次：同一事件循环内到达的解析合并为一次批量描述（规则 3.3）。
 * 用微任务而不是定时器：批次边界就是当前同步执行段的结束，不额外引入延迟。
 */
function enqueue(job: Job): void {
  job.queued = true;
  pending.push(job);
  if (flushScheduled) return;
  flushScheduled = true;
  queueMicrotask(flush);
}

/** 把待发批次按上限切分并派发；超出上限的部分进入后续批次（受并发上限约束） */
function flush(): void {
  flushScheduled = false;
  while (pending.length > 0) {
    const batch: Job[] = [];
    while (batch.length < FILE_ACCESS_BATCH_LIMIT && pending.length > 0) {
      const job = pending.shift()!;
      if (!job.cancelled) batch.push(job);
    }
    if (batch.length > 0) void dispatchBatch(batch);
  }
}

/**
 * 批量互斥：在途批次不超过上限。等待期间作业仍是「排队」状态，
 * 订阅者全部退出时可以被取消（规则 3.3）。
 */
function acquireBatchSlot(): Promise<void> {
  if (activeBatches < FILE_ACCESS_BATCH_CONCURRENCY) {
    activeBatches += 1;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => slotWaiters.push(resolve));
}

function releaseBatchSlot(): void {
  activeBatches -= 1;
  const next = slotWaiters.shift();
  if (next) {
    activeBatches += 1;
    next();
  }
}

async function dispatchBatch(batch: Job[]): Promise<void> {
  await acquireBatchSlot();
  try {
    // 等到席位后才标记「已开始」：此前取消仍然有效
    const live = batch.filter((job) => !job.cancelled);
    if (live.length === 0) return;
    for (const job of live) {
      job.queued = false;
      job.started = true;
    }
    await runBatch(live);
  } finally {
    releaseBatchSlot();
  }
}

/** 一次批量描述：整批成败之外的逐条结果按下标对回请求 */
async function runBatch(batch: Job[]): Promise<void> {
  // 规则 3.4 的检查必须发生在请求真正发出时：批次可能在首个响应之前就已组建。
  // 已学习 stream 后，地址由请求确定性构造（与服务端同一构造器），整批不再发请求。
  if (isStreamLearned()) {
    for (const job of batch) settleDescriptor(job, streamDescriptorOf("", job.request));
    return;
  }

  let payload: { items?: unknown } | null;
  try {
    payload = await api<{ items?: unknown }>("/api/files/access", {
      method: "POST",
      body: JSON.stringify({ items: batch.map((job) => job.request) }),
    });
  } catch (error) {
    for (const job of batch) settleFailure(job, error);
    return;
  }

  const items = payload?.items;
  if (!Array.isArray(items) || items.length !== batch.length) {
    // 「同序同长」是接口契约（规则 2.3）：不满足时无法把结果对回请求，
    // 整批按契约错误失败，而不是把结果错配给别的条目
    const error = new Error("File access response does not match the requested items");
    for (const job of batch) settleFailure(job, error);
    return;
  }

  batch.forEach((job, index) => settleItem(job, items[index]));
}

function settleItem(job: Job, raw: unknown): void {
  const code = (raw as { error?: unknown } | null)?.error;
  if (typeof code === "string" && code.length > 0) {
    settleFailure(job, new FileAccessError(code));
    return;
  }
  let descriptor: FileAccessDescriptor;
  try {
    descriptor = parseDescriptor(raw);
  } catch (error) {
    settleFailure(job, error);
    return;
  }
  settleDescriptor(job, descriptor);
}

function releaseJob(job: Job): void {
  if (job.registry.get(job.cacheKey) === job) job.registry.delete(job.cacheKey);
}

function settleFailure(job: Job, error: unknown): void {
  releaseJob(job);
  if (job.scope !== currentScope()) {
    job.reject(abortError());
    return;
  }
  job.reject(error);
}

function settleDescriptor(job: Job, descriptor: FileAccessDescriptor): void {
  releaseJob(job);
  if (job.cancelled || job.scope !== currentScope()) {
    job.reject(abortError());
    return;
  }
  // 形态学习只采纳普通读取的结论（规则 3.4）：下载在端点不遵守 `response-*` 覆盖时
  // 会按请求降级为 stream（规则 4.2），那是「这一次下载」的语义，不代表后端不能签发
  // 读地址；从下载响应学习会让一次下载把整个会话的媒体都改走应用流
  if (descriptor.delivery === "stream" && job.request.download !== true) learnStreamDelivery();
  // 缓存与持久化同一写入定序：旧响应不能借落盘路径绕过时序判定
  if (storeIfNewer(job.cacheKey, job.seq, descriptor)) {
    persistDescriptor(job.request, descriptor);
  }
  job.resolve(descriptor);
}

/** 创建一个在途请求并登记到自己那张表（去重表或强制刷新表），随后进入待发批次 */
function createJob(
  request: AccessRequest,
  cacheKey: string,
  registry: Map<string, Job>,
): Job {
  let resolve!: (descriptor: FileAccessDescriptor) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<FileAccessDescriptor>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const job: Job = {
    cacheKey,
    request,
    scope: currentScope(),
    seq: nextRequestSeq(),
    registry,
    subscribers: 0,
    queued: false,
    started: false,
    cancelled: false,
    promise,
    resolve,
    reject,
  };
  registry.set(cacheKey, job);
  enqueue(job);
  return job;
}

/** 普通解析：同一键共享在途请求（结果对任何订阅者都成立） */
function acquireJob(request: AccessRequest, cacheKey: string): Job {
  const existing = jobs.get(cacheKey);
  if (existing && !existing.cancelled) return existing;
  return createJob(request, cacheKey, jobs);
}

/**
 * 强制刷新：判定手上地址已失效（媒体元素 403/404 / 瞬时描述失败），必须真正
 * 重新描述一次，因此不并入 `jobs` 里可能携带旧地址的在途请求。同键的多次强制
 * 刷新仍合并为一个（它们要的是同一个新地址，重复请求没有额外价值）。
 */
function acquireRefreshJob(request: AccessRequest, cacheKey: string): Job {
  const existing = refreshJobs.get(cacheKey);
  if (existing && !existing.cancelled) return existing;
  return createJob(request, cacheKey, refreshJobs);
}

/**
 * 订阅一个在途请求：同一键共享一个 job；订阅者中止（组件卸载 / 切换源）时
 * 退出等待，若 job 仍在排队且已无订阅者则取消它（规则 3.3）。
 */
function subscribe(job: Job, signal: AbortSignal | undefined): Promise<FileAccessDescriptor> {
  job.subscribers += 1;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    job.subscribers -= 1;
    if (job.subscribers === 0) cancelQueued(job);
  };

  const settled = job.promise.finally(release);
  if (!signal) return settled;

  return new Promise<FileAccessDescriptor>((resolve, reject) => {
    const onAbort = () => {
      release();
      reject(abortError());
    };
    // 先挂 abort 监听、再无条件挂 settled 的两个分支：已经中止的信号不会触发
    // 监听器，但 settled 的处理端必须在同一次同步执行里挂上——否则 job 被
    // 拒绝（会话切换 / 网络失败）时没有任何观察者，变成 unhandled rejection。
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    settled.then(
      (descriptor) => {
        signal.removeEventListener("abort", onAbort);
        resolve(descriptor);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function cancelQueued(job: Job): void {
  if (!job.queued || job.started) return;
  job.cancelled = true;
  releaseJob(job);
  job.reject(abortError());
}

/**
 * 取得一条描述：同一键共享在途请求，`forceRefresh` 另起一个（不然会搭上旧地址）。
 * 地址命中判定在调用方（`index.resolveMediaUrl`）：这里只负责发请求与结算。
 */
export function requestDescriptor(
  request: AccessRequest,
  cacheKey: string,
  options: { forceRefresh?: boolean; signal?: AbortSignal },
): Promise<FileAccessDescriptor> {
  const job = options.forceRefresh
    ? acquireRefreshJob(request, cacheKey)
    : acquireJob(request, cacheKey);
  return subscribe(job, options.signal);
}

/**
 * 会话切换：待发批次不会再有执行机会，必须立即拒绝；已启动项同样结算，
 * 避免网络悬挂时调用方永久等待（结果不会写入新作用域）。
 */
export function resetBatches(): void {
  for (const job of [...jobs.values(), ...refreshJobs.values()]) {
    job.cancelled = true;
    job.reject(abortError());
  }
  jobs.clear();
  refreshJobs.clear();
  pending.length = 0;
}
