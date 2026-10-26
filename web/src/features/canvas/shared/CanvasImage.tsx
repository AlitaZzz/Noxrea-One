"use client";

import { type ComponentType, type ImgHTMLAttributes, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { ExclamationCircleOutlined, PictureOutlined, ReloadOutlined } from "@/components/ui/AppIcon";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useCanvasImage } from "@/features/canvas/hooks/use-canvas-image";
import { useCanvasImageLod } from "@/features/canvas/hooks/use-canvas-image-lod";
import { imageLoadWeight } from "@/features/canvas/shared/image-lod";
import type { ImagePlacement } from "@/features/canvas/shared/image-visibility";
import { fileRefUrl } from "@/lib/file-url";
import { useFileAccessUrl } from "@/lib/use-file-access-url";
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
  /** 启用分辨率 LOD（specs/canvas-media-resolution-lod.md）；默认关闭，视频海报等已带 `w` 的调用点保持原样 */
  lod?: boolean;
  /** 已知自然宽度：LOD 取档超过它时回退原图 */
  naturalWidth?: number;
};

type BodyProps = Omit<Props, "src" | "lod" | "naturalWidth"> & {
  /** 逻辑引用（用于 stale 判定，档位变化不改变它） */
  src: string;
  /** 当前应请求的显示 URL；undefined = 尚未测量/首档未定，不发起请求（与 useCanvasImage 同一哨兵） */
  displayUrl: string | undefined;
  /** 中止在途 job（缩小时降档），不影响已就绪的旧图 */
  suspend?: boolean;
};

/**
 * 图片加载 + 展示：调度器探测同一 URL，ready 后由 <img> 命中 HTTP 缓存。
 * 换档时新 URL 就绪前保留上一张已就绪图（stale-while-revalidate），逻辑源变化才回骨架。
 */
