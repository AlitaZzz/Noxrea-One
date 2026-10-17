"use client";

import type { ComponentType, ImgHTMLAttributes } from "react";
import { useTranslation } from "react-i18next";

import { ExclamationCircleOutlined, PictureOutlined, ReloadOutlined } from "@/components/ui/AppIcon";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useCanvasImage } from "@/features/canvas/hooks/use-canvas-image";
import type { ImagePlacement } from "@/features/canvas/shared/image-visibility";
import { fileRefUrl } from "@/lib/file-url";
import { cn } from "@/lib/utils";

type Props = Omit<ImgHTMLAttributes<HTMLImageElement>, "src" | "loading"> & {
  nodeId: string;
  /** 引用值：存储 key 或外部 URL / data: / blob: 预览；URL 在此派生（渲染期唯一入口） */
  src: string;
  placement?: ImagePlacement;
  /** 加载中/失败占位图标：图片场景默认 PictureOutlined，视频海报等场景可覆盖 */
  placeholderIcon?: ComponentType<{ className?: string }>;
  /** 已知媒体宽高比（宽/高，>0 时生效）：骨架渲染为按比例定形的居中块，未知时满铺 */
  aspect?: number;
};

export default function CanvasImage({ nodeId, src, placement = {}, alt = "", className, style, placeholderIcon: PlaceholderIcon, aspect, ...props }: Props) {
  const { t } = useTranslation();
  const { result, retry } = useCanvasImage(nodeId, fileRefUrl(src), placement);
  const Icon = PlaceholderIcon ?? PictureOutlined;
  if (result?.status === "ready") return <img {...props} className={className} style={style} src={result.url} alt={alt} decoding="async" />;
  const failed = result?.status === "failed";
  return (
    <span className={cn("absolute inset-0 flex items-center justify-center gap-2 bg-card text-muted-foreground", className)} style={style} role={failed ? "group" : "img"} aria-label={alt} data-image-status={result?.status ?? "pending"}>
      {failed ? (
        <>
          <ExclamationCircleOutlined className="size-6 text-destructive" />
          <Tooltip><TooltipTrigger asChild>
            <Button type="button" size="icon-sm" variant="secondary" className="nodrag nopan" aria-label={t("media.retry")} onClick={(event) => { event.stopPropagation(); retry(); }}>
              <ReloadOutlined />
            </Button>
          </TooltipTrigger><TooltipContent>{t("media.retry")}</TooltipContent></Tooltip>
        </>
      ) : (
        // pending 占位：骨架经 tw-animate-css 官方工具类延迟 150ms 淡入
        // （delay + fill-mode both，缓存命中瞬时加载时骨架与图标不会闪现）。
        // 已知媒体宽高比时渲染按比例定形的居中块（容器查询单位做完美 contain，
        // 加载完成时与 object-contain 图片边界吻合），未知时满铺；内容类型图标居中叠加
        <span className="animate-in fade-in delay-150 fill-mode-both absolute inset-0 flex items-center justify-center" style={{ containerType: "size" }}>
          {aspect && aspect > 0 ? (
            <Skeleton style={{ width: `min(100cqw, ${aspect * 100}cqh)`, aspectRatio: `${aspect}` }} />
          ) : (
            <Skeleton className="absolute inset-0 rounded-none" />
          )}
          <Icon className="absolute inset-0 m-auto size-6" />
        </span>
      )}
    </span>
  );
}
