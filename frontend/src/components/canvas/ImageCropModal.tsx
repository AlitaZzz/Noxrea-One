"use client";

import "react-image-crop/dist/ReactCrop.css";

import { useCallback, useEffect, useRef,useState } from "react";
import ReactCrop, {
  centerCrop,
  convertToPixelCrop,
  type Crop,
  makeAspectCrop,
} from "react-image-crop";

import ModalButton from "@/components/common/ModalButton";
import NavButton from "@/components/common/NavButton";
import AppModal from "@/lib/app-modal";
import { canvasToBlob,uploadAndAddNode } from "@/lib/image-utils";
import { useCanvasStore } from "@/stores/canvas-store";

interface Props {
  src: string;
  sourceId: string;
  onClose: () => void;
}

const ASPECT_PRESETS: { label: string; value?: number }[] = [
  { label: "自由", value: undefined },
  { label: "1:1", value: 1 },
  { label: "4:3", value: 4 / 3 },
  { label: "3:4", value: 3 / 4 },
  { label: "16:9", value: 16 / 9 },
  { label: "9:16", value: 9 / 16 },
];

function centerAspectCrop(mediaWidth: number, mediaHeight: number, aspect?: number): Crop {
  if (!aspect) {
    // Free mode: default to 80% of the smaller dimension
    const pct = 80;
    return { unit: "%", x: (100 - pct) / 2, y: (100 - pct) / 2, width: pct, height: pct };
  }
  return centerCrop(
    makeAspectCrop({ unit: "%", width: 80 }, aspect, mediaWidth, mediaHeight),
    mediaWidth,
    mediaHeight,
  );
}

