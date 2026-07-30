"use client";

import { CheckOutlined, CloseOutlined, HighlightOutlined, UndoOutlined, RedoOutlined, BorderOutlined } from "@ant-design/icons";
import { useViewport } from "@xyflow/react";
import { Button, ColorPicker, Slider, Tooltip } from "antd";
import { useCallback, useEffect, useRef, useState } from "react";

import WheelGuard from "@/components/common/WheelGuard";
import { canvasToBlob, loadMediaDimensions, uploadAndAddNode } from "@/lib/image-utils";
import { useCanvasStore } from "@/stores/canvas-store";
import { useI18nStore } from "@/stores/i18n-store";

interface Props {
  src: string;
  sourceId: string;
  onClose: () => void;
}

const MAX_UNDO = 50;

type AnnotateMode = "brush" | "rect";

export default function AnnotationPanel({ src, sourceId, onClose }: Props) {
  const t = useI18nStore((s) => s.t);
  const setModalOpen = useCanvasStore((s) => s.setModalOpen);
  // Subscribe to React Flow viewport zoom so toolbar stays fixed size
  const { zoom } = useViewport();

  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);

  const [color, setColor] = useState("#FF0000");
  const [brushSize, setBrushSize] = useState(5);
  const [mode, setMode] = useState<AnnotateMode>("brush");
  const [loading, setLoading] = useState(false);
  const [imgLoaded, setImgLoaded] = useState(false);
  const [naturalSize, setNaturalSize] = useState({ w: 0, h: 0 });

  // undo/redo stacks using ImageData
  const undoStackRef = useRef<ImageData[]>([]);
  const redoStackRef = useRef<ImageData[]>([]);
  const [undoCount, setUndoCount] = useState(0);
  const [redoCount, setRedoCount] = useState(0);

  const drawingRef = useRef(false);
  const lastPointRef = useRef<{ x: number; y: number } | null>(null);

  // Rectangle preview state
  const rectStartRef = useRef<{ x: number; y: number } | null>(null);
  const previewSnapshotRef = useRef<ImageData | null>(null);

  // Lock canvas interaction while annotating
  useEffect(() => {
    setModalOpen(true);
    return () => setModalOpen(false);
  }, [setModalOpen]);

  // Load image natural dimensions
  useEffect(() => {
    let cancelled = false;
    loadMediaDimensions(src, false).then(({ w, h }) => {
      if (cancelled || w === 0) return;
      setNaturalSize({ w, h });
    });
    return () => { cancelled = true; };
  }, [src]);

  // Initialize canvas when image loads
  const handleImgLoad = useCallback(() => {
    const img = imgRef.current;
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!img || !canvas || !container) return;

    const nw = img.naturalWidth;
    const nh = img.naturalHeight;
    canvas.width = nw;
    canvas.height = nh;

    // Push initial empty state to undo stack
    const ctx = canvas.getContext("2d");
    if (ctx) {
      undoStackRef.current = [ctx.getImageData(0, 0, nw, nh)];
      setUndoCount(1);
      redoStackRef.current = [];
      setRedoCount(0);
    }
    setImgLoaded(true);
  }, []);

  // Convert pointer coords from display space to canvas/natural space
  const getCanvasPoint = useCallback((e: React.PointerEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top) * scaleY,
    };
  }, []);

  // ---- Pointer handlers ----
  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    if (!imgLoaded) return;

    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    drawingRef.current = true;
    const pt = getCanvasPoint(e);
    lastPointRef.current = pt;

    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!ctx) return;

    if (mode === "brush") {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, (brushSize * canvas.width) / canvas.getBoundingClientRect().width / 2, 0, Math.PI * 2);
      ctx.fill();
    } else if (mode === "rect") {
      rectStartRef.current = pt;
      previewSnapshotRef.current = ctx.getImageData(0, 0, canvas.width, canvas.height);
    }
  }, [color, brushSize, imgLoaded, getCanvasPoint, mode]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!drawingRef.current || !imgLoaded) return;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!ctx) return;

    const pt = getCanvasPoint(e);

    if (mode === "brush") {
      const last = lastPointRef.current;
      if (!last) return;

      const rect = canvas.getBoundingClientRect();
      const scale = canvas.width / rect.width;

      ctx.strokeStyle = color;
      ctx.lineWidth = brushSize * scale;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";

      ctx.beginPath();
      ctx.moveTo(last.x, last.y);
      ctx.lineTo(pt.x, pt.y);
      ctx.stroke();

      lastPointRef.current = pt;
    } else if (mode === "rect") {
      const start = rectStartRef.current;
      const snapshot = previewSnapshotRef.current;
      if (!start || !snapshot) return;

      ctx.putImageData(snapshot, 0, 0);
      const rect = canvas.getBoundingClientRect();
      const scale = canvas.width / rect.width;

      ctx.strokeStyle = color;
      ctx.lineWidth = brushSize * scale;
      ctx.strokeRect(
        Math.min(start.x, pt.x),
        Math.min(start.y, pt.y),
        Math.abs(pt.x - start.x),
        Math.abs(pt.y - start.y),
      );
    }
  }, [color, brushSize, imgLoaded, getCanvasPoint, mode]);

  const handlePointerUp = useCallback(() => {
    if (!drawingRef.current) return;
    drawingRef.current = false;
    lastPointRef.current = null;
    rectStartRef.current = null;
    previewSnapshotRef.current = null;

    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    undoStackRef.current.push(imageData);
    if (undoStackRef.current.length > MAX_UNDO) {
      undoStackRef.current.shift();
    }
    redoStackRef.current = [];
    setUndoCount(undoStackRef.current.length);
    setRedoCount(0);
  }, []);

  const handleUndo = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    if (undoStackRef.current.length <= 1) return;

    const current = undoStackRef.current.pop()!;
    redoStackRef.current.push(current);
    const prev = undoStackRef.current[undoStackRef.current.length - 1];
    ctx.putImageData(prev, 0, 0);

    setUndoCount(undoStackRef.current.length);
    setRedoCount(redoStackRef.current.length);
  }, []);

  const handleRedo = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    const next = redoStackRef.current.pop();
    if (!next) return;

    undoStackRef.current.push(next);
    ctx.putImageData(next, 0, 0);

    setUndoCount(undoStackRef.current.length);
    setRedoCount(redoStackRef.current.length);
  }, []);

  const handleSave = useCallback(async () => {
    setLoading(true);
    try {
      const img = imgRef.current;
      const canvas = canvasRef.current;
      if (!img || !canvas) return;

      const nw = naturalSize.w || img.naturalWidth;
      const nh = naturalSize.h || img.naturalHeight;

      const blob = await canvasToBlob(nw, nh, (ctx) => {
        ctx.drawImage(img, 0, 0, nw, nh);
        ctx.drawImage(canvas, 0, 0, nw, nh);
      });

      await uploadAndAddNode(sourceId, blob, " (标注)", { naturalWidth: nw, naturalHeight: nh });
      onClose();
    } catch (e) {
      console.error("Annotation save failed:", e);
    } finally {
      setLoading(false);
    }
  }, [sourceId, naturalSize, onClose]);

  return (
    <>
      {/* Toolbar - above node, in overlay layer, counter-scaled to stay fixed size */}
      <WheelGuard
        className="canvas-toolbar nodrag absolute left-1/2 flex items-center gap-1 rounded-xl z-40 pointer-events-auto"
        style={{
          height: 50,
          padding: "6px 10px",
          whiteSpace: "nowrap",
          // Position above node, counter-scaled to maintain fixed size regardless of zoom
          bottom: `calc(100% + 8px)`,
          transform: `translateX(-50%) scale(${1 / zoom})`,
          transformOrigin: "center bottom",
        }}
      >
        {/* Mode buttons */}
        <Tooltip title={t("annotation.mode.brush")}>
          <Button
            type="text"
            size="middle"
            style={{ padding: 8, ...(mode === "brush" ? { background: "var(--canvas-bg-hover)", color: "#fff" } : {}) }}
            icon={<HighlightOutlined />}
            onClick={() => setMode("brush")}
          />
        </Tooltip>
        <Tooltip title={t("annotation.mode.rect")}>
          <Button
            type="text"
            size="middle"
            style={{ padding: 8, ...(mode === "rect" ? { background: "var(--canvas-bg-hover)", color: "#fff" } : {}) }}
            icon={<BorderOutlined />}
            onClick={() => setMode("rect")}
          />
        </Tooltip>

        {/* Divider */}
        <div className="w-px h-5 mx-1" style={{ background: "var(--canvas-border)" }} />

        {/* Color picker */}
        <Tooltip title={t("annotation.color")}>
          <ColorPicker
            value={color}
            onChangeComplete={(c) => setColor(c.toHexString())}
            size="small"
            format="hex"
          />
        </Tooltip>

        {/* Divider */}
        <div className="w-px h-5 mx-1" style={{ background: "var(--canvas-border)" }} />

        {/* Brush size slider */}
        <div className="flex items-center gap-1.5" style={{ width: 90 }}>
          <HighlightOutlined style={{ fontSize: 12, color: "var(--canvas-text-dim)" }} />
          <Slider
            min={1}
            max={50}
            value={brushSize}
            tooltip={{ open: false }}
            onChange={(v) => setBrushSize(v as number)}
            style={{ width: 60, margin: 0 }}
          />
          <span className="text-[10px] font-medium" style={{ color: "var(--canvas-text-dim)", minWidth: 16 }}>
            {brushSize}
          </span>
        </div>

        {/* Divider */}
        <div className="w-px h-5 mx-1" style={{ background: "var(--canvas-border)" }} />

        {/* Undo / Redo */}
        <Tooltip title={t("annotation.undo")}>
          <Button type="text" size="middle" style={{ padding: 8 }} icon={<UndoOutlined />} disabled={undoCount <= 1} onClick={handleUndo} />
        </Tooltip>
        <Tooltip title={t("annotation.redo")}>
          <Button type="text" size="middle" style={{ padding: 8 }} icon={<RedoOutlined />} disabled={redoCount === 0} onClick={handleRedo} />
        </Tooltip>

        {/* Divider */}
        <div className="w-px h-5 mx-1" style={{ background: "var(--canvas-border)" }} />

        {/* Cancel / Save */}
        <Tooltip title={t("annotation.cancel")}>
          <Button type="text" size="middle" style={{ padding: 8 }} icon={<CloseOutlined />} onClick={onClose} />
        </Tooltip>
        <Tooltip title={t("annotation.save")}>
          <Button type="text" size="middle" style={{ padding: 8, color: loading || !imgLoaded ? undefined : "#1D9E75" }} icon={<CheckOutlined />} disabled={loading || !imgLoaded} onClick={handleSave} loading={loading} />
        </Tooltip>
      </WheelGuard>

      {/* Transparent canvas overlay - self-clipped to rounded corners */}
      <div
        ref={containerRef}
        className="nodrag absolute inset-0 z-30 pointer-events-auto rounded-lg overflow-hidden"
        style={{ cursor: "crosshair" }}
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
        <canvas
          ref={canvasRef}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            touchAction: "none",
          }}
        />
      </div>
    </>
  );
}
