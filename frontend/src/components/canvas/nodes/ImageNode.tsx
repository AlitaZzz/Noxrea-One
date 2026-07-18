"use client";

import { memo, useState, useCallback, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import { Handle, Position } from "@xyflow/react";
import ImageCropModal from "@/components/canvas/ImageCropModal";
import { Tooltip, Popover, Input } from "antd";
import {
  UploadOutlined,
  PictureOutlined,
  FileImageOutlined,
  DownloadOutlined,
  ScissorOutlined,
  StarOutlined,
} from "@ant-design/icons";
import type { ImageNodeData, AnyNode } from "@/lib/types";
import {
  DEFAULT_NODE_WIDTH, DEFAULT_NODE_HEIGHT, THUMBNAIL_MAX,
} from "@/lib/constants";
import { useCanvasStore, markDirtyImmediate } from "@/stores/canvas-store";
import { useAssetsStore } from "@/stores/assets-store";
import { createEdge } from "@/lib/node-defaults";
import { apiUpload } from "@/lib/api";
import { uploadBlob, buildNodeFromUrl } from "@/lib/image-utils";
import { useI18nStore } from "@/stores/i18n-store";

interface ImageNodeProps {
  id: string;
  data: ImageNodeData;
  selected?: boolean;
}

function ImageNode({ id, data, selected }: ImageNodeProps) {
  useI18nStore((s) => s.lang);
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

  const handleTransform = useCallback(async (op: "rot90" | "flipH" | "flipV") => {
    if (!src) return;
    const store = useCanvasStore.getState();
    store.updateNodeData(id, { _generating: true });
    try {
      // 1. 加载原图
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const i = new window.Image();
        i.crossOrigin = "anonymous";
        i.onload = () => resolve(i);
        i.onerror = reject;
        i.src = src;
      });

      // 2. Canvas 烘焙
      const isRot90 = op === "rot90";
      const canvas = document.createElement("canvas");
      canvas.width = isRot90 ? img.naturalHeight : img.naturalWidth;
      canvas.height = isRot90 ? img.naturalWidth : img.naturalHeight;
      const ctx = canvas.getContext("2d")!;
      ctx.translate(canvas.width / 2, canvas.height / 2);
      if (isRot90) ctx.rotate(Math.PI / 2);
      if (op === "flipH") ctx.scale(-1, 1);
      if (op === "flipV") ctx.scale(1, -1);
      ctx.drawImage(img, -img.naturalWidth / 2, -img.naturalHeight / 2);

      // 3. 导出并上传
      const blob = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!), "image/png"));
      const url = await uploadBlob(blob, `transform_${Date.now()}.png`);
      if (!url) throw new Error("Upload failed");

      // 4. 按 THUMBNAIL_MAX 等比缩放计算显示尺寸
      const nw = canvas.width;
      const nh = canvas.height;
      const shortSide = Math.min(nw, nh);
      const scale = shortSide > THUMBNAIL_MAX ? THUMBNAIL_MAX / shortSide : 1;
      const displayW = Math.round(nw * scale);
      const displayH = Math.round(nh * scale);

      // 5. 更新节点
      store.updateNodeData(id, {
        src: url,
        naturalWidth: nw,
        naturalHeight: nh,
        _generating: false,
        rotation: undefined,
        flipH: undefined,
        flipV: undefined,
      }, { width: displayW, height: displayH + 24 });
      markDirtyImmediate();
    } catch (e) {
      store.updateNodeData(id, { _generating: false });
      console.error("transform failed:", e);
    }
  }, [id, src]);

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
      const shortSide = Math.min(pieceW, pieceH);
      const scale = shortSide > THUMBNAIL_MAX ? THUMBNAIL_MAX / shortSide : 1;
      const displayW = Math.round(pieceW * scale);
      const displayH = Math.round(pieceH * scale);

      // Get original node position for grid layout
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
          const url = await uploadBlob(blob, `grid_${r}_${c}.png`);
          if (!url) continue;

          // Position each piece in the grid
          const pos = { x: baseX + c * (displayW + gap), y: baseY + r * (displayH + gap) };
          const node = buildNodeFromUrl(id, url, pieceW, pieceH, ` (${r + 1}-${c + 1})`, undefined, pos);
          nodes.push(node);
        }
      }
      if (nodes.length > 0) {
        addNodes(nodes);
        const store = useCanvasStore.getState();
        const newEdges = nodes.map((n) => createEdge(id, n.id));
        store.setEdges([...store.edges, ...newEdges]);
      }
    } catch (e) {
      console.error("grid-split failed:", e);
    } finally {
      useCanvasStore.getState().updateNodeData(id, { _generating: false });
    }
  }, [id, src, addNodes]);

  const handleBgRemoval = useCallback(async () => {
    if (!src) return;
    useCanvasStore.getState().updateNodeData(id, { _generating: true });
    try {
      // Create task via existing generation task queue
      const { BASE, getTokenHeader } = await import("@/lib/api");
      const res = await fetch(`${BASE}/api/generate/task`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getTokenHeader() },
        body: JSON.stringify({
          type: "bg_removal",
          prompt: "",
          refUrls: [src],
          nodeId: id,
        }),
      });
      if (!res.ok) throw new Error(`Task creation failed: HTTP ${res.status}`);
      const json = await res.json();
      const taskId = json.data?.id;
      if (!taskId) throw new Error("No task_id returned");

      // Store task info in node data for InfiniteCanvas SSE monitor
      useCanvasStore.getState().updateNodeData(id, {
        task_id: taskId,
        task_status: "pending",
        pendingAction: "bg_removal",
      });
      // markDirtyImmediate handled by updateNodeData internally
    } catch (e: any) {
      useCanvasStore.getState().updateNodeData(id, { _generating: false });
      console.error("bg-removal failed:", e);
    }
  }, [id, src]);

  const handleClear = useCallback(() => {
    setSrc("");
    useCanvasStore.getState().updateNodeData(id, {
      src: "", label: t("image.node"), alt: "", naturalWidth: 0, naturalHeight: 0,
      rotation: undefined, flipH: undefined, flipV: undefined,
    }, { width: DEFAULT_NODE_WIDTH, height: DEFAULT_NODE_HEIGHT });
    markDirtyImmediate();
  }, [id]);

  // Listen for node action events from NodeToolbar
  const actionRefs = useRef({ handleDownload, handleSaveToAssets, handleReplace, handleClear, handleTransform, handleGridSplit, handleBgRemoval });
  actionRefs.current = { handleDownload, handleSaveToAssets, handleReplace, handleClear, handleTransform, handleGridSplit, handleBgRemoval };
  useEffect(() => {
    function onNodeAction(e: Event) {
      const detail = (e as CustomEvent).detail;
      if (detail.nodeId !== id) return;
      const a = actionRefs.current;
      switch (detail.action) {
        case "download": a.handleDownload(); break;
        case "save-asset": a.handleSaveToAssets(); break;
        case "crop-interactive": setCropOpen(true); break;
        case "replace": a.handleReplace(); break;
        case "clear": a.handleClear(); break;
        case "transform": a.handleTransform(detail.op); break;
        case "grid-split": a.handleGridSplit(detail.rows, detail.cols); break;
        case "bg-removal": a.handleBgRemoval(); break;
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

  // 烘焙模式：图片本身就是旋转/翻转后的成品，无需 CSS transform

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
