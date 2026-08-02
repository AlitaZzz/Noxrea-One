"use client";

import {
  DownloadOutlined,
  FullscreenOutlined,
  FileImageOutlined,
  PictureOutlined,
  ScissorOutlined,
  CrownOutlined,
  UploadOutlined,
} from "@ant-design/icons";
import { Handle, type NodeProps,Position } from "@xyflow/react";
import { Input,Popover, Tooltip } from "antd";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import MultiAngleEditor from "@/components/canvas/MultiAngleEditor";
import LightingPanel from "@/components/canvas/LightingPanel";
import AnnotationPanel from "@/components/canvas/AnnotationPanel";
import CropPanel from "@/components/canvas/CropPanel";
import { useEditableTitle } from "@/hooks/use-editable-title";
import { apiUploadWithProgress } from "@/lib/api";
import {
DEFAULT_NODE_HEIGHT,
  DEFAULT_NODE_WIDTH, } from "@/lib/constants";
import { EventNames } from "@/lib/event-names";
import { canvasToBlob, computeNodeSize, computeThumbScale, createNodeFromUrl, loadMediaDimensions, uploadBlob } from "@/lib/image-utils";
import {
  type ImageNode as ImageNodeType,
  type ImageNodeData,
  isGenerating,
} from "@/lib/types";
import { useAssetsStore } from "@/stores/assets-store";
import { markDirtyImmediate,useCanvasStore } from "@/stores/canvas-store";
import { useI18nStore } from "@/stores/i18n-store";

/**
 * 多图展开网格布局：主图固定在 (0,0,z=0)，其余结果图沿「向右成列、向上扇出」的
 * 2 列网格排布，溢出节点边界之上方与右侧。抽成纯函数便于单独测试与阅读。
 */
interface MultiCardLayout { left: string; top: string; z: number }
function layoutMultiCards(urls: string[], mainUrl: string): MultiCardLayout[] {
  const GAP = 8;
  const layouts: MultiCardLayout[] = [];
  let remainingIdx = 0;
  for (const url of urls) {
    if (url === mainUrl) {
      layouts.push({ left: "0px", top: "0px", z: 0 });
    } else {
      const ri = remainingIdx++;
      const col = (ri + 1) % 2;
      const row = -Math.floor((ri + 1) / 2);
      layouts.push({
        left: col > 0 ? `calc(100% + ${GAP}px)` : "0px",
        top: `calc(${row * 100}% + ${row * GAP}px)`,
        z: -1,
      });
    }
  }
  return layouts;
}

