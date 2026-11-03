/**
 * 视频预览代理加载。
 *
 * 拖动播放头时用低分辨率短 GOP 副本做 scrub，seek 最多解码 1 秒画面。
 * 请求悬挂到客户端超时即进入 failed 并允许手动重试：服务端全量完整性校验 +
 * 转码可能超过一分钟，不能无限停在 pending；若服务端其实已生成，重试会直接
 * 命中产物，不会重复转码。超时只中止本次等待，服务端对已断开的搭车请求只退出
 * 等待，不影响仍在等待的生成。
 *
 * 面板卸载 / 换视频 / 手动重试都会中止在途请求（开发模式双挂载与快速开关面板
 * 不再白白发请求）。外部 URL / 本地预览地址没有对应 key，不发起请求；
 * 面板的 scrub 闸门要求代理就绪，因此这两类源仍不可拖动。
 * 请求失败只有三种：本组件中止（忽略）、真实网络失败、等待超时（后两者进入
 * failed，可重试）。
 */
"use client";

import { storageKeyOf } from "@noxrea/shared/url";
import { useCallback, useEffect, useState } from "react";

import { fetchVideoProxy, type MediaRequestError, networkError, readMediaError } from "@/features/canvas/api/file-api";
import { resolveMediaUrlString } from "@/lib/file-access";

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
 * 客户端等待上限：按「用户愿意为一个面板等多久」设定，不是服务端预算的保证。
 * 服务端最坏路径（源下载 + 重型池排队 + 完整性校验 60s + 重型池排队 + 代理转码
 * 60s + 元数据探测）可以超过该值。超时与网络失败同态（failed + 可重试），
 * 不能无限停在 pending：重试要么命中已发布产物，要么重新发起 / 加入在途生成。
 */
const PROXY_TIMEOUT_MS = 150_000;

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
    const timer = setTimeout(() => {
      if (cancelled) return;
      setSettled({
        status: "failed",
        url: null,
        duration: null,
        error: networkError(),
        src: videoRef,
        attempt,
      });
      controller.abort();
    }, PROXY_TIMEOUT_MS);
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
            // 响应里的 url 是逻辑托管 URL（`/api/files/_proxy/...`），必须经访问解析层
            // 换成最终地址（S3 为签名直连，字节不回流应用）；解析失败含一次重新描述，
            // 仍失败按代理失败处理——面板保持禁用（不退回原视频长 GOP scrub），
            // 也不把必然 401/403 的地址交给元素
            const proxyUrl = await resolveMediaUrlString(json.data.url).catch(() => null);
            if (!proxyUrl) {
              return { status: "failed", url: null, duration: null, error: networkError() };
            }
            return {
              status: "ready",
              url: proxyUrl,
              duration: json.data.duration ?? null,
              error: null,
            };
          })
          .catch((): VideoProxyState | undefined => {
            if (controller.signal.aborted) return undefined;
            return { status: "failed", url: null, duration: null, error: networkError() };
          })
      : Promise.resolve(NO_PROXY);

    void request.then((outcome) => {
      clearTimeout(timer);
      // 已超时/卸载后迟到的响应不得把 failed 翻回 ready：请求已中止，结论已定
      if (cancelled || controller.signal.aborted || outcome === undefined) return;
      setSettled({ ...outcome, src: videoRef, attempt });
    });
    return () => {
      cancelled = true;
      clearTimeout(timer);
      controller.abort();
    };
  }, [videoRef, attempt]);

  const current = settled?.src === videoRef && settled.attempt === attempt;
  const state: VideoProxyState = current
    ? { status: settled.status, url: settled.url, duration: settled.duration, error: settled.error }
    : PENDING;
  return { ...state, retry, markFailed };
}