function CanvasImageBody({ nodeId, src, displayUrl, suspend = false, placement = {}, alt = "", className, style, placeholderIcon: PlaceholderIcon, aspect, ...props }: BodyProps) {
  const { t } = useTranslation();
  // 逻辑 URL → 最终访问地址（S3 签名直连 / local 流式）；调度器与 <img> 都消费解析结果
  const { url: accessUrl, failed: accessFailed, refresh: refreshAccess, retrySigned } = useFileAccessUrl(displayUrl);
  const { result, retry } = useCanvasImage(nodeId, accessUrl, placement, {
    // 显示 URL 未就绪（未测量/首档未定）时没有可称重的地址：按最轻档计，
    // 此时也不会申请调度任务，重量只在真正加载时生效
    weight: displayUrl === undefined ? 1 : imageLoadWeight(displayUrl),
    suspend,
  });

  // signed URL 403/404（过期、时钟或 bucket 策略）：跳过缓存重新描述一次再重试；
  // 仍失败进入现有失败态，不无限重试（specs/storage-signed-direct-delivery.md 规则 3.6）。
  // stream / 外部 URL 重试同一地址不会改变结果，直接进入失败态。
  useEffect(() => {
    if (result?.status !== "failed" || !accessUrl) return;
    void retrySigned().then((refreshed) => {
      // 地址已换：useCanvasImage 会为新鲜地址新建 lease 并自行加载，重试旧 job
      // 只会再探一次过期地址；只有同一签名窗口（地址未变）才需要重试该 job
      if (refreshed !== null && refreshed === accessUrl) retry();
    });
  }, [result, accessUrl, retrySigned, retry]);

  // 逻辑源与显示 URL 分离：档位变化只换显示 URL，节点数据永远保存原始引用。
  // stale 在等待新档位（pending）期间保留旧图；新档位失败且旧图来自另一个档位时也保留
  // （规则 6.3）；同一 URL 由 ready 转 failed 是真实失败，必须显示失败态。
  // 比较对象必须是访问地址：stale.url 与 accessUrl 同域，displayUrl 是逻辑 URL（signed 下永不相等）。
  // 渲染期同步（React 官方「依据 props 调整 state」写法）：新档位就绪与本次渲染
  // 同批提交，不会出现「已 ready 但还渲染旧骨架」的中间帧
  const [stale, setStale] = useState<{ src: string; url: string } | null>(null);
  if (result?.status === "ready" && (stale === null || stale.src !== src || stale.url !== result.url)) {
    setStale({ src, url: result.url });
  }
  const staleUrl = stale && stale.src === src ? stale.url : null;

  const Icon = PlaceholderIcon ?? PictureOutlined;
  const readyUrl = result?.status === "ready"
    ? result.url
    : result?.status === "failed"
      ? (staleUrl && staleUrl !== accessUrl ? staleUrl : null)
      : staleUrl;
  if (readyUrl) return <img {...props} className={className} style={style} src={readyUrl} alt={alt} decoding="async" />;
  const failed = accessFailed || result?.status === "failed";
  return (
    <span className={cn("absolute inset-0 flex items-center justify-center gap-2 bg-card text-muted-foreground", className)} style={style} role={failed ? "group" : "img"} aria-label={alt} data-image-status={result?.status ?? "pending"}>
      {failed ? (
        <>
          <ExclamationCircleOutlined className="size-6 text-destructive" />
          <Tooltip><TooltipTrigger asChild>
            <Button type="button" size="icon-sm" variant="secondary" className="nodrag nopan" aria-label={t("media.retry")} onClick={(event) => { event.stopPropagation(); if (accessFailed) void refreshAccess(); else retry(); }}>
              <ReloadOutlined />
            </Button>
          </TooltipTrigger><TooltipContent>{t("media.retry")}</TooltipContent></Tooltip>
        </>
      ) : (
        // pending 占位：延迟 150ms 淡入（缓存命中瞬时加载时骨架与图标不会闪现）。
        // fill-mode 必须是 backwards：both 会让淡入动画以 fill-forwards 常驻，每个待加载
        // 节点因此保留一个合成层（90 节点实测多 90 层）。
        // 骨架用 animate-none 覆盖 Skeleton 默认的 pulse：每个待加载节点的无限 opacity
        // 动画会额外带出约 3 个合成层（90 节点实测 280 层），低缩放全节点可见时拖动
        // 画布明显掉帧；静态骨架 + 内容类型图标已足够表达加载态。
        // 已知媒体宽高比时渲染按比例定形的居中块（容器查询单位做完美 contain，
        // 加载完成时与 object-contain 图片边界吻合），未知时满铺；内容类型图标居中叠加
        <span className="animate-in fade-in delay-150 fill-mode-backwards absolute inset-0 flex items-center justify-center" style={{ containerType: "size" }}>
          {aspect && aspect > 0 ? (
            <Skeleton className="animate-none" style={{ width: `min(100cqw, ${aspect * 100}cqh)`, aspectRatio: `${aspect}` }} />
          ) : (
            <Skeleton className="animate-none absolute inset-0 rounded-none" />
          )}
          <Icon className="absolute inset-0 m-auto size-6" />
        </span>
      )}
    </span>
  );
}

/** LOD 分支：需要 React Flow store 读取节点测量尺寸，只有显式开启时才挂载 */
function LodCanvasImage({ nodeId, src, placement, aspect, naturalWidth, ...rest }: Props) {
  const { url, suspend } = useCanvasImageLod({ nodeId, src, placement, aspect, naturalWidth });
  return <CanvasImageBody {...rest} nodeId={nodeId} src={src} placement={placement} aspect={aspect} displayUrl={url} suspend={suspend} />;
}

export default function CanvasImage({ lod = false, naturalWidth, ...props }: Props) {
  // 非 LOD 路径不触碰 React Flow store（视频海报、上传预览等可在 Provider 外渲染）
  if (!lod) return <CanvasImageBody {...props} displayUrl={fileRefUrl(props.src)} />;
  return <LodCanvasImage {...props} naturalWidth={naturalWidth} />;
}
