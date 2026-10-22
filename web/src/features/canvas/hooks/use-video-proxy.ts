/**
 * 视频预览代理加载。
 *
 * 拖动播放头时用低分辨率短 GOP 副本做 scrub，seek 最多解码 1 秒画面。
 * 这里刻意不做「超时就放弃」的竞速：转码通常 1–3 秒，一旦放弃，url 就停在
 * null，切换 effect 不会再触发——本次会话再也用不上代理，用户只能一直拿长
 * GOP 的原视频拖动，而后端其实还在转，转完也白白落到缓存里等下次打开才命中。
 * 改成等请求自然完成：期间节点先用原视频 scrub，代理就绪后自动切过去，
 * swapVideoSource 会把当前时间点写回，切换不跳位。
 *
 * 面板卸载 / 换视频 / 手动重试都会中止在途请求（开发模式双挂载与快速开关面板
 * 不再白白发请求；服务端对被中止的搭车请求只退出等待，不影响仍在等待的生成）。
 * 外部 URL / 本地预览地址没有对应 key，不发起请求，节点继续用原视频 scrub。
 * 请求失败只有两种：本组件中止（忽略），或真实网络失败（进入 failed，可重试）。
 */
"use client";

import { storageKeyOf } from "@noxrea/shared/url";
import { useCallback, useEffect, useState } from "react";

import { fetchVideoProxy, type MediaRequestError, readMediaError } from "@/features/canvas/api/file-api";

export type VideoProxyStatus = "pending" | "ready" | "failed";

export interface VideoProxyState {
  /** pending = 首帧 / 换源 / 重试中；ready = 已定论（含无代理可用）；failed = 请求失败，可重试 */
  status: VideoProxyStatus;
  /** 代理访问 URL；无代理（外部 URL / 空响应）时为 null */
  url: string | null;
  /** 代理副本时长（秒）：源容器标称时长不可信时用于补齐轨道时长 */
  duration: number | null;
  error: MediaRequestError | null;
}

/** 已定论结果带来源与重试代数：与当前输入不一致即视为 pending，无需在 effect 里同步清空 */
interface SettledProxy extends VideoProxyState {
  src: string;
  attempt: number;
}

const PENDING: VideoProxyState = { status: "pending", url: null, duration: null, error: null };
/** 非 key 源（外部 URL / 本地预览）的定论：没有代理可用，且不是请求失败，无处重试 */
const NO_PROXY: VideoProxyState = { status: "ready", url: null, duration: null, error: null };

/**
 * 按引用值加载视频代理。换视频源或重试时旧结果立即失效（派生为 pending），
 * 避免旧源代理被新源沿用；retry 重新发起请求，markFailed 供消费方上报
 * 「代理可下载但浏览器解码不了」（无 error：重试同一份缓存产物不会成功）。
 */
export function useVideoProxy(videoRef: string): VideoProxyState & {
  retry: () => void;
  markFailed: () => void;
} {
  const [settled, setSettled] = useState<SettledProxy | null>(null);
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((a) => a + 1), []);
  const markFailed = useCallback(() => {
    setSettled((s) => (s?.status === "ready" ? { ...s, status: "failed" } : s));
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    const videoKey = storageKeyOf(videoRef);

    const request: Promise<VideoProxyState | undefined> = videoKey
      ? fetchVideoProxy(videoKey, controller.signal)
          .then(async (res): Promise<VideoProxyState> => {
            if (!res.ok) {
              return { status: "failed", url: null, duration: null, error: await readMediaError(res) };
            }
            const json = (await res.json()) as { data?: { url?: string; duration?: number } };
            // key 请求成功却缺 url 属响应契约破坏：按失败处理（无错误码，重试无意义），
            // 与编辑响应缺 key 的判定同形，不静默停在「无代理」定论上
            if (!json.data?.url) {
              return { status: "failed", url: null, duration: null, error: null };
            }
            return {
              status: "ready",
              url: json.data.url,
              duration: json.data.duration ?? null,
              error: null,
            };
          })
          .catch((): VideoProxyState | undefined => {
            if (controller.signal.aborted) return undefined;
            return {
              status: "failed",
              url: null,
              duration: null,
              error: { code: "network_error", retryAfterSeconds: null, receivedAt: Date.now() },
            };
          })
      : Promise.resolve(NO_PROXY);

    void request.then((outcome) => {
      if (cancelled || outcome === undefined) return;
      setSettled({ ...outcome, src: videoRef, attempt });
    });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [videoRef, attempt]);

  const current = settled?.src === videoRef && settled.attempt === attempt;
  const state: VideoProxyState = current
    ? { status: settled.status, url: settled.url, duration: settled.duration, error: settled.error }
    : PENDING;
  return { ...state, retry, markFailed };
}
