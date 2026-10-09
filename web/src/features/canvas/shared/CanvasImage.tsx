"use client";

import type { ImgHTMLAttributes } from "react";
import { useTranslation } from "react-i18next";

import { ExclamationCircleOutlined, PictureOutlined, ReloadOutlined } from "@/components/ui/AppIcon";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useCanvasImage } from "@/features/canvas/hooks/use-canvas-image";
import type { ImagePlacement } from "@/features/canvas/shared/image-visibility";
import { cn } from "@/lib/utils";

type Props = Omit<ImgHTMLAttributes<HTMLImageElement>, "src" | "loading"> & {
  nodeId: string;
  src: string;
  placement?: ImagePlacement;
};

export default function CanvasImage({ nodeId, src, placement = {}, alt = "", className, style, ...props }: Props) {
  const { t } = useTranslation();
  const { result, retry } = useCanvasImage(nodeId, src, placement);
  if (result?.status === "ready") return <img {...props} className={className} style={style} src={src} alt={alt} decoding="async" />;
  const failed = result?.status === "failed";
  return (
    <span className={cn("absolute inset-0 flex items-center justify-center gap-2 bg-card text-muted-foreground", className)} style={style} role={failed ? "group" : "img"} aria-label={alt} data-image-status={result?.status ?? "pending"}>
      {failed ? <ExclamationCircleOutlined className="size-6 text-destructive" /> : <PictureOutlined className="size-6" />}
      {failed && <Tooltip><TooltipTrigger asChild>
        <Button type="button" size="icon-sm" variant="secondary" className="nodrag nopan" aria-label={t("media.retry")} onClick={(event) => { event.stopPropagation(); retry(); }}>
          <ReloadOutlined />
        </Button>
      </TooltipTrigger><TooltipContent>{t("media.retry")}</TooltipContent></Tooltip>}
    </span>
  );
}
