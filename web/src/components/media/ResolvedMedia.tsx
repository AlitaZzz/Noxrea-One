"use client";

/**
 * 已解析媒体元素（specs/storage-signed-direct-delivery.md 规则 3.5 / 3.6）。
 *
 * 托管引用值先经访问解析层换成最终地址，再渲染 `<img>` / `<video>`：
 * - 外部 http(s) / data: / blob: 原样使用；逻辑 URL 上的 `?w=` / `#t=` 原样保留；
 * - 地址未就绪时不渲染元素（不发空 `src` 请求、不闪一帧坏图），由 `fallback` 承接；
 * - 元素加载失败时按规则 3.6 重新描述一次（Hook 按源闩锁，不会无限重试），
 *   成功后以 `reloadToken` 重挂元素——签名地址未变时也会重新加载；
 * - 无引用值 / 描述失败 / 重试用尽时渲染 `fallback`。
 *
 * `fallback` 以函数形态接收 `{ failed, retry }`：描述失败没有媒体元素可挂 `onError`，
 * 重试入口只能由调用方放在替代内容里（`retry` 走 `refresh` 强制重新描述）。装饰性
 * 缩略图保持静态替代内容即可；预览等「媒体即内容」的场景用 `failed` 区分解析中与失败，
 * 失败时渲染 `MediaAccessError`。失败态与元素重试都由本组件接线，调用方不再各自维护。
 */
import type { ImgHTMLAttributes, ReactNode, VideoHTMLAttributes } from "react";
import { useCallback, useState } from "react";

import { withManagedFileWidth } from "@/lib/file-url";
import { useFileAccessUrl } from "@/lib/use-file-access-url";

import { MediaAccessError } from "./MediaAccessError";

/** 替代内容的状态：`failed` 为真表示解析/加载已失败（可由 `retry` 重试），否则仍在解析 */
export interface MediaFallbackState {
  failed: boolean;
  /** 强制重新描述访问地址（规则 3.6 的手动重试入口）；仅在托管值上有效 */
  retry: () => void;
}

interface ResolvedMediaProps {
  /** 逻辑引用值：存储 key 或托管 URL；外部地址原样使用 */
  value: string | null | undefined;
  /** 派生缩略宽度（`?w=`），仅对托管值生效；以本参数为准覆盖逻辑 URL 上的档位 */
  width?: number;
  /**
   * 无可用媒体时渲染的替代内容（无引用值 / 解析中 / 描述失败 / 加载失败）；缺省不渲染。
   * 函数形态可按失败态决定外观并提供重试入口。
   */
  fallback?: ReactNode | ((state: MediaFallbackState) => ReactNode);
}

type ResolvedImageProps = ResolvedMediaProps
  & Omit<ImgHTMLAttributes<HTMLImageElement>, "src" | "width" | "alt"> & {
    /** 替代文本：装饰性缩略图传空串，语义缩略图传可读描述 */
    alt: string;
  };

/** 视频海报的档位已由逻辑 URL 的 `?w=` 表达（宽度只有一个来源），不再接受 width 覆盖 */
type ResolvedVideoProps = Omit<ResolvedMediaProps, "width">
  & Omit<VideoHTMLAttributes<HTMLVideoElement>, "src" | "width">;

/**
 * 解析状态与失败记账。
 *
 * 失败按**最终地址**记录：地址一变（换源、重描述成功、账号切换后重解析）失败态
 * 自动复位；同一地址在重试用尽后再次失败则保持失败，避免反复重试。
 */
function useResolvedMedia(value: string | null | undefined, width: number | undefined) {
  const logical = width !== undefined && value ? withManagedFileWidth(value, width) : value;
  const { url, failed, refresh, retrySigned, reloadToken } = useFileAccessUrl(logical);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);

  const handleError = useCallback(() => {
    void retrySigned().then((refreshed) => {
      // 重描述成功时地址或重挂令牌已更新，元素随即重新加载；失败则停留在失败态
      if (refreshed === null) setFailedUrl(url ?? null);
    });
  }, [retrySigned, url]);

  const retry = useCallback(() => {
    // 失败按地址记账：手动重试先清掉加载失败标记，再强制重新描述；
    // 描述失败（无地址）由 Hook 的 failed 反映，重试后自动重解析
    setFailedUrl(null);
    void refresh();
  }, [refresh]);

  const loadFailed = url !== undefined && url === failedUrl;
  return {
    /** 可用的最终地址：尚未解析出或加载已判定失败时为 undefined */
    url: loadFailed ? undefined : url,
    reloadToken,
    handleError,
    retry,
    failed: failed || loadFailed,
  };
}

/**
 * 「媒体即内容」场景的替代内容（规则 3.6）：描述失败时就地给重试入口，解析中保持空白。
 * 预览类调用方的接线完全相同，统一在这里提供，避免每处各写一段内联函数。
 */
export function accessFailedFallback({ failed, retry }: MediaFallbackState): ReactNode {
  return failed ? <MediaAccessError onRetry={retry} /> : null;
}

function renderFallback(
  fallback: ResolvedMediaProps["fallback"],
  state: MediaFallbackState,
): ReactNode {
  return typeof fallback === "function" ? fallback(state) : fallback;
}

export function ResolvedImage({
  value,
  width,
  fallback = null,
  alt,
  onError,
  ...props
}: ResolvedImageProps) {
  const { url, reloadToken, handleError, retry, failed } = useResolvedMedia(value, width);
  if (!url) return renderFallback(fallback, { failed, retry });
  return (
    // 媒体地址是解析后的动态/外部 URL，缩放由文件服务的 ?w= 参数负责，不走 next/image
    // eslint-disable-next-line @next/next/no-img-element
    <img
      {...props}
      key={reloadToken}
      src={url}
      alt={alt}
      onError={(event) => {
        handleError();
        onError?.(event);
      }}
    />
  );
}

export function ResolvedVideo({
  value,
  fallback = null,
  onError,
  ...props
}: ResolvedVideoProps) {
  const { url, reloadToken, handleError, retry, failed } = useResolvedMedia(value, undefined);
  if (!url) return renderFallback(fallback, { failed, retry });
  return (
    <video
      {...props}
      key={reloadToken}
      src={url}
      onError={(event) => {
        handleError();
        onError?.(event);
      }}
    />
  );
}
