"use client";

import { memo, useState, useEffect, useRef, useMemo } from "react";
import { Input, Popover, App } from "antd";
import { ArrowUpOutlined, CloseOutlined, RobotOutlined, PlusOutlined } from "@ant-design/icons";
import { useModelStore } from "@/stores/model-store";
import { useCanvasStore, markDirty, markDirtyImmediate, flushAndWait } from "@/stores/canvas-store";
import { NODE_TYPE } from "@/lib/types";
import { getTokenHeader, apiUpload, BASE } from "@/lib/api";
import { createImageNode, createEdge } from "@/lib/node-defaults";
import { applyThumbnailSettings } from "@/lib/image-utils";
import { useI18nStore } from "@/stores/i18n-store";
import { THUMBNAIL_MAX } from "@/lib/constants";
import { EventNames } from "@/lib/eventNames";
import WheelGuard from "@/components/common/WheelGuard";

function RatioIcon({ ratio, active }: { ratio: string; active?: boolean }) {
  const [w, h] = ratio.split(":").map(Number);
  const maxDim = 14;
  const boxW = Math.max(3, Math.round(maxDim * Math.min(1, w / Math.max(w, h))));
  const boxH = Math.max(3, Math.round(maxDim * Math.min(1, h / Math.max(w, h))));
  return <div className="rounded-sm border flex-shrink-0"
    style={{ width: boxW, height: boxH, borderColor: active ? "var(--canvas-text)" : "var(--canvas-border)" }} />;
}

interface GenSettings { prompt: string; modelKey: string; quality: string; genSize: string; ratio: string; refOrder: string[]; n: number; }

interface Props { nodeId: string; type?: "image" | "video"; }

