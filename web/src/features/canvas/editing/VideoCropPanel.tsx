/**
 * 视频画面裁剪面板（交互与图片 CropPanel 同构）。
 * 挂载时通过 captureFrame 抓取视频当前帧作为背景静帧，选框确定后按源像素
 * 矩形派发 crop-video-apply 事件，由视频节点走服务端 ffmpeg 裁剪 + 派生节点
 * 链路。挂在节点 body 之外（露出顶部工具条），由 croppingNodeId 驱动显隐。
 */
"use client";

import { CloseOutlined, UndoOutlined } from "@ant-design/icons";
import { NodeToolbar as RfNodeToolbar, Position } from "@xyflow/react";
import { Button, Tooltip } from "antd";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import WheelGuard from "@/components/ui/WheelGuard";
import { dispatchNodeAction } from "@/features/canvas/shared/node-action";
import { useCanvasStore } from "@/features/canvas/stores/canvas-store";
import { NODE_TITLE_HEIGHT } from "@/lib/constants";

import PrimaryActionButton from "./PrimaryActionButton";

interface Props {
  nodeId: string;
  /** 抓取视频当前帧为裁剪背景（面板挂载时调用一次） */
  captureFrame: () => { src: string; w: number; h: number } | null;
  onClose: () => void;
}

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

