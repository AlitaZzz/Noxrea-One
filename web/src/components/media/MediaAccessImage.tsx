"use client";

/**
 * 已解析地址的覆盖型图片（标注 / 裁剪底图，specs/storage-signed-direct-delivery.md 规则 3.5/3.6）。
 *
 * 与 `ResolvedImage` 的分工：那一层负责「逻辑引用值 → 元素」；这里接收已经解析好的
 * 最终地址，供需要自己持有 `img` 引用做测量 / 绘制的覆盖型编辑器使用。两条共同约定
 * 集中在这里，调用方不再各写一遍：
 * - 地址未就绪不渲染元素（空 `src` 会被浏览器解析成页面自身 URL 并当图片请求）；
 * - 元素加载失败重新描述一次，成功后按 `reloadToken` 重挂（同一签名窗口地址不变）。
 *
 * 解码需要读回像素（画布绘制），因此固定 `crossOrigin="anonymous"`。
 */
import type { ImgHTMLAttributes, Ref } from "react";

interface Props extends Omit<ImgHTMLAttributes<HTMLImageElement>, "src" | "onError"> {
  /** 解析层给出的最终地址；`undefined` = 尚未就绪，不渲染元素 */
  url: string | undefined;
  /** 重挂令牌：重新描述后强制元素重新加载 */
  reloadToken: number;
  /** 元素加载失败：重新描述一次（`useFileAccessUrl().retrySigned`） */
  onRetryAccess: () => void;
  ref?: Ref<HTMLImageElement>;
}

export function MediaAccessImage({ url, reloadToken, onRetryAccess, ref, ...props }: Props) {
  if (!url) return null;
  return (
    // 媒体地址是解析层的产物，缩放由文件服务的 ?w= 参数负责，不走 next/image
    // eslint-disable-next-line @next/next/no-img-element
    <img
      key={reloadToken}
      ref={ref}
      src={url}
      alt=""
      crossOrigin="anonymous"
      draggable={false}
      {...props}
      onError={onRetryAccess}
    />
  );
}
