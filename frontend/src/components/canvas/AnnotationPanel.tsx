"use client";

import { CheckOutlined, CloseOutlined, DeleteOutlined, HighlightOutlined, BorderOutlined, FontSizeOutlined } from "@ant-design/icons";
import { useViewport } from "@xyflow/react";
import { Button, ColorPicker, Slider, Tooltip } from "antd";
import { useCallback, useEffect, useRef, useState } from "react";

const UndoIcon = () => (
  <svg viewBox="0 0 16 16" width="1em" height="1em" fill="currentColor">
    <path d="M5.67 1.39 2.85 4.2h6.8a3.99 3.99 0 0 1 0 7.97H7.19v-1.05h2.46a2.94 2.94 0 0 0 0-5.87h-6.8l2.82 2.82-.75.74L.84 4.73 4.92.64z" />
  </svg>
);

const RedoIcon = () => (
  <svg viewBox="0 0 16 16" width="1em" height="1em" fill="currentColor">
    <path d="m8.55 2.05 2.82 2.81h-6.8a3.99 3.99 0 0 0 0 7.97h2.45v-1.05H4.57a2.94 2.94 0 0 1 0-5.87h6.8L8.55 8.73l.74.74 4.09-4.08L9.29 1.3z" />
  </svg>
);

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

type AnnotateMode = "brush" | "rect" | "text";

/** 已确认的文字标注项（可拖动的 DOM 标签） */
interface TextAnnotation {
  id: string;
  x: number;   // canvas natural coords
  y: number;   // canvas natural coords
  text: string;
  color: string;
  fontSize: number;
}

const BrushSizeIcon = () => (
  <svg viewBox="0 0 16 16" width="1em" height="1em" fill="currentColor" style={{ fontSize: 16 }}>
    <path d="M8.631 1.304c.394-.142.802-.22 1.196-.168.409.054.774.245 1.058.583.334.397.374.874.273 1.32-.098.43-.335.875-.622 1.305-.576.863-1.473 1.834-2.324 2.763-.872.95-1.699 1.857-2.21 2.641-.257.393-.406.715-.458.963-.047.231-.004.354.073.443.093.108.191.149.345.14.184-.012.443-.1.78-.293.672-.385 1.462-1.076 2.285-1.844.799-.745 1.632-1.566 2.33-2.128.348-.28.7-.527 1.027-.668.288-.125.706-.23 1.078 0l.073.05.129.106c.286.256.46.57.519.926.064.388-.017.778-.149 1.136-.26.702-.794 1.463-1.283 2.153-.513.724-.985 1.384-1.235 1.964-.252.58-.197.872.004 1.07a.58.58 0 0 0 .38.187c.137.01.312-.025.532-.124.451-.203.946-.61 1.442-1.056l.348.387.348.386c-.49.44-1.093.953-1.71 1.232-.315.142-.668.239-1.035.212a1.62 1.62 0 0 1-1.037-.485c-.672-.665-.53-1.52-.227-2.222.304-.703.855-1.465 1.342-2.152.511-.722.953-1.366 1.156-1.913.098-.268.12-.464.097-.606a.54.54 0 0 0-.216-.344.6.6 0 0 0-.143.047q-.293.127-.789.524c-.658.53-1.435 1.299-2.272 2.08-.814.759-1.686 1.531-2.477 1.984-.394.227-.817.402-1.234.428a1.41 1.41 0 0 1-1.198-.5c-.34-.396-.395-.874-.301-1.329.09-.437.32-.887.604-1.322.569-.871 1.463-1.847 2.315-2.776.873-.952 1.704-1.857 2.226-2.638.262-.391.416-.711.473-.958.052-.23.01-.342-.054-.419a.6.6 0 0 0-.4-.221c-.172-.023-.405.006-.707.114-.612.22-1.365.712-2.199 1.382C5.116 5.005 3.326 6.88 1.911 8.206l-.711-.76c1.347-1.262 3.226-3.22 4.933-4.592.854-.687 1.717-1.27 2.498-1.55" />
  </svg>
);