export default function ImageCropModal({ src, sourceId, onClose }: Props) {
  const imgRef = useRef<HTMLImageElement>(null);
  const [crop, setCrop] = useState<Crop>();
  const [completedCrop, setCompletedCrop] = useState<Crop | null>(null);
  const [aspect, setAspect] = useState<number | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [naturalSize, setNaturalSize] = useState({ w: 0, h: 0 });
  const [displaySize, setDisplaySize] = useState({ w: 0, h: 0 });
  const [imgLoaded, setImgLoaded] = useState(false);

  const setModalOpen = useCanvasStore((s) => s.setModalOpen);

  // Sync crop → completedCrop so it's always set (not just after user drag),
  // adjusted during render to avoid cascading renders.
  const [prevCrop, setPrevCrop] = useState(crop);
  if (crop !== prevCrop) {
    setPrevCrop(crop);
    if (crop) setCompletedCrop(crop);
  }

  // Preload to get natural dimensions
  useEffect(() => {
    setModalOpen(true);
    const img = new window.Image();
    img.onload = () => {
      setNaturalSize({ w: img.naturalWidth, h: img.naturalHeight });
      setCrop(centerAspectCrop(img.naturalWidth, img.naturalHeight));
      setImgLoaded(true);
    };
    img.src = src;
    return () => setModalOpen(false);
  }, [src, setModalOpen]);

  const onImageLoad = useCallback(
    (e: React.SyntheticEvent<HTMLImageElement>) => {
      const img = e.currentTarget;
      const rect = img.getBoundingClientRect();
      setDisplaySize({ w: rect.width, h: rect.height });
      setCrop(centerAspectCrop(img.naturalWidth, img.naturalHeight, aspect));
    },
    [aspect],
  );

  const handleAspectChange = (newAspect?: number) => {
    setAspect(newAspect);
    if (imgRef.current) {
      const { naturalWidth, naturalHeight } = imgRef.current;
      setCrop(centerAspectCrop(naturalWidth, naturalHeight, newAspect));
    }
  };

  const handleReset = () => {
    setAspect(undefined);
    if (imgRef.current) {
      const { naturalWidth, naturalHeight } = imgRef.current;
      setCrop(centerAspectCrop(naturalWidth, naturalHeight));
    }
  };

  const handleConfirm = async () => {
    if (!completedCrop || loading || !imgRef.current) return;
    setLoading(true);
    useCanvasStore.getState().updateNodeData(sourceId, { taskBinding: { taskId: "", status: "processing" } }, undefined, { forceHistory: true });

    try {
      const img = imgRef.current;
      const rect = img.getBoundingClientRect();
      const dispW = rect.width;
      const dispH = rect.height;
      const pixelCrop = convertToPixelCrop(completedCrop, dispW, dispH);

      // Scale from display coordinates to natural image coordinates
      const scaleX = img.naturalWidth / dispW;
      const scaleY = img.naturalHeight / dispH;

      const cw = Math.round(pixelCrop.width * scaleX);
      const ch = Math.round(pixelCrop.height * scaleY);
      const blob = await canvasToBlob(cw, ch, (ctx) => {
        ctx.drawImage(
          img,
          pixelCrop.x * scaleX, pixelCrop.y * scaleY,
          pixelCrop.width * scaleX, pixelCrop.height * scaleY,
          0, 0, cw, ch,
        );
      });

      await uploadAndAddNode(sourceId, blob, " (cropped)", {
        naturalWidth: cw,
        naturalHeight: ch,
      });

      onClose();
    } catch (e) {
      console.error("crop failed:", e);
    } finally {
      useCanvasStore.getState().updateNodeData(sourceId, { taskBinding: undefined }, undefined, { skipHistory: true });
      setLoading(false);
    }
  };

  const scale = naturalSize.w > 0 && displaySize.w > 0 ? naturalSize.w / displaySize.w : 1;
  const pixel = completedCrop
    ? convertToPixelCrop(completedCrop, displaySize.w || naturalSize.w, displaySize.h || naturalSize.h)
    : null;
  const naturalW = pixel ? Math.round(pixel.width * scale) : 0;
  const naturalH = pixel ? Math.round(pixel.height * scale) : 0;
  const activePreset = ASPECT_PRESETS.find((p) => p.value === aspect);
  const ratioStr = naturalW > 0 && naturalH > 0
    ? activePreset?.value
      ? activePreset.label
      : `≈ ${(naturalW / naturalH).toFixed(2)}:1`
    : "-";

  return (
    <AppModal
      title="裁剪图片"
      open
      onCancel={onClose}
      width={900}
      footer={null}
    >
      <div style={{ minHeight: 400 }}>
        {imgLoaded && (
          <div className="flex flex-col gap-3">
            {/* Crop area */}
            <div className="flex justify-center">
              <ReactCrop
                crop={crop}
                onChange={(c) => setCrop(c)}
                onComplete={(c) => setCompletedCrop(c)}
                aspect={aspect}
                minWidth={10}
                minHeight={10}
              >
                <img ref={imgRef} src={src} crossOrigin="anonymous" onLoad={onImageLoad} style={{ maxHeight: 480 }} />
              </ReactCrop>
            </div>
            {/* Info bar */}
            <div className="flex items-center justify-center gap-3 text-xs" style={{ color: "var(--canvas-text-dim)" }}>
              <span>裁剪: <b style={{ color: "var(--canvas-text)" }}>{naturalW} × {naturalH}</b></span>
              <span>比例: <b style={{ color: "var(--canvas-text)" }}>{ratioStr}</b></span>
              <span>原图: <b style={{ color: "var(--canvas-text)" }}>{naturalSize.w} × {naturalSize.h}</b></span>
            </div>
            {/* Preset buttons */}
            <div className="flex items-stretch gap-1 w-full">
              {ASPECT_PRESETS.map((p) => (
                <NavButton key={p.label} onClick={() => handleAspectChange(p.value)}
                  active={aspect === p.value}
                  style={{
                    padding: "2px 6px", height: 28, fontSize: 12, minWidth: 45,
                    flex: 1, border: "1px solid var(--canvas-border)", justifyContent: "center",
                  }}
                >{p.label}</NavButton>
              ))}
            </div>
            {/* Actions */}
            <div className="flex justify-end gap-2 w-full">
              <ModalButton onClick={handleReset}>重置</ModalButton>
              <ModalButton variant="primary" onClick={handleConfirm} disabled={loading} loading={loading}>确认</ModalButton>
            </div>
          </div>
        )}
      </div>
    </AppModal>
  );
}
