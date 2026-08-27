/**
 * 文本生成面板，挂在文本节点下方。
 * 负责提示词输入（支持 @ 引用其他节点）与文本模型选择，
 * 以流式方式接收生成结果并写回节点内容。
 */
"use client";

import { ArrowUpOutlined, CloseOutlined, PlusOutlined } from "@ant-design/icons";
import { App, Button, Tooltip } from "antd";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { TextIcon } from "@/components/ui/icons/media/TextIcon";
import { MenuItem, MenuPopover } from "@/components/ui/MenuPopover";
import WheelGuard from "@/components/ui/WheelGuard";
import { generationApi } from "@/features/canvas/api/generation-api";
import { createEdge, createImageNode } from "@/features/canvas/node-defaults";
import { flushAndWait, markDirtyImmediate, useCanvasStore } from "@/features/canvas/stores/canvas-store";
import { useHistoryStore } from "@/features/canvas/stores/history-store";
import type { TextGenSettings, TextNodeData } from "@/features/canvas/types";
import { apiUpload } from "@/lib/api/client";
import { isGenerating as isGeneratingBinding, NODE_TYPE } from "@/lib/constants";
import { ModelIcon } from "@/lib/model-icon";
import { useModelStore } from "@/lib/model-store";
import { applyThumbnailSettings } from "@/lib/utils/image-utils";

import MentionPrompt, { type ReferenceItem } from "../shared/MentionPrompt";
import { EMPTY_ORDER, mergeOrder, useGenSettings, writeOrderPref } from "../shared/ref-order";
import { findReferenceNode, useRevealCanvasNode } from "../shared/reveal-node";

interface Props {
  nodeId: string;
}

interface ModelOption {
  value: string;
  providerId: string;
  modelId: string;
  name: string;
  providerName: string;
}