export default function AnnotationPanel({ src, sourceId, onClose }: Props) {
  const t = useI18nStore((s) => s.t);
  const setModalOpen = useCanvasStore((s) => s.setModalOpen);
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

  // undo/redo stacks
  const undoStackRef = useRef<ImageData[]>([]);
  const redoStackRef = useRef<ImageData[]>([]);
  const [undoCount, setUndoCount] = useState(0);
  const [redoCount, setRedoCount] = useState(0);

  const drawingRef = useRef(false);
  const lastPointRef = useRef<{ x: number; y: number } | null>(null);

  // Rectangle preview state
  const rectStartRef = useRef<{ x: number; y: number } | null>(null);
  const previewSnapshotRef = useRef<ImageData | null>(null);

  // ---- Text annotation state ----
  /** 已确认的文字标注列表（DOM 标签，可拖动） */
  const [textAnnotations, setTextAnnotations] = useState<TextAnnotation[]>([]);
  /** 文字输入框是否可见 */
  const [textInputVisible, setTextInputVisible] = useState(false);
  /** 文字输入位置（canvas natural coords） */
  const [textInputPos, setTextInputPos] = useState({ x: 0, y: 0 });
  /** 文字输入内容 */
  const [textValue, setTextValue] = useState("");
  const textInputRef = useRef<HTMLTextAreaElement>(null);
  /** 正在拖动的文字标注 ID */
  const draggingTextRef = useRef<string | null>(null);
  const dragOffsetRef = useRef({ x: 0, y: 0 });
  /** 已确认文字的 undo/redo */
  const textUndoStackRef = useRef<TextAnnotation[][]>([]);
  const textRedoStackRef = useRef<TextAnnotation[][]>([]);

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

  /** 将 canvas natural 坐标转为容器百分比 */
  const naturalToPercent = useCallback((nx: number, ny: number) => {
    return {
      left: `${(nx / (naturalSize.w || 1)) * 100}%`,
      top: `${(ny / (naturalSize.h || 1)) * 100}%`,
    };
  }, [naturalSize]);

  /** 将容器像素偏移转为 natural 坐标偏移 */
  const pixelToNatural = useCallback((px: number, py: number) => {
    const container = containerRef.current;
    if (!container) return { x: 0, y: 0 };
    const rect = container.getBoundingClientRect();
    return {
      x: (px / (rect.width || 1)) * (naturalSize.w || 1),
      y: (py / (rect.height || 1)) * (naturalSize.h || 1),
    };
  }, [naturalSize]);

  // ==================== Text handlers ====================

  /** 确认当前输入的文字，转为可拖动标签 */
  const confirmTextAnnotation = useCallback(() => {
    const value = textValue.trim();
    if (!value) {
      setTextInputVisible(false);
      setTextValue("");
      return;
    }

    const canvas = canvasRef.current;
    const scale = canvas ? canvas.width / (canvas.getBoundingClientRect().width || 1) : 1;
    const fontSize = brushSize * scale * 3;

    const newAnnotation: TextAnnotation = {
      id: `text-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      x: textInputPos.x,
      y: textInputPos.y,
      text: value,
      color,
      fontSize,
    };

    // Save current annotations for undo
    textUndoStackRef.current.push([...textAnnotations]);
    if (textUndoStackRef.current.length > MAX_UNDO) textUndoStackRef.current.shift();
    textRedoStackRef.current = [];

    setTextAnnotations((prev) => [...prev, newAnnotation]);
    setTextInputVisible(false);
    setTextValue("");
  }, [textValue, textInputPos, color, brushSize, textAnnotations]);

  const cancelTextInput = useCallback(() => {
    setTextInputVisible(false);
    setTextValue("");
  }, []);

  const handleTextKeyDown = useCallback((e: React.KeyboardEvent) => {
    // Allow Shift+Enter for newline
    if (e.key === "Enter" && !e.shiftKey) {
      // Don't auto-confirm on Enter; user clicks elsewhere to confirm
      e.stopPropagation();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancelTextInput();
    }
  }, [cancelTextInput]);

  /** 删除文字标注 */
  const deleteTextAnnotation = useCallback((id: string) => {
    textUndoStackRef.current.push([...textAnnotations]);
    if (textUndoStackRef.current.length > MAX_UNDO) textUndoStackRef.current.shift();
    textRedoStackRef.current = [];
    setTextAnnotations((prev) => prev.filter((a) => a.id !== id));
  }, [textAnnotations]);

  // ==================== Text drag handlers ====================

  const handleTextDragStart = useCallback((e: React.PointerEvent, id: string) => {
    e.preventDefault();
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    draggingTextRef.current = id;

    const target = e.currentTarget as HTMLElement;
    const rect = target.getBoundingClientRect();
    dragOffsetRef.current = {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    };
  }, []);

  const handleTextDragMove = useCallback((e: React.PointerEvent) => {
    if (!draggingTextRef.current) return;
    const id = draggingTextRef.current;
    const container = containerRef.current;
    if (!container) return;

    const containerRect = container.getBoundingClientRect();
    const rawX = e.clientX - containerRect.left - dragOffsetRef.current.x;
    const rawY = e.clientY - containerRect.top - dragOffsetRef.current.y;

    // Convert pixel offset within container to natural coords
    const natural = pixelToNatural(rawX, rawY);

    setTextAnnotations((prev) =>
      prev.map((a) => (a.id === id ? { ...a, x: natural.x, y: natural.y } : a))
    );
  }, [pixelToNatural]);

  const handleTextDragEnd = useCallback(() => {
    draggingTextRef.current = null;
  }, []);

  // ==================== Pointer handlers ====================

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    if (!imgLoaded) return;

    if (mode === "text") {
      // If text input is open, clicking elsewhere confirms the text
      if (textInputVisible) {
        confirmTextAnnotation();
        return;
      }
      // Otherwise, open text input at click point
      e.preventDefault();
      const pt = getCanvasPoint(e);
      setTextInputPos(pt);
      setTextValue("");
      setTextInputVisible(true);
      requestAnimationFrame(() => textInputRef.current?.focus());
      return;
    }

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
  }, [color, brushSize, imgLoaded, getCanvasPoint, mode, textInputVisible, confirmTextAnnotation]);

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

  // ==================== Undo / Redo ====================

  const handleUndo = useCallback(() => {
    // Undo text annotations first
    if (textUndoStackRef.current.length > 0) {
      const prev = textUndoStackRef.current.pop()!;
      textRedoStackRef.current.push([...textAnnotations]);
      setTextAnnotations(prev);
      return;
    }

    // Then undo canvas drawings
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
  }, [textAnnotations]);

  const handleRedo = useCallback(() => {
    // Redo text annotations first
    if (textRedoStackRef.current.length > 0) {
      const next = textRedoStackRef.current.pop()!;
      textUndoStackRef.current.push([...textAnnotations]);
      setTextAnnotations(next);
      return;
    }

    // Then redo canvas drawings
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    const next = redoStackRef.current.pop();
    if (!next) return;

    undoStackRef.current.push(next);
    ctx.putImageData(next, 0, 0);

    setUndoCount(undoStackRef.current.length);
    setRedoCount(redoStackRef.current.length);
  }, [textAnnotations]);

  // ==================== Save ====================

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

        // Render all text annotations onto the composition
        for (const ta of textAnnotations) {
          ctx.fillStyle = ta.color;
          ctx.font = `${ta.fontSize}px sans-serif`;
          ctx.textBaseline = "top";
          ctx.textAlign = "left";
          const lines = ta.text.split("\n");
          const lineHeight = ta.fontSize * 1.3;
          for (let i = 0; i < lines.length; i++) {
            ctx.fillText(lines[i], ta.x, ta.y + i * lineHeight);
          }
        }
      });

      await uploadAndAddNode(sourceId, blob, " (标注)", { naturalWidth: nw, naturalHeight: nh });
      onClose();
    } catch (e) {
      console.error("Annotation save failed:", e);
    } finally {
      setLoading(false);
    }
  }, [sourceId, naturalSize, textAnnotations, onClose]);

  // Allow undo on canvas OR text annotations
  const canUndo = undoCount > 1 || textUndoStackRef.current.length > 0;
  const canRedo = redoCount > 0 || textRedoStackRef.current.length > 0;

  return (
    <>
      {/* Toolbar */}
      <WheelGuard
        className="canvas-toolbar nodrag absolute left-1/2 flex items-center gap-1 rounded-xl z-40 pointer-events-auto"
        style={{
          height: 50,
          padding: "6px 10px",
          whiteSpace: "nowrap",
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
        <Tooltip title={t("annotation.mode.text")}>
          <Button
            type="text"
            size="middle"
            style={{ padding: 8, ...(mode === "text" ? { background: "var(--canvas-bg-hover)", color: "#fff" } : {}) }}
            icon={<FontSizeOutlined />}
            onClick={() => setMode("text")}
          />
        </Tooltip>

        <div className="w-px h-5 mx-1" style={{ background: "var(--canvas-border)" }} />

        {/* Color picker */}
        <Tooltip title={t("annotation.color")}>
          <ColorPicker value={color} onChangeComplete={(c) => setColor(c.toHexString())} size="small" format="hex" />
        </Tooltip>

        <div className="w-px h-5 mx-1" style={{ background: "var(--canvas-border)" }} />

        {/* Brush size slider */}
        <div className="flex items-center gap-1.5" style={{ width: 90 }}>
          <BrushSizeIcon />
          <Slider min={1} max={50} value={brushSize} tooltip={{ open: false }} onChange={(v) => setBrushSize(v as number)} style={{ width: 60, margin: 0 }} />
          <span className="text-[10px] font-medium" style={{ color: "var(--canvas-text-dim)", minWidth: 16 }}>{brushSize}</span>
        </div>

        <div className="w-px h-5 mx-1" style={{ background: "var(--canvas-border)" }} />

        {/* Undo / Redo */}
        <Tooltip title={t("annotation.undo")}>
          <Button type="text" size="middle" style={{ padding: 8 }} icon={<UndoIcon />} disabled={!canUndo} onClick={handleUndo} />
        </Tooltip>
        <Tooltip title={t("annotation.redo")}>
          <Button type="text" size="middle" style={{ padding: 8 }} icon={<RedoIcon />} disabled={!canRedo} onClick={handleRedo} />
        </Tooltip>

        <div className="w-px h-5 mx-1" style={{ background: "var(--canvas-border)" }} />

        {/* Cancel / Save */}
        <Tooltip title={t("annotation.cancel")}>
          <Button type="text" size="middle" style={{ padding: 8 }} icon={<CloseOutlined />} onClick={onClose} />
        </Tooltip>
        <Tooltip title={t("annotation.save")}>
          <Button type="text" size="middle" style={{ padding: 8, color: loading || !imgLoaded ? undefined : "#1D9E75" }} icon={<CheckOutlined />} disabled={loading || !imgLoaded} onClick={handleSave} loading={loading} />
        </Tooltip>
      </WheelGuard>

      {/* Canvas overlay */}
      <div
        ref={containerRef}
        className="nodrag absolute inset-0 z-30 pointer-events-auto rounded-lg overflow-hidden"
        style={{ cursor: mode === "text" ? "cell" : "crosshair" }}
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
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%", touchAction: "none" }}
        />

        {/* Text input overlay */}
        {textInputVisible && (
          <textarea
            ref={textInputRef}
            className="nodrag nowheel"
            value={textValue}
            onChange={(e) => setTextValue(e.target.value)}
            onKeyDown={handleTextKeyDown}
            placeholder={t("annotation.text.placeholder")}
            style={{
              position: "absolute",
              left: naturalToPercent(textInputPos.x, textInputPos.y).left,
              top: naturalToPercent(textInputPos.x, textInputPos.y).top,
              minWidth: 120,
              minHeight: 28,
              padding: "2px 4px",
              border: "1px solid #1D9E75",
              background: "rgba(0,0,0,0.65)",
              color: color,
              fontSize: 14,
              fontFamily: "sans-serif",
              lineHeight: 1.3,
              resize: "both",
              outline: "none",
              borderRadius: 4,
              pointerEvents: "auto",
              zIndex: 50,
            }}
          />
        )}

        {/* Confirmed text annotations (draggable) */}
        {textAnnotations.map((ta) => (
          <div
            key={ta.id}
            className="nodrag group absolute pointer-events-auto select-none"
            style={{
              left: naturalToPercent(ta.x, ta.y).left,
              top: naturalToPercent(ta.x, ta.y).top,
              color: ta.color,
              fontSize: 14,
              fontFamily: "sans-serif",
              lineHeight: 1.4,
              whiteSpace: "pre-wrap",
              textShadow: "0 0 3px rgba(0,0,0,0.8), 0 0 6px rgba(0,0,0,0.6)",
              cursor: "move",
              zIndex: 40,
              padding: "2px 4px",
              borderRadius: 2,
              background: "rgba(0,0,0,0.15)",
            }}
            onPointerDown={(e) => handleTextDragStart(e, ta.id)}
            onPointerMove={handleTextDragMove}
            onPointerUp={handleTextDragEnd}
            onPointerCancel={handleTextDragEnd}
          >
            {ta.text.split("\n").map((line, i) => (
              <span key={i} style={{ display: "block" }}>{line}</span>
            ))}
            {/* Delete button */}
            <button
              className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
              style={{ background: "rgba(60,60,60,0.9)", color: "#fff", fontSize: 10, border: "none", cursor: "pointer", lineHeight: 1, padding: 0 }}
              onPointerDown={(e) => { e.stopPropagation(); e.preventDefault(); }}
              onClick={(e) => { e.stopPropagation(); deleteTextAnnotation(ta.id); }}
            >
              <DeleteOutlined style={{ fontSize: 8 }} />
            </button>
          </div>
        ))}
      </div>
    </>
  );
}
