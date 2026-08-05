/**
 * 视频生成面板，挂在视频节点下方。
 * 负责提示词输入（支持 @ 引用与首尾帧图片）、模型与分辨率 / 比例 / 时长 / 音频等参数配置，
 * 提交异步生成任务并把参数持久化到节点数据。
 */
"use client";

import { ArrowUpOutlined, CloseOutlined, PlusOutlined, RobotOutlined } from "@ant-design/icons";
import { App, Button, Popover, Slider, Tooltip } from "antd";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { MenuItem, MenuPopover } from "@/components/common/MenuPopover";
import WheelGuard from "@/components/common/WheelGuard";
import { TextIcon } from "@/components/common/icons/media/TextIcon";
import { WaveIcon } from "@/components/common/icons/media/WaveIcon";
import { PlayIcon } from "@/components/common/icons/media/PlayIcon";
import { StopIcon } from "@/components/common/icons/media/StopIcon";
import { apiUpload, BASE, getTokenHeader } from "@/lib/api";
import { applyThumbnailSettings } from "@/lib/image-utils";
import { createEdge, createImageNode } from "@/lib/node-defaults";
import { isGenerating as isGeneratingBinding, type MediaGenFields, ModelChannel, NODE_TYPE, type VideoGenSettings } from "@/lib/types";
import { flushAndWait, markDirtyImmediate, useCanvasStore } from "@/stores/canvas-store";
import { useHistoryStore } from "@/stores/history-store";
import { useI18nStore } from "@/stores/i18n-store";
import { useModelStore } from "@/stores/model-store";
import MentionPrompt, { type ReferenceItem } from "../chat/MentionPrompt";
import { RatioIcon, type ModelOption } from "../gen/shared";

interface Props { nodeId: string; }

