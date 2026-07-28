"use client";

import { ArrowUpOutlined, CloseOutlined, PlusOutlined, RobotOutlined } from "@ant-design/icons";
import { App, Button, Input } from "antd";
import { memo, useEffect, useMemo, useRef, useState } from "react";

import { MenuItem, MenuPopover } from "@/components/common/MenuPopover";
import WheelGuard from "@/components/common/WheelGuard";
import { apiUpload, BASE, getTokenHeader } from "@/lib/api";
import { applyThumbnailSettings } from "@/lib/image-utils";
import { createEdge, createImageNode } from "@/lib/node-defaults";
import { type GenSettings, NODE_TYPE } from "@/lib/types";
import { markDirtyImmediate, useCanvasStore } from "@/stores/canvas-store";
import { useI18nStore } from "@/stores/i18n-store";
import { useModelStore } from "@/stores/model-store";

interface Props {
  nodeId: string;
}

interface ModelOption {
  value: string;
  channelId: string;
  modelName: string;
}

const TextGenerationPanel = memo(function TextGenerationPanel({ nodeId }: Props) {
  const t = useI18nStore((s) => s.t);
  const channels = useModelStore((s) => s.channels);
  const { message } = App.useApp();

  const allModels = channels
    .flatMap((c) =>
      c.models
        .filter((m) => m.capabilities?.includes("text"))
        .map((m) => ({ value: `${c.name}/${m.name}`, channelId: c.id, modelName: m.name })),
    )
    .filter((m, i, arr) => arr.findIndex((x) => x.value === m.value) === i);

  // Read persisted settings from node data
  const saved = useMemo(() => {
    const node = useCanvasStore.getState().nodes.find((n) => n.id === nodeId);
    const s = ((node?.data as { genSettings?: Partial<GenSettings> })?.genSettings ?? {}) as Partial<GenSettings>;
    return {
      prompt: s.prompt || "",
      modelKey: s.modelKey || allModels[0]?.value || "",
      refOrder: s.refOrder || [],
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeId]);

  const [prompt, setPrompt] = useState(saved.prompt);
  const [modelKey, setModelKey] = useState(saved.modelKey);
  const [modelOpen, setModelOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [hoverImg, setHoverImg] = useState<string | null>(null);

  // Upstream reference images - derived live from current edges
  const canvasNodes = useCanvasStore((s) => s.nodes);
  const canvasEdges = useCanvasStore((s) => s.edges);
  const refImages = useMemo(() => {
    const upstreamIds = new Set(canvasEdges.filter((e) => e.target === nodeId).map((e) => e.source));
    return canvasNodes
      .filter((n) => upstreamIds.has(n.id) && n.type === NODE_TYPE.IMAGE)
      .map((n) => (n.data as { src?: string }).src)
      .filter(Boolean) as string[];
  }, [nodeId, canvasNodes, canvasEdges]);

  // User-controllable display order
  const [refOrder, setRefOrder] = useState<string[]>(saved.refOrder || []);
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);
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

  const abortRef = useRef<AbortController | null>(null);
  const latestSettingsRef = useRef({ prompt, modelKey, refOrder });
  useEffect(() => {
    latestSettingsRef.current = { prompt, modelKey, refOrder };
  }, [prompt, modelKey, refOrder]);

  // Persist settings to node data (debounced)
  useEffect(() => {
    const timer = setTimeout(() => {
      useCanvasStore.getState().updateNodeData(
        nodeId,
        { genSettings: { prompt, modelKey, quality: "", resolution: "", ratio: "", refOrder, n: 1 } },
        undefined,
        { skipHistory: true },
      );
    }, 300);
    return () => clearTimeout(timer);
  }, [prompt, modelKey, refOrder, nodeId]);

  // Flush pending settings on unmount
  useEffect(() => {
    return () => {
      const latest = latestSettingsRef.current;
      const node = useCanvasStore.getState().nodes.find((n) => n.id === nodeId);
      const savedGen = (node?.data as { genSettings?: GenSettings })?.genSettings;
      if (
        savedGen &&
        savedGen.prompt === latest.prompt &&
        savedGen.modelKey === latest.modelKey &&
        JSON.stringify(savedGen.refOrder) === JSON.stringify(latest.refOrder)
      )
        return;
      useCanvasStore.getState().updateNodeData(
        nodeId,
        { genSettings: { prompt: latest.prompt, modelKey: latest.modelKey, quality: "", resolution: "", ratio: "", refOrder: latest.refOrder, n: 1 } },
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
    if (!prompt.trim() || !modelKey || loading) return;
    const entry: ModelOption | undefined = allModels.find((m) => m.value === modelKey);
    if (!entry) return;

    setLoading(true);
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      // Build message content (multimodal if ref images exist)
      const content =
        refOrder.length > 0
          ? [
              { type: "text", text: prompt },
              ...refOrder.map((url) => ({ type: "image_url", image_url: { url } })),
            ]
          : prompt;

      const res = await fetch(`${BASE}/api/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getTokenHeader() },
        body: JSON.stringify({
          channelId: entry.channelId,
          model: entry.modelName,
          messages: [{ role: "user", content }],
        }),
        signal: controller.signal,
      });
      const json = await res.json();
      if (json.code !== 200) throw new Error(json.msg || `HTTP ${res.status}`);

      const reply = json.data?.choices?.[0]?.message?.content || "";
      useCanvasStore.getState().updateNodeData(nodeId, { content: reply });
      markDirtyImmediate();
      message.success(t("generation.text.success"));
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      message.error(err instanceof Error ? err.message : t("generation.failed"));
    } finally {
      setLoading(false);
      abortRef.current = null;
    }
  };

  const handleCancel = () => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    setLoading(false);
  };

  return (
    <>
      <style>{`.gen-textarea:focus, .gen-textarea-focused { border: none !important; box-shadow: none !important; outline: none !important; }`}</style>
      <WheelGuard
        className="nodrag nopan flex flex-col gap-2 px-4 py-3 rounded-lg shadow-xl"
        style={{ background: "var(--canvas-bg, #262626)", border: "1px solid var(--canvas-border, #3a3a3a)", width: 580 }}
      >
        <Button
          size="small"
          type="text"
          className="flex items-center justify-center gap-1 rounded-lg text-xs text-white/60 hover:text-white transition-colors self-start"
          style={{ width: 54, height: 26, background: "rgba(255,255,255,0.04)", border: "none", cursor: "pointer" }}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLElement).style.background = "rgba(255,255,255,0.1)";
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLElement).style.background = "rgba(255,255,255,0.04)";
          }}
          onClick={handleRefUpload}
        >
          <PlusOutlined style={{ fontSize: 12 }} /> {t("reference")}
        </Button>
        {refOrder.length > 0 && (
          <div
            className="flex gap-2 flex-wrap"
            onDragOver={(e) => {
              e.preventDefault();
              e.stopPropagation();
              e.dataTransfer.dropEffect = "move";
            }}
            onDragLeave={() => setDragOverIdx(null)}
            onDrop={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setDragOverIdx(null);
              const dragged = e.dataTransfer.getData("text/plain");
              if (!dragged) return;
              setRefOrder((prev) => {
                const list = prev.filter((u) => u !== dragged);
                return [...list, dragged];
              });
            }}
          >
            {refOrder.map((img, i) => (
              <div
                key={img}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData("text/plain", img);
                  e.dataTransfer.effectAllowed = "move";
                }}
                onDragOver={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
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
                <img
                  src={img.includes("/api/files/") ? `${img}?w=64` : img}
                  alt={`Ref ${i + 1}`}
                  className={`h-16 rounded object-cover cursor-grab active:cursor-grabbing transition-shadow ${dragOverIdx === i ? "ring-2 ring-white shadow-lg" : ""}`}
                  onMouseEnter={() => setHoverImg(img)}
                  onMouseLeave={() => setHoverImg(null)}
                />
                {hoverImg === img && (
                  <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 z-50 pointer-events-none">
                    <img
                      src={img.includes("/api/files/") ? `${img}?w=320` : img}
                      className="max-w-[320px] max-h-[280px] rounded-lg shadow-2xl"
                      style={{ background: "var(--canvas-bg)", objectFit: "contain" }}
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
          </div>
        )}
        <Input.TextArea
          className="gen-textarea"
          size="small"
          placeholder={t("prompt.placeholder.text")}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          autoSize={{ minRows: 4, maxRows: 8 }}
          style={{ ...is, resize: "vertical", minHeight: 100, outline: "none", boxShadow: "none" }}
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
                className="gen-panel-btn flex items-center gap-1.5 px-3 py-1.5 rounded text-sm truncate"
                style={{ border: "none", cursor: "pointer" }}
              >
                <RobotOutlined style={{ fontSize: 14, flexShrink: 0 }} />
                {modelKey ? allModels.find((m) => m.value === modelKey)?.value : "Select model"}
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
                {m.value}
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
              background: loading ? "#e74c3c" : !prompt.trim() || !modelKey ? "var(--canvas-border)" : "var(--canvas-text)",
              color: loading ? "#fff" : !prompt.trim() || !modelKey ? "var(--canvas-text-muted)" : "var(--canvas-bg)",
              border: "none",
              cursor: "pointer",
              opacity: (!prompt.trim() || !modelKey) && !loading ? 0.5 : 1,
            }}
            onClick={loading ? handleCancel : handleGenerate}
          >
            {loading ? <CloseOutlined style={{ fontSize: 16 }} /> : <ArrowUpOutlined style={{ fontSize: 16 }} />}
          </Button>
        </div>
      </WheelGuard>
    </>
  );
});

export default TextGenerationPanel;