function ImageNode({ id, data, selected }: NodeProps<ImageNodeType>) {
  useI18nStore((s) => s.lang);
  const t = useI18nStore((s) => s.t);
  const dropRef = useRef<HTMLDivElement>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [cropOpen, setCropOpen] = useState(false);
  // cropOpen driven by store's croppingNodeId (same pattern as annotateOpen)
  const setCroppingNodeId = useCanvasStore((s) => s.setCroppingNodeId);
  const croppingNodeId = useCanvasStore((s) => s.croppingNodeId);
  useEffect(() => {
    setCropOpen(croppingNodeId === id);
  }, [croppingNodeId, id]);
  const [angleEditorOpen, setAngleEditorOpen] = useState(false);
  const [lightingOpen, setLightingOpen] = useState(false);
  const [annotateOpen, setAnnotateOpenInternal] = useState(false);
  // annotateOpen is driven by the store's annotatingNodeId so that clicking
  // other nodes or the pane can close annotation mode externally.
  const setAnnotateOpen = useCallback((open: boolean) => {
    useCanvasStore.getState().setAnnotatingNodeId(open ? id : null);
  }, [id]);
  const annotatingNodeId = useCanvasStore((s) => s.annotatingNodeId);
  useEffect(() => {
    setAnnotateOpenInternal(annotatingNodeId === id);
  }, [annotatingNodeId, id]);
  const [expanded, setExpanded] = useState(false);
  const nodeRef = useRef<HTMLDivElement>(null);

  // 点击节点外部时收起展开视图（捕获阶段，绕过 ReactFlow 事件拦截）
  useEffect(() => {
    if (!expanded) return;
    const handler = (e: MouseEvent) => {
      if (nodeRef.current && !nodeRef.current.contains(e.target as Node)) {
        setExpanded(false);
      }
    };
    document.addEventListener("mousedown", handler, true);
    return () => document.removeEventListener("mousedown", handler, true);
  }, [expanded]);

  // 主图真相统一为 data.src（不再有本地 src state / 渲染期 setState hack）。
  // 多图模式约定：src 必为 multiResultUrls 的成员；撤销会把整个 data 快照替换，故无需额外同步。
  // Fallback: if src is missing but multiResultUrls exists, use first URL
  const src = data.src || (Array.isArray(data.multiResultUrls) && data.multiResultUrls.length > 0 ? data.multiResultUrls[0] : "") || "";

  // 多图结果模式：存在 multiResultUrls 且 >=2 张时，节点以堆叠卡片/展开网格展示
  const isMulti = Array.isArray(data.multiResultUrls) && data.multiResultUrls.length >= 2;

  // 展开网格的卡片布局（纯函数计算，仅在多图+展开时有效）
  const multiExpandedLayouts = useMemo(
    () => (expanded && isMulti && data.multiResultUrls ? layoutMultiCards(data.multiResultUrls, src) : []),
    [expanded, isMulti, data.multiResultUrls, src]
  );

  const handleFile = useCallback(
    async (file: File) => {
      if (!file.type.startsWith("image/")) return;

      // 生成本次上传的版本标记。版本号存储在 node.data.upload.version 中，
      // 撤销时整个 node.data 被快照替换，版本号自动失效。
      const uploadVersion = Date.now();
      const store = useCanvasStore.getState();
      const nodeBefore = store.nodes.find((n) => n.id === id);
      if (nodeBefore) {
        // 立即进入 uploading 状态，让节点进度条出现（与拖到画布路径一致）
        store.updateNodeData(
          id,
          { upload: { uploading: true, progress: 0, version: uploadVersion } },
          undefined,
          { skipHistory: true }
        );
      }

      try {
        const formData = new FormData();
        formData.append("file", file);
        const res = await apiUploadWithProgress<{ url: string }>(
          "/api/files/upload?category=images",
          formData,
          (pct) => {
            // 上传进度回传，更新进度条
            useCanvasStore.getState().updateNodeData(
              id,
              { upload: { uploading: true, progress: pct, version: uploadVersion } },
              undefined,
              { skipHistory: true }
            );
          }
        );
        if (res.code === 200 && res.data?.url) {
          const imgUrl = res.data.url;
          const img = new window.Image();
          img.onload = () => {
            // 异步回调时校验：节点存在且版本号匹配（未被撤销/重置）
            const s = useCanvasStore.getState();
            const currentNode = s.nodes.find((n) => n.id === id);
            if (!currentNode) return;
            if ((currentNode.data as ImageNodeData).upload?.version !== uploadVersion) return;

            const nw = img.naturalWidth, nh = img.naturalHeight;
            const { width, height } = computeNodeSize(nw, nh);
            const latestData = currentNode.data as ImageNodeData;
            // 上传完成：清空 upload（进度条消失），写回图片主信息；
            // 同时清掉可能残留的 multiResultUrls，避免旧多图层叠在新主图后。
            window.dispatchEvent(
              new CustomEvent(EventNames.NODE_UPDATE_DATA, {
                detail: {
                  nodeId: id,
                  data: { ...latestData, src: imgUrl, label: file.name, alt: file.name, naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight, upload: undefined, multiResultUrls: undefined, multiResultTotalCount: undefined },
                  style: { width, height },
                  immediate: true,
                },
              })
            );
          };
          img.src = imgUrl;
        } else {
          // 后端返回非 200：清除 uploading 状态，避免卡在"上传中"
          const s = useCanvasStore.getState();
          const currentNode = s.nodes.find((n) => n.id === id);
          if (currentNode && (currentNode.data as ImageNodeData).upload?.version === uploadVersion) {
            s.updateNodeData(id, { upload: undefined }, undefined, { skipHistory: true });
          }
        }
      } catch (e) {
        console.error("Image upload failed:", e);
        // 失败时清除 uploading 状态（进度条消失），避免卡在"上传中"
        const s = useCanvasStore.getState();
        const currentNode = s.nodes.find((n) => n.id === id);
        if (currentNode && (currentNode.data as ImageNodeData).upload?.version === uploadVersion) {
          s.updateNodeData(id, { upload: undefined }, undefined, { skipHistory: true });
        }
      }
    },
    [id]
  );

  const handleDownload = useCallback(() => {
    if (!src) return;
    const a = document.createElement("a");
    const sep = src.includes("?") ? "&" : "?";
    const params = new URLSearchParams({ download: "true" });
    if (data.alt) params.set("filename", data.alt);
    a.href = `${src}${sep}${params.toString()}`;
    a.download = "";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }, [src, data.alt]);

  /** 多图模式：下载指定 URL 的结果图 */
  const handleDownloadUrl = useCallback((url: string) => {
    if (!url) return;
    const a = document.createElement("a");
    const sep = url.includes("?") ? "&" : "?";
    const params = new URLSearchParams({ download: "true" });
    if (data.alt) params.set("filename", data.alt);
    a.href = `${url}${sep}${params.toString()}`;
    a.download = "";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }, [data.alt]);

  /** 多图模式：把某张结果图设为主图（更新 src 与真实尺寸，并收起网格） */
  const handleSetMain = useCallback((url: string) => {
    if (!url) return;
    const store = useCanvasStore.getState();
    store.updateNodeData(id, { src: url }, undefined, { skipHistory: true });
    markDirtyImmediate();
    const node = store.nodes.find((n) => n.id === id);
    const d = node?.data as ImageNodeData | undefined;
    const { width, height } = computeNodeSize(d?.naturalWidth || 1024, d?.naturalHeight || 1024);
    store.updateNodeData(id, {}, { width, height }, { skipHistory: true });
    markDirtyImmediate();
    setExpanded(false);
    loadMediaDimensions(url, false).then((dims) => {
      if (dims.w > 0) {
        const s = useCanvasStore.getState();
        s.updateNodeData(id, { naturalWidth: dims.w, naturalHeight: dims.h }, undefined, { skipHistory: true });
        const { width: w2, height: h2 } = computeNodeSize(dims.w, dims.h);
        s.updateNodeData(id, {}, { width: w2, height: h2 }, { skipHistory: true });
        markDirtyImmediate();
      }
    });
  }, [id]);

  /** 多图模式：展开/收起——浮层展示，节点尺寸不变 */
  const toggleExpand = useCallback(() => {
    setExpanded((prev) => !prev);
  }, []);

  const addAsset = useAssetsStore((s) => s.addAsset);

  const handleTransform = useCallback(async (op: "rot90" | "flipH" | "flipV") => {
    if (!src) return;
    const store = useCanvasStore.getState();
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
      const cw = isRot90 ? img.naturalHeight : img.naturalWidth;
      const ch = isRot90 ? img.naturalWidth : img.naturalHeight;
      const blob = await canvasToBlob(cw, ch, (ctx) => {
        ctx.translate(cw / 2, ch / 2);
        if (isRot90) ctx.rotate(Math.PI / 2);
        if (op === "flipH") ctx.scale(-1, 1);
        if (op === "flipV") ctx.scale(1, -1);
        ctx.drawImage(img, -img.naturalWidth / 2, -img.naturalHeight / 2);
      });
      const url = await uploadBlob(blob, `transform_${Date.now()}.png`);
      if (!url) throw new Error("Upload failed");

      const nw = cw;
      const nh = ch;
      const { width, height } = computeNodeSize(nw, nh);

      // 5. 更新节点
      store.updateNodeData(id, {
        src: url,
        naturalWidth: nw,
        naturalHeight: nh,
        taskBinding: undefined,
        rotation: undefined,
        flipH: undefined,
        flipV: undefined,
      }, { width, height }, { skipHistory: true });
      markDirtyImmediate();
    } catch (e) {
      store.updateNodeData(id, { taskBinding: undefined }, undefined, { skipHistory: true });
      console.error("transform failed:", e);
    }
  }, [id, src]);

  const handleSaveToAssets = useCallback(() => {
    if (!src) return;
    const node = useCanvasStore.getState().nodes.find(n => n.id === id);
    const d = node?.data as ImageNodeData | undefined;
    addAsset({
      name: data.alt || data.label || t("image.node"),
      type: "other",
      width: d?.naturalWidth || 0,
      height: d?.naturalHeight || 0,
      description: "",
      metadata: { sourceUrl: src },
    });
  }, [src, data.alt, data.label, id, addAsset]);

  const handleGridSplit = useCallback(async (rows: number, cols: number) => {
    if (!src) return;
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
      const { displayW, displayH } = computeThumbScale(pieceW, pieceH);

      // Get original node position for grid layout
      const origNode = useCanvasStore.getState().nodes.find((n) => n.id === id);
      const baseX = (origNode?.position.x || 0) + (origNode?.style?.width as number || 600) + 60;
      const baseY = origNode?.position.y || 0;
      const gap = 12;

      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const blob = await canvasToBlob(pieceW, pieceH, (ctx) => {
            ctx.drawImage(img, c * pieceW, r * pieceH, pieceW, pieceH, 0, 0, pieceW, pieceH);
          });
          const url = await uploadBlob(blob, `grid_${r}_${c}.png`);
          if (!url) continue;

          const pos = { x: baseX + c * (displayW + gap), y: baseY + r * (displayH + gap) };
          await createNodeFromUrl(id, url, pieceW, pieceH, ` (${r + 1}-${c + 1})`, undefined, pos);
        }
      }
    } catch (e) {
      console.error("grid-split failed:", e);
    } finally {
      useCanvasStore.getState().updateNodeData(id, { taskBinding: undefined }, undefined, { skipHistory: true });
    }
  }, [id, src]);

  const handleBgRemoval = useCallback(async () => {
    if (!src) return;
    try {
      // Create task via existing generation task queue
      const { BASE, getTokenHeader } = await import("@/lib/api");
      const res = await fetch(`${BASE}/api/generate/task`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getTokenHeader() },
        body: JSON.stringify({
          type: "bg_removal",
          prompt: "",
          refImages: [src],
          nodeId: id,
        }),
      });
      if (!res.ok) throw new Error(`Task creation failed: HTTP ${res.status}`);
      const json = await res.json();
      const taskId = json.data?.id;
      if (!taskId) throw new Error("No task_id returned");

      // Store task info in node data for InfiniteCanvas SSE monitor
      useCanvasStore.getState().updateNodeData(id, {
        taskBinding: { taskId, status: "pending", pendingAction: "bg_removal" },
      }, undefined, { skipHistory: true });
      // markDirtyImmediate handled by updateNodeData internally
    } catch (e) {
      useCanvasStore.getState().updateNodeData(id, { taskBinding: undefined }, undefined, { skipHistory: true });
      console.error("bg-removal failed:", e);
    }
  }, [id, src]);

  const handleClear = useCallback(() => {
    useCanvasStore.getState().updateNodeData(id, {
      src: "", label: "", alt: "", naturalWidth: 0, naturalHeight: 0,
      rotation: undefined, flipH: undefined, flipV: undefined,
      upload: undefined, multiResultUrls: undefined, multiResultTotalCount: undefined,
    }, { width: DEFAULT_NODE_WIDTH, height: DEFAULT_NODE_HEIGHT });
    markDirtyImmediate();
  }, [id]);

  // Listen for node action events from NodeToolbar
  const actionRefs = useRef({ handleDownload, handleSaveToAssets, handleClear, handleTransform, handleGridSplit, handleBgRemoval });
  useEffect(() => {
    actionRefs.current = { handleDownload, handleSaveToAssets, handleClear, handleTransform, handleGridSplit, handleBgRemoval };
  }, [handleDownload, handleSaveToAssets, handleClear, handleTransform, handleGridSplit, handleBgRemoval]);
  useEffect(() => {
    function onNodeAction(e: Event) {
      const detail = (e as CustomEvent).detail;
      if (detail.nodeId !== id) return;
      const a = actionRefs.current;
      switch (detail.action) {
        case "download": a.handleDownload(); break;
        case "save-asset": a.handleSaveToAssets(); break;
        case "crop-interactive": if (src) setCroppingNodeId(id); break;
        case "angle-editor": if (src) setAngleEditorOpen(true); break;
        case "lighting": if (src) setLightingOpen(true); break;
        case "annotate": if (src) setAnnotateOpen(true); break;
        case "clear": a.handleClear(); break;
        case "transform": a.handleTransform(detail.op); break;
        case "grid-split": a.handleGridSplit(detail.rows, detail.cols); break;
        case "bg-removal": a.handleBgRemoval(); break;
      }
    }
    window.addEventListener(EventNames.CANVAS_NODE_ACTION, onNodeAction);
    return () => window.removeEventListener(EventNames.CANVAS_NODE_ACTION, onNodeAction);
  }, [id, src, setCroppingNodeId, setAnnotateOpen]);

  const handleDragOver = (e: React.DragEvent) => { e.preventDefault(); e.stopPropagation(); setIsDragOver(true); };
  const handleDragLeave = (e: React.DragEvent) => { e.preventDefault(); e.stopPropagation(); setIsDragOver(false); };
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault(); e.stopPropagation(); setIsDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) handleFile(file);
  };

  const { editing: editingTitle, draft: titleDraft, setDraft: setTitleDraft, handleDblClick: handleTitleDblClick, handleSave: handleTitleSave } =
    useEditableTitle(id, data.alt || data.label || t("image.node"), { syncAlt: true });

  const hasImage = src && src.length > 0;

  // 烘焙模式：图片本身就是旋转/翻转后的成品，无需 CSS transform

  return (
    <>
    <div ref={nodeRef} className="group relative w-full h-full flex flex-col">
      {/* Title */}
      <div className="flex items-center justify-between px-3 py-1 text-[13px] font-medium text-white/80" style={{ height: 28, flexShrink: 0 }}>
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

      {/* Body wrapper - relative container for body + overlay layer */}
      <div className="relative flex-1">
      <div
        className={`
          node-body w-full h-full flex items-center justify-center rounded-lg relative group/body
          ${isMulti ? "overflow-visible" : "overflow-hidden"}
          ${selected ? "node-selected" : ""}
          ${isDragOver ? "node-drag-over" : ""}
        `}
        style={{ background: hasImage ? "transparent" : "var(--canvas-bg, #262626)" }}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        ref={dropRef}
      >
        {isMulti && !expanded && (
          <div className="absolute top-2 right-2 z-20 nodrag">
            <Tooltip title={t("expand")}>
              <button
                className="flex items-center justify-center w-7 h-7 rounded-md bg-black/60 hover:bg-black/80 text-white/80 hover:text-white transition-colors cursor-pointer"
                onClick={toggleExpand}
              >
                <FullscreenOutlined style={{ fontSize: 12 }} />
              </button>
            </Tooltip>
          </div>
        )}
        {data.upload?.uploading ? (
          <div className="absolute inset-0 rounded-lg overflow-hidden flex flex-col items-center justify-center gap-3 px-8" style={{ background: "var(--canvas-bg)" }}>
            {data.upload?.progress != null ? (
              <div className="w-full h-1.5 bg-white/10 rounded-full overflow-hidden">
                <div className="h-full bg-blue-500 rounded-full transition-all duration-300" style={{ width: `${data.upload.progress}%` }} />
              </div>
            ) : (
              <div className="w-full h-1.5 bg-white/10 rounded-full overflow-hidden">
                <div className="h-full bg-blue-500 rounded-full animate-pulse" style={{ width: "60%" }} />
              </div>
            )}
            <span className="text-sm text-white/50">{t("uploading")}</span>
          </div>
        ) : isGenerating(data.taskBinding) ? (
          <div className="absolute inset-0 rounded-lg overflow-hidden flex flex-col items-center justify-center gap-3" style={{ background: "var(--canvas-bg)" }}>
            <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
            <span className="text-sm text-white/50">{t("generating")}</span>
          </div>
        ) : isMulti && hasImage ? (
            expanded ? (
              // 展开平铺：卡片同尺寸 2 列排列，溢出节点边界（布局由 layoutMultiCards 计算）
              <div className="absolute inset-0 overflow-visible">
                {data.multiResultUrls!.map((url, i) => {
                  const isMain = url === src;
                  const { left, top, z } = multiExpandedLayouts[i] ?? { left: "0px", top: "0px", z: 0 };
                  return (
                    <div
                      key={i}
                      className="absolute rounded-lg overflow-hidden shadow-xl"
                      style={{
                        left,
                        top,
                        width: "100%",
                        height: "100%",
                        zIndex: z,
                        background: "#262626",
                        outline: "1px solid rgba(255,255,255,0.15)",
                      }}
                    >
                          <img src={url} alt={`${i + 1}`} className="absolute inset-0 w-full h-full" draggable={false} />
                          {/* 操作按钮 */}
                          <div className="absolute top-1 right-1 flex gap-1 z-10 nodrag">
                            <Tooltip title={t("download")}>
                              <button
                                className="flex items-center justify-center w-7 h-7 rounded-md bg-black/60 hover:bg-black/80 text-white/80 hover:text-white cursor-pointer"
                                onClick={() => handleDownloadUrl(url)}
                              >
                                <DownloadOutlined style={{ fontSize: 13 }} />
                              </button>
                            </Tooltip>
                            {!isMain && (
                              <Tooltip title={t("set.as.main")}>
                                <button
                                  className="flex items-center justify-center w-7 h-7 rounded-md bg-black/60 hover:bg-black/80 text-white/80 hover:text-white cursor-pointer"
                                  onClick={() => handleSetMain(url)}
                                >
                                  <CrownOutlined style={{ fontSize: 13 }} />
                                </button>
                              </Tooltip>
                            )}
                            {isMain && (
                              <Tooltip title={t("collapse")}>
                                <button
                                  className="flex items-center justify-center w-7 h-7 rounded-md bg-black/60 hover:bg-black/80 text-white/80 hover:text-white cursor-pointer"
                                  onClick={toggleExpand}
                                >
                                  <FullscreenOutlined style={{ fontSize: 13 }} />
                                </button>
                              </Tooltip>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
            ) : (
              // 折叠堆叠卡片：排除当前主图，取最多 3 张作为背景卡
              <div className="relative w-full h-full overflow-visible rounded-lg">
                {data.multiResultUrls!.filter((u) => u !== src).slice(0, 3).map((url, i) => {
                  const depth = i + 1;
                  const left = depth * 12;
                  const top = depth * 4;
                  const scale = 1 - depth * 0.035;
                  const rotate = depth * 2.5;
                  return (
                    <div
                      key={i}
                      className="absolute rounded-lg overflow-hidden shadow-xl"
                      style={{
                        left: `${left}px`,
                        top: `${top}px`,
                        width: "100%",
                        height: "100%",
                        transform: `scale(${scale}) rotate(${rotate}deg)`,
                        transformOrigin: "center center",
                        zIndex: -depth,
                        background: "#262626",
                        outline: "1px solid rgba(255,255,255,0.15)",
                      }}
                    >
                      <img src={url} alt="" className="absolute inset-0 w-full h-full" draggable={false} />
                    </div>
                  );
                })}
                {/* 主卡：scale=1，在最上层，覆盖大部分面积 */}
                <div
                  className="absolute rounded-lg overflow-hidden shadow-2xl"
                  style={{
                    left: 0,
                    top: 0,
                    width: "100%",
                    height: "100%",
                    transform: "scale(1)",
                    zIndex: 0,
                  }}
                >
                  <img src={src} alt={data.alt || ""} className="absolute inset-0 w-full h-full" draggable={false} />
                </div>
              </div>
            )
          )
        : hasImage ? (
          <img src={src} alt={data.alt || ""} className="absolute inset-0 w-full h-full" draggable={false} />
        ) : (
          <div className="flex flex-col items-center justify-center gap-2 p-4 text-white/40">
            <PictureOutlined className="text-5xl" />
            <span className="text-base text-center">{t("drop.upload")}</span>
            <button className="node-upload-btn nodrag flex items-center gap-2 px-6 py-3 rounded-lg text-base"
              onClick={() => {
                const input = document.createElement("input");
                input.type = "file";
                input.accept = "image/*";
                input.onchange = (e) => {
                  const file = (e.target as HTMLInputElement).files?.[0];
                  if (file) handleFile(file);
                };
                input.click();
              }}>
              <UploadOutlined className="text-lg" /> {t("upload")}
            </button>
          </div>
        )}
      </div>
      {annotateOpen && src && (
        <div className="pointer-events-none absolute inset-0 overflow-visible">
          <AnnotationPanel src={src} sourceId={id} onClose={() => setAnnotateOpen(false)} />
        </div>
      )}
      {cropOpen && src && (
        <div className="pointer-events-none absolute inset-0 overflow-visible">
          <CropPanel src={src} sourceId={id} onClose={() => setCroppingNodeId(null)} />
        </div>
      )}
      </div>

      <Handle type="target" position={Position.Left} style={{ width: 10, height: 10, background: "#52c41a" }} />
      <Handle type="source" position={Position.Right} style={{ width: 10, height: 10, background: "#52c41a" }} />
    </div>
    {angleEditorOpen && src && createPortal(
      <MultiAngleEditor src={src} sourceId={id} onClose={() => setAngleEditorOpen(false)} />,
      document.body
    )}
    {lightingOpen && src && createPortal(
      <LightingPanel src={src} onClose={() => setLightingOpen(false)} />,
      document.body
    )}
    </>
  );
}

export default memo(ImageNode);
