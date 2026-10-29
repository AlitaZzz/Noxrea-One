/**
 * 音频峰值服务（specs/canvas-audio-peaks-cache.md 规则 1）。
 *
 * 取数顺序：内存缓存 → IndexedDB → 取数 → 解码。命中前两级时 peaks 路径不发起
 * 任何网络请求；未命中才走取数（取址、探测、下载，可与其它文件并发），随后解码
 * ——解码本身是 CPU/内存重操作，全局串行（并发 1，FIFO，规则 1.4），多节点同时
 * 挂载不会并行解码。
 *
 * 缓存键复用解析层的归一化（`requestOf`）：托管值取存储 key，同一文件经 key 或
 * 托管 URL 引用时命中同一条记录；非托管值只有 `http(s)` 可缓存且只进内存——
 * URL 不是内容身份，其背后内容可变，按 URL 落盘会把旧波形永久固化（规则 3.5）。
 */
import { requestOf } from "@/lib/file-access/protocol";

import {
  type AudioPeaks,
  type AudioPeaksResult,
  decodeAudioPeaks,
  loadAudioSource,
} from "./decode";
import { readPeaks, touchPeaks, writePeaks } from "./store";

export type { AudioPeaks, AudioPeaksResult } from "./decode";

/** 失败记忆里只存不可用结果 */
type AudioPeaksFailure = Extract<AudioPeaksResult, { status: "unavailable" }>;

/** 内存缓存条数上限：与描述缓存同量级 */
const MEMORY_ENTRY_LIMIT = 500;
/**
 * 内存缓存字节上限（32 MiB）。单条峰值受 20 分钟闸门约束，最大约 150 KB
 * （8kHz、512 采样/桶、双声道），500 条满长条目约 75 MB：条数上限挡不住这个量级，
 * 需要独立的字节预算。与 IndexedDB 的条数淘汰是两回事（规则 3.4 只约束持久层）。
 */
const MEMORY_BYTE_LIMIT = 32 * 1024 * 1024;

/**
 * 内存缓存：上限 500 条 / 32 MiB。服务路径命中时刷新插入顺序（`memoryGet`）；
 * 渲染期探测（`peekAudioPeaks`）是纯读，不参与顺序维护——顺序不准只影响淘汰
 * 哪个条目，代价是一次 IndexedDB 读取（不重解码、不发网络请求）
 */
const memory = new Map<string, AudioPeaks>();
/** 内存缓存里现有峰值数组的总字节数，与 `memory` 同步增减 */
let memoryBytes = 0;

function peaksBytes(peaks: AudioPeaks): number {
  return peaks.channels.reduce((sum, channel) => sum + channel.byteLength, 0);
}
/**
 * 终止性失败的会话内记忆（只进内存、不落盘）：内容寻址的 key 上重试不会改变结果，
 * 组件重挂载不得重复触发一次完整下载 + 解码（异常与边界「同一会话内不自动重试」）。
 * 只记 `decode_failed` / `too_large`：`network` / `timeout` / `internal` 属环境问题，
 * 下次挂载仍重试（规则 2.7）。外部 URL 不记——URL 背后的内容可变（规则 3.5）。
 */
const failures = new Map<string, AudioPeaksFailure>();

/** 记一次终止性失败；与内存缓存同量级淘汰，长会话里反复失败的文件不会无限堆积 */
function rememberFailure(key: string, result: AudioPeaksFailure): void {
  failures.delete(key);
  failures.set(key, result);
  for (const oldest of failures.keys()) {
    if (failures.size <= MEMORY_ENTRY_LIMIT) break;
    failures.delete(oldest);
  }
}

/** 单飞表：同一 key 的并发请求合并为同一个 Promise（规则 1.3） */
const inflight = new Map<string, Promise<AudioPeaksResult>>();
/** 解码串行队列的队尾 */
let queueTail: Promise<unknown> = Promise.resolve();

/** 一次引用值解析的产物：缓存键 + 是否可落盘；取数、记账与失败记忆共用 */
interface PeaksTarget {
  key: string;
  persistable: boolean;
}

/**
 * 归一化缓存键（规则 1.1）：
 * - 托管值：`requestOf` 的存储 key（含 `userId` 前缀，天然按账号隔离）；
 * - 外部 `http(s)`：原值作键，只进内存；
 * - `blob:` / `data:` 及其他畸形值：不可缓存，也不解码。
 */
function peaksKeyOf(value: string): PeaksTarget | null {
  const request = requestOf(value, {});
  if (request) return { key: request.key, persistable: true };
  return /^https?:\/\//i.test(value) ? { key: value, persistable: false } : null;
}

/** 纯读（渲染期探测用）：不改 LRU 顺序——渲染可能被丢弃/重放，副作用不能留在渲染里 */
function memoryPeek(key: string): AudioPeaks | undefined {
  return memory.get(key);
}

function memoryGet(key: string): AudioPeaks | undefined {
  const hit = memory.get(key);
  if (hit === undefined) return undefined;
  // 命中移到队尾：LRU 淘汰时不会把刚用过的条目当成最旧项
  memory.delete(key);
  memory.set(key, hit);
  return hit;
}

