/**
 * 视频生成面板，挂在视频节点下方。
 * 负责提示词输入（支持 @ 引用与首尾帧图片）、模型与分辨率 / 比例 / 时长 / 音频等参数配置，
 * 提交异步生成任务并把参数持久化到节点数据。
 */
"use client";

import { ArrowUpOutlined, CloseOutlined, DownOutlined, PlusOutlined } from "@ant-design/icons";
import { App, Button, Popover, Tooltip } from "antd";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { PlayIcon } from "@/components/ui/icons/media/PlayIcon";
import { StopIcon } from "@/components/ui/icons/media/StopIcon";
import { TextIcon } from "@/components/ui/icons/media/TextIcon";
import { VideoCameraIcon } from "@/components/ui/icons/media/VideoCameraIcon";
import { VideoFrameIcon } from "@/components/ui/icons/media/VideoFrameIcon";
import { VideoRefIcon } from "@/components/ui/icons/media/VideoRefIcon";
import { WaveIcon } from "@/components/ui/icons/media/WaveIcon";
import { MenuItem, MenuPopover } from "@/components/ui/MenuPopover";
import WheelGuard from "@/components/ui/WheelGuard";
import { generationApi } from "@/features/canvas/api/generation-api";
import { createEdge, createImageNode } from "@/features/canvas/node-defaults";
import ParamFields, { fieldDefaults, hasField, ParamSummary } from "@/features/canvas/panels/ParamFields";
import { flushAndWait, markDirtyImmediate, useCanvasStore } from "@/features/canvas/stores/canvas-store";
import { useHistoryStore } from "@/features/canvas/stores/history-store";
import type { MediaGenFields, VideoGenSettings } from "@/features/canvas/types";
import { apiRaw, apiUpload } from "@/lib/api/client";
import { isGenerating as isGeneratingBinding, NODE_TYPE } from "@/lib/constants";
import { ModelIcon } from "@/lib/model-icon";
import { useModelStore } from "@/lib/model-store";
import type { ModelChannel } from "@/lib/types/models";
import { type ModelOption } from "@/lib/types/models";
import { applyThumbnailSettings } from "@/lib/utils/image-utils";

import MentionPrompt, { type ReferenceItem } from "../shared/MentionPrompt";
import { useVideoGenPanel } from "./use-video-gen-panel";

interface Props { nodeId: string; }

