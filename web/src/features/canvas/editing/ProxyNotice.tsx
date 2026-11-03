/**
 * 预览代理未就绪 / 缓冲中 / 失败时的轨道居中提示。
 *
 * 两个面板的禁用原因都是「代理不可播放」，但重试入口的位置不同：帧序列面板在
 * 轨道底部保留可重试原因条，中央只放不可操作的文字说明；片段截取面板没有底条，
 * 重试按钮直接放在中央。状态判定收敛到这里，避免两处各写一套分支后逐渐漂移。
 */
"use client";

import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import type { MediaRequestError } from "@/features/canvas/api/file-api";
import type { VideoProxyStatus } from "@/features/canvas/hooks/use-video-proxy";

import { MediaRetryNotice } from "./MediaRetryNotice";
import { TrackNotice } from "./TrackNotice";

type ProxyNotice =
  | { kind: "retry"; error: MediaRequestError }
  | { kind: "text"; key: "clip.proxyUnavailable" | "clip.proxyLoading" | "clip.buffering" };

type TextProxyNotice = Extract<ProxyNotice, { kind: "text" }>;

/**
 * 中央提示判定；playable 为 true（代理可下载且浏览器已 canplay）时没有提示。
 * 不能用 status === "ready" 代替 playable：ready 只代表产物可下载，解锁交互
 * 还要求浏览器已缓冲，缓冲期同样要给出说明。
 */
export function proxyNoticeOf(state: {
  status: VideoProxyStatus;
  url: string | null;
  playable: boolean;
  error: MediaRequestError | null;
}): ProxyNotice | null {
  if (state.playable) return null;
  if (state.status === "failed") {
    return state.error
      ? { kind: "retry", error: state.error }
      : { kind: "text", key: "clip.proxyUnavailable" };
  }
  if (state.status === "pending") return { kind: "text", key: "clip.proxyLoading" };
  // ready 但尚不可播放：没有代理地址（非 key 源）与等待缓冲是两种不同结论
  return { kind: "text", key: state.url === null ? "clip.proxyUnavailable" : "clip.buffering" };
}

/**
 * 把可重试失败降为文字说明：带错误码的失败由调用方在底部原因条给重试，
 * 同一失败不在两个位置各放一个重试按钮。
 */
export function demoteRetryNotice(notice: ProxyNotice | null): TextProxyNotice | null {
  return notice?.kind === "retry" ? { kind: "text", key: "clip.proxyUnavailable" } : notice;
}

function ProxyNoticeFrame({ children }: { children: ReactNode }) {
  return (
    <div className="pointer-events-none absolute inset-0 z-40 flex items-center justify-center">
      {children}
    </div>
  );
}

/** 仅文字提示的居中层：可重试失败由面板其他位置提供重试入口 */
export function ProxyNoticeTextOverlay({ notice }: { notice: TextProxyNotice | null }) {
  const { t } = useTranslation();
  if (!notice) return null;
  return (
    <ProxyNoticeFrame>
      <TrackNotice>{t(notice.key)}</TrackNotice>
    </ProxyNoticeFrame>
  );
}

/** 完整居中提示层：带错误码的失败在中央提供重试 */
export function ProxyNoticeOverlay({ notice, onRetry }: { notice: ProxyNotice | null; onRetry: () => void }) {
  if (!notice) return null;
  if (notice.kind === "text") return <ProxyNoticeTextOverlay notice={notice} />;
  return (
    <ProxyNoticeFrame>
      <MediaRetryNotice error={notice.error} onRetry={onRetry} />
    </ProxyNoticeFrame>
  );
}