function memorySet(key: string, peaks: AudioPeaks): void {
  failures.delete(key);
  const existing = memory.get(key);
  if (existing) {
    memoryBytes -= peaksBytes(existing);
    memory.delete(key);
  }
  memory.set(key, peaks);
  memoryBytes += peaksBytes(peaks);
  // 任一条数或字节超限就淘汰最旧条目；单条本身超限时连它一起淘汰，缓存保持有界
  for (const [oldestKey, oldestPeaks] of memory) {
    if (memory.size <= MEMORY_ENTRY_LIMIT && memoryBytes <= MEMORY_BYTE_LIMIT) break;
    memory.delete(oldestKey);
    memoryBytes -= peaksBytes(oldestPeaks);
  }
}

/**
 * 命中即刷新使用时刻（规则 3.4）：LRU 按「最近用过」而不是「最近解过」淘汰。
 * 只在 IndexedDB 命中时刷新会让本次会话反复使用的条目停留在解码时刻，
 * 下次会话的容量淘汰会先删掉它。
 */
function recordUse(target: PeaksTarget): void {
  if (target.persistable) void touchPeaks(target.key, Date.now());
}

/**
 * 解码串行：全局并发 1，FIFO（按进入解码队列的顺序，不按可见性重排，规则 1.4）。
 * 只有解码步骤进队列：取址、探测与下载在队列外并发，一个慢下载不得把其他文件的
 * 波形堵在它后面。失败不阻断后续任务。
 */
function enqueueDecode<T>(job: () => Promise<T>): Promise<T> {
  const run = queueTail.then(job);
  queueTail = run.catch(() => undefined);
  return run;
}

/**
 * 同步读内存缓存（渲染期探测，不触发网络、不读 IndexedDB）：
 * 已在本会话解过的文件首帧即可出波形，不闪一帧占位。
 */
export function peekAudioPeaks(value: string | null | undefined): AudioPeaks | null {
  if (!value) return null;
  const target = peaksKeyOf(value);
  return target ? (memoryPeek(target.key) ?? null) : null;
}

/**
 * 同步读失败记忆（渲染期探测）：本会话已确认不可解的托管值直接落为不可用，
 * 不闪一帧占位、也不再走一次取数。
 */
export function peekAudioPeaksFailure(value: string | null | undefined): AudioPeaksFailure | null {
  if (!value) return null;
  const target = peaksKeyOf(value);
  // 失败记忆只写托管 key（外部 URL 的内容可变，不入记忆），无需再判 persistable
  return target ? (failures.get(target.key) ?? null) : null;
}

/**
 * 记录一次使用（规则 3.4）。渲染期探测（`peekAudioPeaks`）必须保持纯读——渲染可能
 * 被丢弃或重放——因此命中后的使用时刻由消费方在提交阶段补记；外部 URL 只进内存，
 * 没有可刷新的持久记录。
 */
export function touchAudioPeaks(value: string): void {
  const target = peaksKeyOf(value);
  if (target) recordUse(target);
}

/**
 * 取音频峰值（唯一入口）。`value` 是逻辑引用值——存储 key、托管 URL 或外部
 * `http(s)` URL；不接受已解析的签名地址（规则 1.1）。
 *
 * 永不抛出：波形不可用是一种结果，调用方据 `status` 渲染占位。
 * 消费者卸载不会取消在途解码（规则 1.5）：结果照常入缓存。
 */
export function getAudioPeaks(value: string): Promise<AudioPeaksResult> {
  const target = peaksKeyOf(value);
  if (!target) return Promise.resolve({ status: "unavailable", duration: null, error: "unsupported" });

  const cached = memoryGet(target.key);
  if (cached) {
    recordUse(target);
    return Promise.resolve({ status: "ready", peaks: cached });
  }

  const remembered = target.persistable ? failures.get(target.key) : undefined;
  if (remembered) return Promise.resolve(remembered);

  const pending = inflight.get(target.key);
  if (pending) return pending;

  const load = (async (): Promise<AudioPeaksResult> => {
    try {
      if (target.persistable) {
        const record = await readPeaks(target.key);
        if (record) {
          const peaks: AudioPeaks = { channels: record.channels, duration: record.duration };
          memorySet(target.key, peaks);
          recordUse(target);
          return { status: "ready", peaks };
        }
      }

      const source = await loadAudioSource(value);
      const result: AudioPeaksResult =
        source.status === "loaded"
          ? await enqueueDecode(() => decodeAudioPeaks(source))
          : source;
      if (result.status !== "ready") {
        // 重挂载不在会话内重复付出一次下载 + 解码；环境类失败不入记忆，下次仍重试
        if (target.persistable && (result.error === "decode_failed" || result.error === "too_large")) {
          rememberFailure(target.key, result);
        }
        return result;
      }

      memorySet(target.key, result.peaks);
      if (target.persistable) {
        const now = Date.now();
        void writePeaks({
          key: target.key,
          channels: result.peaks.channels,
          duration: result.peaks.duration,
          savedAt: now,
          lastUsedAt: now,
        });
      }
      return result;
    } catch {
      // 「永不抛出」在这里兜底：取数链路上任何未预期异常（探测元素构造、解码队列
      // 机制等）都按环境类不可用返回，既不把拒绝抛给调用方，也不写终止性记忆
      return { status: "unavailable", duration: null, error: "internal" };
    }
  })().finally(() => {
    inflight.delete(target.key);
  });

  inflight.set(target.key, load);
  return load;
}
