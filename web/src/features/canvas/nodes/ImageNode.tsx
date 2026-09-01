/**
 * 图片节点（image-node）渲染组件，功能最重的节点类型。
 * 负责图片展示与上传（含拖拽、进度）、多结果图扇形网格展开、生成中占位，
 * 并按需挂载裁剪 / 打光 / 标注 / 多视角等图像编辑浮层。
 */
"use client";

import {
  CloseOutlined,
  CrownOutlined,
  DownloadOutlined,
  FullscreenOutlined,
  LeftOutlined,
  PictureOutlined,
  RightOutlined,
  UploadOutlined,
} from "@ant-design/icons";
import { Handle, type NodeProps,Position } from "@xyflow/react";
import { Input, Tooltip } from "antd";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import { useAssetsStore } from "@/features/assets/store";
import { getPromptTemplate } from "@/features/canvas/api/canvas-api";
import AnnotationPanel from "@/features/canvas/editing/AnnotationPanel";
import CropPanel from "@/features/canvas/editing/CropPanel";
import { useGridSplit } from "@/features/canvas/editing/GridSplitter";
import LightingPanel from "@/features/canvas/editing/LightingPanel";
import MultiAngleEditor from "@/features/canvas/editing/MultiAngleEditor";
import PanoramaPanel from "@/features/canvas/editing/PanoramaPanel";
import { useEditableTitle } from "@/features/canvas/hooks/use-editable-title";
import { createEdge, createImageNode, createTextNode } from "@/features/canvas/node-defaults";
import { markDirtyImmediate,useCanvasStore } from "@/features/canvas/stores/canvas-store";
import type { ImageNode as ImageNodeType, ImageNodeData, TextNodeData } from "@/features/canvas/types";
import { runMediaUpload, useNodeUpload } from "@/features/canvas/upload";
import {
DEFAULT_NODE_HEIGHT,
  DEFAULT_NODE_WIDTH,EventNames,NODE_HANDLE_TOP,NODE_TITLE_HEIGHT } from "@/lib/constants";
import { isGenerating } from "@/lib/constants";
import { canvasToBlob, computeNodeSize, loadMediaDimensions } from "@/lib/utils/image-utils";