const VideoGenerationPanel = memo(function VideoGenerationPanel({ nodeId }: Props) {
  const t = useI18nStore((s) => s.t);
  const channels = useModelStore((s) => s.channels);
  const findModelParams = useModelStore((s) => s.findModelParams);
  const allModels = channels.flatMap((c) =>
    c.models.filter((m) => m.capabilities?.includes("video")).map((m) => ({ value: `${c.name}/${m.name}`, channelId: c.id, modelName: m.name }))
  ).filter((m, i, arr) => arr.findIndex((x) => x.value === m.value) === i);

  // Read persisted settings from node data
  const saved = useMemo(() => {
    const node = useCanvasStore.getState().nodes.find((n) => n.id === nodeId);
    const s = ((node?.data as MediaGenFields)?.genSettings ?? {}) as Partial<VideoGenSettings>;
    const mk = s.modelKey || allModels[0]?.value || "";
    const entry = allModels.find((m) => m.value === mk);
    const mp = entry ? findModelParams(entry.modelName, "video") : null;
    const d = mp?.defaults ?? {};
    return {
      prompt: s.prompt || "",
      modelKey: mk,
      resolution: s.resolution || (d.resolution as string) || "720p",
      ratio: s.ratio || (d.ratio as string) || "16:9",
      seconds: s.seconds ?? (d.seconds as number) ?? 5,
      generateAudio: s.generateAudio ?? true,
      refOrder: s.refOrder || [],
      refAudioOrder: s.refAudioOrder || [],
      n: s.n || (d.n as number) || 1,
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeId]);
  const [prompt, setPrompt] = useState(saved.prompt);
  const [modelKey, setModelKey] = useState(saved.modelKey || allModels[0]?.value || "");
  const [resolution, setResolution] = useState(saved.resolution);
  const [ratio, setRatio] = useState(saved.ratio);
  const [seconds, setSeconds] = useState(saved.seconds);
  const [generateAudio, setGenerateAudio] = useState(saved.generateAudio);
  const [n, setN] = useState(saved.n);
  const [hoverImg, setHoverImg] = useState<string | null>(null);
  const [modelOpen, setModelOpen] = useState(false);

  // 查找当前模型的参数配置
  const modelParams = useMemo(() => {
    const entry = allModels.find((m) => m.value === modelKey);
    return entry ? findModelParams(entry.modelName, "video") : null;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelKey, allModels, findModelParams]);

  const ratioOptions = modelParams?.constraints?.ratio ?? ["1:1", "9:16", "16:9", "3:4", "4:3"];
  const resolutionOptions = modelParams?.constraints?.resolution ?? ["480p", "720p", "1080p", "4K"];
  const showRatio = !modelParams || modelParams.params.includes("ratio");
  const showResolution = !modelParams || modelParams.params.includes("resolution");
  const showSeconds = !modelParams || modelParams.params.includes("seconds");
  const showN = !modelParams || modelParams.params.includes("n");

  // 模型切换时：重置不在新模型 constraints 中的参数
  useEffect(() => {
    if (!modelParams) return;
    const d = modelParams.defaults;
    const c = modelParams.constraints;
    const p = modelParams.params;
    if (p.includes("ratio") && c.ratio && !c.ratio.includes(ratio)) {
      setRatio((d.ratio as string) || "16:9");
    }
    if (!p.includes("resolution")) {
      setResolution("");
    } else if (c.resolution && !c.resolution.includes(resolution)) {
      setResolution((d.resolution as string) || "720p");
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

  // Upstream reference texts (TEXT 节点, 按连接顺序, 去重)
  const upstreamTexts = useMemo(() => {
    const seen = new Set<string>();
    return canvasEdges
      .filter((e) => e.target === nodeId)
      .map((e) => canvasNodes.find((n) => n.id === e.source))
      .filter((n): n is NonNullable<typeof n> => !!n && n.type === NODE_TYPE.TEXT)
      .map((n) => ({ id: n.id, content: ((n.data as { content?: string }).content || "").trim() }))
      .filter((t) => t.content !== "" && !seen.has(t.id) && seen.add(t.id));
  }, [nodeId, canvasNodes, canvasEdges]);

  // 最终 prompt：上游文本 + 当前 prompt
  const finalPrompt = useMemo(() => {
    return [...upstreamTexts.map((t) => t.content), prompt.trim()].filter(Boolean).join("\n");
  }, [upstreamTexts, prompt]);

  // Upstream reference audio (AUDIO 节点, 按连接顺序, 按节点 id 与 src 双重去重)
  const upstreamAudio = useMemo(() => {
    const seenIds = new Set<string>();
    const seenSrcs = new Set<string>();
    return canvasEdges
      .filter((e) => e.target === nodeId)
      .map((e) => canvasNodes.find((n) => n.id === e.source))
      .filter((n): n is NonNullable<typeof n> => !!n && n.type === NODE_TYPE.AUDIO)
      .map((n) => ({
        id: n.id,
        src: ((n.data as { src?: string }).src || "").trim(),
        label: ((n.data as { label?: string }).label || "").trim(),
      }))
      .filter(
        (a) =>
          a.src !== "" &&
          !seenIds.has(a.id) &&
          !seenSrcs.has(a.src) &&
          (seenIds.add(a.id), seenSrcs.add(a.src), true),
      );
  }, [nodeId, canvasNodes, canvasEdges]);

  // User-controllable display order
  const [refOrder, setRefOrder] = useState<string[]>(saved.refOrder || []);
  const [audioOrder, setAudioOrder] = useState<string[]>(saved.refAudioOrder || []);
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
  // 上游音频 src→label 映射，用于回填持久化顺序的 label
  const audioSrcLabel = useMemo(() => {
    const m = new Map<string, string>();
    upstreamAudio.forEach((a) => {
      if (a.src) m.set(a.src, a.label);
    });
    return m;
  }, [upstreamAudio]);
  const audioSrcSet = useMemo(() => new Set(upstreamAudio.map((a) => a.src)), [upstreamAudio]);
  const [prevAudioSrcs, setPrevAudioSrcs] = useState(audioSrcSet);
  if (audioSrcSet !== prevAudioSrcs) {
    setPrevAudioSrcs(audioSrcSet);
    setAudioOrder((prev) => {
      const alive = prev.filter((u) => audioSrcSet.has(u));
      const added = [...audioSrcSet].filter((u) => !prev.includes(u));
      if (added.length === 0 && alive.length === prev.length) return prev;
      return [...alive, ...added];
    });
  }

  // 构建 @ 提及的参考列表（图片基于 refOrder、音频基于 audioOrder，均保证编号稳定）
  const references = useMemo<ReferenceItem[]>(() => {
    const images: ReferenceItem[] = refOrder.map((src, i) => ({
      src,
      thumbnail: src.includes("/api/files/") ? `${src}?w=64` : src,
      index: i,
      kind: "image",
    }));
    const audios: ReferenceItem[] = audioOrder.map((src, i) => ({
      src,
      thumbnail: src,
      index: i,
      kind: "audio",
      label: audioSrcLabel.get(src) || "",
    }));
    return [...images, ...audios];
  }, [refOrder, audioOrder, audioSrcLabel]);

  // Button disabled state derived from persistent node.data.task_status
  const isGenerating = useMemo(() => {
    const node = canvasNodes.find((n) => n.id === nodeId);
    return isGeneratingBinding((node?.data as MediaGenFields)?.taskBinding);
  }, [canvasNodes, nodeId]);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState("");

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const retryRef = useRef<{ count: number; prompt: string; modelKey: string; resolution: string; ratio: string; seconds: number; generateAudio: boolean; refImages: string[]; refAudio: string[]; n: number; entry: ModelOption | null; channel: ModelChannel | null }>({ count: 0, prompt: "", modelKey: "", resolution: "", ratio: "", seconds: 5, generateAudio: true, refImages: [] as string[], refAudio: [] as string[], n: 1, entry: null, channel: null });
  const latestSettingsRef = useRef({ prompt, modelKey, resolution, ratio, seconds, generateAudio, refOrder, refAudioOrder: audioOrder, n });
  useEffect(() => {
    latestSettingsRef.current = { prompt, modelKey, resolution, ratio, seconds, generateAudio, refOrder, refAudioOrder: audioOrder, n };
  }, [prompt, modelKey, resolution, ratio, seconds, generateAudio, refOrder, audioOrder, n]);
  const { notification } = App.useApp();

  // Persist settings to node data on change (debounced)
  useEffect(() => {
    const timer = setTimeout(() => {
      useCanvasStore.getState().updateNodeData(nodeId, {
        genSettings: { prompt, modelKey, resolution, ratio, seconds, generateAudio, refOrder, refAudioOrder: audioOrder, n },
      }, undefined, { skipHistory: true });
    }, 300);
    return () => clearTimeout(timer);
  }, [prompt, modelKey, resolution, ratio, seconds, generateAudio, refOrder, audioOrder, n, nodeId]);

  // Flush pending settings on component unmount (not on dep changes)
  useEffect(() => {
    return () => {
      const latest = latestSettingsRef.current;
      const node = useCanvasStore.getState().nodes.find((n) => n.id === nodeId);
      const saved = (node?.data as MediaGenFields)?.genSettings as Partial<VideoGenSettings> | undefined;
      if (saved &&
          saved.prompt === latest.prompt && saved.modelKey === latest.modelKey &&
          saved.resolution === latest.resolution && saved.ratio === latest.ratio &&
          saved.seconds === latest.seconds && saved.generateAudio === latest.generateAudio &&
          saved.n === latest.n &&
          JSON.stringify(saved.refOrder) === JSON.stringify(latest.refOrder) &&
          JSON.stringify(saved.refAudioOrder) === JSON.stringify(latest.refAudioOrder)) return;
      useCanvasStore.getState().updateNodeData(nodeId, { genSettings: { ...latest } }, undefined, { skipHistory: true });
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
    const { entry, channel, prompt: p, resolution: res, ratio: r, seconds: sec, generateAudio: audio, refImages: refs, refAudio: auds, n: num } = retryRef.current;
    if (!entry || !channel) return "缺少模型配置";
    try {
      const res2 = await fetch(`${BASE}/api/generate/task`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getTokenHeader() },
        body: JSON.stringify({
          type: "video",
          prompt: p.trim(),
          model: entry.modelName,
          channelId: entry.channelId,
          resolution: (!modelParams || modelParams.params.includes("resolution")) ? res : undefined,
          ratio: (!modelParams || modelParams.params.includes("ratio")) ? r : undefined,
          seconds: (!modelParams || modelParams.params.includes("seconds")) ? sec : undefined,
          generateAudio: audio,
          n: (!modelParams || modelParams.params.includes("n")) ? num : undefined,
          refImages: refs.length > 0 ? refs : undefined,
          refAudio: auds.length > 0 ? auds : undefined,
          nodeId,
        }),
      });
      if (!res2.ok) {
        const err = await res2.json().catch(() => ({}));
        return err.error || `HTTP ${res2.status}`;
      }
      const json = await res2.json();
      const taskId = json.data?.id;
      if (!taskId) return "No task_id returned";

      const cur = useCanvasStore.getState().nodes.find(n => n.id === nodeId);
      const curBinding = cur ? (cur.data as MediaGenFields).taskBinding : undefined;
      if (!isGeneratingBinding(curBinding)) return null;
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
    useCanvasStore.getState().updateNodeData(nodeId, { taskBinding: { taskId: "", status: "processing" } }, undefined, { forceHistory: true });
    markDirtyImmediate();
    setElapsed(0);
    retryRef.current = { count: 0, prompt: finalPrompt, modelKey, resolution, ratio, seconds, generateAudio, refImages: refOrder, refAudio: audioOrder, n, entry, channel };
    timerRef.current = setInterval(() => setElapsed((e) => e + 1), 1000);

    const errMsg = await submitTask();

    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }

    if (errMsg === null) {
      setError("");
    } else {
      useCanvasStore.getState().updateNodeData(nodeId, { taskBinding: undefined }, undefined, { skipHistory: true });
      markDirtyImmediate();
      useHistoryStore.setState((s) => ({ undoStack: s.undoStack.slice(0, -1) }));
      setError(errMsg);
    }
  };

  const handleCancel = () => {
    const node = useCanvasStore.getState().nodes.find((n) => n.id === nodeId);
    const tid = (node?.data as MediaGenFields)?.taskBinding?.taskId;
    if (tid) {
      fetch(`${BASE}/api/generate/task/${tid}/cancel`, {
        method: "POST", headers: { ...getTokenHeader() },
      }).catch(() => {});
    }
    useCanvasStore.getState().updateNodeData(nodeId, {
      taskBinding: undefined,
    }, undefined, { skipHistory: true });
    markDirtyImmediate();
    useHistoryStore.setState((s) => ({ undoStack: s.undoStack.slice(0, -1) }));
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
      <Button size="small" type="text"
        className="flex items-center justify-center gap-1 rounded-lg text-xs text-white/60 hover:text-white transition-colors self-start"
        style={{ width: 54, height: 26, background: "rgba(255,255,255,0.04)", border: "none", cursor: "pointer" }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "rgba(255,255,255,0.1)"; }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "rgba(255,255,255,0.04)"; }}
        onClick={handleRefUpload}>
        <PlusOutlined style={{ fontSize: 12 }} /> {t("reference")}
      </Button>
      {(refOrder.length > 0 || upstreamTexts.length > 0 || upstreamAudio.length > 0) && (
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
          {/* 上游 Text 节点 - 不可拖动，排在最前 */}
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
          {/* 上游 Audio 节点 - 不可拖动，排在文本之后、图片之前 */}
          {upstreamAudio.map((aud) => (
            <AudioRefCard key={`audio-${aud.id}`} audio={aud} nodeId={nodeId} />
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
        placeholder={t("prompt.placeholder.video")}
        style={{ minHeight: 100, outline: "none", boxShadow: "none" }}
      />
      <div className="flex items-center gap-2">
        <MenuPopover
          open={modelOpen} onOpenChange={setModelOpen} placement="bottomLeft"
          trigger={
            <Button size="small" type="text" className="gen-panel-btn flex items-center gap-1.5 px-3 py-1.5 rounded text-sm truncate"
              style={{ border: "none", cursor: "pointer" }}>
              <RobotOutlined style={{ fontSize: 14, flexShrink: 0 }} />
              {modelKey ? allModels.find((m) => m.value === modelKey)?.value : "Select model"}
            </Button>
          }
          content={allModels.map((m) => (
            <MenuItem key={m.value} onClick={() => { setModelKey(m.value); setModelOpen(false); }} selected={modelKey === m.value}>
              {m.value}
            </MenuItem>
          ))}
        />
        <div className="w-px h-7 flex-shrink-0" style={{ background: "var(--canvas-border)" }} />
        <Popover
          content={
            <div className="flex flex-col gap-3 p-2" style={{ width: 360, margin: -12, background: "var(--menu-bg, #262626)", border: "1px solid var(--menu-border, #3a3a3a)", borderRadius: 12 }}>
              {/* ── ① 比例 ── */}
              {showRatio && (
              <div>
                <div className="text-xs mb-1.5" style={{ color: "var(--canvas-text-muted)" }}>{t("ratio")}</div>
                <div className="grid grid-cols-5 gap-1">
                  {ratioOptions.map((v) => {
                    const [w, h] = v.split(":").map(Number);
                    const maxDim = 18;
                    const boxW = Math.max(4, Math.round(maxDim * Math.min(1, w / Math.max(w, h))));
                    const boxH = Math.max(4, Math.round(maxDim * Math.min(1, h / Math.max(w, h))));
                    const active = ratio === v;
                    return (
                      <Button size="small" type="text" key={v} className="flex flex-col items-center justify-center rounded-md transition-colors"
                        style={{ height: "auto", minHeight: 48, padding: "8px 2px", background: active ? "var(--canvas-bg-hover, #3c3c3c)" : "transparent", border: `1px solid ${active ? "var(--canvas-text)" : "#555"}`, cursor: "pointer" }}
                        onMouseEnter={(e) => { if (!active) (e.currentTarget as HTMLElement).style.background = "var(--canvas-bg-hover, #3c3c3c)"; }}
                        onMouseLeave={(e) => { if (!active) (e.currentTarget as HTMLElement).style.background = "transparent"; }}
                        onClick={() => setRatio(v)}>
                        <div className="flex items-center justify-center" style={{ height: 20 }}>
                          <div className="border"
                            style={{ width: boxW, height: boxH, borderColor: active ? "var(--canvas-text)" : "var(--canvas-border-light)", transition: "border-color 0.15s" }} />
                        </div>
                        <span className="text-xs mt-1 leading-none" style={{ color: active ? "var(--canvas-text)" : "var(--canvas-text-muted)" }}>{v}</span>
                      </Button>
                    );
                  })}
                </div>
              </div>
              )}
              {/* ── ② 清晰度 ── */}
              {showResolution && (
              <div>
                <div className="text-xs mb-1.5" style={{ color: "var(--canvas-text-muted)" }}>{t("clarity")}</div>
                <div className="grid grid-cols-4 gap-1">
                  {resolutionOptions.map((v) => {
                    const active = resolution === v;
                    return (
                      <Button size="small" type="text" key={v} className="rounded-md text-[13px] transition-colors"
                        style={{ padding: "4px 8px", background: active ? "var(--canvas-bg-hover, #3c3c3c)" : "transparent", color: active ? "var(--canvas-text)" : "var(--canvas-text-muted)", border: `1px solid ${active ? "var(--canvas-text)" : "#555"}`, cursor: "pointer" }}
                        onMouseEnter={(e) => { if (!active) (e.currentTarget as HTMLElement).style.background = "var(--canvas-bg-hover, #3c3c3c)"; }}
                        onMouseLeave={(e) => { if (!active) (e.currentTarget as HTMLElement).style.background = "transparent"; }}
                        onClick={() => setResolution(v)}>{v}</Button>
                    );
                  })}
                </div>
              </div>
              )}
              {/* ── ③ 时长 (Slider) ── */}
              {showSeconds && (
              <div>
                <div className="text-xs mb-1.5" style={{ color: "var(--canvas-text-muted)" }}>{t("gen.seconds")}</div>
                <Slider
                  min={1} max={15} step={1}
                  value={seconds}
                  onChange={(v) => setSeconds(v)}
                  style={{ margin: "0 4px" }}
                  marks={{ 5: "5s", 10: "10s", 15: "15s" }}
                  tooltip={{ formatter: (v) => `${v}s` }}
                />
              </div>
              )}
              {/* ── ④ 生成音频 ── */}
              <div>
                <div className="text-xs mb-1.5" style={{ color: "var(--canvas-text-muted)" }}>{t("gen.audio")}</div>
                <div className="grid grid-cols-2 gap-1">
                  {[true, false].map((v) => {
                    const active = generateAudio === v;
                    const label = v ? t("gen.audio.on") : t("gen.audio.off");
                    return (
                      <Button size="small" type="text" key={String(v)} className="rounded-md text-[13px] transition-colors"
                        style={{ padding: "4px 0", background: active ? "var(--canvas-bg-hover, #3c3c3c)" : "transparent", color: active ? "var(--canvas-text)" : "var(--canvas-text-muted)", border: `1px solid ${active ? "var(--canvas-text)" : "#555"}`, cursor: "pointer" }}
                        onMouseEnter={(e) => { if (!active) (e.currentTarget as HTMLElement).style.background = "var(--canvas-bg-hover, #3c3c3c)"; }}
                        onMouseLeave={(e) => { if (!active) (e.currentTarget as HTMLElement).style.background = "transparent"; }}
                        onClick={() => setGenerateAudio(v)}>{label}</Button>
                    );
                  })}
                </div>
              </div>
              {/* ── ⑤ 生成数量 ── */}
              {showN && (
              <div>
                <div className="text-xs mb-1.5" style={{ color: "var(--canvas-text-muted)" }}>{t("gen.count")}</div>
                <div className="grid grid-cols-3 gap-1">
                  {[1, 2, 4].map((v) => {
                    const active = n === v;
                    return (
                      <Button size="small" type="text" key={v} className="rounded-md text-[13px] transition-colors"
                        style={{ padding: "4px 8px", background: active ? "var(--canvas-bg-hover, #3c3c3c)" : "transparent", color: active ? "var(--canvas-text)" : "var(--canvas-text-muted)", border: `1px solid ${active ? "var(--canvas-text)" : "#555"}`, cursor: "pointer" }}
                        onMouseEnter={(e) => { if (!active) (e.currentTarget as HTMLElement).style.background = "var(--canvas-bg-hover, #3c3c3c)"; }}
                        onMouseLeave={(e) => { if (!active) (e.currentTarget as HTMLElement).style.background = "transparent"; }}
                        onClick={() => setN(v)}>{v}{t("count.unit.video")}</Button>
                    );
                  })}
                </div>
              </div>
              )}
            </div>
          }
          trigger="click" placement="bottomLeft"
        >
          <button type="button" className="gen-panel-btn flex items-center gap-1 px-4 py-1.5 rounded flex-shrink-0 text-xs"
            style={{ border: "none", cursor: "pointer", color: "var(--canvas-text)", minWidth: 140, justifyContent: "center" }}>
            {showRatio && (<span className="inline-flex items-center" style={{ lineHeight: 1 }}><RatioIcon ratio={ratio} active />{ratio}</span>)}
            {showResolution && <> · {resolution}</>}
            {showSeconds && <> · {seconds}{t("seconds.unit")}</>}
            <> · {generateAudio ? t("gen.audio.on.short") : t("gen.audio.off.short")}</>
            {showN && <> · {n}{t("count.unit.video")}</>}
          </button>
        </Popover>
        <div className="flex-1" />
        <Button size="small" type="text"
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
        </Button>
      </div>
    </WheelGuard>
    </>
  );
});

export default VideoGenerationPanel;

// 上游音频参考卡片：展示 label，悬停显示播放图标，点击播放/停止，移出停止，下次从头播放
function AudioRefCard({
  audio,
  nodeId,
}: {
  audio: { id: string; src: string; label: string };
  nodeId: string;
}) {
  const [hovered, setHovered] = useState(false);
  const [playing, setPlaying] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const stop = useCallback(() => {
    const el = audioRef.current;
    if (el) {
      el.pause();
      el.currentTime = 0; // 下次从头播放
    }
    setPlaying(false);
  }, []);

  const toggle = useCallback(() => {
    const el = audioRef.current;
    if (!el) return;
    if (playing) {
      stop();
    } else {
      el.currentTime = 0;
      void el.play().then(() => setPlaying(true)).catch(() => setPlaying(false));
    }
  }, [playing, stop]);

  return (
    <Tooltip title={audio.label || audio.src}>
      <div
        className="relative group h-16 w-16 rounded flex items-center justify-center"
        style={{ background: "var(--canvas-bg-hover)", border: "1px solid var(--canvas-border)" }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => {
          setHovered(false);
          if (playing) stop();
        }}
      >
        <WaveIcon className="pointer-events-none" style={{ color: "var(--canvas-text)", width: 16, height: 16 }} />
        {/* 悬停时覆盖中央的播放/停止图标，点击可播放 */}
        {hovered && (
          <Button
            type="text"
            size="small"
            aria-label={playing ? "停止" : "播放"}
            className="!absolute inset-0 !m-auto !w-8 !h-8 !flex items-center justify-center !rounded-full !bg-black/60 !text-white hover:!text-white hover:!bg-black/70 !p-0 !border-0"
            onClick={(e) => {
              e.stopPropagation();
              toggle();
            }}
          >
            {playing ? (
              <StopIcon style={{ color: "#fff", width: 16, height: 16 }} />
            ) : (
              <PlayIcon style={{ color: "#fff", width: 16, height: 16 }} />
            )}
          </Button>
        )}
        {/* 播放中不悬停时也显示停止图标，便于随时停止 */}
        {playing && !hovered && (
          <Button
            type="text"
            size="small"
            aria-label="停止"
            className="!absolute inset-0 !m-auto !w-8 !h-8 !flex items-center justify-center !rounded-full !bg-black/60 !text-white hover:!text-white hover:!bg-black/70 !p-0 !border-0"
            onClick={(e) => {
              e.stopPropagation();
              stop();
            }}
          >
            <StopIcon style={{ color: "#fff", width: 16, height: 16 }} />
          </Button>
        )}
        <Button type="text" size="small"
          className="!absolute -top-1.5 -right-1.5 !w-4 !h-4 !flex items-center justify-center !rounded-full !bg-black/70 !text-white/60 hover:!text-white hover:!bg-white/30 !text-[10px] opacity-0 group-hover:opacity-100 transition-opacity !p-0 !border-0"
          onClick={() => {
            const store = useCanvasStore.getState();
            const edge = store.edges.find((e) => e.target === nodeId && e.source === audio.id);
            if (edge) store.removeEdges([edge.id]);
          }}>✕</Button>
        <audio
          ref={audioRef}
          src={audio.src}
          preload="none"
          onEnded={() => setPlaying(false)}
          onPause={() => {
            if (audioRef.current && audioRef.current.currentTime === 0) setPlaying(false);
          }}
        />
      </div>
    </Tooltip>
  );
}
