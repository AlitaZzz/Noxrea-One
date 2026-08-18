/**
 * 图片生成面板，挂在图片节点下方。
 * 负责提示词输入（支持 @ 引用其他节点）、模型与画质 / 分辨率 / 比例 / 张数等参数配置，
 * 提交生成任务并把参数持久化到节点数据，生成结果回填当前节点或派生新节点。
 */
"use client";

import { ArrowUpOutlined, CloseOutlined, PlusOutlined } from "@ant-design/icons";
import { Button, Popover, Tooltip } from "antd";
import { memo, useEffect, useMemo,useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { TextIcon } from "@/components/ui/icons/media/TextIcon";
import { MenuItem,MenuPopover } from "@/components/ui/MenuPopover";
import WheelGuard from "@/components/ui/WheelGuard";
import { generationApi } from "@/features/canvas/api/generation-api";
import { createEdge,createImageNode } from "@/features/canvas/node-defaults";
import ParamFields, { fieldDefaults, hasField, ParamSummary } from "@/features/canvas/panels/ParamFields";
import { flushAndWait, markDirtyImmediate, useCanvasStore } from "@/features/canvas/stores/canvas-store";
import { useHistoryStore } from "@/features/canvas/stores/history-store";
import type { ImageGenSettings, MediaGenFields } from "@/features/canvas/types";
import { apiUpload } from "@/lib/api/client";
import { isGenerating as isGeneratingBinding, NODE_TYPE } from "@/lib/constants";
import { ModelIcon } from "@/lib/model-icon";
import { useModelStore } from "@/lib/model-store";
import type { ModelProvider } from "@/lib/types/models";
import { type ModelOption } from "@/lib/types/models";
import { applyThumbnailSettings } from "@/lib/utils/image-utils";

import MentionPrompt, { type ReferenceItem } from "../shared/MentionPrompt";

interface Props { nodeId: string; }

const ImageGenerationPanel = memo(function ImageGenerationPanel({ nodeId }: Props) {
  const { t } = useTranslation();
  const providers = useModelStore((s) => s.providers);
  const findModelParams = useModelStore((s) => s.findModelParams);
  const modelParamsCache = useModelStore((s) => s.modelParamsCache);
  const allModels = providers.flatMap((c) =>
    c.models.filter((m) => m.capabilities?.includes("image")).map((m) => ({ value: `${c.id}/${m.id}`, providerId: c.id, modelId: m.id, name: m.name, providerName: c.name }))
  ).filter((m, i, arr) => arr.findIndex((x) => x.value === m.value) === i);

  // Read persisted settings from node data
  const saved = useMemo(() => {
    const node = useCanvasStore.getState().nodes.find((n) => n.id === nodeId);
    const s = ((node?.data as MediaGenFields)?.genSettings ?? {}) as Partial<ImageGenSettings>;
    const mp = allModels.find((m) => m.value === (s.modelKey || allModels[0]?.value)) ?
      findModelParams(allModels.find((m) => m.value === (s.modelKey || allModels[0]?.value))!.providerId, allModels.find((m) => m.value === (s.modelKey || allModels[0]?.value))!.name, "image") : null;
    const d = mp ? fieldDefaults(mp.fields) : {};
    return {
      prompt: s.prompt || "",
      modelKey: s.modelKey || allModels[0]?.value || "",
      quality: s.quality || (d.quality as string) || "auto",
      resolution: s.resolution || (d.resolution as string) || "1K",
      ratio: s.ratio || (d.ratio as string) || "1:1",
      refOrder: s.refOrder || [],
      n: s.n || (d.n as number) || 1,
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeId]);
  const [prompt, setPrompt] = useState(saved.prompt);
  const [modelKey, setModelKey] = useState(saved.modelKey || allModels[0]?.value || "");
  const [quality, setQuality] = useState(saved.quality);
  const [resolution, setResolution] = useState(saved.resolution);
  const [ratio, setRatio] = useState(saved.ratio);
  const [n, setN] = useState(saved.n);
  const [hoverImg, setHoverImg] = useState<string | null>(null);
  const [modelOpen, setModelOpen] = useState(false);

  // 查找当前模型的参数配置（params + defaults + constraints）
  const modelParams = useMemo(() => {
    const entry = allModels.find((m) => m.value === modelKey);
    return entry ? findModelParams(entry.providerId, entry.name, "image") : null;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelKey, allModels, findModelParams, modelParamsCache]);

  // fields 为唯一数据源：渲染控件 + 默认值
  const fields = modelParams?.fields ?? [];
  const fieldValues: Record<string, unknown> = { quality, resolution, ratio, n };
  const setField = (name: string, value: unknown) => {
    if (name === "quality") setQuality(value as string);
    else if (name === "resolution") setResolution(value as string);
    else if (name === "ratio") setRatio(value as string);
    else if (name === "n") setN(value as number);
  };

  // 模型切换时：重置不在新模型 options 中的参数
  useEffect(() => {
    if (!modelParams) return;
    for (const f of modelParams.fields) {
      const cur = fieldValues[f.name] as string | number | undefined;
      if (f.options && f.options.length && cur !== undefined && !f.options.includes(cur)) {
        setField(f.name, f.default);
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelParams]);

  // Upstream reference images - derived live from current edges.
  const canvasNodes = useCanvasStore((s) => s.nodes);
  const canvasEdges = useCanvasStore((s) => s.edges);
  const refImages = useMemo(() => {
    const upstreamIds = new Set(canvasEdges.filter((e) => e.target === nodeId).map((e) => e.source));
    return canvasNodes
      .filter((n) => upstreamIds.has(n.id) && n.type === NODE_TYPE.IMAGE)
      .map((n) => (n.data as { src?: string }).src)
      .filter(Boolean) as string[];
  }, [nodeId, canvasNodes, canvasEdges]);

  // 上游 Text 节点（按连接顺序，去重），仅保留 content 非空的
  const upstreamTexts = useMemo(() => {
    const seen = new Set<string>();
    return canvasEdges
      .filter((e) => e.target === nodeId)
      .map((e) => canvasNodes.find((n) => n.id === e.source))
      .filter((n): n is NonNullable<typeof n> => !!n && n.type === NODE_TYPE.TEXT)
      .map((n) => ({ id: n.id, content: ((n.data as { content?: string }).content || "").trim() }))
      .filter((t) => t.content !== "" && !seen.has(t.id) && seen.add(t.id));
  }, [nodeId, canvasNodes, canvasEdges]);

  // 最终 prompt = 上游文本内容 + 面板输入，按连接顺序拼接
  const finalPrompt = useMemo(() => {
    return [...upstreamTexts.map((t) => t.content), prompt.trim()].filter(Boolean).join("\n");
  }, [upstreamTexts, prompt]);

  // User-controllable display order
  const [refOrder, setRefOrder] = useState<string[]>(saved.refOrder || []);
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);
  // Sync refOrder when upstream sources change, adjusted during render.
  const [prevRefImages, setPrevRefImages] = useState(refImages);
  if (refImages !== prevRefImages) {
    setPrevRefImages(refImages);
    setRefOrder((prev) => {
      const alive = prev.filter((u) => refImages.includes(u));
      const added = refImages.filter((u) => !prev.includes(u));
      if (added.length === 0 && alive.length === prev.length) return prev;
      return [...alive, ...added];
    });
  }

  // 构建 @ 提及的参考图列表（基于 refOrder，保证图1图2编号稳定）
  const references = useMemo<ReferenceItem[]>(() => {
    return refOrder.map((src, i) => ({
      src,
      thumbnail: src.includes("/api/files/") ? `${src}?w=64` : src,
      index: i,
      kind: "image" as const,
    }));
  }, [refOrder]);

  // Button disabled state derived from persistent node.data.task_status
  const isGenerating = useMemo(() => {
    const node = canvasNodes.find((n) => n.id === nodeId);
    return isGeneratingBinding((node?.data as MediaGenFields)?.taskBinding);
  }, [canvasNodes, nodeId]);

  const retryRef = useRef<{ count: number; prompt: string; modelKey: string; quality: string; resolution: string; ratio: string; refImages: string[]; n: number; entry: ModelOption | null; provider: ModelProvider | null }>({ count: 0, prompt: "", modelKey: "", quality: "", resolution: "", ratio: "", refImages: [] as string[], n: 1, entry: null, provider: null });
  const latestSettingsRef = useRef({ kind: "image" as const, prompt, modelKey, quality, resolution, ratio, refOrder, n });
  useEffect(() => {
    latestSettingsRef.current = { kind: "image", prompt, modelKey, quality, resolution, ratio, refOrder, n };
  }, [prompt, modelKey, quality, resolution, ratio, refOrder, n]);
  // Persist settings to node data on change (debounced)
  useEffect(() => {
    const timer = setTimeout(() => {
      useCanvasStore.getState().updateNodeData(nodeId, {
        genSettings: { kind: "image", prompt, modelKey, quality, resolution, ratio, refOrder, n },
      }, undefined, { skipHistory: true });
    }, 300);
    return () => clearTimeout(timer);
  }, [prompt, modelKey, quality, resolution, ratio, refOrder, n, nodeId]);

  // Flush pending settings on component unmount (not on dep changes)
  useEffect(() => {
    return () => {
      const latest = latestSettingsRef.current;
      const node = useCanvasStore.getState().nodes.find((n) => n.id === nodeId);
      const saved = (node?.data as MediaGenFields)?.genSettings as Partial<ImageGenSettings> | undefined;
      // 没有已保存值 或 任一字段变化 -> flush（refOrder 用 JSON.stringify 比较）
      if (saved &&
          saved.prompt === latest.prompt && saved.modelKey === latest.modelKey &&
          saved.quality === latest.quality && saved.resolution === latest.resolution &&
          saved.ratio === latest.ratio && saved.n === latest.n &&
          JSON.stringify(saved.refOrder) === JSON.stringify(latest.refOrder)) return;
      useCanvasStore.getState().updateNodeData(nodeId, { genSettings: { ...latest } }, undefined, { skipHistory: true });
      markDirtyImmediate();
    };
  }, []);


  // ── Submit generation task (SSE handled by InfiniteCanvas) ──
  const submitTask = async (): Promise<string | null> => {
    const { entry, provider, prompt: p, quality: q, resolution, ratio: r, refImages: refs, n: num } = retryRef.current;
    if (!entry || !provider) return "缺少模型配置";
    try {
      const res = await generationApi.submitGenerationTask({
        type: "image",
        prompt: p.trim(),
        model: entry.name,
        providerId: entry.providerId,
        quality: hasField(fields, "quality") ? q : undefined,
        resolution: hasField(fields, "resolution") ? resolution : undefined,
        ratio: hasField(fields, "ratio") ? r : undefined,
        n: hasField(fields, "n") ? num : undefined,
        refImages: refs.length > 0 ? refs : undefined,
        nodeId,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        return err.error || `HTTP ${res.status}`;
      }
      const json = await res.json();
      const taskId = json.data?.id;
      if (!taskId) return "No task_id returned";

      // 异步回调时检查：取消后 taskBinding 被清空，丢弃过期结果
      const cur = useCanvasStore.getState().nodes.find(n => n.id === nodeId);
      const curBinding = cur ? (cur.data as MediaGenFields).taskBinding : undefined;
      if (!isGeneratingBinding(curBinding)) return null;
      // Save task_id to node data immediately (SSE handled by InfiniteCanvas)
      useCanvasStore.getState().updateNodeData(nodeId, { taskBinding: { taskId, status: "pending" } }, undefined, { skipHistory: true });
      await flushAndWait();
      return null;
    } catch (e: unknown) {
      return e instanceof Error ? e.message : "Failed to submit task";
    }
  };

  /** Upload image -> create ImageNode + auto-connect to the selected node */
  const handleRefUpload = () => {
    const input = document.createElement("input");
    input.type = "file"; input.accept = "image/*";
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
        const nw = img.naturalWidth, nh = img.naturalHeight;
        const tw = (targetNode.style?.width as number) || 400;

        const newNode = createImageNode(
          { x: targetNode.position.x - 50, y: targetNode.position.y + (tw) / 2 },
          imgUrl,
        );
        applyThumbnailSettings(newNode, nw, nh, file.name);
        // Position relative to target: left side, vertically centered
        const dw = newNode.style?.width as number || nw;
        const dh = newNode.style?.height as number || nh;
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
    if ((!prompt.trim() && upstreamTexts.length === 0) || !modelKey) return;
    const entry = allModels.find((m) => m.value === modelKey);
    if (!entry) return;
    const provider = providers.find((c) => c.id === entry.providerId);
    if (!provider) return;

    // forceHistory 先捕获不含 taskBinding 的干净状态，再写入处理中标记
    useCanvasStore.getState().updateNodeData(nodeId, { taskBinding: { taskId: "", status: "processing" } }, undefined, { forceHistory: true });
    markDirtyImmediate();
    retryRef.current = { count: 0, prompt: finalPrompt, modelKey, quality, resolution, ratio, refImages: refOrder, n, entry, provider };

    const errMsg = await submitTask();

    if (errMsg === null) {
      // 生成成功
    } else {
      useCanvasStore.getState().updateNodeData(nodeId, { taskBinding: undefined }, undefined, { skipHistory: true });
      markDirtyImmediate();
      // 生成失败：pop 掉 forceHistory 压的那条预生成快照，不留死撤销
      useHistoryStore.setState((s) => ({ undoStack: s.undoStack.slice(0, -1) }));
    }
  };

  const handleCancel = () => {
    const node = useCanvasStore.getState().nodes.find((n) => n.id === nodeId);
    const tid = (node?.data as MediaGenFields)?.taskBinding?.taskId;
    if (tid) {
      generationApi.cancelGenerationTask(tid).catch(() => {});
    }
    useCanvasStore.getState().updateNodeData(nodeId, {
      taskBinding: undefined,
    }, undefined, { skipHistory: true });
    markDirtyImmediate();
    // 取消生成：pop 掉 forceHistory 压的那条预生成快照，不留死撤销
    useHistoryStore.setState((s) => ({ undoStack: s.undoStack.slice(0, -1) }));
  };

  return (
    <>
    <style>{`.gen-textarea:focus, .gen-textarea-focused { border: none !important; box-shadow: none !important; outline: none !important; }`}</style>
    <WheelGuard
      className="nodrag nopan flex flex-col gap-2 px-4 py-3 rounded-lg shadow-xl"
      style={{
        background: "var(--canvas-bg, #262626)",
        border: "1px solid var(--canvas-border, #3a3a3a)",
        width: 640,
      }}
    >
      <Button size="small" type="text"
        className="flex items-center justify-center gap-1 rounded-lg text-xs text-white/60 hover:text-white transition-colors self-start"
        style={{ width: 54, height: 26, background: "rgba(255,255,255,0.04)", border: "none", cursor: "pointer" }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "rgba(255,255,255,0.1)"; }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "rgba(255,255,255,0.04)"; }}
        onClick={handleRefUpload}>
        <PlusOutlined style={{ fontSize: 12 }} /> {t("common.reference")}
      </Button>
      {(refOrder.length > 0 || upstreamTexts.length > 0) && (
        <div
          className="flex gap-2 flex-wrap"
          onDragOver={(e) => {
            e.preventDefault();
            e.stopPropagation();
            e.dataTransfer.dropEffect = 'move';
          }}
          onDragLeave={() => setDragOverIdx(null)}
          onDrop={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setDragOverIdx(null);
            const dragged = e.dataTransfer.getData('text/plain');
            if (!dragged) return;
            setRefOrder((prev) => {
              const list = prev.filter((u) => u !== dragged);
              return [...list, dragged];
            });
          }}
        >
          {/* 上游 Text 节点 - 不可拖动，按连接顺序自动排前 */}
          {upstreamTexts.map((txt) => (
            <Tooltip key={`text-${txt.id}`} title={txt.content.length > 50 ? txt.content.slice(0, 50) + "..." : txt.content}>
              <div className="relative group h-16 w-16 rounded flex items-center justify-center" style={{ background: "var(--canvas-bg-hover)", border: "1px solid var(--canvas-border)" }}>
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
              onDragStart={(e) => {
                e.dataTransfer.setData('text/plain', img);
                e.dataTransfer.effectAllowed = 'move';
              }}
              onDragOver={(e) => {
                e.preventDefault();
                e.stopPropagation();
                e.dataTransfer.dropEffect = 'move';
                setDragOverIdx(i);
              }}
              onDragLeave={() => setDragOverIdx(null)}
              onDrop={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setDragOverIdx(null);
                const dragged = e.dataTransfer.getData('text/plain');
                if (!dragged || dragged === img) return;
                setRefOrder((prev) => {
                  const list = [...prev];
                  const fromIdx = list.indexOf(dragged);
                  const toIdx = list.indexOf(img);
                  if (fromIdx === toIdx) return prev;
                  const [moved] = list.splice(fromIdx, 1);
                  list.splice(toIdx, 0, moved);
                  return list;
                });
              }}
              className="relative group"
            >
              <img src={img.includes('/api/files/') ? `${img}?w=64` : img} alt={`Ref ${i+1}`} className={`h-16 rounded object-cover cursor-grab active:cursor-grabbing transition-shadow ${dragOverIdx === i ? 'ring-2 ring-white shadow-lg' : ''}`}
                onMouseEnter={() => setHoverImg(img)} onMouseLeave={() => setHoverImg(null)} />
              {hoverImg === img && (
                <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 z-50 pointer-events-none">
                  <img src={img.includes('/api/files/') ? `${img}?w=320` : img} className="max-w-[320px] max-h-[280px] rounded-lg shadow-2xl" style={{ background: "var(--canvas-bg)", objectFit: "contain" }} />
                </div>
              )}
              <Button type="text" size="small"
                className="!absolute -top-1.5 -right-1.5 !w-4 !h-4 !flex items-center justify-center !rounded-full !bg-black/70 !text-white/60 hover:!text-white hover:!bg-white/30 !text-[10px] opacity-0 group-hover:opacity-100 transition-opacity !p-0 !border-0"
                onClick={() => {
                  const store = useCanvasStore.getState();
                  const edge = store.edges.find((e) => {
                    if (e.target !== nodeId) return false;
                    const srcNode = store.nodes.find((n) => n.id === e.source);
                    return srcNode && srcNode.type === NODE_TYPE.IMAGE && (srcNode.data as { src?: string }).src === img;
                  });
                  if (edge) store.removeEdges([edge.id]);
                }}>✕</Button>
            </div>
          ))}
        </div>
      )}
      <MentionPrompt
        references={references}
        value={prompt}
        onChange={setPrompt}
        placeholder={t("generation.promptPlaceholder")}
        style={{ minHeight: 100, outline: "none", boxShadow: "none" }}
      />
      <div className="flex items-center gap-2">
        <MenuPopover
          open={modelOpen} onOpenChange={setModelOpen} placement="bottomLeft"
          trigger={
            <Button size="small" type="text" className="gen-panel-btn flex items-center gap-1.5 px-3 py-1.5 rounded text-sm max-w-[180px]"
              style={{ border: "none", cursor: "pointer" }}>
              <ModelIcon model={allModels.find((m) => m.value === modelKey)?.name ?? modelKey} style={{ fontSize: 14, flexShrink: 0 }} />
              <span className="truncate">
                {allModels.find((m) => m.value === modelKey)?.name ?? "Select model"}
              </span>
            </Button>
          }
          content={allModels.map((m) => (
            <MenuItem key={m.value} onClick={() => { setModelKey(m.value); setModelOpen(false); }} selected={modelKey === m.value}>
              <span className="flex items-center gap-1.5">
                <ModelIcon model={m.name} className="size-4 shrink-0" />
                <span className="truncate">{m.name}</span>
                {m.providerName ? <span className="ml-auto max-w-24 shrink-0 truncate text-xs opacity-50">{m.providerName}</span> : null}
              </span>
            </MenuItem>
          ))}
        />
        <div className="w-px h-7 flex-shrink-0" style={{ background: "var(--canvas-border)" }} />
        <Popover
          content={
            <div className="menu-popover" style={{ width: 360, padding: 6 }}>
              <ParamFields fields={fields} values={fieldValues} onChange={setField} />
            </div>
          }
          trigger="click" placement="bottomLeft"
          styles={{ container: { padding: 0, background: "transparent" } }}
        >
          <button type="button" className="gen-panel-btn flex items-center gap-1 px-4 py-1.5 rounded flex-shrink-0 text-sm"
            style={{ border: "none", cursor: "pointer", color: "var(--canvas-text)", justifyContent: "center" }}>
            <ParamSummary fields={fields} values={fieldValues} />
          </button>
        </Popover>
        <div className="flex-1" />
        <Button size="small" type="text"
          className="flex items-center justify-center rounded-full flex-shrink-0 transition-all"
          style={{
            width: 36, height: 36,
            background: isGenerating ? "#e74c3c" : ((!prompt.trim() && upstreamTexts.length === 0) || !modelKey) ? "var(--canvas-border)" : "var(--canvas-text)",
            color: isGenerating ? "#fff" : ((!prompt.trim() && upstreamTexts.length === 0) || !modelKey) ? "var(--canvas-text-muted)" : "var(--canvas-bg)",
            border: "none", cursor: "pointer",
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

export default ImageGenerationPanel;