const TextGenerationPanel = memo(function TextGenerationPanel({ nodeId }: Props) {
  const { t } = useTranslation();
  const reveal = useRevealCanvasNode();
  const providers = useModelStore((s) => s.providers);
  const { notification } = App.useApp();

  const allModels = providers
    .flatMap((c) =>
      c.models
        .filter((m) => m.capabilities?.includes("text"))
        .map((m) => ({ value: `${c.id}/${m.id}`, providerId: c.id, modelId: m.id, name: m.name, providerName: c.name })),
    )
    .filter((m, i, arr) => arr.findIndex((x) => x.value === m.value) === i);

  // Read persisted settings from node data
  const saved = useMemo(() => {
    const node = useCanvasStore.getState().nodes.find((n) => n.id === nodeId);
    const s = ((node?.data as { genSettings?: Partial<TextGenSettings> })?.genSettings ?? {}) as Partial<TextGenSettings>;
    return {
      prompt: s.prompt || "",
      modelKey: s.modelKey || allModels[0]?.value || "",
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeId]);

  const [prompt, setPrompt] = useState(saved.prompt);
  const [modelKey, setModelKey] = useState(saved.modelKey);
  const [modelOpen, setModelOpen] = useState(false);
  const [hoverImg, setHoverImg] = useState<string | null>(null);
  const [isRefDragging, setIsRefDragging] = useState(false);

  // Upstream reference images - derived live from current edges
  const canvasNodes = useCanvasStore((s) => s.nodes);
  const canvasEdges = useCanvasStore((s) => s.edges);

  const isGenerating = useMemo(() => {
    const node = canvasNodes.find((n) => n.id === nodeId);
    return isGeneratingBinding((node?.data as TextNodeData)?.taskBinding);
  }, [canvasNodes, nodeId]);
  const refImages = useMemo(() => {
    const upstreamIds = new Set(canvasEdges.filter((e) => e.target === nodeId).map((e) => e.source));
    return canvasNodes
      .filter((n) => upstreamIds.has(n.id) && n.type === NODE_TYPE.IMAGE)
      .map((n) => (n.data as { src?: string }).src)
      .filter(Boolean) as string[];
  }, [nodeId, canvasNodes, canvasEdges]);

  // 上游 Text 节点（按连接顺序），仅保留 content 非空的
  const upstreamTexts = useMemo(() => {
    return canvasEdges
      .filter((e) => e.target === nodeId)
      .map((e) => canvasNodes.find((n) => n.id === e.source))
      .filter((n): n is NonNullable<typeof n> => !!n && n.type === NODE_TYPE.TEXT)
      .map((n) => ({ id: n.id, content: ((n.data as { content?: string }).content || "").trim() }))
      .filter((t) => t.content !== "");
  }, [nodeId, canvasNodes, canvasEdges]);

  // 最终 prompt = 上游文本内容 + 面板输入，按连接顺序拼接
  const finalPrompt = useMemo(() => {
    return [...upstreamTexts.map((t) => t.content), prompt.trim()].filter(Boolean).join("\n");
  }, [upstreamTexts, prompt]);

  // 参考显示顺序：排序偏好（genSettings，唯一写者 = 拖拽排序事件）+ 连线实时列表，纯派生合并
  const genSettings = useGenSettings(nodeId);
  const orderPref = (genSettings as Partial<TextGenSettings> | undefined)?.refOrder ?? EMPTY_ORDER;
  const refOrder = useMemo(() => mergeOrder(orderPref, refImages), [orderPref, refImages]);
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);

  // 构建 @ 提及的参考图列表（基于 refOrder，保证图1图2编号稳定）
  const references = useMemo<ReferenceItem[]>(() => {
    return refOrder.map((src, i) => ({
      src,
      thumbnail: src.includes("/api/files/") ? `${src}?w=64` : src,
      index: i,
      kind: "image" as const,
    }));
  }, [refOrder]);

  const latestSettingsRef = useRef({ prompt, modelKey });
  useEffect(() => {
    latestSettingsRef.current = { prompt, modelKey };
  }, [prompt, modelKey]);

  // Persist settings to node data (debounced)。
  // 参考排序偏好不经过此通道：它在排序事件时已即时写入，此处从 store 透传，避免双写。
  useEffect(() => {
    const timer = setTimeout(() => {
      const node = useCanvasStore.getState().nodes.find((n) => n.id === nodeId);
      const cur = ((node?.data as { genSettings?: Partial<TextGenSettings> })?.genSettings ?? {}) as Partial<TextGenSettings>;
      useCanvasStore.getState().updateNodeData(
        nodeId,
        { genSettings: { kind: "text", prompt, modelKey, refOrder: cur.refOrder ?? [] } },
        undefined,
        { skipHistory: true },
      );
    }, 300);
    return () => clearTimeout(timer);
  }, [prompt, modelKey, nodeId]);

  // Flush pending settings on unmount
  useEffect(() => {
    return () => {
      const latest = latestSettingsRef.current;
      const node = useCanvasStore.getState().nodes.find((n) => n.id === nodeId);
      const savedGen = (node?.data as { genSettings?: TextGenSettings })?.genSettings;
      if (
        savedGen &&
        savedGen.prompt === latest.prompt &&
        savedGen.modelKey === latest.modelKey
      )
        return;
      const cur: Partial<TextGenSettings> = savedGen ?? {};
      useCanvasStore.getState().updateNodeData(
        nodeId,
        { genSettings: { kind: "text", prompt: latest.prompt, modelKey: latest.modelKey, refOrder: cur.refOrder ?? [] } },
        undefined,
        { skipHistory: true },
      );
      markDirtyImmediate();
    };
  }, []);

  const is: React.CSSProperties = {
    background: "transparent",
    border: "none",
    color: "var(--canvas-text)",
    borderRadius: 4,
    fontSize: 13,
  };

  /** Upload image -> create ImageNode + auto-connect */
  const handleRefUpload = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      const formData = new FormData();
      formData.append("file", file);
      const res = await apiUpload<{ url: string }>("/api/files/upload?category=images", formData);
      if (res.code !== 200 || !res.data?.url) return;
      const imgUrl = res.data.url;

      const store = useCanvasStore.getState();
      const targetNode = store.nodes.find((n) => n.id === nodeId);
      if (!targetNode) return;

      const img = new window.Image();
      img.onload = () => {
        const nw = img.naturalWidth,
          nh = img.naturalHeight;
        const tw = (targetNode.style?.width as number) || 400;
        const newNode = createImageNode({ x: targetNode.position.x - 50, y: targetNode.position.y + tw / 2 }, imgUrl);
        applyThumbnailSettings(newNode, nw, nh, file.name);
        const dw = (newNode.style?.width as number) || nw;
        const dh = (newNode.style?.height as number) || nh;
        newNode.position.x = targetNode.position.x - dw - 50;
        newNode.position.y = targetNode.position.y + (tw - dh) / 2;
        store.addNodes([newNode]);
        store.setEdges([...store.edges, createEdge(newNode.id, nodeId)]);
        markDirtyImmediate();
      };
      img.src = imgUrl;
    };
    input.click();
  };

  const handleGenerate = async () => {
    if ((!prompt.trim() && upstreamTexts.length === 0) || !modelKey || isGenerating) return;
    const entry: ModelOption | undefined = allModels.find((m) => m.value === modelKey);
    if (!entry) return;

    // forceHistory 先捕获不含 taskBinding 的干净状态，再写入处理中标记
    useCanvasStore.getState().updateNodeData(nodeId, { taskBinding: { taskId: "", status: "processing" } }, undefined, { forceHistory: true });
    markDirtyImmediate();

    try {
      // 与 image/video 链路完全同构：prompt 落任务级文本列、参考图落 ref_images 列。
      // messages 的构造（含多模态组装与 base64 转换）由后端 llm service 归一化完成
      const res = await generationApi.submitGenerationTask({
        type: "llm",
        prompt: finalPrompt,
        model: entry.name,
        providerId: entry.providerId,
        nodeId,
        refImages: refOrder.length > 0 ? refOrder : undefined,
      });
      const json = await res.json();
      if (json.code !== 200) throw new Error(json.msg || `HTTP ${res.status}`);

      const taskId: string | undefined = json.data?.id;
      if (!taskId) throw new Error("No taskId returned");

      // 异步回调时检查：取消后 taskBinding 被清空，丢弃过期结果
      const cur = useCanvasStore.getState().nodes.find((n) => n.id === nodeId);
      const curBinding = cur ? (cur.data as TextNodeData)?.taskBinding : undefined;
      if (!isGeneratingBinding(curBinding)) return;

      // Save task_id to node data immediately (SSE handled by InfiniteCanvas)
      useCanvasStore.getState().updateNodeData(nodeId, { taskBinding: { taskId, status: "pending" } }, undefined, { skipHistory: true });
      await flushAndWait();
    } catch (err: unknown) {
      useCanvasStore.getState().updateNodeData(nodeId, { taskBinding: undefined }, undefined, { skipHistory: true });
      markDirtyImmediate();
      // 生成失败：pop 掉 forceHistory 压的那条预生成快照，不留死撤销
      useHistoryStore.setState((s) => ({ undoStack: s.undoStack.slice(0, -1) }));
      notification.error({
        title: t("generation.failed"),
        description: err instanceof Error ? err.message : "",
        placement: "bottomRight",
        duration: 15,
      });
    }
  };

  const handleCancel = async () => {
    const node = useCanvasStore.getState().nodes.find((n) => n.id === nodeId);
    const tid = (node?.data as TextNodeData)?.taskBinding?.taskId;
    if (tid) {
      generationApi.cancelGenerationTask(tid).catch(() => {});
    }
    useCanvasStore.getState().updateNodeData(nodeId, { taskBinding: undefined }, undefined, { skipHistory: true });
    markDirtyImmediate();
    // 取消生成：pop 掉 forceHistory 压的那条预生成快照，不留死撤销
    useHistoryStore.setState((s) => ({ undoStack: s.undoStack.slice(0, -1) }));
  };

  return (
    <>
      <style>{`.gen-textarea:focus, .gen-textarea-focused { border: none !important; box-shadow: none !important; outline: none !important; }`}</style>
      <WheelGuard
        className="nodrag nopan flex flex-col gap-2 px-4 py-3 rounded-lg shadow-xl"
        style={{ background: "var(--canvas-bg, #262626)", border: "1px solid var(--canvas-border, #3a3a3a)", width: 580 }}
      >
        <div
          className="flex gap-2 flex-wrap"
          onDragOver={(e) => {
            e.preventDefault();
            e.stopPropagation();
            if (e.dataTransfer.types.includes("application/x-ref-image") || e.dataTransfer.types.includes("application/x-ref-video") || e.dataTransfer.types.includes("application/x-ref-audio")) {
              e.dataTransfer.dropEffect = "none"; // 排序仅限图片缩略图上，加号/空白一律禁止
              return;
            }
            e.dataTransfer.dropEffect = "move";
          }}
          onDragLeave={() => setDragOverIdx(null)}
          onDrop={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setDragOverIdx(null);
          }}
        >
            {/* 上游 Text 节点 - 不可拖动，按连接顺序自动排前 */}
            {upstreamTexts.map((txt) => (
              <Tooltip key={`text-${txt.id}`} title={txt.content.length > 50 ? txt.content.slice(0, 50) + "..." : txt.content}>
                <div className="relative group h-16 w-16 rounded flex items-center justify-center" style={{ background: "var(--canvas-bg-hover)", border: "1px solid var(--canvas-border)" }}
                onDoubleClick={() => {
                  const n = useCanvasStore.getState().nodes.find((x) => x.id === txt.id);
                  if (n) reveal(n);
                }}>
                  <TextIcon className="pointer-events-none" style={{ color: "var(--canvas-text)", width: 14, height: 15 }} />
                  <Button type="text" size="small"
                    className="!absolute -top-1.5 -right-1.5 !w-4 !h-4 !flex items-center justify-center !rounded-full !bg-black/70 !text-white/60 hover:!text-white hover:!bg-white/30 !text-[10px] opacity-0 group-hover:opacity-100 transition-opacity !p-0 !border-0"
                    onClick={() => {
                      const store = useCanvasStore.getState();
                      const edge = store.edges.find((e) => e.target === nodeId && e.source === txt.id);
                      if (edge) store.removeEdges([edge.id]);
                    }}>✕</Button>
                </div>
              </Tooltip>
            ))}
            {refOrder.map((img, i) => (
              <div
                key={img}
                draggable
                onDoubleClick={() => { const n = findReferenceNode(nodeId, NODE_TYPE.IMAGE, img); if (n) reveal(n); }}
                onDragStart={(e) => {
                  e.dataTransfer.setData("application/x-ref-image", img);
                  e.dataTransfer.setData("text/plain", img);
                  e.dataTransfer.effectAllowed = "move";
                  setIsRefDragging(true);
                  // 以缩略图为拖拽图像并锚定中心，避免快照携带悬停预览浮层导致错位
                  const el = (e.currentTarget as HTMLElement).querySelector("img");
                  if (el) e.dataTransfer.setDragImage(el, 32, 32);
                }}
                onDragEnd={() => setIsRefDragging(false)}
                onDragOver={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  if (!e.dataTransfer.types.includes("application/x-ref-image")) {
                    e.dataTransfer.dropEffect = "none"; // 仅图片可放到图片位置
                    return;
                  }
                  e.dataTransfer.dropEffect = "move";
                  setDragOverIdx(i);
                }}
                onDragLeave={() => setDragOverIdx(null)}
                onDrop={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setDragOverIdx(null);
                  const dragged = e.dataTransfer.getData("text/plain");
                  if (!dragged || dragged === img) return;
                  const list = [...refOrder];
                  const fromIdx = list.indexOf(dragged);
                  const toIdx = list.indexOf(img);
                  if (fromIdx === -1 || fromIdx === toIdx) return;
                  const [moved] = list.splice(fromIdx, 1);
                  list.splice(toIdx, 0, moved);
                  writeOrderPref(nodeId, { refOrder: list });
                }}
                className="relative group"
              >
                <img
                  src={img.includes("/api/files/") ? `${img}?w=128` : img}
                  draggable={false}
                  alt={`Ref ${i + 1}`}
                  className={`h-16 w-16 rounded object-cover cursor-grab active:cursor-grabbing transition-shadow ${dragOverIdx === i ? "ring-2 ring-white shadow-lg" : ""}`}
                  onMouseEnter={() => setHoverImg(img)}
                  onMouseLeave={() => setHoverImg(null)}
                />
                <span className="absolute bottom-0.5 left-1/2 -translate-x-1/2 text-[11px] font-bold px-1 rounded pointer-events-none whitespace-nowrap" style={{ background: "rgba(0,0,0,0.6)", color: "#fff" }}>{t("common.refImageLabel", { index: i + 1 })}</span>
                {hoverImg === img && !isRefDragging && (
                  <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 z-50 pointer-events-none">
                    <img
                      src={img.includes("/api/files/") ? `${img}?w=640` : img}
                      className="max-w-[360px] max-h-[360px] rounded-lg shadow-2xl"
                      style={{ background: "var(--canvas-bg)", border: "1px solid var(--canvas-border)", objectFit: "contain" }}
                    />
                  </div>
                )}
                <Button
                  type="text"
                  size="small"
                  className="!absolute -top-1.5 -right-1.5 !w-4 !h-4 !flex items-center justify-center !rounded-full !bg-black/70 !text-white/60 hover:!text-white hover:!bg-white/30 !text-[10px] opacity-0 group-hover:opacity-100 transition-opacity !p-0 !border-0"
                  onClick={() => {
                    const store = useCanvasStore.getState();
                    const edge = store.edges.find((e) => {
                      if (e.target !== nodeId) return false;
                      const srcNode = store.nodes.find((n) => n.id === e.source);
                      return srcNode && srcNode.type === NODE_TYPE.IMAGE && (srcNode.data as { src?: string }).src === img;
                    });
                    if (edge) store.removeEdges([edge.id]);
                  }}
                >
                  ✕
                </Button>
              </div>
            ))}
            {/* 添加参考：方形加号占位，与参考缩略图同行 */}
            <Tooltip title={t("common.reference")}>
              <Button size="small" type="text"
                className="flex items-center justify-center rounded transition-colors flex-shrink-0"
                style={{ width: 64, height: 64, background: "var(--canvas-bg-hover)", border: "1px dashed var(--canvas-border)", cursor: "pointer" }}
                onMouseEnter={(e) => { const el = e.currentTarget as HTMLElement; el.style.borderColor = "var(--canvas-text-dim)"; el.style.background = "rgba(255,255,255,0.08)"; }}
                onMouseLeave={(e) => { const el = e.currentTarget as HTMLElement; el.style.borderColor = "var(--canvas-border)"; el.style.background = "var(--canvas-bg-hover)"; }}
                onClick={handleRefUpload}>
                <PlusOutlined style={{ fontSize: 18, color: "var(--canvas-text-muted)" }} />
              </Button>
            </Tooltip>
          </div>
        <MentionPrompt
          references={references}
          value={prompt}
          onChange={setPrompt}
          placeholder={t("generation.promptPlaceholderText")}
          style={{ minHeight: 100, outline: "none", boxShadow: "none" }}
        />
        <div className="flex items-center gap-2">
          <MenuPopover
            open={modelOpen}
            onOpenChange={setModelOpen}
            placement="bottomLeft"
            trigger={
              <Button
                size="small"
                type="text"
                className="gen-panel-btn flex items-center gap-1.5 px-3 py-1.5 rounded text-sm max-w-[180px]"
                style={{ border: "none", cursor: "pointer" }}
              >
                <ModelIcon model={allModels.find((m) => m.value === modelKey)?.name ?? modelKey} style={{ fontSize: 14, flexShrink: 0 }} />
                <span className="truncate">
                  {allModels.find((m) => m.value === modelKey)?.name ?? "Select model"}
                </span>
              </Button>
            }
            content={allModels.map((m) => (
              <MenuItem
                key={m.value}
                onClick={() => {
                  setModelKey(m.value);
                  setModelOpen(false);
                }}
                selected={modelKey === m.value}
              >
                <span className="flex items-center gap-1.5">
                  <ModelIcon model={m.name} className="size-4 shrink-0" />
                  <span className="truncate">{m.name}</span>
                  {m.providerName ? <span className="ml-auto max-w-24 shrink-0 truncate text-xs opacity-50">{m.providerName}</span> : null}
                </span>
              </MenuItem>
            ))}
          />
          <div className="flex-1" />
          <Button
            size="small"
            type="text"
            className="flex items-center justify-center rounded-full flex-shrink-0 transition-all"
            style={{
              width: 36,
              height: 36,
              background: isGenerating ? "#e74c3c" : ((!prompt.trim() && upstreamTexts.length === 0) || !modelKey) ? "var(--canvas-border)" : "var(--canvas-text)",
              color: isGenerating ? "#fff" : ((!prompt.trim() && upstreamTexts.length === 0) || !modelKey) ? "var(--canvas-text-muted)" : "var(--canvas-bg)",
              border: "none",
              cursor: "pointer",
              opacity: (!prompt.trim() && upstreamTexts.length === 0 || !modelKey) && !isGenerating ? 0.5 : 1,
            }}
            onClick={isGenerating ? handleCancel : handleGenerate}
          >
            {isGenerating ? <CloseOutlined style={{ fontSize: 16 }} /> : <ArrowUpOutlined style={{ fontSize: 16 }} />}
          </Button>
        </div>
      </WheelGuard>
    </>
  );
});

export default TextGenerationPanel;