const GenerationPanel = memo(function GenerationPanel({ nodeId, type = "image" }: Props) {
  const t = useI18nStore((s) => s.t);
  const capability = type === "video" ? "video" : "image";
  const channels = useModelStore((s) => s.channels);
  const allModels = channels.flatMap((c) =>
    c.models.filter((m) => m.capabilities?.includes(capability)).map((m) => ({ value: `${c.name}/${m.name}`, channelId: c.id, modelName: m.name }))
  ).filter((m, i, arr) => arr.findIndex((x) => x.value === m.value) === i);

  // Read persisted settings from node data
  const saved = useMemo(() => {
    const node = useCanvasStore.getState().nodes.find((n) => n.id === nodeId);
    const s = (node?.data as any)?._genSettings || {};
    return {
      prompt: s.prompt || "",
      modelKey: s.modelKey || allModels[0]?.value || "",
      quality: s.quality || "auto",
      genSize: s.genSize || "1K",
      ratio: s.ratio || "1:1",
      refOrder: s.refOrder || [],
      n: s.n || 1,
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeId]);
  const [prompt, setPrompt] = useState(saved.prompt);
  const [modelKey, setModelKey] = useState(saved.modelKey || allModels[0]?.value || "");
  const [quality, setQuality] = useState(saved.quality);
  const [genSize, setGenSize] = useState(saved.genSize);
  const [ratio, setRatio] = useState(saved.ratio);
  const [n, setN] = useState(saved.n);
  const [hoverImg, setHoverImg] = useState<string | null>(null);
  const [modelOpen, setModelOpen] = useState(false);

  // Upstream reference images — derived live from current edges.
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
  // Sync refOrder when upstream sources change
  useEffect(() => {
    setRefOrder((prev) => {
      const alive = prev.filter((u) => refImages.includes(u));
      const added = refImages.filter((u) => !prev.includes(u));
      if (added.length === 0 && alive.length === prev.length) return prev;
      return [...alive, ...added];
    });
  }, [refImages]);

  // Button disabled state derived from persistent node.data.task_status
  const isGenerating = useMemo(() => {
    const node = canvasNodes.find((n) => n.id === nodeId);
    const st = (node?.data as any)?.task_status;
    return st === "pending" || st === "processing";
  }, [canvasNodes, nodeId]);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState("");

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const retryRef = useRef({ count: 0, prompt: "", modelKey: "", quality: "", genSize: "", ratio: "", refImages: [] as string[], n: 1, entry: null as any, channel: null as any });
  const latestSettingsRef = useRef({ prompt, modelKey, quality, genSize, ratio, refOrder, n });
  latestSettingsRef.current = { prompt, modelKey, quality, genSize, ratio, refOrder, n };
  const { notification } = App.useApp();

  // Persist settings to node data on change (debounced)
  useEffect(() => {
    const timer = setTimeout(() => {
      useCanvasStore.getState().updateNodeData(nodeId, {
        _genSettings: { prompt, modelKey, quality, genSize, ratio, refOrder, n },
      }, undefined, { skipHistory: true });
    }, 300);
    return () => clearTimeout(timer);
  }, [prompt, modelKey, quality, genSize, ratio, refOrder, n, nodeId]);

  // Flush pending settings on component unmount (not on dep changes)
  useEffect(() => {
    return () => {
      const latest = latestSettingsRef.current;
      const node = useCanvasStore.getState().nodes.find((n) => n.id === nodeId);
      const saved = (node?.data as any)?._genSettings;
      // 没有已保存值 或 任一字段变化 → flush（refOrder 用 JSON.stringify 比较）
      if (saved &&
          saved.prompt === latest.prompt && saved.modelKey === latest.modelKey &&
          saved.quality === latest.quality && saved.genSize === latest.genSize &&
          saved.ratio === latest.ratio && saved.n === latest.n &&
          JSON.stringify(saved.refOrder) === JSON.stringify(latest.refOrder)) return;
      useCanvasStore.getState().updateNodeData(nodeId, { _genSettings: { ...latest } }, undefined, { skipHistory: true });
      markDirtyImmediate();
    };
  }, []);

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  const is: React.CSSProperties = {
    background: "transparent", border: "none", color: "var(--canvas-text)", borderRadius: 4, fontSize: 13,
  };

  // ── Submit generation task (SSE handled by InfiniteCanvas) ──
  const submitTask = async (): Promise<string | null> => {
    const { entry, channel, prompt: p, quality: q, genSize: gs, ratio: r, refImages: refs, n: num } = retryRef.current;
    try {
      const res = await fetch(`${BASE}/api/generate/task`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getTokenHeader() },
        body: JSON.stringify({
          type,
          prompt: p.trim(),
          model: entry.modelName,
          baseUrl: channel.baseUrl,
          apiKey: channel.apiKey,
          quality: q === "auto" ? undefined : q,
          size: gs,
          ratio: r,
          n: num,
          refUrls: refs.length > 0 ? refs : undefined,
          nodeId,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        return err.error || `HTTP ${res.status}`;
      }
      const json = await res.json();
      const taskId = json.data?.id;
      if (!taskId) return "No task_id returned";

      // Save task_id to node data immediately (SSE handled by InfiniteCanvas)
      useCanvasStore.getState().updateNodeData(nodeId, { task_id: taskId, task_status: "pending" }, undefined, { skipHistory: true });
      await flushAndWait();
      return null;
    } catch (e: any) {
      return e?.message || "Failed to submit task";
    }
  };

  /** Upload image → create ImageNode + auto-connect to the selected node */
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
    if (!prompt.trim() || !modelKey) return;
    const entry = allModels.find((m) => m.value === modelKey);
    if (!entry) return;
    const channel = channels.find((c) => c.id === entry.channelId);
    if (!channel) return;

    setError("");
    useCanvasStore.getState().updateNodeData(nodeId, { task_status: "pending" }, undefined, { skipHistory: true });
    markDirtyImmediate();
    setElapsed(0);
    retryRef.current = { count: 0, prompt, modelKey, quality, genSize, ratio, refImages: refOrder, n, entry, channel };
    timerRef.current = setInterval(() => setElapsed((e) => e + 1), 1000);
    window.dispatchEvent(new CustomEvent(EventNames.NODE_UPDATE_DATA, { detail: { nodeId, data: { _generating: true }, immediate: true } }));

    const errMsg = await submitTask();

    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }

    if (errMsg === null) {
      setError("");
    } else {
      useCanvasStore.getState().updateNodeData(nodeId, { task_status: undefined }, undefined, { skipHistory: true });
      markDirtyImmediate();
      useCanvasStore.getState().updateNodeData(nodeId, { _generating: false }, undefined, { skipHistory: true });
      setError(errMsg);
    }
  };

  const handleCancel = () => {
    const node = useCanvasStore.getState().nodes.find((n) => n.id === nodeId);
    const tid = (node?.data as any)?.task_id;
    if (tid) {
      fetch(`${BASE}/api/generate/task/${tid}/cancel`, {
        method: "POST", headers: { ...getTokenHeader() },
      }).catch(() => {});
    }
    useCanvasStore.getState().updateNodeData(nodeId, {
      task_status: undefined, task_id: undefined, _generating: false,
    }, undefined, { skipHistory: true });
    markDirtyImmediate();
    setError("");
  };

  return (
    <>
    <style>{`.gen-textarea:focus, .gen-textarea-focused { border: none !important; box-shadow: none !important; outline: none !important; }`}</style>
    <WheelGuard
      className="nodrag nopan flex flex-col gap-2 px-4 py-3 rounded-lg shadow-xl"
      style={{
        background: "var(--canvas-bg, #262626)",
        border: "1px solid var(--canvas-border, #3a3a3a)",
        width: 580,
      }}
    >
      <button
        className="flex items-center justify-center gap-1 rounded-lg text-xs text-white/60 hover:text-white transition-colors self-start"
        style={{ width: 54, height: 26, background: "rgba(255,255,255,0.04)", border: "none", cursor: "pointer" }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "rgba(255,255,255,0.1)"; }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "rgba(255,255,255,0.04)"; }}
        onClick={handleRefUpload}>
        <PlusOutlined style={{ fontSize: 12 }} /> {t("reference")}
      </button>
      {refOrder.length > 0 && (
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
              <button className="absolute -top-1.5 -right-1.5 w-4 h-4 flex items-center justify-center rounded-full bg-black/70 text-white/60 hover:text-white hover:bg-white/30 text-[10px] opacity-0 group-hover:opacity-100 transition-opacity"
                style={{ border: "none", cursor: "pointer", lineHeight: 1 }}
                onClick={() => {
                  const store = useCanvasStore.getState();
                  const edge = store.edges.find((e) => {
                    if (e.target !== nodeId) return false;
                    const srcNode = store.nodes.find((n) => n.id === e.source);
                    return srcNode && srcNode.type === NODE_TYPE.IMAGE && (srcNode.data as { src?: string }).src === img;
                  });
                  if (edge) store.removeEdges([edge.id]);
                }}>✕</button>
            </div>
          ))}
        </div>
      )}
      <Input.TextArea
        className="gen-textarea"
        size="small" placeholder={t("prompt.placeholder")} value={prompt}
        onChange={(e) => setPrompt(e.target.value)} autoSize={{ minRows: 4, maxRows: 8 }}
        style={{ ...is, resize: "vertical", minHeight: 100, outline: "none", boxShadow: "none" }}
      />
      <div className="flex items-center gap-2">
        <Popover
          content={<div className="flex flex-col gap-1 p-1" style={{ width: 320, margin: -12, background: "var(--canvas-bg)", borderRadius: 8 }}>
            {allModels.map((m) => (
              <button key={m.value} className="text-left px-3 py-1.5 rounded text-sm transition-colors"
                style={{ background: modelKey === m.value ? "var(--canvas-bg-hover, #3c3c3c)" : "transparent", color: "var(--canvas-text)", border: "none", cursor: "pointer" }}
                onMouseEnter={(e) => { if (modelKey !== m.value) (e.currentTarget as HTMLElement).style.background = "var(--canvas-bg-hover, #3c3c3c)"; }}
                onMouseLeave={(e) => { if (modelKey !== m.value) (e.currentTarget as HTMLElement).style.background = "transparent"; }}
                onClick={() => { setModelKey(m.value); setModelOpen(false); }}>{m.value}</button>
            ))}
          </div>}
          trigger="click" placement="bottomLeft"
          open={modelOpen} onOpenChange={setModelOpen}
        >
          <button className="flex items-center gap-1.5 px-3 py-1.5 rounded text-sm text-white hover:bg-white/10 transition-colors truncate"
            style={{ height: 36, background: "transparent", border: "none", cursor: "pointer", color: "var(--canvas-text)" }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "rgba(255,255,255,0.1)"; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "transparent"; }}>
            <RobotOutlined style={{ fontSize: 14, flexShrink: 0 }} />
            {modelKey ? allModels.find((m) => m.value === modelKey)?.value : "Select model"}
          </button>
        </Popover>
        <div className="w-px h-7 flex-shrink-0" style={{ background: "var(--canvas-border)" }} />
        <Popover
          content={
            <div className="flex flex-col gap-3 p-2" style={{ width: 420, margin: -12, background: "var(--canvas-bg, #262626)", borderRadius: 8 }}>
              <div>
                <div className="text-white/50 text-xs mb-1.5">Quality</div>
                <div className="flex gap-1">
                  {["auto", "high", "medium", "low"].map((v) => (
                    <button key={v} className="flex-1 rounded-md text-[13px] transition-colors"
                      style={{ padding: "4px 0", background: quality === v ? "var(--canvas-bg-hover, #3c3c3c)" : "transparent", color: "var(--canvas-text)", border: "1px solid #555", cursor: "pointer" }}
                      onMouseEnter={(e) => { if (quality !== v) (e.currentTarget as HTMLElement).style.background = "var(--canvas-bg-hover, #3c3c3c)"; }}
                      onMouseLeave={(e) => { if (quality !== v) (e.currentTarget as HTMLElement).style.background = "transparent"; }}
                      onClick={() => setQuality(v)}>{v}</button>
                  ))}
                </div>
              </div>
              <div>
                <div className="text-white/50 text-xs mb-1.5">Size</div>
                <div className="flex gap-0.5 justify-center">
                  {["1K", "2K", "4K"].map((v) => (
                    <button key={v} className="flex-1 rounded-md text-[13px] transition-colors"
                      style={{ padding: "4px 0", background: genSize === v ? "var(--canvas-bg-hover, #3c3c3c)" : "transparent", color: "var(--canvas-text)", border: "1px solid #555", cursor: "pointer" }}
                      onMouseEnter={(e) => { if (genSize !== v) (e.currentTarget as HTMLElement).style.background = "var(--canvas-bg-hover, #3c3c3c)"; }}
                      onMouseLeave={(e) => { if (genSize !== v) (e.currentTarget as HTMLElement).style.background = "transparent"; }}
                      onClick={() => setGenSize(v)}>{v}</button>
                  ))}
                </div>
              </div>
              <div>
                <div className="text-white/50 text-xs mb-1.5">Ratio</div>
                <div className="grid grid-cols-5 gap-1">
                  {(["1:1", "1:2", "2:1", "9:16", "16:9", "3:4", "4:3", "3:2", "2:3", "5:4", "4:5", "21:9", "9:21"] as const).map((v) => {
                    const [w, h] = v.split(":").map(Number);
                    const maxDim = 18;
                    const boxW = Math.max(4, Math.round(maxDim * Math.min(1, w / Math.max(w, h))));
                    const boxH = Math.max(4, Math.round(maxDim * Math.min(1, h / Math.max(w, h))));
                    const active = ratio === v;
                    return (
                      <button key={v} className="flex flex-col items-center rounded-md transition-colors"
                        style={{ padding: "6px 2px 4px", background: active ? "var(--canvas-bg-hover, #3c3c3c)" : "transparent", border: "1px solid #555", cursor: "pointer" }}
                        onMouseEnter={(e) => { if (!active) (e.currentTarget as HTMLElement).style.background = "var(--canvas-bg-hover, #3c3c3c)"; }}
                        onMouseLeave={(e) => { if (!active) (e.currentTarget as HTMLElement).style.background = "transparent"; }}
                        onClick={() => setRatio(v)}>
                        <div className="flex items-center justify-center" style={{ height: 20 }}>
                          <div className="rounded-sm border"
                            style={{ width: boxW, height: boxH, borderColor: active ? "var(--canvas-text)" : "var(--canvas-border)", transition: "border-color 0.15s" }} />
                        </div>
                        <span className="text-xs mt-0.5 leading-none" style={{ color: active ? "var(--canvas-text)" : "var(--canvas-text-muted)" }}>{v}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
              <div>
                <div className="text-white/50 text-xs mb-1.5">Count</div>
                <div className="flex gap-0.5 justify-center">
                  {[1, 2, 3, 4].map((v) => (
                    <button key={v} className="flex-1 rounded-md text-[13px] transition-colors"
                      style={{ padding: "4px 0", background: n === v ? "var(--canvas-bg-hover, #3c3c3c)" : "transparent", color: "var(--canvas-text)", border: "1px solid #555", cursor: "pointer" }}
                      onMouseEnter={(e) => { if (n !== v) (e.currentTarget as HTMLElement).style.background = "var(--canvas-bg-hover, #3c3c3c)"; }}
                      onMouseLeave={(e) => { if (n !== v) (e.currentTarget as HTMLElement).style.background = "transparent"; }}
                      onClick={() => setN(v)}>{v}</button>
                  ))}
                </div>
              </div>
            </div>
          }
          trigger="click" placement="bottomRight"
        >
          <button className="flex items-center gap-1 px-3 py-1.5 rounded flex-shrink-0 text-xs text-white transition-colors"
            style={{ height: 36, background: "transparent", border: "none", cursor: "pointer", color: "var(--canvas-text)" }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "rgba(255,255,255,0.1)"; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "transparent"; }}>
            <RatioIcon ratio={ratio} active />
            {ratio} · {quality} · {genSize} · {n}张
          </button>
        </Popover>
        <div className="flex-1" />
        <button
          className="flex items-center justify-center rounded-full flex-shrink-0 transition-all"
          style={{
            width: 36, height: 36,
            background: isGenerating ? "#e74c3c" : (!prompt.trim() || !modelKey) ? "var(--canvas-border)" : "var(--canvas-text)",
            color: isGenerating ? "#fff" : (!prompt.trim() || !modelKey) ? "var(--canvas-text-muted)" : "var(--canvas-bg)",
            border: "none", cursor: "pointer",
            opacity: (!prompt.trim() || !modelKey) && !isGenerating ? 0.5 : 1,
          }}
          onClick={isGenerating ? handleCancel : handleGenerate}
        >
          {isGenerating ? <CloseOutlined style={{ fontSize: 16 }} /> : <ArrowUpOutlined style={{ fontSize: 16 }} />}
        </button>
      </div>
    </WheelGuard>
    </>
  );
});

export default GenerationPanel;
