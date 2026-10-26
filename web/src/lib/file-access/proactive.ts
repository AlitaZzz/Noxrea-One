/**
 * signed 描述的主动刷新调度（specs/storage-signed-direct-delivery.md 规则 3.8）。
 *
 * 所有 Hook 共用一个定时器与唤醒监听：同一到期时刻的媒体在一次任务里触发，
 * 解析层的同拍合并仍能把它们组成一个批量描述。每个 Hook 各自 `setTimeout`
 * 会让浏览器逐个任务触发，把批次打散成 N 个单条请求。
 *
 * 抖动是会话级的：同一页面的媒体共享一个偏移，仍能合并；不同标签页/用户
 * 各自随机，避免所有客户端在寿命 80% 的同一时刻形成请求尖峰。
 */
import { EXPIRY_SKEW_MS } from "./protocol";

/** 失效前的安全余量：不在最后一刻刷新 */
const EXPIRY_SAFETY_MS = 5_000;
/** setTimeout 的上界（2^31-1 ms） */
const MAX_TIMER_DELAY_MS = 2_147_483_647;
/** 后台刷新失败后的首次退避 */
const RETRY_BASE_DELAY_MS = 30_000;
/** 后台刷新失败的退避上界 */
const RETRY_MAX_DELAY_MS = 5 * 60_000;

/** 主动刷新只需要寿命字段；`delivery` 由调用方保证是 signed */
export interface RefreshTiming {
  expiresAt: number;
  refreshAt?: number;
}

interface Entry {
  dueAt: number;
  run: () => void;
}

const entries = new Set<Entry>();
let timer: ReturnType<typeof setTimeout> | null = null;
let timerDue = Number.POSITIVE_INFINITY;
let jitterRatio: number | null = null;
let listening = false;

/**
 * 会话级抖动系数 [-1, 1]。按 `refreshAt → expiresAt` 的余量缩放，取余量的一半
 * 即寿命的 ±10%（当前 `refreshAt` = 寿命 80%）。同一会话共享系数，页面内多个
 * 媒体仍在同一时刻批量刷新；不同会话独立随机。
 */
function sessionJitterRatio(): number {
  if (jitterRatio === null) jitterRatio = Math.random() * 2 - 1;
  return jitterRatio;
}

/** 计划主动刷新时刻；已临近失效时返回 null（交给元素失败路径） */
export function proactiveRefreshAt(
  timing: RefreshTiming,
  now: number,
  jitter: number = sessionJitterRatio(),
): number | null {
  const expiresAtMs = timing.expiresAt * 1000;
  if (expiresAtMs <= now + EXPIRY_SAFETY_MS) return null;
  const refreshAtMs = timing.refreshAt !== undefined
    ? timing.refreshAt * 1000
    : expiresAtMs - EXPIRY_SKEW_MS;
  const margin = Math.max(0, expiresAtMs - refreshAtMs);
  const dueAt = refreshAtMs + (jitter * margin) / 2;
  // 不早于现在（描述本身已过建议时刻则立即补一次），不晚于失效前安全线
  return Math.min(Math.max(dueAt, now), expiresAtMs - EXPIRY_SAFETY_MS);
}

/** 后台刷新失败的退避时刻：30s 起指数增长、5min 封顶，最晚到失效前安全线 */
export function backgroundRetryAt(expiresAt: number, attempts: number, now: number): number | null {
  const deadline = expiresAt * 1000 - EXPIRY_SAFETY_MS;
  if (deadline <= now) return null;
  const delay = Math.min(
    RETRY_BASE_DELAY_MS * 2 ** Math.min(Math.max(0, attempts - 1), 10),
    RETRY_MAX_DELAY_MS,
  );
  return Math.min(now + delay, deadline);
}

function stopTimer(): void {
  if (timer !== null) clearTimeout(timer);
  timer = null;
  timerDue = Number.POSITIVE_INFINITY;
}

function onVisibilityChange(): void {
  if (typeof document !== "undefined" && document.visibilityState === "visible") runDue();
}

function startListening(): void {
  if (listening || typeof window === "undefined" || typeof document === "undefined") return;
  listening = true;
  window.addEventListener("focus", runDue);
  window.addEventListener("online", runDue);
  document.addEventListener("visibilitychange", onVisibilityChange);
}

function stopListening(): void {
  if (!listening || typeof window === "undefined" || typeof document === "undefined") return;
  listening = false;
  window.removeEventListener("focus", runDue);
  window.removeEventListener("online", runDue);
  document.removeEventListener("visibilitychange", onVisibilityChange);
}

/** 按最早到期项重排共享定时器；没有注册项时释放定时器与监听 */
function arm(): void {
  if (entries.size === 0) {
    stopTimer();
    stopListening();
    return;
  }
  let earliest = Number.POSITIVE_INFINITY;
  for (const entry of entries) {
    if (entry.dueAt < earliest) earliest = entry.dueAt;
  }
  // 现有定时器不晚于最早到期项：保留，避免每次注册都重排
  if (timer !== null && timerDue <= earliest) return;
  stopTimer();
  timerDue = earliest;
  timer = setTimeout(fire, Math.min(Math.max(0, earliest - Date.now()), MAX_TIMER_DELAY_MS));
  startListening();
}

function fire(): void {
  timer = null;
  timerDue = Number.POSITIVE_INFINITY;
  runDue();
}

/**
 * 运行所有已到期项。回调在同一任务内执行，解析层据此把多个媒体的强制刷新
 * 合并成一次批量描述。
 */
function runDue(): void {
  const now = Date.now();
  const due: Entry[] = [];
  for (const entry of entries) {
    if (entry.dueAt <= now) {
      entries.delete(entry);
      due.push(entry);
    }
  }
  for (const entry of due) entry.run();
  // 到期项可能被取消（arm 会保留仍更早的旧定时器）：这里必须无条件重排，
  // 否则旧定时器触发一次空批次后，剩余项会一直搁浅到下次注册或唤醒事件
  arm();
}

/**
 * 注册一个主动刷新任务，返回取消函数。到期项由共享定时器统一触发；
 * 同一时刻的多个 Hook 因此落在同一个任务里。
 */
export function scheduleProactiveRefresh(dueAt: number, run: () => void): () => void {
  const entry: Entry = { dueAt, run };
  entries.add(entry);
  arm();
  return () => {
    if (entries.delete(entry)) arm();
  };
}

/** 会话切换：清空调度与抖动系数（旧账号的定时器不得在新会话触发） */
export function resetProactiveRefresh(): void {
  entries.clear();
  stopTimer();
  stopListening();
  jitterRatio = null;
}