const VideoGenerationPanel = memo(function VideoGenerationPanel({ nodeId }: Props) {
  const { t } = useTranslation();
  const channels = useModelStore((s) => s.channels);
  const findModelParams = useModelStore((s) => s.findModelParams);
  const allModels = channels.flatMap((c) =>
    c.models.filter((m) => m.capabilities?.includes("video")).map((m) => ({ value: `${c.id}/${m.id}`, channelId: c.id, modelId: m.id, name: m.name, channelName: c.name }))
  ).filter((m, i, arr) => arr.findIndex((x) => x.value === m.value) === i);

  // Read persisted settings from node data
  const saved = useMemo(() => {
    const node = useCanvasStore.getState().nodes.find((n) => n.id === nodeId);
    const s = ((node?.data as MediaGenFields)?.genSettings ?? {}) as Partial<VideoGenSettings>;
    const mk = s.modelKey || allModels[0]?.value || "";
    const entry = allModels.find((m) => m.value === mk);
    const mp = entry ? findModelParams(entry.channelId, entry.name, "video") : null;
    const d = mp ? fieldDefaults(mp.fields) : {};
    return {
      prompt: s.prompt || "",
      modelKey: mk,
      resolution: s.resolution || (d.resolution as string) || "1K",
      ratio: s.ratio || (d.ratio as string) || "16:9",
      seconds: s.seconds ?? (d.seconds as number) ?? 5,
      generateAudio: s.generateAudio ?? (d.generateAudio as boolean) ?? true,
      refOrder: s.refOrder || [],
      refAudioOrder: s.refAudioOrder || [],
      refVideoOrder: s.refVideoOrder || [],
      refMode: s.refMode || "full",
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
  const [refModeOpen, setRefModeOpen] = useState(false);

  // 查找当前模型的参数配置
  const modelParams = useMemo(() => {
    const entry = allModels.find((m) => m.value === modelKey);
    return entry ? findModelParams(entry.channelId, entry.name, "video") : null;
   
  }, [modelKey, allModels, findModelParams]);

  // capabilities 能力声明：refMode 选项由模型声明，未声明则不渲染（不支持参考）
  const refModeOptions = modelParams?.capabilities?.refMode?.options ?? [];

  // fields 为唯一数据源：渲染控件 + 默认值
  const fields = modelParams?.fields ?? [];
  const fieldValues: Record<string, unknown> = { resolution, ratio, seconds, generateAudio, n };
  const setField = (name: string, value: unknown) => {
    if (name === "resolution") setResolution(value as string);
    else if (name === "ratio") setRatio(value as string);
    else if (name === "seconds") setSeconds(value as number);
    else if (name === "generateAudio") setGenerateAudio(value as boolean);
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

  // User-controllable display order
  const [refOrder, setRefOrder] = useState<string[]>(saved.refOrder || []);
  const [audioOrder, setAudioOrder] = useState<string[]>(saved.refAudioOrder || []);
  const [refVideoOrder, setRefVideoOrder] = useState<string[]>(saved.refVideoOrder || []);
  const [refMode, setRefMode] = useState<string>(saved.refMode || "");

  // ── 派生数据与持久化副作用（抽到 useVideoGenPanel） ──
  const {
    refImages, upstreamTexts, upstreamAudio, upstreamVideos, audioSrcLabel, references, finalPrompt, isGenerating,
    elapsed, error, setElapsed, setError, latestSettingsRef, timerRef,
  } = useVideoGenPanel({
    nodeId, prompt, modelKey, resolution, ratio, seconds, generateAudio, n, refOrder, audioOrder, refVideoOrder, refMode,
  });

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
  const videoSrcSet = useMemo(() => new Set(upstreamVideos.map((v) => v.src)), [upstreamVideos]);
  const [prevVideoSrcs, setPrevVideoSrcs] = useState(videoSrcSet);
  if (videoSrcSet !== prevVideoSrcs) {
    setPrevVideoSrcs(videoSrcSet);
    setRefVideoOrder((prev) => {
      const alive = prev.filter((u) => videoSrcSet.has(u));
      const added = [...videoSrcSet].filter((u) => !prev.includes(u));
      if (added.length === 0 && alive.length === prev.length) return prev;
      return [...alive, ...added];
    });
  }

  const retryRef = useRef<{ count: number; prompt: string; modelKey: string; resolution: string; ratio: string; seconds: number; generateAudio: boolean; refImages: string[]; refAudios: string[]; refVideos: string[]; refMode: string; n: number; entry: ModelOption | null; channel: ModelChannel | null }>({ count: 0, prompt: "", modelKey: "", resolution: "", ratio: "", seconds: 5, generateAudio: true, refImages: [] as string[], refAudios: [] as string[], refVideos: [] as string[], refMode: "", n: 1, entry: null, channel: null });
  const { notification } = App.useApp();

  const is: React.CSSProperties = {
    background: "transparent", border: "none", color: "var(--canvas-text)", borderRadius: 4, fontSize: 13,
  };

  // ── Submit generation task (SSE handled by InfiniteCanvas) ──
  const submitTask = async (): Promise<string | null> => {
    const { entry, channel, prompt: p, resolution: res, ratio: r, seconds: sec, generateAudio: audio, refImages: refs, refAudios: auds, refVideos: vids, refMode: rm, n: num } = retryRef.current;
    if (!entry || !channel) return "缺少模型配置";
    try {
      const res2 = await generationApi.submitGenerationTask({
        type: "video",
        prompt: p.trim(),
        model: entry.name,
        channelId: entry.channelId,
        resolution: hasField(fields, "resolution") ? res : undefined,
        ratio: hasField(fields, "ratio") ? r : undefined,
        seconds: hasField(fields, "seconds") ? sec : undefined,
        generateAudio: hasField(fields, "generateAudio") ? audio : undefined,
        n: hasField(fields, "n") ? num : undefined,
        refImages: refs.length > 0 ? refs : undefined,
        refAudios: auds.length > 0 ? auds : undefined,
        refVideos: vids.length > 0 ? vids : undefined,
        refMode: rm || undefined,
        nodeId,
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
    retryRef.current = { count: 0, prompt: finalPrompt, modelKey, resolution, ratio, seconds, generateAudio, refImages: refOrder, refAudios: audioOrder, refVideos: refVideoOrder, refMode, n, entry, channel };
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
      generationApi.cancelGenerationTask(tid).catch(() => {});
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
      {(refOrder.length > 0 || upstreamTexts.length > 0 || upstreamAudio.length > 0 || upstreamVideos.length > 0) && (
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
          {/* 上游 Video 节点 - 参考视频，可移除 */}
          {refVideoOrder.map((vid, i) => (
            <div key={`video-${vid}`} className="relative group h-16 w-16 rounded flex items-center justify-center"
              style={{ background: "var(--canvas-bg-hover)", border: "1px solid var(--canvas-border)" }}>
              <PlayIcon className="pointer-events-none" style={{ color: "var(--canvas-text)", width: 16, height: 16 }} />
              <span className="absolute -bottom-1 left-0 right-0 text-center text-[9px] text-white/60 pointer-events-none">V{i + 1}</span>
              <Button type="text" size="small"
                className="!absolute -top-1.5 -right-1.5 !w-4 !h-4 !flex items-center justify-center !rounded-full !bg-black/70 !text-white/60 hover:!text-white hover:!bg-white/30 !text-[10px] opacity-0 group-hover:opacity-100 transition-opacity !p-0 !border-0"
                onClick={() => setRefVideoOrder((prev) => prev.filter((u) => u !== vid))}>✕</Button>
            </div>
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
        placeholder={t("generation.promptPlaceholderVideo")}
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
                {m.channelName ? <span className="ml-auto max-w-24 shrink-0 truncate text-xs opacity-50">{m.channelName}</span> : null}
              </span>
            </MenuItem>
          ))}
        />
        <div className="w-px h-7 flex-shrink-0" style={{ background: "var(--canvas-border)" }} />
        {refModeOptions.length > 0 && (
          <MenuPopover
            open={refModeOpen}
            onOpenChange={setRefModeOpen}
            placement="bottomLeft"
            trigger={
              <Button size="small" type="text"
                className="gen-panel-btn flex items-center justify-between gap-1.5 px-3 rounded text-sm"
                style={{ border: "none", cursor: "pointer", width: 120 }}>
                <span className="truncate" style={{ display: "inline-flex", alignItems: "center", gap: 6, justifyContent: "flex-start" }}>
                  {refMode === "full" && <VideoRefIcon style={{ fontSize: 14 }} />}
                  {refMode === "first-last" && <VideoFrameIcon style={{ fontSize: 14 }} />}
                  {refMode === "first" && <VideoCameraIcon style={{ fontSize: 14 }} />}
                  {t(`video.refMode.${refMode}`)}
                </span>
                <DownOutlined style={{ fontSize: 11, color: "var(--canvas-text-dim)", flexShrink: 0 }} />
              </Button>
            }
            content={
              <>
                <div style={{ padding: "2px 4px 0", fontSize: 11, color: "var(--canvas-text-muted)" }}>{t("video.refModeTitle")}</div>
                {refModeOptions.map((m: string) => (
                  <MenuItem key={m} selected={refMode === m}
                    onClick={() => { setRefMode(m); setRefModeOpen(false); }}>
                    {m === "full" && (
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                        <VideoRefIcon style={{ fontSize: 14 }} />
                        {t(`video.refMode.${m}`)}
                      </span>
                    )}
                    {m === "first-last" && (
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                        <VideoFrameIcon style={{ fontSize: 14 }} />
                        {t(`video.refMode.${m}`)}
                      </span>
                    )}
                    {m === "first" && (
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                        <VideoCameraIcon style={{ fontSize: 14 }} />
                        {t(`video.refMode.${m}`)}
                      </span>
                    )}
                    {m !== "full" && m !== "first-last" && m !== "first" && t(`video.refMode.${m}`)}
                  </MenuItem>
                ))}
              </>
            }
          />
        )}
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
