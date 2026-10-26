"use client";

import { useStore, useStoreApi } from "@xyflow/react";
import { useContext, useEffect, useState } from "react";

import { CanvasMediaViewportContext } from "@/features/canvas/shared/CanvasMediaLoadingProvider";
import {
  chooseLodLevel,
  inFlightWidth,
  isLodEligibleImageUrl,
  LOD_SETTLE_MS,
  lodCssWidth,
  nextLodLevel,
  ORIGINAL_LEVEL,
} from "@/features/canvas/shared/image-lod";
import { type ImagePlacement, placedImageRect } from "@/features/canvas/shared/image-visibility";
import { NODE_TITLE_HEIGHT } from "@/lib/constants";
import { fileRefUrl, withManagedFileWidth } from "@/lib/file-url";

/** 只取节点外框尺寸（React Flow 的 `measured` 与节点声明宽高都是外框，不含内边距差） */
type NodeFrame = {
  measured?: { width?: number; height?: number };
  width?: number | string;
  height?: number | string;
  style?: { width?: unknown; height?: unknown };
};

function positiveNumber(value: unknown): number | undefined {
  const num = typeof value === "number" ? value : Number(value);
  return Number.isFinite(num) && num > 0 ? num : undefined;
}

/**
 * 节点尺寸（规则 3.1）：实测值优先，缺失时退回节点声明宽高（`width`/`height` 或
 * style 上的显式值）。媒体节点在首帧测量前只有声明尺寸——没有这条回退，
 * 目标像素恒为 0，节点会一直停在骨架态。
 *
 * 选择器只返回数字：返回对象会让每次 store 变更都产生新引用，退化成全量重渲染。
 */
function nodeWidthOf(node: NodeFrame | undefined): number {
  return positiveNumber(node?.measured?.width)
    ?? positiveNumber(node?.width)
    ?? positiveNumber(node?.style?.width)
    ?? 0;
}

function nodeHeightOf(node: NodeFrame | undefined): number {
  return positiveNumber(node?.measured?.height)
    ?? positiveNumber(node?.height)
    ?? positiveNumber(node?.style?.height)
    ?? 0;
}

type Options = {
  nodeId: string;
  /** 逻辑引用（存储 key / 外部 URL / blob 预览），不得是带 `?w=` 的显示 URL */
  src: string;
  placement?: ImagePlacement;
  /** 已知媒体宽高比（宽/高）：用于计算 contain 后的实际显示宽度 */
  aspect?: number;
  /** 已知自然宽度：目标取档超过它时回退原图 */
  naturalWidth?: number;
};

/**
 * 画布图片分辨率 LOD（specs/canvas-media-resolution-lod.md）：
 * 按「布局宽度 × 结算缩放 × DPR」选档，缩放/尺寸结算后换档，缩小时中止在途高档位。
 * 返回当前应请求的显示 URL 与 `suspend`（只中止在途 job，不影响已就绪的旧图）。
 *
 * 档位与尺寸结算都在渲染期按「上次状态 + 当前输入」推导：逻辑源变化、首次测量与
 * 结算换档都与本次渲染同批提交，不存在「先用旧档位请求新图片」的中间渲染。
 */