export default function VideoCropPanel({ nodeId, captureFrame, onClose }: Props) {
  const { t } = useTranslation();
  const setModalOpen = useCanvasStore((s) => s.setModalOpen);

  const imgRef = useRef<HTMLImageElement>(null);
  // 挂载时抓帧一次：state 初始化器只在首次挂载执行，抓到的帧在面板生命周期内固定
  const [snap] = useState(() => captureFrame());
  const [imgLoaded, setImgLoaded] = useState(false);
  const [displaySize, setDisplaySize] = useState({ w: 0, h: 0 });
  const [aspect, setAspect] = useState<number | undefined>(undefined);
  const [crop, setCrop] = useState<CropRect>({ x: 0.1, y: 0.1, w: 0.8, h: 0.8 });

  const dragRef = useRef<{ handle: Handle; startMouseX: number; startMouseY: number; startRect: CropRect } | null>(null);

  useEffect(() => {
    setModalOpen(true);
    return () => { setModalOpen(false); };
  }, [setModalOpen]);

  const handleImgLoad = useCallback(() => {
    const img = imgRef.current;
    if (!img) return;
    // clientWidth/clientHeight 是 CSS 布局尺寸，不受 React Flow 缩放影响
    setDisplaySize({ w: img.clientWidth, h: img.clientHeight });
    setImgLoaded(true);
  }, []);

  // 显示像素 → 选框比例（0-1）
  const getFraction = useCallback((e: PointerEvent | React.PointerEvent) => {
    const img = imgRef.current;
    if (!img) return { x: 0, y: 0 };
    const rect = img.getBoundingClientRect();
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
    const img = imgRef.current;
    if (!img) return;
    const rect = img.getBoundingClientRect();
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

  // 确认：比例 → 源像素矩形（宽高/偏移取偶，满足 yuv420p 色度采样要求），
  // 派发给视频节点走服务端 ffmpeg 裁剪链路。
  // 不在这里关闭面板：busy 守卫拒绝时（clip.busy 提示）面板保持打开、选区
  // 原样保留可重试；裁剪被接受后节点会清除 croppingNodeId 关闭面板
  const handleConfirm = useCallback(() => {
    if (!snap || !imgLoaded || snap.w === 0) return;
    let x = Math.round(crop.x * snap.w);
    let y = Math.round(crop.y * snap.h);
    let w = Math.round(crop.w * snap.w);
    let h = Math.round(crop.h * snap.h);
    // 取偶并防越界：裁剪偏移与宽高必须为偶数，且矩形落在画面内
    w -= w % 2;
    h -= h % 2;
    x -= x % 2;
    y -= y % 2;
    x = Math.max(0, Math.min(x, snap.w - 2));
    y = Math.max(0, Math.min(y, snap.h - 2));
    w = Math.max(2, Math.min(w, snap.w - x));
    h = Math.max(2, Math.min(h, snap.h - y));

    dispatchNodeAction(nodeId, "crop-video-apply", { rect: { x, y, width: w, height: h } });
  }, [snap, imgLoaded, crop, nodeId]);

  // 视频帧不可用（理论上不可达：入口已保证视频有画面）：不渲染面板
  if (!snap) return null;

  // 信息展示：源像素尺寸
  const cropW = Math.round(crop.w * snap.w);
  const cropH = Math.round(crop.h * snap.h);

  const handleStyle: React.CSSProperties = {
    position: "absolute",
    width: 10,
    height: 10,
    background: "#fff",
    border: "1.5px solid var(--canvas-success)",
    borderRadius: 3,
    pointerEvents: "auto",
    cursor: "pointer",
  };

  if (!snap) {
    // 视频帧不可用（理论上不可达：入口已保证视频有画面）：不渲染面板
    return null;
  }

  return (
    <>
      {/* Toolbar - RfNodeToolbar 恒定尺寸定位（与其它编辑工具栏统一） */}
      <RfNodeToolbar nodeId={nodeId} position={Position.Top} align="center" offset={8} isVisible>
      <WheelGuard
        className="canvas-toolbar nodrag flex items-center gap-1 rounded-xl"
        style={{
          height: 50,
          padding: "6px 10px",
          whiteSpace: "nowrap",
        }}
      >
        {/* 左组：✗ 关闭 + 标题 */}
        <div className="flex shrink-0 items-center gap-1">
          <Button type="text" size="middle" style={{ padding: 8 }} icon={<CloseOutlined />} onClick={onClose} />
          <span className="text-[13px]" style={{ color: "var(--canvas-text)" }}>{t("node.crop")}</span>
        </div>

        <div className="w-px h-5 mx-1" style={{ background: "var(--canvas-border)" }} />

        {ASPECT_PRESETS.map((p) => (
          <Button
            key={p.label}
            type="text"
            size="middle"
            style={{ padding: "4px 8px", fontSize: 12, ...(aspect === p.value ? { background: "var(--canvas-bg-hover)", color: "#fff" } : {}) }}
            onClick={() => handleAspectChange(p.value)}
          >
            {t(p.label)}
          </Button>
        ))}

        <div className="w-px h-5 mx-1" style={{ background: "var(--canvas-border)" }} />

        <span className="text-xs font-medium text-center" style={{ color: "var(--canvas-text-dim)", minWidth: 70 }}>
          {cropW} × {cropH}
        </span>

        <div className="w-px h-5 mx-1" style={{ background: "var(--canvas-border)" }} />

        <Tooltip title={t("crop.reset")}>
          <Button type="text" size="middle" style={{ padding: 8 }} icon={<UndoOutlined />} onClick={handleReset} />
        </Tooltip>

        <div className="w-px h-5 mx-1" style={{ background: "var(--canvas-border)" }} />

        {/* 确认：反色 ↑（与截取/变速工具栏一致） */}
        <PrimaryActionButton onClick={handleConfirm} disabled={!imgLoaded} />
      </WheelGuard>
      </RfNodeToolbar>

      {/* Crop overlay */}
      {/* 只覆盖视频画面区（标题栏以下）：面板挂在节点根部以露出顶部工具条，
          若用 inset-0 会把背景帧铺到标题栏里，画面被拉伸并超出视频显示区 */}
      <div
        className="nodrag absolute z-30 pointer-events-auto rounded-lg overflow-hidden"
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        style={{ top: NODE_TITLE_HEIGHT, left: 0, right: 0, bottom: 0, cursor: "crosshair", touchAction: "none" }}
      >
        {/* 背景是本地 dataURL 快照，不用 next/image */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          ref={imgRef}
          src={snap.src}
          alt=""
          draggable={false}
          onLoad={handleImgLoad}
          className="absolute inset-0 w-full h-full"
          style={{ pointerEvents: "none", userSelect: "none" }}
        />
        {/* Dark overlay outside crop area */}
        <div className="absolute inset-0 pointer-events-none" style={{ background: "rgba(0,0,0,0.5)" }} />

        {/* Cutout for crop area (clear the dark overlay) */}
        <div
          className="absolute pointer-events-none"
          style={{
            left: `${crop.x * 100}%`,
            top: `${crop.y * 100}%`,
            width: `${crop.w * 100}%`,
            height: `${crop.h * 100}%`,
            boxShadow: "0 0 0 9999px rgba(0,0,0,0.5)",
            border: "1.5px solid var(--canvas-success)",
          }}
        >
          {/* Rule of thirds */}
          <div className="absolute inset-0 pointer-events-none">
            <div className="absolute top-1/3 left-0 right-0 h-px" style={{ background: "rgba(255,255,255,0.3)" }} />
            <div className="absolute top-2/3 left-0 right-0 h-px" style={{ background: "rgba(255,255,255,0.3)" }} />
            <div className="absolute left-1/3 top-0 bottom-0 w-px" style={{ background: "rgba(255,255,255,0.3)" }} />
            <div className="absolute left-2/3 top-0 bottom-0 w-px" style={{ background: "rgba(255,255,255,0.3)" }} />
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
