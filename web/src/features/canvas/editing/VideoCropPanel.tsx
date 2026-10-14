/**
 * 视频画面裁剪面板。
 * 裁剪是空间操作，矩形对每一帧同样成立：裁剪框直接叠加在节点的会话视频上
 * （cropOpen 时节点挂载会话 <video>），不抓帧、不生成静态背景图。
 * 选框确定后按源像素矩形派发 crop-video-apply 事件，由视频节点走客户端管线
 * 或服务端裁剪链路。挂在节点 body 之外（露出顶部工具条），由 croppingNodeId
 * 驱动显隐。
 */
"use client";

import { clampRect as clampRectPx } from "@noxrea/shared/crop-rect";
import { NodeToolbar as RfNodeToolbar, Position } from "@xyflow/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { CloseOutlined, ReloadOutlined } from "@/components/ui/AppIcon";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import IconActionButton from "@/components/ui/IconActionButton";
import { Separator } from "@/components/ui/separator";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import WheelGuard from "@/components/ui/WheelGuard";
import { dispatchNodeAction } from "@/features/canvas/shared/node-action";
import { useCanvasStore } from "@/features/canvas/stores/canvas-store";
import { NODE_TITLE_HEIGHT } from "@/lib/constants";

interface Props {
  nodeId: string;
  /** 源视频像素尺寸：确认时把比例选框换算成源像素矩形。元数据未回填时缺省
      （轮六⑦允许运行时缺失）——确认禁用、尺寸显示占位 */
  videoSize?: { w: number; h: number };
  onClose: () => void;
}

/** 比例坐标 → 源像素（四舍五入）：确认换算与尺寸展示共用同一投影 */
const toPx = (fraction: number, size: number) => Math.round(fraction * size);

const ASPECT_PRESETS: { label: string; value: number | undefined }[] = [
  { label: "crop.aspect.free", value: undefined },
  { label: "crop.aspect.1_1", value: 1 },
  { label: "crop.aspect.4_3", value: 4 / 3 },
  { label: "crop.aspect.3_4", value: 3 / 4 },
  { label: "crop.aspect.16_9", value: 16 / 9 },
  { label: "crop.aspect.9_16", value: 9 / 16 },
];

type Handle = "move" | "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const MIN_SIZE = 20;

