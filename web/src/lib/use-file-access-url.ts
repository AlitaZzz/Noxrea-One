"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  type FileDelivery,
  isAbortError,
  isManagedMediaValue,
  isTransientDescriptorFailure,
  peekMediaAccess,
  resolveMediaAccess,
} from "@/lib/file-access";
import {
  backgroundRetryAt,
  proactiveRefreshAt,
  type RefreshTiming,
  scheduleProactiveRefresh,
} from "@/lib/file-access/proactive";
import { onSessionChange } from "@/lib/session-lifecycle";

export interface FileAccessUrlState {
  /** 可用的最终媒体地址；解析中/失败时为 undefined */
  url: string | undefined;
  delivery?: FileDelivery;
  /** 描述请求失败（网络 / 404 / 503 等），由调用方展示失败态 */
  failed: boolean;
  /** 跳过缓存重新描述；媒体元素 403/404 时调用一次（规则 3.6） */
  refresh: () => Promise<string | undefined>;
  /**
   * 规则 3.6 的媒体元素失败重试：signed 地址失败时优先使用规则 3.8 后台刷新
   * 得到的新鲜地址；没有可用新地址时重新描述一次，返回最终地址。
   * 未重试时返回 `null`：stream / 外部地址（同一地址重试不会改变结果）、该失败地址的
   * 重试预算已用尽（同一地址只重描述一次；重新签发得到新地址或换源后重新武装）
   * 或重描述失败。
   * 返回值用于区分「地址已换」与「同一签名窗口」：地址变化时新地址会自行生效，
   * 只有地址未变才需要调用方重试同一加载。
   */
  retrySigned: () => Promise<string | null>;
  /**
   * 重挂令牌：`retrySigned` 成功重新描述后 +1。媒体元素以它作为 `key`，刷新后即使
   * 签出的地址未变（同一签名窗口）也会重新走一次加载；调用方不得自行再维护重试闩锁。
   */
  reloadToken: number;
}

interface ResolvedState {
  source: string;
  url: string;
  delivery?: FileDelivery;
  expiresAt?: number;
  refreshAt?: number;
}

/**
 * 强制刷新的内部结算。失败与取消必须分开：重试预算只对「失败」消耗，
 * 换源 / 卸载 / 会话切换的取消不应让同一地址重新获得一次描述。
 */
type RefreshOutcome =
  | { type: "resolved"; url: string }
  | { type: "failed" }
  | { type: "cancelled" };

/**
 * 托管媒体访问 Hook（specs/storage-signed-direct-delivery.md 规则 3）。
 *
 * 外部 http(s) / data: / blob: 原样返回；托管值经统一解析服务换取最终地址。
 * `value` 可以是存储 key，也可以是带 `?w=`/`download` 的逻辑托管 URL。
 *
 * signed 描述在 `refreshAt` 后主动刷新（规则 3.8）：后台只更新缓存与「新鲜地址」
 * 槽，不替换已挂载元素的地址——在寿命 80% 时换 `src` 会让所有图片/视频重新下载
 * 并打断播放。元素失败时 `retrySigned` 先使用该新鲜地址，没有再走强制重描述。
 */