export function useCanvasImageLod({
  nodeId,
  src,
  placement,
  aspect,
  naturalWidth,
}: Options): { url: string | undefined; suspend: boolean } {
  const { settledZoom, dpr, zoomingOut } = useContext(CanvasMediaViewportContext);
  const store = useStoreApi();
  // 资格按派生后的访问 URL 判定：src 在画布数据里是存储 key（不是 URL 形态）
  const originalUrl = src ? fileRefUrl(src) : "";
  // 本 Hook 只由 LOD 分支（CanvasImage 的 `lod`）挂载：资格只取决于源形态，
  // 「是否启用 LOD」的开关留在 CanvasImage 的 prop 上，不在 Hook 里再留一个死开关
  const eligible = src.length > 0 && isLodEligibleImageUrl(originalUrl);

  // 只订阅尺寸原语：位置/拖拽变化不触发本组件重渲染。
  // 实测值优先、缺失时退回节点声明宽高（规则 3.1）：媒体节点在首帧测量前只有
  // style 上的尺寸，没有回退就会停在 cssWidth = 0 的骨架态
  const measuredWidth = useStore((state) => (eligible ? nodeWidthOf(state.nodeLookup.get(nodeId)) : 0));
  const measuredHeight = useStore((state) => (eligible ? nodeHeightOf(state.nodeLookup.get(nodeId)) : 0));

  // 尺寸结算：首次测量立即采用（不拖慢首屏），之后改尺寸尾随 200ms 才换档
  const [settled, setSettled] = useState({ width: 0, height: 0 });
  if (settled.width <= 0 && measuredWidth > 0) {
    setSettled({ width: measuredWidth, height: measuredHeight });
  }
  const sizeChanged = settled.width !== measuredWidth || settled.height !== measuredHeight;
  useEffect(() => {
    if (!sizeChanged || settled.width <= 0) return;
    const timer = setTimeout(() => setSettled({ width: measuredWidth, height: measuredHeight }), LOD_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [sizeChanged, measuredWidth, measuredHeight, settled.width]);

  const bodyWidth = eligible ? settled.width : 0;
  const bodyHeight = eligible ? settled.height - NODE_TITLE_HEIGHT : 0;
  const rect = placedImageRect({ x: 0, y: 0, width: bodyWidth, height: bodyHeight }, placement ?? {});
  const cssWidth = lodCssWidth(rect.width, rect.height, aspect);

  // 档位状态与逻辑源绑定：src 变化后旧档位立即失效，绝不用旧档位请求新图片
  const [choice, setChoice] = useState<{ src: string; level: number } | null>(null);
  const currentLevel = choice && choice.src === src ? choice.level : null;

  // 首次档位：不等结算窗口；缩小手势中按规则 3.8 用 min(实时, 已结算)。
  // 实时 zoom 只在这个窄窗口订阅（尚未选档的节点），选档后立即退订，不逐帧渲染。
  const awaitingFirstLevel = eligible && cssWidth > 0 && currentLevel === null;
  const liveZoom = useStore((state) => (awaitingFirstLevel && zoomingOut ? state.transform[2] : null));
  if (awaitingFirstLevel) {
    const zoom = liveZoom !== null && liveZoom > 0 ? Math.min(settledZoom, liveZoom) : settledZoom;
    setChoice({ src, level: chooseLodLevel(cssWidth * zoom * dpr, naturalWidth) });
  }

  // 结算后换档：手势进行中不为已加载图片换档（规则 5.1），结算后按滞回降档。
  if (eligible && cssWidth > 0 && currentLevel !== null && !zoomingOut) {
    const targetPx = cssWidth * settledZoom * dpr;
    const level = nextLodLevel(currentLevel, targetPx, chooseLodLevel(targetPx, naturalWidth), naturalWidth);
    if (level !== currentLevel) setChoice({ src, level });
  }

  // 缩小手势中止在途高档位（规则 3.9）：实时目标低于在途档位时置 suspend，
  // 由 useCanvasImage 把 lease 优先级置 null；只有布尔翻转才触发渲染。
  // 在途比较用 inFlightWidth（原图未知自然宽度时视为高于最大档，规则 3.9）；
  // 换档滞回用 levelWidth（需要有限值），两者语义不同不可互换
  const requestedWidth = currentLevel === null ? null : inFlightWidth(currentLevel, naturalWidth);
  const suspensible = eligible && zoomingOut && requestedWidth !== null && cssWidth > 0;
  const [suspendFlag, setSuspendFlag] = useState(false);
  // 手势结束即解除：下一次手势必须从「未中止」开始，不继承上一轮的判定
  if (!suspensible && suspendFlag) setSuspendFlag(false);
  useEffect(() => {
    if (!suspensible) return;
    let cancelled = false;
    const evaluate = () => {
      if (cancelled || requestedWidth === null) return;
      const zoom = store.getState().transform[2];
      if (!(zoom > 0)) return;
      const liveWidth = inFlightWidth(chooseLodLevel(cssWidth * zoom * dpr, naturalWidth), naturalWidth);
      setSuspendFlag(liveWidth < requestedWidth);
    };
    // 订阅回调里 setState 是允许的；effect body 同步 setState 会触发级联渲染
    queueMicrotask(evaluate);
    const unsubscribe = store.subscribe(evaluate);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [suspensible, requestedWidth, cssWidth, dpr, naturalWidth, store]);
  const suspend = suspensible && suspendFlag;

  let url: string | undefined;
  if (!src) {
    url = undefined;
  } else if (!eligible) {
    url = originalUrl;
  } else if (currentLevel === null) {
    // 尚未测量/首档未定：保持骨架，不先请求原图再换档
    url = undefined;
  } else {
    url = currentLevel === ORIGINAL_LEVEL ? originalUrl : withManagedFileWidth(originalUrl, currentLevel);
  }

  return { url, suspend };
}
