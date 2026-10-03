/**
 * 头像裁剪弹窗。
 * 在固定圆形取景框内支持拖拽平移与滚轮 / 滑块缩放，
 * 确认后按固定输出分辨率导出并上传，回传头像 URL。
 */

"use client";

import { useCallback, useEffect,useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { useAppFeedback } from "@/components/ui/use-app-feedback";
import { uploadOne } from "@/features/canvas/upload";
import { canvasToBlob } from "@/lib/utils/image-utils";

interface Props {
  open: boolean;
  file: File | null;
  onDone: (url: string) => void;
  onClose: () => void;
}

const SIZE = 220; // crop area display size
const OUTPUT = 200; // output resolution

export default function AvatarCropModal({ open, file, onDone, onClose }: Props) {
  const { t } = useTranslation();
  const { message } = useAppFeedback();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const dragging = useRef(false);
  const dragStart = useRef({ x: 0, y: 0, ox: 0, oy: 0 });
  const prevZoom = useRef(1);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open || !file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      const i = new Image();
      i.onload = () => {
        setImg(i);
        const s = Math.min(i.naturalWidth, i.naturalHeight);
        const initZoom = SIZE / s;
        prevZoom.current = initZoom;
        setZoom(initZoom);
        const srcW = SIZE / initZoom;
        setOffset({
          x: (i.naturalWidth - srcW) / 2,
          y: (i.naturalHeight - srcW) / 2,
        });
      };
      i.src = e.target?.result as string;
    };
    reader.readAsDataURL(file);
    return () => { setImg(null); };
  }, [open, file]);

  // When zoom changes, adjust offset to keep center point stable
  useEffect(() => {
    if (!img) return;
    const oldSrcW = SIZE / prevZoom.current;
    const newSrcW = SIZE / zoom;
    setOffset((prev) => ({
      x: prev.x + (oldSrcW - newSrcW) / 2,
      y: prev.y + (oldSrcW - newSrcW) / 2,
    }));
    prevZoom.current = zoom;
  }, [img, zoom]);

  // Draw preview
  useEffect(() => {
    if (!img) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = SIZE;
    canvas.height = SIZE;
    const ctx = canvas.getContext("2d")!;
    const scale = zoom;
    const srcW = SIZE / scale;
    const srcH = SIZE / scale;
    ctx.drawImage(img, offset.x, offset.y, srcW, srcH, 0, 0, SIZE, SIZE);
  }, [img, offset, zoom]);

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    dragging.current = true;
    dragStart.current = { x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y };
  }, [offset]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragging.current || !img) return;
    const dx = (e.clientX - dragStart.current.x) / zoom;
    const dy = (e.clientY - dragStart.current.y) / zoom;
    const srcW = SIZE / zoom;
    const maxX = Math.max(0, img.naturalWidth - srcW);
    const maxY = Math.max(0, img.naturalHeight - srcW);
    const minX = Math.min(0, img.naturalWidth - srcW);
    const minY = Math.min(0, img.naturalHeight - srcW);
    const nx = Math.max(minX, Math.min(maxX, dragStart.current.ox - dx));
    const ny = Math.max(minY, Math.min(maxY, dragStart.current.oy - dy));
    setOffset({ x: nx, y: ny });
  }, [img, zoom]);

  const handlePointerUp = () => { dragging.current = false; };

  const handleSave = async () => {
    if (!img) return;
    setSaving(true);
    const srcW = SIZE / zoom;
    const blob = await canvasToBlob(OUTPUT, OUTPUT, (ctx) => {
      ctx.drawImage(img, offset.x, offset.y, srcW, srcW, 0, 0, OUTPUT, OUTPUT);
    });
    try {
      // 统一上传管道 raw sink：只取远程地址，不碰画布
      const result = await uploadOne(blob, "avatar.png", "derived");
      if (result?.url) { onDone(result.url); message.success(t("auth.avatarSaved")); }
      else message.error(t("auth.avatarFailed"));
    } catch { message.error(t("auth.avatarFailed")); }
    setSaving(false);
  };

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => { if (!nextOpen) onClose(); }}>
      <DialogContent
        showOverlay={false}
        className="sm:max-w-[360px]"
        onInteractOutside={(event) => event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>{t("auth.cropAvatar")}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col items-center gap-3">
        <div
          className="cursor-grab select-none overflow-hidden rounded-full border-[3px] border-border active:cursor-grabbing"
          style={{ width: SIZE, height: SIZE }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerLeave={handlePointerUp}
        >
          <canvas ref={canvasRef} width={SIZE} height={SIZE} style={{ width: SIZE, height: SIZE }} />
        </div>
        <div className="flex items-center gap-2 w-full">
          <Label htmlFor="avatar-zoom" className="text-xs text-muted-foreground">{t("common.zoom")}</Label>
          <Slider
            id="avatar-zoom"
            aria-label={t("common.zoom")}
            min={0.05}
            max={3}
            step={0.01}
            value={[zoom]}
            onValueChange={([value]) => { if (value !== undefined) setZoom(value); }}
            className="flex-1"
          />
        </div>
        <div className="flex gap-2 w-full">
          <Button variant="outline" onClick={onClose} block>{t("common.cancel")}</Button>
          <Button variant="primary" onClick={handleSave} loading={saving} block>{t("common.save")}</Button>
        </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