export default function VideoCropPanel({ nodeId, videoSize, onClose }: Props) {
  const { t } = useTranslation();
  const setModalOpen = useCanvasStore((s) => s.setModalOpen);

  const overlayRef = useRef<HTMLDivElement>(null);
  // 裁剪框相对的显示区域尺寸：ResizeObserver 跟踪 overlay 尺寸——面板打开期间
  // 元数据回填（onLoadedMeta）仍可能改变节点主体大小，一次性测量会拿到过期值
  const [displaySize, setDisplaySize] = useState({ w: 0, h: 0 });
  const [aspect, setAspect] = useState<number | undefined>(undefined);
  const [crop, setCrop] = useState<CropRect>({ x: 0.1, y: 0.1, w: 0.8, h: 0.8 });

  useEffect(() => {
    const overlay = overlayRef.current;
    if (!overlay) return;
    // clientWidth/clientHeight 是 CSS 布局尺寸，不受 React Flow 缩放影响；
    // observe 首次回调即完成初始测量，之后尺寸变化时续测
    const observer = new ResizeObserver(() => {
      setDisplaySize({ w: overlay.clientWidth, h: overlay.clientHeight });
    });
    observer.observe(overlay);
    return () => observer.disconnect();
  }, []);

  const dragRef = useRef<{ handle: Handle; startMouseX: number; startMouseY: number; startRect: CropRect } | null>(null);

  useEffect(() => {
    setModalOpen(true);
    return () => { setModalOpen(false); };
  }, [setModalOpen]);

  // 显示像素 → 选框比例（0-1）
  const getFraction = useCallback((e: PointerEvent | React.PointerEvent) => {
    const overlay = overlayRef.current;
    if (!overlay) return { x: 0, y: 0 };
    const rect = overlay.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height)),
    };
  }, []);

  // 钳到 [0,1] 边界，可选比例锁定（比例在源像素空间定义，换算到比例空间见 CropPanel）
  const clampRect = useCallback((r: CropRect, lockAspect?: number): CropRect => {
    let { x, y, w, h } = r;
    const fracAspect = lockAspect ? lockAspect * (displaySize.h / displaySize.w) : 0;
    if (lockAspect && lockAspect > 0) {
      h = w / fracAspect;
    }
    w = Math.max(MIN_SIZE / displaySize.w, w);
    h = Math.max(MIN_SIZE / displaySize.h, h);
    if (x < 0) { w += x; x = 0; }
    if (y < 0) { h += y; y = 0; }
    if (x + w > 1) w = 1 - x;
    if (y + h > 1) h = 1 - y;
    if (lockAspect && lockAspect > 0) {
      w = h * fracAspect;
      if (x + w > 1) { w = 1 - x; h = w / fracAspect; }
    }
    return { x, y, w, h };
  }, [displaySize.w, displaySize.h]);

  const handlePointerDown = useCallback((e: React.PointerEvent, handle: Handle) => {
    e.stopPropagation();
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = {
      handle,
      startMouseX: e.clientX,
      startMouseY: e.clientY,
      startRect: { ...crop },
    };
  }, [crop]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragRef.current) return;
    e.stopPropagation();
    const { handle, startRect } = dragRef.current;
    const pt = getFraction(e);
    const overlay = overlayRef.current;
    if (!overlay) return;
    const rect = overlay.getBoundingClientRect();
    const dx = pt.x - (dragRef.current.startMouseX - rect.left) / rect.width;
    const dy = pt.y - (dragRef.current.startMouseY - rect.top) / rect.height;

    const r = { ...startRect };
    if (handle === "move") {
      r.x = Math.max(0, Math.min(1 - startRect.w, startRect.x + dx));
      r.y = Math.max(0, Math.min(1 - startRect.h, startRect.y + dy));
    } else {
      if (handle.includes("w")) { r.x = startRect.x + dx; r.w = startRect.w - dx; }
      if (handle.includes("e")) { r.w = startRect.w + dx; }
      if (handle.includes("n")) { r.y = startRect.y + dy; r.h = startRect.h - dy; }
      if (handle.includes("s")) { r.h = startRect.h + dy; }
      if (aspect && aspect > 0) {
        const fa = aspect * (displaySize.h / displaySize.w);
        if (handle === "n" || handle === "s") {
          r.w = r.h * fa;
          r.x = startRect.x + (startRect.w - r.w) / 2;
        } else if (handle === "e" || handle === "w") {
          r.h = r.w / fa;
          r.y = startRect.y + (startRect.h - r.h) / 2;
        } else {
          r.w = r.h * fa;
          if (handle === "nw") { r.x = startRect.x + startRect.w - r.w; }
          else if (handle === "sw") { r.x = startRect.x + startRect.w - r.w; }
        }
      }
      if (r.w < 0) { r.x += r.w; r.w = -r.w; }
      if (r.h < 0) { r.y += r.h; r.h = -r.h; }
    }
    setCrop(clampRect(r, aspect));
  }, [getFraction, aspect, clampRect, displaySize.w, displaySize.h]);

  const handlePointerUp = useCallback(() => {
    dragRef.current = null;
  }, []);

  const handleAspectChange = useCallback((newAspect?: number) => {
    setAspect(newAspect);
    if (newAspect && newAspect > 0) {
      const fracAspect = newAspect * (displaySize.h / displaySize.w);
      let w = 0.8;
      let h = w / fracAspect;
      if (h > 0.95) { h = 0.95; w = h * fracAspect; }
      setCrop({ x: (1 - w) / 2, y: (1 - h) / 2, w, h });
    }
  }, [displaySize]);

  const handleReset = useCallback(() => {
    setAspect(undefined);
    setCrop({ x: 0.1, y: 0.1, w: 0.8, h: 0.8 });
  }, []);

  // 确认：比例 → 源像素矩形（偶数钳位与边界校验收口到共享实现
  // @noxrea/shared/crop-rect，与服务端兜底路由同一 clampRect），
  // 派发给视频节点走客户端管线或服务端裁剪链路（按能力探测）。
  // 不在这里关闭面板：busy 守卫拒绝时（clip.busy 提示）面板保持打开、选区
  // 原样保留可重试；裁剪被接受后节点会清除 croppingNodeId 关闭面板
  const handleConfirm = useCallback(() => {
    if (!videoSize || videoSize.w < 2 || videoSize.h < 2) return;
    const rect = clampRectPx(
      {
        x: toPx(crop.x, videoSize.w),
        y: toPx(crop.y, videoSize.h),
        width: toPx(crop.w, videoSize.w),
        height: toPx(crop.h, videoSize.h),
      },
      videoSize.w,
      videoSize.h,
    );

    dispatchNodeAction(nodeId, "crop-video-apply", { rect });
  }, [videoSize, crop, nodeId]);

  // 信息展示：输出像素尺寸（源尺寸未就绪时占位，不产 NaN）
  const sizeReady = videoSize != null && videoSize.w >= 2 && videoSize.h >= 2;
  const sizeLabel = sizeReady
    ? `${toPx(crop.w, videoSize.w)} × ${toPx(crop.h, videoSize.h)}`
    : "– × –";

  const handleStyle: React.CSSProperties = {
    position: "absolute",
    width: 10,
    height: 10,
    background: "#fff",
    border: "1.5px solid var(--primary)",
    borderRadius: 3,
    pointerEvents: "auto",
    cursor: "pointer",
  };

  return (
    <>
      {/* Toolbar - RfNodeToolbar 恒定尺寸定位（与其它编辑工具栏统一） */}
      <RfNodeToolbar nodeId={nodeId} position={Position.Top} align="center" offset={8} isVisible>
      <WheelGuard
        className="nodrag"
      >
      <Card className="flex h-[50px] flex-row items-center gap-1 rounded-xl whitespace-nowrap px-2.5 py-1.5">
        {/* 左组：✗ 关闭 + 标题 */}
        <div className="flex shrink-0 items-center gap-1">
          <Button size="icon" variant="ghost" onClick={onClose} ><CloseOutlined /></Button>
          <span className="text-[13px] text-foreground">{t("node.crop")}</span>
        </div>

        <Separator orientation="vertical" className="mx-1 h-5 self-center" />

        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          spacing={1}
          value={ASPECT_PRESETS.find((p) => p.value === aspect)?.label ?? ASPECT_PRESETS[0].label}
          onValueChange={(value) => {
            if (value) handleAspectChange(ASPECT_PRESETS.find((p) => p.label === value)?.value);
          }}
          aria-label={t("crop.aspect.free")}
        >
          {ASPECT_PRESETS.map((p) => <ToggleGroupItem key={p.label} value={p.label}>{t(p.label)}</ToggleGroupItem>)}
        </ToggleGroup>

        <Separator orientation="vertical" className="mx-1 h-5 self-center" />

        <span className="min-w-[70px] text-center text-xs font-medium text-muted-foreground">
          {sizeLabel}
        </span>

        <Separator orientation="vertical" className="mx-1 h-5 self-center" />

        <Tooltip><TooltipTrigger asChild>
            <Button size="icon" variant="ghost" onClick={handleReset} aria-label={t("crop.reset")} ><ReloadOutlined /></Button>
          </TooltipTrigger><TooltipContent>{t("crop.reset")}</TooltipContent></Tooltip>

        <Separator orientation="vertical" className="mx-1 h-5 self-center" />

        {/* 确认：反色 ↑（与截取/变速工具栏一致）。源尺寸未就绪（元数据未回填，
            videoSize 缺省）时禁用——handleConfirm 的同条件守卫只作防御，不留
            可点但静默 no-op 的按钮 */}
        <IconActionButton
          onClick={handleConfirm}
          disabled={!sizeReady}
        />
      </Card>
      </WheelGuard>
      </RfNodeToolbar>

      {/* Crop overlay */}
      {/* 只覆盖视频画面区（标题栏以下）并直接叠在会话视频上：裁剪是空间操作，
          矩形对每一帧同样成立，无需冻结某一帧为背景图 */}
      <div
        ref={overlayRef}
        className="nodrag absolute z-30 pointer-events-auto rounded-lg overflow-hidden"
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        style={{ top: NODE_TITLE_HEIGHT, left: 0, right: 0, bottom: 0, cursor: "crosshair", touchAction: "none" }}
      >
        {/* 裁剪框的 9999px 投影负责压暗框外区域，框内保持原始亮度（裁剪结果预览）；
            不另铺全幅遮罩，否则框内会被二次压暗 */}
        {/* Cutout for crop area (clear the dark overlay) */}
        <div
          className="absolute pointer-events-none shadow-[0_0_0_9999px_rgb(0_0_0_/_50%)]"
          style={{
            left: `${crop.x * 100}%`,
            top: `${crop.y * 100}%`,
            width: `${crop.w * 100}%`,
            height: `${crop.h * 100}%`,
            border: "1.5px solid #fff",
          }}
        >
          {/* Rule of thirds：细线加轻微投影，明亮画面下仍可辨 */}
          <div className="absolute inset-0 pointer-events-none drop-shadow-[0_1px_1px_rgba(0,0,0,0.55)]">
            <div className="absolute top-1/3 left-0 right-0 h-px bg-white/30" />
            <div className="absolute top-2/3 left-0 right-0 h-px bg-white/30" />
            <div className="absolute left-1/3 top-0 bottom-0 w-px bg-white/30" />
            <div className="absolute left-2/3 top-0 bottom-0 w-px bg-white/30" />
          </div>
        </div>

        {/* Crop area - move handle */}
        <div
          className="absolute cursor-move"
          style={{
            left: `${crop.x * 100}%`,
            top: `${crop.y * 100}%`,
            width: `${crop.w * 100}%`,
            height: `${crop.h * 100}%`,
            pointerEvents: "auto",
          }}
          onPointerDown={(e) => handlePointerDown(e, "move")}
        />

        {/* 8 resize handles */}
        <div onPointerDown={(e) => handlePointerDown(e, "nw")} style={{ ...handleStyle, left: `${crop.x * 100}%`, top: `${crop.y * 100}%`, transform: "translate(-50%, -50%)", cursor: "nw-resize" }} />
        <div onPointerDown={(e) => handlePointerDown(e, "ne")} style={{ ...handleStyle, left: `${(crop.x + crop.w) * 100}%`, top: `${crop.y * 100}%`, transform: "translate(-50%, -50%)", cursor: "ne-resize" }} />
        <div onPointerDown={(e) => handlePointerDown(e, "sw")} style={{ ...handleStyle, left: `${crop.x * 100}%`, top: `${(crop.y + crop.h) * 100}%`, transform: "translate(-50%, -50%)", cursor: "sw-resize" }} />
        <div onPointerDown={(e) => handlePointerDown(e, "se")} style={{ ...handleStyle, left: `${(crop.x + crop.w) * 100}%`, top: `${(crop.y + crop.h) * 100}%`, transform: "translate(-50%, -50%)", cursor: "se-resize" }} />
        <div onPointerDown={(e) => handlePointerDown(e, "n")} style={{ ...handleStyle, left: `${(crop.x + crop.w / 2) * 100}%`, top: `${crop.y * 100}%`, transform: "translate(-50%, -50%)", cursor: "n-resize" }} />
        <div onPointerDown={(e) => handlePointerDown(e, "s")} style={{ ...handleStyle, left: `${(crop.x + crop.w / 2) * 100}%`, top: `${(crop.y + crop.h) * 100}%`, transform: "translate(-50%, -50%)", cursor: "s-resize" }} />
        <div onPointerDown={(e) => handlePointerDown(e, "w")} style={{ ...handleStyle, left: `${crop.x * 100}%`, top: `${(crop.y + crop.h / 2) * 100}%`, transform: "translate(-50%, -50%)", cursor: "w-resize" }} />
        <div onPointerDown={(e) => handlePointerDown(e, "e")} style={{ ...handleStyle, left: `${(crop.x + crop.w) * 100}%`, top: `${(crop.y + crop.h / 2) * 100}%`, transform: "translate(-50%, -50%)", cursor: "e-resize" }} />
      </div>
    </>
  );
}
