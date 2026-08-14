/**
 * 图片裁剪面板（自实现拖拽手柄版本）。
 * 支持自由与预设比例裁剪、八向手柄调整与整体移动，
 * 确认后裁切图片并上传为新的图片节点。
 */
"use client";

import { CheckOutlined, CloseOutlined, UndoOutlined } from "@ant-design/icons";
import { Button, Tooltip } from "antd";
import { useCallback, useEffect, useRef, useState } from "react";
import { useViewport } from "@xyflow/react";

import WheelGuard from "@/components/ui/WheelGuard";
import { NODE_TITLE_HEIGHT } from "@/lib/constants";
import { canvasToBlob, loadMediaDimensions, uploadAndAddNode } from "@/lib/utils/image-utils";
import { useCanvasStore } from "@/features/canvas/stores/canvas-store";
import { useTranslation } from "react-i18next";

interface Props {
  src: string;
  sourceId: string;
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

export default function CropPanel({ src, sourceId, onClose }: Props) {
  const { t } = useTranslation();
  const setModalOpen = useCanvasStore((s) => s.setModalOpen);
  const { zoom } = useViewport();

  const imgRef = useRef<HTMLImageElement>(null);
  const [loading, setLoading] = useState(false);
  const [imgLoaded, setImgLoaded] = useState(false);
  const [naturalSize, setNaturalSize] = useState({ w: 0, h: 0 });
  const [displaySize, setDisplaySize] = useState({ w: 0, h: 0 });
  const [aspect, setAspect] = useState<number | undefined>(undefined);
  const [crop, setCrop] = useState<CropRect>({ x: 0.1, y: 0.1, w: 0.8, h: 0.8 });

  const dragRef = useRef<{ handle: Handle; startMouseX: number; startMouseY: number; startRect: CropRect } | null>(null);

  useEffect(() => {
    setModalOpen(true);
    let cancelled = false;
    loadMediaDimensions(src, false).then(({ w, h }) => {
      if (cancelled || w === 0) return;
      setNaturalSize({ w, h });
    });
    return () => { cancelled = true; setModalOpen(false); };
  }, [src, setModalOpen]);

  const handleImgLoad = useCallback(() => {
    const img = imgRef.current;
    if (!img) return;
    // Use clientWidth/clientHeight (CSS layout size, unaffected by React Flow zoom)
    setDisplaySize({ w: img.clientWidth, h: img.clientHeight });
    setImgLoaded(true);
  }, []);

  // Convert display pixels to crop fractions (0-1)
  const getFraction = useCallback((e: PointerEvent | React.PointerEvent) => {
    const img = imgRef.current;
    if (!img) return { x: 0, y: 0 };
    const rect = img.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height)),
    };
  }, []);

  // Clamp crop rect to [0,1] bounds with optional aspect lock
  // aspect is in image pixel space (e.g. 4/3 means w:h = 4:3 in pixels)
  // In fraction space: pixelW = w * dispW, pixelH = h * dispH
  // So pixelAspect = (w * dispW) / (h * dispH) => w/h = pixelAspect * dispH / dispW
  const clampRect = useCallback((r: CropRect, lockAspect?: number): CropRect => {
    let { x, y, w, h } = r;
    const fracAspect = lockAspect ? lockAspect * (displaySize.h / displaySize.w) : 0;
    if (lockAspect && lockAspect > 0) {
      h = w / fracAspect;
    }
    // Min size
    w = Math.max(MIN_SIZE / displaySize.w, w);
    h = Math.max(MIN_SIZE / displaySize.h, h);
    // Clamp to bounds
    if (x < 0) { w += x; x = 0; }
    if (y < 0) { h += y; y = 0; }
    if (x + w > 1) w = 1 - x;
    if (y + h > 1) h = 1 - y;
    if (lockAspect && lockAspect > 0) {
      w = h * fracAspect;
      if (x + w > 1) { w = 1 - x; h = w / fracAspect; }
    }
    return { x, y, w, h };
  }, [displaySize]);

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
    // Delta in fractions
    const dx = pt.x - (dragRef.current.startMouseX - rect.left) / rect.width;
    const dy = pt.y - (dragRef.current.startMouseY - rect.top) / rect.height;

    const r = { ...startRect };
    if (handle === "move") {
      r.x = Math.max(0, Math.min(1 - startRect.w, startRect.x + dx));
      r.y = Math.max(0, Math.min(1 - startRect.h, startRect.y + dy));
    } else {
      // Resize: move only the dragged edge, keep opposite edge fixed
      if (handle.includes("w")) { r.x = startRect.x + dx; r.w = startRect.w - dx; }
      if (handle.includes("e")) { r.w = startRect.w + dx; }
      if (handle.includes("n")) { r.y = startRect.y + dy; r.h = startRect.h - dy; }
      if (handle.includes("s")) { r.h = startRect.h + dy; }
      // Handle aspect lock during resize
      if (aspect && aspect > 0) {
        const fa = aspect * (displaySize.h / displaySize.w);
        if (handle === "n" || handle === "s") {
          // Height drove the change, adjust width and center horizontally
          r.w = r.h * fa;
          r.x = startRect.x + (startRect.w - r.w) / 2;
        } else if (handle === "e" || handle === "w") {
          // Width drove the change, adjust height and center vertically
          r.h = r.w / fa;
          r.y = startRect.y + (startRect.h - r.h) / 2;
        } else {
          // Corner: keep opposite corner fixed
          r.w = r.h * fa;
          if (handle === "nw") { r.x = startRect.x + startRect.w - r.w; }
          else if (handle === "sw") { r.x = startRect.x + startRect.w - r.w; }
          // ne, se: r.x stays (west edge fixed by "e" handler)
        }
      }
      // Normalize negative width/height
      if (r.w < 0) { r.x += r.w; r.w = -r.w; }
      if (r.h < 0) { r.y += r.h; r.h = -r.h; }
    }
    setCrop(clampRect(r, aspect));
  }, [getFraction, aspect, clampRect]);

  const handlePointerUp = useCallback(() => {
    dragRef.current = null;
  }, []);

  const handleAspectChange = useCallback((newAspect?: number) => {
    setAspect(newAspect);
    if (newAspect && newAspect > 0) {
      // pixelAspect = (w * dispW) / (h * dispH) => w/h = pixelAspect * dispH / dispW
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

  const handleConfirm = useCallback(async () => {
    if (loading || !imgRef.current) return;
    setLoading(true);
    try {
      const img = imgRef.current;
      const nw = naturalSize.w || img.naturalWidth;
      const nh = naturalSize.h || img.naturalHeight;

      const sx = Math.round(crop.x * nw);
      const sy = Math.round(crop.y * nh);
      const sw = Math.round(crop.w * nw);
      const sh = Math.round(crop.h * nh);

      const blob = await canvasToBlob(sw, sh, (ctx) => {
        ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
      });

      await uploadAndAddNode(sourceId, blob, " (cropped)", useCanvasStore.getState(), { naturalWidth: sw, naturalHeight: sh, source: "derived" }, undefined, "derived");
      onClose();
    } catch (e) {
      console.error("Crop failed:", e);
    } finally {
      setLoading(false);
    }
  }, [loading, naturalSize, crop, sourceId, onClose]);

  // Info display
  const cropW = Math.round(crop.w * (naturalSize.w || displaySize.w));
  const cropH = Math.round(crop.h * (naturalSize.h || displaySize.h));
  const activePreset = ASPECT_PRESETS.find((p) => p.value === aspect);

  const handleStyle: React.CSSProperties = {
    position: "absolute",
    width: 10,
    height: 10,
    background: "#fff",
    border: "1.5px solid #1D9E75",
    borderRadius: 3,
    pointerEvents: "auto",
    cursor: "pointer",
  };

  return (
    <>
      {/* Toolbar - above node, counter-scaled */}
      <WheelGuard
        className="canvas-toolbar nodrag absolute left-1/2 flex items-center gap-1 rounded-xl z-40 pointer-events-auto"
        style={{
          height: 50,
          padding: "6px 10px",
          whiteSpace: "nowrap",
          bottom: `calc(100% + ${NODE_TITLE_HEIGHT + 8 / zoom}px)`,
          transform: `translateX(-50%) scale(${1 / zoom})`,
          transformOrigin: "center bottom",
        }}
      >
        {/* Aspect presets */}
        {ASPECT_PRESETS.map((p) => (
          <Tooltip key={p.label} title={t(p.label)}>
            <Button
              type="text"
              size="middle"
              style={{ padding: "4px 8px", fontSize: 12, ...(aspect === p.value ? { background: "var(--canvas-bg-hover)", color: "#fff" } : {}) }}
              onClick={() => handleAspectChange(p.value)}
            >
              {t(p.label)}
            </Button>
          </Tooltip>
        ))}

        <div className="w-px h-5 mx-1" style={{ background: "var(--canvas-border)" }} />

        {/* Info */}
        <span className="text-[11px] font-medium text-center" style={{ color: "var(--canvas-text-dim)", minWidth: 70 }}>
          {cropW} × {cropH}
        </span>

        <div className="w-px h-5 mx-1" style={{ background: "var(--canvas-border)" }} />

        {/* Reset */}
        <Tooltip title={t("crop.reset")}>
          <Button type="text" size="middle" style={{ padding: 8 }} icon={<UndoOutlined />} onClick={handleReset} />
        </Tooltip>

        <div className="w-px h-5 mx-1" style={{ background: "var(--canvas-border)" }} />

        {/* Cancel / Confirm */}
        <Tooltip title={t("crop.cancel")}>
          <Button type="text" size="middle" style={{ padding: 8 }} icon={<CloseOutlined />} onClick={onClose} />
        </Tooltip>
        <Tooltip title={t("crop.confirm")}>
          <Button type="text" size="middle" style={{ padding: 8, color: loading ? undefined : "#1D9E75" }} icon={<CheckOutlined />} disabled={loading || !imgLoaded} onClick={handleConfirm} loading={loading} />
        </Tooltip>
      </WheelGuard>

      {/* Crop overlay */}
      <div
        className="nodrag absolute inset-0 z-30 pointer-events-auto rounded-lg overflow-hidden"
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        style={{ cursor: "crosshair", touchAction: "none" }}
      >
        <img
          ref={imgRef}
          src={src}
          alt=""
          crossOrigin="anonymous"
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
            border: "1.5px solid #1D9E75",
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
        {/* Corners */}
        <div onPointerDown={(e) => handlePointerDown(e, "nw")} style={{ ...handleStyle, left: `${crop.x * 100}%`, top: `${crop.y * 100}%`, transform: "translate(-50%, -50%)", cursor: "nw-resize" }} />
        <div onPointerDown={(e) => handlePointerDown(e, "ne")} style={{ ...handleStyle, left: `${(crop.x + crop.w) * 100}%`, top: `${crop.y * 100}%`, transform: "translate(-50%, -50%)", cursor: "ne-resize" }} />
        <div onPointerDown={(e) => handlePointerDown(e, "sw")} style={{ ...handleStyle, left: `${crop.x * 100}%`, top: `${(crop.y + crop.h) * 100}%`, transform: "translate(-50%, -50%)", cursor: "sw-resize" }} />
        <div onPointerDown={(e) => handlePointerDown(e, "se")} style={{ ...handleStyle, left: `${(crop.x + crop.w) * 100}%`, top: `${(crop.y + crop.h) * 100}%`, transform: "translate(-50%, -50%)", cursor: "se-resize" }} />
        {/* Edges */}
        <div onPointerDown={(e) => handlePointerDown(e, "n")} style={{ ...handleStyle, left: `${(crop.x + crop.w / 2) * 100}%`, top: `${crop.y * 100}%`, transform: "translate(-50%, -50%)", cursor: "n-resize" }} />
        <div onPointerDown={(e) => handlePointerDown(e, "s")} style={{ ...handleStyle, left: `${(crop.x + crop.w / 2) * 100}%`, top: `${(crop.y + crop.h) * 100}%`, transform: "translate(-50%, -50%)", cursor: "s-resize" }} />
        <div onPointerDown={(e) => handlePointerDown(e, "w")} style={{ ...handleStyle, left: `${crop.x * 100}%`, top: `${(crop.y + crop.h / 2) * 100}%`, transform: "translate(-50%, -50%)", cursor: "w-resize" }} />
        <div onPointerDown={(e) => handlePointerDown(e, "e")} style={{ ...handleStyle, left: `${(crop.x + crop.w) * 100}%`, top: `${(crop.y + crop.h / 2) * 100}%`, transform: "translate(-50%, -50%)", cursor: "e-resize" }} />
      </div>
    </>
  );
}