export function useFileAccessUrl(value: string | null | undefined): FileAccessUrlState {
  const managed = !!value && isManagedMediaValue(value);
  const [state, setState] = useState<ResolvedState | null>(null);
  // 失败按「源 + 尝试序号」记账：新源或新的 refresh 请求自动让旧失败态失效
  const [failedAttempt, setFailedAttempt] = useState<{ source: string; attempt: number } | null>(null);
  const [scope, setScope] = useState(0);
  // 最近一次 refresh 的目标源与序号：源切换不继承强制刷新语义
  const [refreshRequest, setRefreshRequest] = useState<{ source: string; tick: number } | null>(null);
  const pendingRef = useRef(new Set<(outcome: RefreshOutcome) => void>());
  // 规则 3.6 重试闩锁：按「逻辑源 + 失败地址」记录。同一地址只重新描述一次
  // （同一签名窗口内重签得到同一地址，再刷新不会改变结果）；重新签发得到新地址
  // 或换源后重新武装，长会话的第二次过期仍享有一次重描述。
  const retriedRef = useRef<{ source: string; url: string } | null>(null);
  // 规则 3.8 主动刷新得到的新鲜地址：只给元素失败路径使用，不参与渲染
  const proactiveRef = useRef<{
    source: string;
    url: string;
    expiresAt: number;
    refreshAt?: number;
  } | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  // 源已切换：上一次 refresh 的强制刷新语义作废（React「依据 props 调整 state」写法）
  if (refreshRequest && refreshRequest.source !== value) setRefreshRequest(null);
  const attempt = refreshRequest && refreshRequest.source === value ? refreshRequest.tick : 0;

  // 缓存命中在渲染期直接出图：stream 形态与 signed 缓存条目都无需再发描述请求，也不闪一帧骨架
  if (managed && value && state?.source !== value) {
    const peeked = peekMediaAccess(value);
    if (peeked) {
      setState({
        source: value,
        url: peeked.url,
        delivery: peeked.delivery,
        expiresAt: peeked.expiresAt,
        refreshAt: peeked.refreshAt,
      });
    }
  }

  // 账号切换：丢弃展示结果并重新解析（内存缓存已由解析服务清空）。
  // 重试闩锁同属会话作用域：新账号下同一逻辑源的失败是一次独立失败，享有一次重试
  useEffect(
    () => onSessionChange(() => {
      setState(null);
      setFailedAttempt(null);
      setRefreshRequest(null);
      retriedRef.current = null;
      proactiveRef.current = null;
      setScope((current) => current + 1);
    }),
    [],
  );

  // 等待 refresh 的调用方必须拿到确定结果：源切换（旧源的重新描述不可能再被 effect
  // 执行）与卸载时都以 `undefined` 结算，否则 Promise 会悬挂到组件卸载为止
  useEffect(
    () => () => {
      for (const resolve of pendingRef.current) resolve({ type: "cancelled" });
      pendingRef.current.clear();
    },
    [value],
  );

  useEffect(() => {
    if (!managed || !value) return;
    const source = value;
    const forceRefresh = attempt > 0;

    const settle = (outcome: RefreshOutcome) => {
      for (const resolve of pendingRef.current) resolve(outcome);
      pendingRef.current.clear();
    };

    // 渲染期缓存命中已出图（规则 3.4 / signed 缓存）：不重复描述
    if (!forceRefresh && peekMediaAccess(source)) return;

    const controller = new AbortController();
    void resolveMediaAccess(source, {
      forceRefresh,
      signal: controller.signal,
    }).then(
      (resolved) => {
        if (controller.signal.aborted) return;
        setState({
          source,
          url: resolved.url,
          delivery: resolved.delivery,
          expiresAt: resolved.expiresAt,
          refreshAt: resolved.refreshAt,
        });
        // 成功即收敛：同一源上一次尝试的失败态作废（账号切换后的重新解析、手动重试
        // 成功都走这里）。失败态与展示态分仓记账，成功不清理就会让失败态粘住。
        setFailedAttempt((current) => (current?.source === source ? null : current));
        settle({ type: "resolved", url: resolved.url });
      },
      (error) => {
        if (controller.signal.aborted) return;
        // 取消不是失败：会话切换时解析层会以 AbortError 结算在途请求，而组件的
        // abort 要等到 effect 重跑才发生——不在这里拦掉就会把「被取消」记成失败
        if (isAbortError(error)) return;
        setFailedAttempt({ source, attempt });
        settle({ type: "failed" });
      },
    );

    return () => controller.abort();
  }, [managed, value, scope, attempt]);

  // 先判 state 非空：value 为空时 `state?.source === value` 也成立，直接读字段会崩
  const signedState = state
    && state.source === value
    && state.delivery === "signed"
    && state.expiresAt !== undefined
    ? state
    : null;
  const signedUrl = signedState?.url;
  const signedExpiresAt = signedState?.expiresAt;
  const signedRefreshAt = signedState?.refreshAt;

  // 换源：旧源后台刷新的新鲜地址不再适用
  useEffect(() => {
    proactiveRef.current = null;
  }, [value]);

  /**
   * 规则 3.8 主动刷新：从当前 signed 描述出发，到点后后台重新描述。
   * 结果只进缓存与 `proactiveRef`，不 setState（不打断已挂载媒体）；成功后按
   * 新描述的 `refreshAt` 继续下一轮，失败按指数退避重试到当前地址失效。
   */
  useEffect(() => {
    if (!managed || !value) return;
    if (signedUrl === undefined || signedExpiresAt === undefined) return;
    const source = value;
    let timing: RefreshTiming = {
      expiresAt: signedExpiresAt,
      ...(signedRefreshAt !== undefined ? { refreshAt: signedRefreshAt } : {}),
    };
    let attempts = 0;
    let cancelled = false;
    let controller: AbortController | null = null;
    let cancelSchedule: (() => void) | null = null;

    function plan(retry: boolean): void {
      cancelSchedule?.();
      cancelSchedule = null;
      const now = Date.now();
      const dueAt = retry
        ? backgroundRetryAt(timing.expiresAt, attempts, now)
        : proactiveRefreshAt(timing, now);
      if (dueAt === null) return;
      cancelSchedule = scheduleProactiveRefresh(dueAt, run);
    }

    function run(): void {
      cancelSchedule = null;
      if (cancelled) return;
      controller = new AbortController();
      const attemptedExpiresAt = timing.expiresAt;
      void resolveMediaAccess(source, { forceRefresh: true, signal: controller.signal }).then(
        (next) => {
          if (cancelled) return;
          if (next.delivery !== "signed" || next.expiresAt === undefined) return;
          // 服务端未推进寿命（时钟异常 / 中间层缓存）：不再循环刷新，交给元素失败路径
          if (next.expiresAt <= attemptedExpiresAt) return;
          proactiveRef.current = {
            source,
            url: next.url,
            expiresAt: next.expiresAt,
            ...(next.refreshAt !== undefined ? { refreshAt: next.refreshAt } : {}),
          };
          timing = {
            expiresAt: next.expiresAt,
            ...(next.refreshAt !== undefined ? { refreshAt: next.refreshAt } : {}),
          };
          attempts = 0;
          // 新描述的建议时刻仍在过去（客户端时钟超前）：立即再刷会形成请求自旋，
          // 停止循环，交给元素失败路径
          const dueAt = proactiveRefreshAt(timing, Date.now());
          if (dueAt === null || dueAt <= Date.now()) return;
          plan(false);
        },
        (error: unknown) => {
          // 主动刷新失败不进入失败态：当前地址通常仍可用，元素真失败时再走规则 3.6。
          // 终态失败（401 / 404 / 429 / 503）重试不会改变结果，只对瞬时故障退避重试。
          if (cancelled || isAbortError(error)) return;
          if (!isTransientDescriptorFailure(error)) return;
          attempts += 1;
          plan(true);
        },
      );
    }

    plan(false);
    return () => {
      cancelled = true;
      controller?.abort();
      cancelSchedule?.();
    };
  }, [managed, value, scope, signedUrl, signedExpiresAt, signedRefreshAt]);

  /** 内部刷新请求：保留失败 / 取消的区别，供 `retrySigned` 记账 */
  const requestRefresh = useCallback((): Promise<RefreshOutcome> => {
    if (!value) return Promise.resolve({ type: "cancelled" });
    return new Promise<RefreshOutcome>((resolve) => {
      pendingRef.current.add(resolve);
      setRefreshRequest((current) => ({
        source: value,
        tick: (current?.tick ?? 0) + 1,
      }));
    });
  }, [value]);

  const refresh = useCallback((): Promise<string | undefined> => {
    if (!value) return Promise.resolve(undefined);
    if (!managed) return Promise.resolve(value);
    return requestRefresh().then((outcome) => (
      outcome.type === "resolved" ? outcome.url : undefined
    ));
  }, [value, managed, requestRefresh]);

  const retrySigned = useCallback(async (): Promise<string | null> => {
    if (!value || !managed) return null;
    // delivery 未解析出来时（描述本身失败）不重试加载：重试加载只会再失败一次，
    // 用户可点的 refresh 才是那条路径的入口
    const current = state?.source === value ? state : null;
    if (current?.delivery !== "signed" || !current.url) return null;
    // 规则 3.8 的后台刷新已拿到更晚失效的地址：直接切过去，不再发描述请求。
    // 必须在重试闩锁之前判断——失败地址即使已用完预算，新地址仍应生效。
    const proactive = proactiveRef.current;
    if (
      proactive?.source === value
      && proactive.url !== current.url
      && proactive.expiresAt > (current.expiresAt ?? 0)
      && proactive.expiresAt * 1000 > Date.now()
    ) {
      retriedRef.current = { source: value, url: current.url };
      proactiveRef.current = null;
      setState({
        source: value,
        url: proactive.url,
        delivery: "signed",
        expiresAt: proactive.expiresAt,
        refreshAt: proactive.refreshAt,
      });
      // 换到可用地址即收敛：此前的描述失败态作废（与解析成功路径一致）
      setFailedAttempt((current) => (current?.source === value ? null : current));
      setReloadToken((token) => token + 1);
      return proactive.url;
    }
    if (proactive?.source === value) proactiveRef.current = null;
    // 重试预算按失败地址计：同一地址只重描述一次（同一签名窗口重签不会改变结果），
    // 新地址（新一轮过期）或换源后重新获得一次预算，避免长会话第二次过期直接进入失败态。
    if (retriedRef.current?.source === value && retriedRef.current.url === current.url) return null;
    retriedRef.current = { source: value, url: current.url };
    const outcome = await requestRefresh();
    if (outcome.type === "cancelled") {
      // 换源 / 卸载 / 会话切换：这次尝试没有消耗重试预算
      retriedRef.current = null;
      return null;
    }
    // 重新描述失败同样消耗该地址的预算：否则同一地址会在每次元素失败时重复描述，
    // 违反规则 3.6「同一签名地址只重新解析一次」；失败态由 effect 的 failedAttempt 提供
    if (outcome.type === "failed") return null;
    setReloadToken((token) => token + 1);
    return outcome.url;
  }, [managed, requestRefresh, state, value]);

  if (!value) return { url: undefined, failed: false, refresh, retrySigned, reloadToken };
  if (!managed) return { url: value, failed: false, refresh, retrySigned, reloadToken };

  const resolved = state?.source === value ? state : null;
  return {
    url: resolved?.url,
    delivery: resolved?.delivery,
    failed: failedAttempt?.source === value && failedAttempt.attempt === attempt,
    refresh,
    retrySigned,
    reloadToken,
  };
}
