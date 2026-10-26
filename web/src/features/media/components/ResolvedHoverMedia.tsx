"use client";

/**
 * 悬浮大图的懒解析包装（specs/storage-signed-direct-delivery.md 规则 3.5 / 3.6）。
 *
 * `HoverCardMediaContent` 只接收最终地址、不感知访问解析（UI 层契约），解析因此留在
 * feature 层。但解析**不能**随卡片挂载就发生：网格里每张卡都持有一个悬浮预览，
 * 提前解析会让每个预览各占一条描述请求，与首屏缩略图争抢同一个 6 槽队列（规则 3.3），
 * 而绝大多数卡片根本不会被悬停。
 *
 * 因此解析以「浮层打开过」为触发条件，且一旦触发就不再收回：
 * - 未打开过：不解析、不发请求，不渲染任何浮层内容；
 * - 打开：开始解析；地址就绪后才挂载媒体内容（不拿空 `src` 请求页面自身）；
 * - 关闭后保持已解析状态，Radix 的退场动画才有内容可渲染，再次悬停也不重新描述。
 *
 * 描述失败时渲染失败提示与重试（规则 3.7 的通知用于命令式下载，这里是用户可见的
 * 浮层本身，就地给出重试入口比弹通知更直接）。
 */
import type { ComponentProps } from "react";
import { useState } from "react";

import { HoverCardContent, HoverCardMediaContent } from "@/components/ui/hover-card";
import { withManagedFileWidth } from "@/lib/file-url";
import { useFileAccessUrl } from "@/lib/use-file-access-url";

import { MediaAccessError } from "./MediaAccessError";

type MediaContentProps = Omit<
  ComponentProps<typeof HoverCardMediaContent>,
  "src" | "onMediaError" | "onRetry" | "mediaRevision"
>;

interface Props extends MediaContentProps {
  /** 逻辑引用值：存储 key 或外部 URL */
  value: string;
  /** 派生缩略宽度（`?w=`），仅对托管值生效 */
  width?: number;
  /** 浮层是否已打开：解析的唯一触发时机 */
  open: boolean;
}

export function ResolvedHoverMedia({ value, width, open, ...contentProps }: Props) {
  const logical = width !== undefined ? withManagedFileWidth(value, width) : value;

  // 打开过即长期武装（渲染期依据 props 调整 state 的官方写法）：收回会让关闭动画
  // 失去内容，也会让下一次悬停重新描述一遍
  const [armed, setArmed] = useState(false);
  if (open && !armed) setArmed(true);

  const { url, failed, refresh, retrySigned, reloadToken } = useFileAccessUrl(armed ? logical : undefined);

  if (!url) {
    // 尚未解析（未打开过 / 解析中）：不挂载媒体元素，避免空 src 请求页面自身
    if (!armed || !failed) return null;
    // 描述本身失败（网络 / 404 / 503）：就地给出重试，不无限自动重试（规则 3.6）。
    // mediaType / mediaClassName 是媒体元素专用属性，失败分支渲染普通内容，必须剥离
    const { mediaType: _mediaType, mediaClassName: _mediaClassName, ...contentOnly } = contentProps;
    return (
      <HoverCardContent {...contentOnly}>
        <MediaAccessError onRetry={() => { void refresh(); }} />
      </HoverCardContent>
    );
  }

  return (
    <HoverCardMediaContent
      {...contentProps}
      src={url}
      // 元素加载失败（签名过期 / 对象被删）：重新描述一次，闩锁由 Hook 按源持有
      onMediaError={() => { void retrySigned(); }}
      // 用户点重试：强制重新描述，不受规则 3.6 的自动重试闩锁限制（闩锁用尽后
      // 仍必须能给出一份新地址，否则按钮只会重挂同一个已过期的地址）
      onRetry={() => { void refresh(); }}
      mediaRevision={reloadToken}
    />
  );
}