import GeneratingOverlay from "./GeneratingOverlay";
import UploadFailedOverlay from "./UploadFailedOverlay";

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
  const { t } = useTranslation();
  // 多选时隐藏全景工具栏：订阅选中节点数 > 1 判定多选。
  // 返回布尔原语，Zustand 默认 Object.is 比较，仅在选择数跨过阈值时才重渲染；
  // 用循环累加避免每次 nodes 变更都分配 filter 临时数组。
  const multiSelect = useCanvasStore((s) => {
    let count = 0;
    for (const n of s.nodes) {
      if (n.selected && ++count > 1) return true;
    }
    return false;
  });
  // cropOpen / annotateOpen 完全由 store 的 croppingNodeId / annotatingNodeId 驱动，
  // 直接派生即可，避免「setState-in-effect」导致的级联渲染。
  const setCroppingNodeId = useCanvasStore((s) => s.setCroppingNodeId);
  const croppingNodeId = useCanvasStore((s) => s.croppingNodeId);
  const cropOpen = croppingNodeId === id;
  const [angleEditorOpen, setAngleEditorOpen] = useState(false);
  const [lightingOpen, setLightingOpen] = useState(false);
  // annotateOpen is driven by the store's annotatingNodeId so that clicking
  // other nodes or the pane can close annotation mode externally.
  const annotatingNodeId = useCanvasStore((s) => s.annotatingNodeId);
  const annotateOpen = annotatingNodeId === id;
  const setAnnotateOpen = useCallback((open: boolean) => {
    useCanvasStore.getState().setAnnotatingNodeId(open ? id : null);
  }, [id]);
  // 全景模式：由节点 data.panorama 布尔字段驱动（随节点落库，刷新后自动恢复），
  // 仅支持手动退出（工具栏关闭按钮）；每个节点独立判断，可多个节点同时开启
  const [panoramaOpen, setPanoramaOpenInternal] = useState<boolean>(() => !!data.panorama);
  const setPanoramaOpen = useCallback(
    (open: boolean) => {
      setPanoramaOpenInternal(open);
      useCanvasStore.getState().updateNodeData(id, { panorama: open });
    },
    [id]
  );
  const [expanded, setExpanded] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewIndex, setPreviewIndex] = useState(0);
  const nodeRef = useRef<HTMLDivElement>(null);

  // 点击节点外部时收起展开视图
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

  /** 节点内上传 / 替换：走统一上传管道（失败自动回滚并提示） */
  const handleUpload = useNodeUpload(id, {
    accept: "image/*",
    clearFields: ["multiResultUrls", "multiResultTotalCount"],
  });

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

  // 预览浮层：图片列表优先用多图结果，单图时退化为 [src]
  const previewList = useMemo(
    () => (isMulti && Array.isArray(data.multiResultUrls) ? data.multiResultUrls : [src]),
    [isMulti, data.multiResultUrls, src]
  );
  const openPreview = useCallback(() => {
    if (!src) return;
    const idx = isMulti && Array.isArray(data.multiResultUrls) ? data.multiResultUrls.indexOf(src) : 0;
    setPreviewIndex(idx < 0 ? 0 : idx);
    setPreviewOpen(true);
  }, [src, isMulti, data.multiResultUrls]);

  // 预览浮层：Esc 关闭
  useEffect(() => {
    if (!previewOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setPreviewOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [previewOpen]);

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
      // 3. 创建派生新节点（与宫格切分、裁剪同一条链路）
      const derivedLabel = op === "rot90" ? "旋转" : op === "flipH" ? "水平翻转" : "垂直翻转";
      await runMediaUpload({
        items: [{ blob, filename: "transform.png", naturalWidth: cw, naturalHeight: ch, label: derivedLabel }],
        sink: { kind: "derived-node", sourceId: id },
      });
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
      name: data.alt || data.label || t("node.image"),
      type: "other",
      width: d?.naturalWidth || 0,
      height: d?.naturalHeight || 0,
      description: "",
      metadata: {
        sourceUrl: src,
        prompt: d?.genSettings?.prompt,
        source: d?.source,
      },
    });
  }, [src, data.alt, data.label, id, addAsset]);

  const handleGridSplit = useGridSplit(id, src);

  const handleApplyTemplate = useCallback(async (type: "reverse" | "characterFaceThreeView" | "characterThreeView" | "nineGridScene" | "storyboard25" | "storyboard4" | "forward3s" | "back5s") => {
    if (!src) return;
    const template = await getPromptTemplate(type);
    if (!template) return;

    const node = useCanvasStore.getState().nodes.find((n) => n.id === id);
    if (!node) return;
    const nodeWidth = (node.style?.width as number) || DEFAULT_NODE_WIDTH;
    const gap = 48;
    const position = {
      x: node.position.x + nodeWidth + gap,
      y: node.position.y,
    };

    // 反推提示词 -> 文本节点（承载可编辑的提示词文本）
    // 角色面部三视图 / 角色三视图 / 多机位九宫格 -> 图片节点（预填提示词，供图片生成面板使用）
    if (type === "reverse") {
      const textNode = createTextNode(position);
      textNode.data = {
        ...textNode.data,
        genSettings: { ...(textNode.data.genSettings || { prompt: "" }), prompt: template } as TextNodeData["genSettings"],
      };
      const edge = createEdge(id, textNode.id);
      const store = useCanvasStore.getState();
      store.addNodes([textNode]);
      store.setEdges([...store.edges, edge]);
    } else {
      const imageNode = createImageNode(position);
      imageNode.data = {
        ...imageNode.data,
        genSettings: { ...(imageNode.data.genSettings || { prompt: "" }), prompt: template } as ImageNodeData["genSettings"],
      };
      const edge = createEdge(id, imageNode.id);
      const store = useCanvasStore.getState();
      store.addNodes([imageNode]);
      store.setEdges([...store.edges, edge]);
    }
    markDirtyImmediate();
  }, [id, src]);

  const handleClear = useCallback(() => {
    useCanvasStore.getState().updateNodeData(id, {
      src: "", label: "", alt: "", naturalWidth: 0, naturalHeight: 0,
      rotation: undefined, flipH: undefined, flipV: undefined,
      upload: undefined, multiResultUrls: undefined, multiResultTotalCount: undefined,
      source: undefined,
    }, { width: DEFAULT_NODE_WIDTH, height: DEFAULT_NODE_HEIGHT });
    markDirtyImmediate();
  }, [id]);

  // Listen for node action events from NodeToolbar
  const actionRefs = useRef({ handleDownload, handleSaveToAssets, handleClear, handleTransform, handleGridSplit, handleApplyTemplate, openPreview });
  useEffect(() => {
    actionRefs.current = { handleDownload, handleSaveToAssets, handleClear, handleTransform, handleGridSplit, handleApplyTemplate, openPreview };
  }, [handleDownload, handleSaveToAssets, handleClear, handleTransform, handleGridSplit, handleApplyTemplate, openPreview]);
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
        case "panorama": if (src) setPanoramaOpen(true); break;
        case "preview-fullscreen": a.openPreview(); break;
        case "clear": a.handleClear(); break;
        case "transform": a.handleTransform(detail.op); break;
        case "grid-split": a.handleGridSplit(detail.rows, detail.cols); break;
        case "create-reverse": a.handleApplyTemplate("reverse"); break;
        case "create-character-face": a.handleApplyTemplate("characterFaceThreeView"); break;
        case "create-character-three-view": a.handleApplyTemplate("characterThreeView"); break;
        case "create-nine-grid-scene": a.handleApplyTemplate("nineGridScene"); break;
        case "create-25-grid-storyboard": a.handleApplyTemplate("storyboard25"); break;
        case "create-4-grid-storyboard": a.handleApplyTemplate("storyboard4"); break;
        case "create-forward-3s": a.handleApplyTemplate("forward3s"); break;
        case "create-back-5s": a.handleApplyTemplate("back5s"); break;
      }
    }
    window.addEventListener(EventNames.CANVAS_NODE_ACTION, onNodeAction);
    return () => window.removeEventListener(EventNames.CANVAS_NODE_ACTION, onNodeAction);
  }, [id, src, setCroppingNodeId, setAnnotateOpen, handleApplyTemplate]);

  const { editing: editingTitle, draft: titleDraft, setDraft: setTitleDraft, handleDblClick: handleTitleDblClick, handleSave: handleTitleSave } =
    useEditableTitle(id, data.alt || data.label || t("node.image"), { syncAlt: true });

  const hasImage = src && src.length > 0;

  // 烘焙模式：图片本身就是旋转/翻转后的成品，无需 CSS transform

  return (
    <>
    <div ref={nodeRef} className="group relative w-full h-full flex flex-col">
      {/* Title */}
      <div className="flex items-center justify-between px-3 py-1 text-[13px] font-medium text-white/80" style={{ height: NODE_TITLE_HEIGHT, flexShrink: 0 }}>
        {editingTitle ? (
          <span className="flex items-center gap-0.5 flex-1 min-w-0">
            <PictureOutlined className="shrink-0" />
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
            <PictureOutlined className="mr-1" />
            {data.label || data.alt || t("node.image")}
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
        `}
        style={{ background: hasImage ? "transparent" : "var(--canvas-bg, #262626)" }}
      >
        {isMulti && !expanded && (
          <div className="absolute top-2 right-2 z-20 nodrag">
            <Tooltip title={t("common.expand")}>
              <button
                className="flex items-center justify-center w-7 h-7 rounded-md bg-black/60 hover:bg-black/80 text-white/80 hover:text-white transition-colors cursor-pointer"
                onClick={toggleExpand}
              >
                <FullscreenOutlined style={{ fontSize: 12 }} />
              </button>
            </Tooltip>
          </div>
        )}
        {data.source === "upload" && hasImage && !data.upload?.uploading && !isGenerating(data.taskBinding) && (
          <div className="absolute top-2 right-2 z-20 nodrag">
            <Tooltip title={t("common.replace")}>
              <button
                className="flex items-center justify-center w-7 h-7 rounded-md bg-black/60 hover:bg-black/80 text-white/80 hover:text-white transition-colors cursor-pointer"
                onClick={handleUpload}
              >
                <UploadOutlined style={{ fontSize: 12 }} />
              </button>
            </Tooltip>
          </div>
        )}
        {data.upload?.uploading ? (
          <div className="absolute inset-0 rounded-lg overflow-hidden">
            {data.upload?.previewUrl && (
              <img src={data.upload.previewUrl} alt="" className="absolute inset-0 w-full h-full object-cover" style={{ filter: "blur(24px)", animation: "breathe 3s ease-in-out infinite" }} />
            )}
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-8" style={{ background: "rgba(0,0,0,0.35)" }}>
              {data.upload?.progress != null ? (
                <div className="w-full h-1.5 bg-white/10 rounded-full overflow-hidden">
                  <div className="h-full bg-[#1D9E75] rounded-full transition-all duration-300" style={{ width: `${data.upload.progress}%` }} />
                </div>
              ) : (
                <div className="w-full h-1.5 bg-white/10 rounded-full overflow-hidden">
                  <div className="h-full bg-[#1D9E75] rounded-full animate-pulse" style={{ width: "60%" }} />
                </div>
              )}
              <span className="text-sm text-white/60 tabular-nums">
                {t("common.uploading")}
                {data.upload?.progress != null ? ` ${Math.round(data.upload.progress)}%` : ""}
              </span>
            </div>
          </div>
        ) : data.upload?.error ? (
          <UploadFailedOverlay nodeId={id} error={data.upload.error} previewUrl={data.upload.previewUrl} />
        ) : isGenerating(data.taskBinding) ? (
          <GeneratingOverlay absolute rounded startedAt={data.taskBinding?.startedAt} />
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
                          {/* 操作按钮：与单图素材/多图未展开的右上角徽章统一 top-2（距顶 8px） */}
                          <div className="absolute top-2 right-2 flex gap-1 z-10 nodrag">
                            <Tooltip title={t("common.download")}>
                              <button
                                className="flex items-center justify-center w-7 h-7 rounded-md bg-black/60 hover:bg-black/80 text-white/80 hover:text-white cursor-pointer"
                                onClick={() => handleDownloadUrl(url)}
                              >
                                <DownloadOutlined style={{ fontSize: 13 }} />
                              </button>
                            </Tooltip>
                            {!isMain && (
                              <Tooltip title={t("node.setAsMain")}>
                                <button
                                  className="flex items-center justify-center w-7 h-7 rounded-md bg-black/60 hover:bg-black/80 text-white/80 hover:text-white cursor-pointer"
                                  onClick={() => handleSetMain(url)}
                                >
                                  <CrownOutlined style={{ fontSize: 13 }} />
                                </button>
                              </Tooltip>
                            )}
                            {isMain && (
                              <Tooltip title={t("common.collapse")}>
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
              onClick={handleUpload}>
              <UploadOutlined className="text-lg" /> {t("common.upload")}
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
      {panoramaOpen && src && (
        <div className="pointer-events-none absolute inset-0 overflow-visible">
          <PanoramaPanel
            src={src}
            sourceId={id}
            selected={selected && !multiSelect}
            onClose={() => setPanoramaOpen(false)}
          />
        </div>
      )}
      </div>

      {data.source !== "upload" && <Handle type="target" position={Position.Left} style={{ top: NODE_HANDLE_TOP, zIndex: 999 }} />}
      <Handle type="source" position={Position.Right} style={{ top: NODE_HANDLE_TOP, zIndex: 999 }} />
    </div>
    {angleEditorOpen && src && createPortal(
      <MultiAngleEditor src={src} sourceId={id} onClose={() => setAngleEditorOpen(false)} />,
      document.body
    )}
    {lightingOpen && src && createPortal(
      <LightingPanel src={src} onClose={() => setLightingOpen(false)} />,
      document.body
    )}
    {previewOpen && createPortal(
      <PreviewOverlay
        list={previewList}
        index={previewIndex}
        onIndexChange={setPreviewIndex}
        onClose={() => setPreviewOpen(false)}
      />,
      document.body
    )}
    </>
  );
}

/** 全屏预览浮层：支持多图切换、下载、Esc/点击背景关闭，带淡入动画 */
function PreviewOverlay({
  list, index, onIndexChange, onClose,
}: {
  list: string[];
  index: number;
  onIndexChange: (i: number) => void;
  onClose: () => void;
}) {
  const [shown, setShown] = useState(false);
  const current = list[Math.max(0, Math.min(index, list.length - 1))] || "";
  const count = list.length;
  const go = (dir: number) => {
    if (count <= 1) return;
    onIndexChange((index + dir + count) % count);
  };
  useEffect(() => {
    const r = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(r);
  }, []);

  const handleDownload = () => {
    if (!current) return;
    const a = document.createElement("a");
    const sep = current.includes("?") ? "&" : "?";
    a.href = `${current}${sep}${new URLSearchParams({ download: "true" }).toString()}`;
    a.download = "";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const btnBase =
    "flex cursor-pointer items-center justify-center rounded-full text-white/90 transition hover:text-white hover:bg-white/15";

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center nodrag"
      style={{
        background: "rgba(0,0,0,0.92)",
        opacity: shown ? 1 : 0,
        transition: "opacity 0.2s ease",
      }}
      onClick={onClose}
    >
      {/* 关闭 */}
      <button
        className={`${btnBase} absolute right-5 top-5 h-10 w-10 text-xl`}
        onClick={onClose}
      >
        <CloseOutlined />
      </button>

      {/* 下载 */}
      <button
        className={`${btnBase} absolute right-5 top-[68px] h-10 w-10 text-lg`}
        onClick={(e) => { e.stopPropagation(); handleDownload(); }}
      >
        <DownloadOutlined />
      </button>

      {/* 上一张 */}
      {count > 1 && (
        <button
          className={`${btnBase} absolute left-5 top-1/2 h-12 w-12 -translate-y-1/2 text-2xl`}
          onClick={(e) => { e.stopPropagation(); go(-1); }}
        >
          <LeftOutlined />
        </button>
      )}

      {/* 当前图片 */}
      {current && (
        <img
          src={current}
          alt=""
          draggable={false}
          onClick={(e) => e.stopPropagation()}
          style={{
            maxWidth: "90vw",
            maxHeight: "88vh",
            objectFit: "contain",
            borderRadius: 8,
            boxShadow: "0 8px 40px rgba(0,0,0,0.5)",
            transform: shown ? "scale(1)" : "scale(0.96)",
            transition: "transform 0.2s ease",
          }}
        />
      )}

      {/* 下一张 */}
      {count > 1 && (
        <button
          className={`${btnBase} absolute right-5 top-1/2 h-12 w-12 -translate-y-1/2 text-2xl`}
          onClick={(e) => { e.stopPropagation(); go(1); }}
        >
          <RightOutlined />
        </button>
      )}

      {/* 计数 */}
      {count > 1 && (
        <div
          className="absolute bottom-5 left-1/2 -translate-x-1/2 rounded-full bg-black/40 px-3 py-1 text-sm text-white/90"
          onClick={(e) => e.stopPropagation()}
        >
          {index + 1} / {count}
        </div>
      )}

      {/* 缩略图条 */}
      {count > 1 && (
        <div
          className="absolute bottom-14 left-1/2 flex max-w-[90vw] -translate-x-1/2 gap-2 overflow-x-auto rounded-xl bg-black/40 p-2"
          onClick={(e) => e.stopPropagation()}
        >
          {list.map((url, i) => (
            <button
              key={i}
              onClick={() => onIndexChange(i)}
              className={`h-14 w-14 shrink-0 cursor-pointer overflow-hidden rounded-md transition ${
                i === index ? "ring-2 ring-white" : "opacity-60 hover:opacity-100"
              }`}
            >
              <img src={url} alt="" className="h-full w-full object-cover" draggable={false} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default memo(ImageNode);
