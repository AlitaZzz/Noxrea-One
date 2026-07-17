"use client";

import { memo, useState, useCallback, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import { Handle, Position } from "@xyflow/react";
import ImageCropModal from "@/components/canvas/ImageCropModal";
import { Tooltip, Popover, Input } from "antd";
import {
  UploadOutlined,
  PictureOutlined,
  DeleteOutlined,
  FileImageOutlined,
  DownloadOutlined,
  ScissorOutlined,
  SwapOutlined,
  StarOutlined,
} from "@ant-design/icons";
import type { ImageNodeData, AnyNode } from "@/lib/types";
import {
  DEFAULT_NODE_WIDTH, THUMBNAIL_MAX,
} from "@/lib/constants";
import { useCanvasStore } from "@/stores/canvas-store";
import { useAssetsStore } from "@/stores/assets-store";
import { createImageNode, createEdge } from "@/lib/node-defaults";
import { apiUpload } from "@/lib/api";
import { useI18nStore } from "@/stores/i18n-store";

interface ImageNodeProps {
  id: string;
  data: ImageNodeData;
  selected?: boolean;
}

function ImageNode({ id, data, selected }: ImageNodeProps) {
  useI18nStore((s) => s.lang); // subscribe to language changes
  const t = useI18nStore((s) => s.t);
  const [src, setSrc] = useState(data.src || "");
  const dropRef = useRef<HTMLDivElement>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [cropOpen, setCropOpen] = useState(false);

  // Sync local src when data.src changes externally (e.g. from generation panel)
  useEffect(() => {
    if (data.src && data.src !== src) setSrc(data.src);
  }, [data.src]);

  const handleFile = useCallback(
    async (file: File) => {
      if (!file.type.startsWith("image/")) return;
      try {
        const formData = new FormData();
        formData.append("file", file);
        const res = await apiUpload<{ url: string }>("/api/files/upload?category=images", formData);
        if (res.code === 200 && res.data?.url) {
          const imgUrl = res.data.url;
          setSrc(imgUrl);
          const img = new window.Image();
          img.onload = () => {
            const THUMBNAIL_MAX = 360;
            const nw = img.naturalWidth, nh = img.naturalHeight;
            const shortSide = Math.min(nw, nh);
            const scale = shortSide > THUMBNAIL_MAX ? THUMBNAIL_MAX / shortSide : 1;
            const displayW = Math.round(nw * scale);
            const displayH = Math.round(nh * scale);
            const titleH = 24;
            const store = useCanvasStore.getState();
            const currentNode = store.nodes.find((n) => n.id === id);
            const latestData = (currentNode?.data || data) as ImageNodeData;
            window.dispatchEvent(
              new CustomEvent("node:update-data", {
                detail: {
                  nodeId: id,
                  data: { ...latestData, src: imgUrl, label: file.name, alt: file.name, naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight },
                  style: { width: displayW, height: displayH + titleH },
                  immediate: true,
                },
              })
            );
          };
          img.src = imgUrl;
        }
      } catch (e) { console.error("Image upload failed:", e); }
    },
    [id, data]
  );

  const handleReplace = useCallback(() => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.onchange = (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (file) handleFile(file);
    };
    input.click();
  }, [handleFile]);

  const handleDownload = useCallback(async () => {
    if (!src) return;
    try {
      const res = await fetch(src);
      if (res.ok) {
        const blob = await res.blob();
        const blobUrl = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = blobUrl;
        a.download = data.alt || "image.png";
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(blobUrl);
      }
    } catch {}
  }, [src, data.alt]);

  const addNodes = useCanvasStore((s) => s.addNodes);
  const addAsset = useAssetsStore((s) => s.addAsset);

  const handleCrop = useCallback(async () => {
    if (!src) return;
    const img = new window.Image();
    img.crossOrigin = "anonymous";
    img.onload = async () => {
      const size = Math.min(img.naturalWidth, img.naturalHeight);
      const sx = (img.naturalWidth - size) / 2;
      const sy = (img.naturalHeight - size) / 2;
      const canvas = document.createElement("canvas");
      canvas.width = size; canvas.height = size;
      canvas.getContext("2d")!.drawImage(img, sx, sy, size, size, 0, 0, size, size);
      const blob: Blob = await new Promise((resolve) => canvas.toBlob((b) => resolve(b!), "image/png"));
      const fd = new FormData();
      fd.append("file", blob, "crop.png");
      const res = await apiUpload<{ url: string }>("/api/files/upload?category=images", fd);
      if (res.code !== 200 || !res.data?.url) return;
      const croppedUrl = res.data.url;
      const s = useCanvasStore.getState();
      const THUMBNAIL_MAX = 360;
      const displaySize = size > THUMBNAIL_MAX ? THUMBNAIL_MAX : size;
      const cx = -s.viewport.x / s.viewport.zoom + (window.innerWidth / 2) / s.viewport.zoom;
      const cy = -s.viewport.y / s.viewport.zoom + (window.innerHeight / 2) / s.viewport.zoom;
      const node = createImageNode({ x: cx - displaySize / 2, y: cy - displaySize / 2 }, croppedUrl);
      node.data.naturalWidth = size; node.data.naturalHeight = size;
      node.data.label = (data.alt || "crop") + " (cropped)";
      node.style = { width: displaySize, height: displaySize };
      addNodes([node]);
    };
    img.src = src;
  }, [src, data.alt, addNodes]);

  const handleTransform = useCallback(async (op: "rot90" | "flipH" | "flipV") => {
    if (!src) return;
    const img = new window.Image();
    img.crossOrigin = "anonymous";
    img.onload = async () => {
      const canvas = document.createElement("canvas");
      if (op === "rot90") { canvas.width = img.naturalHeight; canvas.height = img.naturalWidth; }
      else { canvas.width = img.naturalWidth; canvas.height = img.naturalHeight; }
      const ctx = canvas.getContext("2d")!;
      if (op === "rot90") { ctx.translate(canvas.width, 0); ctx.rotate(Math.PI / 2); }
      else if (op === "flipH") { ctx.translate(canvas.width, 0); ctx.scale(-1, 1); }
      else if (op === "flipV") { ctx.translate(0, canvas.height); ctx.scale(1, -1); }
      ctx.drawImage(img, 0, 0);
      const blob: Blob = await new Promise((resolve) => canvas.toBlob((b) => resolve(b!), "image/png"));
      const fd = new FormData();
      fd.append("file", blob, "transform.png");
      const res = await apiUpload<{ url: string }>("/api/files/upload?category=images", fd);
      if (res.code !== 200 || !res.data?.url) return;
      const url = res.data.url;
      const s = useCanvasStore.getState();
      const THUMBNAIL_MAX = 360;
      const nw = canvas.width, nh = canvas.height;
      const shortSide = Math.min(nw, nh);
      const scale = shortSide > THUMBNAIL_MAX ? THUMBNAIL_MAX / shortSide : 1;
      const displayW = Math.round(nw * scale);
      const displayH = Math.round(nh * scale);
      const cx = -s.viewport.x / s.viewport.zoom + (window.innerWidth / 2) / s.viewport.zoom;
      const cy = -s.viewport.y / s.viewport.zoom + (window.innerHeight / 2) / s.viewport.zoom;
      const node = createImageNode({ x: cx - displayW / 2, y: cy - displayH / 2 }, url);
      node.data.naturalWidth = nw; node.data.naturalHeight = nh;
      node.data.label = (data.alt || "image") + ` (${op})`;
      node.style = { width: displayW, height: displayH };
      addNodes([node]);
    };
    img.src = src;
  }, [src, data.alt, addNodes]);

  const handleSaveToAssets = useCallback(() => {
    if (!src) return;
    addAsset({
      name: data.alt || data.label || t("image.node"),
      type: "other",
      width: data.naturalWidth || 0,
      height: data.naturalHeight || 0,
      description: "",
      metadata: { sourceUrl: src },
    });
  }, [src, data.alt, data.label, addAsset]);

  const handleGridSplit = useCallback(async (rows: number, cols: number) => {
    if (!src) return;
    // Show loading
    useCanvasStore.getState().updateNodeData(id, { _generating: true });
    try {
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const img = new window.Image();
        img.crossOrigin = "anonymous";
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error("Failed to load image"));
        img.src = src;
      });

      const pieceW = img.naturalWidth / cols;
      const pieceH = img.naturalHeight / rows;
      const titleH = 24;
      const shortSide = Math.min(pieceW, pieceH);
      const scale = shortSide > THUMBNAIL_MAX ? THUMBNAIL_MAX / shortSide : 1;
      const displayW = Math.round(pieceW * scale);
      const displayH = Math.round(pieceH * scale);

      // Get original node position
      const origNode = useCanvasStore.getState().nodes.find((n) => n.id === id);
      const baseX = (origNode?.position.x || 0) + (origNode?.style?.width as number || 600) + 60;
      const baseY = origNode?.position.y || 0;
      const gap = 12;

      const nodes: AnyNode[] = [];
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const canvas = document.createElement("canvas");
          canvas.width = pieceW;
          canvas.height = pieceH;
          const ctx = canvas.getContext("2d")!;
          ctx.drawImage(img, c * pieceW, r * pieceH, pieceW, pieceH, 0, 0, pieceW, pieceH);

          const blob = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!), "image/png"));
          const fd = new FormData();
          fd.append("file", blob, `grid_${r}_${c}.png`);
          const res = await apiUpload<{ url: string }>("/api/files/upload?category=images", fd);
          if (res.code !== 200 || !res.data?.url) continue;

          const node = createImageNode(
            { x: baseX + c * (displayW + gap), y: baseY + r * (displayH + gap) },
            res.data.url
          );
          node.data.naturalWidth = pieceW;
          node.data.naturalHeight = pieceH;
          node.data.label = `${data.alt || data.label || "image"} (${r + 1}-${c + 1})`;
          node.style = { width: displayW, height: displayH + titleH };
          nodes.push(node);
        }
      }
      if (nodes.length > 0) {
        addNodes(nodes);
        // Create edges from original node to each grid piece
        const store = useCanvasStore.getState();
        const newEdges = nodes.map((n) => createEdge(id, n.id));
        store.setEdges([...store.edges, ...newEdges]);
      }
    } catch (e) {
      console.error("grid-split failed:", e);
    } finally {
      useCanvasStore.getState().updateNodeData(id, { _generating: false });
    }
  }, [id, src, data.alt, data.label, addNodes, addAsset]);

  const handleClear = useCallback(() => {
    setSrc("");
    window.dispatchEvent(
      new CustomEvent("node:update-data", {
        detail: {
          nodeId: id,
          data: { ...data, src: "", label: t("image.node") },
          style: { width: DEFAULT_NODE_WIDTH, height: DEFAULT_NODE_WIDTH },
          immediate: true,
        },
      })
    );
  }, [id, data]);

  // Listen for node action events from NodeToolbar
  const actionRefs = useRef({ handleDownload, handleSaveToAssets, handleCrop, handleReplace, handleClear, handleTransform, handleGridSplit });
  actionRefs.current = { handleDownload, handleSaveToAssets, handleCrop, handleReplace, handleClear, handleTransform, handleGridSplit };
  useEffect(() => {
    function onNodeAction(e: Event) {
      const detail = (e as CustomEvent).detail;
      if (detail.nodeId !== id) return;
      const a = actionRefs.current;
      switch (detail.action) {
        case "download": a.handleDownload(); break;
        case "save-asset": a.handleSaveToAssets(); break;
        case "crop": a.handleCrop(); break;
        case "crop-interactive": setCropOpen(true); break;
        case "replace": a.handleReplace(); break;
        case "clear": a.handleClear(); break;
        case "transform": a.handleTransform(detail.op); break;
        case "grid-split": a.handleGridSplit(detail.rows, detail.cols); break;
      }
    }
    window.addEventListener("canvas:node-action", onNodeAction);
    return () => window.removeEventListener("canvas:node-action", onNodeAction);
  }, [id]);

  const handleDragOver = (e: React.DragEvent) => { e.preventDefault(); e.stopPropagation(); setIsDragOver(true); };
  const handleDragLeave = (e: React.DragEvent) => { e.preventDefault(); e.stopPropagation(); setIsDragOver(false); };
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault(); e.stopPropagation(); setIsDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) handleFile(file);
  };

  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(data.alt || data.label || "");

  const handleTitleDblClick = () => {
    setTitleDraft(data.alt || data.label || "");
    setEditingTitle(true);
  };

  const handleTitleSave = () => {
    setEditingTitle(false);
    if (titleDraft && titleDraft !== (data.alt || data.label)) {
      window.dispatchEvent(
        new CustomEvent("node:update-data", {
          detail: { nodeId: id, data: { ...data, label: titleDraft, alt: titleDraft } },
        })
      );
    }
  };

  const hasImage = src && src.length > 0;

  return (
    <>
    <div className="group relative w-full h-full flex flex-col">
      {/* Title */}
      <div className="flex items-center justify-between px-3 py-1 text-[13px] font-medium text-white/80">
        {editingTitle ? (
          <span className="flex items-center gap-0.5 flex-1 min-w-0">
            <FileImageOutlined className="shrink-0" />
            <Input
              size="small"
              variant="borderless"
              className="text-[13px] font-medium text-white/80"
              value={titleDraft}
              onChange={(e) => setTitleDraft(e.target.value)}
              onBlur={handleTitleSave}
              onPressEnter={handleTitleSave}
              autoFocus
              style={{ padding: "1px 4px", height: 20, background: "var(--canvas-bg)", border: "1px solid #525252", borderRadius: 4, outline: "none", boxShadow: "none", width: "100%" }}
            />
          </span>
        ) : (
          <span className="truncate cursor-default" onDoubleClick={handleTitleDblClick}>
            <FileImageOutlined className="mr-1" />
            {data.label || data.alt || t("image.node")}
          </span>
        )}
        {hasImage && data.naturalWidth > 0 && (
          <span className="text-white/30 text-xs whitespace-nowrap ml-2">{data.naturalWidth}×{data.naturalHeight}</span>
        )}
      </div>

      {/* Body */}
      <div
        className={`
          flex-1 flex items-center justify-center overflow-hidden rounded-lg relative group/body
          ${selected ? "outline outline-1 outline-white/30 shadow-lg" : "outline outline-1 outline-white/10"}
          ${isDragOver ? "outline-2 outline-white/50" : ""}
        `}
        style={{ background: hasImage ? "transparent" : "var(--canvas-bg, #262626)" }}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        ref={dropRef}
      >
        {(data as any)._generating ? (
          <div className="absolute inset-0 rounded-lg overflow-hidden flex flex-col items-center justify-center gap-3" style={{ background: "var(--canvas-bg)" }}>
            <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
            <span className="text-sm text-white/50">Generating...</span>
          </div>
        ) : hasImage ? (
          <>
            <img src={src} alt={data.alt || ""} className="absolute inset-0 w-full h-full" draggable={false} />
          </>
        ) : (
          <div className="flex flex-col items-center justify-center gap-2 p-4 text-white/40">
            <PictureOutlined className="text-5xl" />
            <span className="text-base text-center">{t("drop.upload")}</span>
            <button className="flex items-center gap-2 px-6 py-3 rounded-lg text-base text-white/70 hover:text-white hover:bg-white/10 transition-colors" onClick={handleReplace}>
              <UploadOutlined className="text-lg" /> {t("upload")}
            </button>
          </div>
        )}
      </div>


      <Handle type="target" position={Position.Left} style={{ width: 10, height: 10, background: "#52c41a" }} />
      <Handle type="source" position={Position.Right} style={{ width: 10, height: 10, background: "#52c41a" }} />
    </div>
    {cropOpen && src && createPortal(
      <ImageCropModal src={src} sourceId={id} onClose={() => setCropOpen(false)} />,
      document.body
    )}
    </>
  );
}

export default memo(ImageNode);
