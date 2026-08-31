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
import { TextToVideoIcon } from "@/components/ui/icons/media/TextToVideoIcon";
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
import { parseErrorBody, resolveApiError } from "@/lib/api/error-message";
import { isGenerating as isGeneratingBinding, NODE_TYPE } from "@/lib/constants";
import i18n from "@/lib/i18n/config";
import { ModelIcon } from "@/lib/model-icon";
import { useModelStore } from "@/lib/model-store";
import type { ModelProvider } from "@/lib/types/models";
import { type ModelOption } from "@/lib/types/models";
import { applyThumbnailSettings } from "@/lib/utils/image-utils";

import MentionPrompt from "../shared/MentionPrompt";
import { applyRatioToNode } from "../shared/ratio-size";
import { writeOrderPref } from "../shared/ref-order";
import type { ReferenceItem } from "../shared/reference";
import { findReferenceNode, useRevealCanvasNode } from "../shared/reveal-node";
import { useVideoGenPanel } from "./use-video-gen-panel";

interface Props { nodeId: string; }

const VideoGenerationPanel = memo(function VideoGenerationPanel({ nodeId }: Props) {
  const { t } = useTranslation();
  const reveal = useRevealCanvasNode();
  const providers = useModelStore((s) => s.providers);
  const findModelParams = useModelStore((s) => s.findModelParams);
  const allModels = providers.flatMap((c) =>
    c.models.filter((m) => m.capabilities?.includes("video")).map((m) => ({ value: `${c.id}/${m.id}`, providerId: c.id, modelId: m.id, name: m.name, providerName: c.name }))
  ).filter((m, i, arr) => arr.findIndex((x) => x.value === m.value) === i);

  // Read persisted settings from node data
  const saved = useMemo(() => {
    const node = useCanvasStore.getState().nodes.find((n) => n.id === nodeId);
    const s = ((node?.data as MediaGenFields)?.genSettings ?? {}) as Partial<VideoGenSettings>;
    const mk = s.modelKey || allModels[0]?.value || "";
    const entry = allModels.find((m) => m.value === mk);
    const mp = entry ? findModelParams(entry.providerId, entry.name, "video") : null;
    const d = mp ? fieldDefaults(mp.fields) : {};
    return {
      prompt: s.prompt || "",
      modelKey: mk,
      resolution: s.resolution || (d.resolution as string) || "1K",
      ratio: s.ratio || (d.ratio as string) || "16:9",
      seconds: s.seconds ?? (d.seconds as number) ?? 5,
      generateAudio: s.generateAudio ?? (d.generateAudio as boolean) ?? true,
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
  const [hoverVideo, setHoverVideo] = useState<string | null>(null);
  const [videoDragOver, setVideoDragOver] = useState<number | null>(null);
  const [isRefDragging, setIsRefDragging] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [refModeOpen, setRefModeOpen] = useState(false);

  // 查找当前模型的参数配置（订阅 modelParamsCache：缓存晚于挂载到达时能触发重算）
  const modelParamsCache = useModelStore((s) => s.modelParamsCache);
  const modelParams = useMemo(() => {
    const entry = allModels.find((m) => m.value === modelKey);
    return entry ? findModelParams(entry.providerId, entry.name, "video") : null;
  }, [modelKey, allModels, findModelParams, modelParamsCache]);

  // capabilities 能力声明：refMode 选项由模型声明，未声明则不渲染（不支持参考）
  const refModeOptions = modelParams?.capabilities?.refMode?.options ?? [];

  // fields 为唯一数据源：渲染控件 + 默认值
  const fields = modelParams?.fields ?? [];
  const fieldValues: Record<string, unknown> = { resolution, ratio, seconds, generateAudio, n };
  const setField = (name: string, value: unknown) => {
    if (name === "resolution") setResolution(value as string);
    else if (name === "ratio") {
      setRatio(value as string);
      // 空节点占位框跟随所选比例（已有内容 / adaptive 跳过）
      applyRatioToNode(nodeId, value as string);
    }
    else if (name === "seconds") setSeconds(value as number);
    else if (name === "generateAudio") setGenerateAudio(value as boolean);
    else if (name === "n") setN(value as number);
  };

  // 模型切换 / fields 异步到达时：重置不在当前模型 options 中的参数
  // （modelParamsCache 晚于组件挂载到达时，初始值可能来自 _default 兜底或硬编码回退，
  //   如 "1K" 不在 agnes-video 的 ["720P","960P","2K"] 中，需回退到字段默认值）
  useEffect(() => {
    if (!Array.isArray(modelParams?.fields)) return;
    for (const f of modelParams.fields) {
      const cur = fieldValues[f.name] as string | number | undefined;
      if (f.options && f.options.length && cur !== undefined && !f.options.includes(cur)) {
        setField(f.name, f.default);
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelParams]);

  const selectModel = (value: string) => {
    const entry = allModels.find((model) => model.value === value);
    const params = entry ? findModelParams(entry.providerId, entry.name, "video") : null;
    for (const field of params?.fields ?? []) {
      const current = fieldValues[field.name] as string | number | undefined;
      if (field.options?.length && current !== undefined && !field.options.includes(current)) {
        setField(field.name, field.default);
      }
    }
    setModelKey(value);
    setModelOpen(false);
  };

  // 参考方式（text = 文生视频）。可用范围由 hook 派生的参考列表决定（见下）。
  const [refMode, setRefMode] = useState<string>(saved.refMode || "full");

  // ── 派生数据与持久化副作用（抽到 useVideoGenPanel） ──
  // 参考存在性与显示顺序均为纯派生：存在性来自连线，顺序 = 排序偏好(genSettings) + 连线合并，
  // 无本地同步状态、首帧即正确；排序偏好由拖拽排序事件（writeOrderPref）即时持久化。
  const {
    refImages, refOrder, audioOrder, refVideoOrder,
    upstreamTexts, upstreamAudio, upstreamVideos, audioSrcLabel, references, finalPrompt, isGenerating,
    elapsed, error, setElapsed, setError, latestSettingsRef, timerRef,
  } = useVideoGenPanel({
    nodeId, prompt, modelKey, resolution, ratio, seconds, generateAudio, n, refMode,
  });

  // 参考模式可用范围：
  //   视频或音频 → 仅全能参考；1 张图 → 图生/全能；2 张图 → 首尾帧/全能；≥3 张图 → 仅全能参考；无图/视频/音频（仅文本或空）→ 只能文生视频
  const allowedRefModes = useMemo(() => {
    if (refVideoOrder.length > 0 || audioOrder.length > 0) return ["full"];
    if (refOrder.length === 1) return ["image", "full"]; // 1 张图：图生视频/全能参考
    if (refOrder.length === 2) return ["first-last", "full"]; // 2 张图：首尾帧/全能参考
    if (refOrder.length >= 3) return ["full"]; // ≥3 张图：仅全能参考
    return ["text"]; // 无图片/视频/音频参考（含只有文本上游）→ 只能文生视频
  }, [refVideoOrder, audioOrder, refOrder]);

  // 当前模式不在可用范围时按默认回退：能全引用用全能参考，否则只能文生视频
  useEffect(() => {
    if (!allowedRefModes.includes(refMode)) {
      setRefMode(allowedRefModes.includes("full") ? "full" : "text");
    }
  }, [allowedRefModes, refMode]);

  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);

  // 音频拖拽排序（仅音频之间）：事件驱动写入排序偏好并即时持久化
  const handleAudioReorder = useCallback((dragged: string, target: string) => {
    const list = [...audioOrder];
    const fromIdx = list.indexOf(dragged);
    const toIdx = list.indexOf(target);
    if (fromIdx === -1 || toIdx === -1 || fromIdx === toIdx) return;
    const [moved] = list.splice(fromIdx, 1);
    list.splice(toIdx, 0, moved);
    writeOrderPref(nodeId, { refAudioOrder: list });
  }, [audioOrder, nodeId]);

  const retryRef = useRef<{ count: number; prompt: string; modelKey: string; resolution: string; ratio: string; seconds: number; generateAudio: boolean; refImages: string[]; refAudios: string[]; refVideos: string[]; refMode: string; n: number; entry: ModelOption | null; provider: ModelProvider | null }>({ count: 0, prompt: "", modelKey: "", resolution: "", ratio: "", seconds: 5, generateAudio: true, refImages: [] as string[], refAudios: [] as string[], refVideos: [] as string[], refMode: "", n: 1, entry: null, provider: null });
  const { notification } = App.useApp();

  const is: React.CSSProperties = {
    background: "transparent", border: "none", color: "var(--canvas-text)", borderRadius: 4, fontSize: 13,
  };

  // ── Submit generation task (SSE handled by InfiniteCanvas) ──
  const submitTask = async (): Promise<string | null> => {
    const { entry, provider, prompt: p, resolution: res, ratio: r, seconds: sec, generateAudio: audio, refImages: refs, refAudios: auds, refVideos: vids, refMode: rm, n: num } = retryRef.current;
    if (!entry || !provider) return "缺少模型配置";
    try {
      const res2 = await generationApi.submitGenerationTask({
        type: "video",
        prompt: p.trim(),
        model: entry.name,
        providerId: entry.providerId,
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
        const body = parseErrorBody(await res2.json().catch(() => null));
        return resolveApiError(body, res2.status, "generate.submit_failed");
      }
      const json = await res2.json();
      const taskId = json.data?.id;
      if (!taskId) return i18n.t("error.generate.no_task_id");

      const cur = useCanvasStore.getState().nodes.find(n => n.id === nodeId);
      const curBinding = cur ? (cur.data as MediaGenFields).taskBinding : undefined;
      if (!isGeneratingBinding(curBinding)) return null;
      useCanvasStore.getState().updateNodeData(nodeId, { taskBinding: { taskId, status: "pending", startedAt: Date.now() } }, undefined, { skipHistory: true });
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
    const provider = providers.find((c) => c.id === entry.providerId);
    if (!provider) return;

    setError("");
    useCanvasStore.getState().updateNodeData(nodeId, { taskBinding: { taskId: "", status: "processing", startedAt: Date.now() } }, undefined, { forceHistory: true });
    markDirtyImmediate();
    setElapsed(0);
    const isTextToVideo = refMode === "text";
    retryRef.current = { count: 0, prompt: finalPrompt, modelKey, resolution, ratio, seconds, generateAudio, refImages: isTextToVideo ? [] : refOrder, refAudios: isTextToVideo ? [] : audioOrder, refVideos: isTextToVideo ? [] : refVideoOrder, refMode, n, entry, provider };
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
      {refMode !== "text" && (
      <div
        className="flex gap-2 flex-wrap"
        onDragOver={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (e.dataTransfer.types.includes('application/x-ref-video') || e.dataTransfer.types.includes('application/x-ref-image') || e.dataTransfer.types.includes('application/x-ref-audio')) {
            e.dataTransfer.dropEffect = 'none'; // 排序仅限同类缩略图上，加号/文本/空白一律禁止
            return;
          }
          e.dataTransfer.dropEffect = 'move';
        }}
        onDragLeave={() => setDragOverIdx(null)}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setDragOverIdx(null);
        }}
      >
          {/* 上游 Text 节点 - 不可拖动，排在最前 */}
          {upstreamTexts.map((txt) => (
            <Tooltip
              key={`text-${txt.id}`}
              title={
                <div style={{ maxWidth: 320, maxHeight: 240, overflowY: "auto", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                  {txt.content}
                </div>
              }
            >
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
          {/* 上游 Audio 节点 - 参考音频，可拖动排序（仅音频之间） */}
          {[...upstreamAudio]
            .sort((a, b) => {
              const ai = audioOrder.indexOf(a.src);
              const bi = audioOrder.indexOf(b.src);
              return (ai === -1 ? Number.MAX_SAFE_INTEGER : ai) - (bi === -1 ? Number.MAX_SAFE_INTEGER : bi);
            })
            .map((aud, i) => (
              <AudioRefCard
                key={`audio-${aud.id}`}
                audio={aud}
                nodeId={nodeId}
                index={i}
                onReorder={handleAudioReorder}
                onDragStateChange={setIsRefDragging}
              />
            ))}
          {/* 上游 Video 节点 - 参考视频，可移除 */}
          {refVideoOrder.map((vid, i) => (
            <div key={`video-${vid}`} className={`relative group h-16 w-16 rounded transition-shadow cursor-grab active:cursor-grabbing ${videoDragOver === i ? 'ring-2 ring-white shadow-lg' : ''}`}
              style={{ background: "var(--canvas-bg-hover)", border: "1px solid var(--canvas-border)" }}
              draggable
              onDoubleClick={() => { const n = findReferenceNode(nodeId, NODE_TYPE.VIDEO, vid); if (n) reveal(n); }}
              onDragStart={(e) => {
                e.dataTransfer.setData('application/x-ref-video', vid);
                e.dataTransfer.setData('text/plain', vid);
                e.dataTransfer.effectAllowed = 'move';
                setIsRefDragging(true);
                // 以首帧视频为拖拽图像并锚定中心，避免快照携带悬停预览浮层导致错位
                const el = (e.currentTarget as HTMLElement).querySelector('video');
                if (el) e.dataTransfer.setDragImage(el, 32, 32);
              }}
              onDragEnd={() => setIsRefDragging(false)}
              onDragOver={(e) => {
                e.preventDefault();
                e.stopPropagation();
                if (!e.dataTransfer.types.includes('application/x-ref-video')) {
                  e.dataTransfer.dropEffect = 'none'; // 图片不可放到视频位置
                  return;
                }
                e.dataTransfer.dropEffect = 'move';
                setVideoDragOver(i);
              }}
              onDragLeave={() => setVideoDragOver(null)}
              onDrop={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setVideoDragOver(null);
                const dragged = e.dataTransfer.getData('text/plain');
                if (!dragged || dragged === vid) return;
                if (!refVideoOrder.includes(dragged)) return; // 仅视频之间排序
                const list = [...refVideoOrder];
                const fromIdx = list.indexOf(dragged);
                const toIdx = list.indexOf(vid);
                if (fromIdx === -1 || fromIdx === toIdx) return;
                const [moved] = list.splice(fromIdx, 1);
                list.splice(toIdx, 0, moved);
                writeOrderPref(nodeId, { refVideoOrder: list });
              }}
              onMouseEnter={() => setHoverVideo(vid)}
              onMouseLeave={() => setHoverVideo(null)}>
              {/* 第一帧缩略：#t=0.1 片段定位首帧，preload=metadata 避免预载全片 */}
              <video src={`${vid}#t=0.1`} className="w-full h-full object-cover rounded pointer-events-none" muted preload="metadata" playsInline draggable={false} />
              {hoverVideo === vid && !isRefDragging && (
                <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 z-50 pointer-events-none">
                  <video src={vid} className="max-w-[360px] max-h-[360px] rounded-lg shadow-2xl" style={{ background: "var(--canvas-bg)", border: "1px solid var(--canvas-border)" }} autoPlay muted loop playsInline />
                </div>
              )}
              <span className="absolute bottom-0.5 left-1/2 -translate-x-1/2 text-[11px] font-bold px-1 rounded pointer-events-none whitespace-nowrap" style={{ background: "rgba(0,0,0,0.6)", color: "#fff" }}>{t("common.refVideoLabel", { index: i + 1 })}</span>
              <Button type="text" size="small"
                className="!absolute -top-1.5 -right-1.5 !w-4 !h-4 !flex items-center justify-center !rounded-full !bg-black/70 !text-white/60 hover:!text-white hover:!bg-white/30 !text-[10px] opacity-0 group-hover:opacity-100 transition-opacity !p-0 !border-0"
                onClick={() => {
                  // 删除参考 = 断开连线（与图片/音频参考一致），显示顺序随后自动派生
                  const store = useCanvasStore.getState();
                  const edge = store.edges.find((e) => {
                    if (e.target !== nodeId) return false;
                    const srcNode = store.nodes.find((n) => n.id === e.source);
                    return srcNode && srcNode.type === NODE_TYPE.VIDEO && (srcNode.data as { src?: string }).src === vid;
                  });
                  if (edge) store.removeEdges([edge.id]);
                }}>✕</Button>
            </div>
          ))}
          {refOrder.map((img, i) => (
            <div
              key={img}
              draggable
              onDoubleClick={() => { const n = findReferenceNode(nodeId, NODE_TYPE.IMAGE, img); if (n) reveal(n); }}
              onDragStart={(e) => {
                e.dataTransfer.setData('application/x-ref-image', img);
                e.dataTransfer.setData('text/plain', img);
                e.dataTransfer.effectAllowed = 'move';
                setIsRefDragging(true);
                // 以缩略图为拖拽图像并锚定中心，避免快照携带悬停预览浮层导致错位
                const el = (e.currentTarget as HTMLElement).querySelector('img');
                if (el) e.dataTransfer.setDragImage(el, 32, 32);
              }}
              onDragEnd={() => setIsRefDragging(false)}
              onDragOver={(e) => {
                e.preventDefault();
                e.stopPropagation();
                if (!e.dataTransfer.types.includes('application/x-ref-image')) {
                  e.dataTransfer.dropEffect = 'none'; // 仅图片可放到图片位置
                  return;
                }
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
                if (refVideoOrder.includes(dragged)) return; // 视频不参与图片排序
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
              <img src={img.includes('/api/files/') ? `${img}?w=128` : img} alt={`Ref ${i+1}`} draggable={false} className={`h-16 w-16 rounded object-cover cursor-grab active:cursor-grabbing transition-shadow ${dragOverIdx === i ? 'ring-2 ring-white shadow-lg' : ''}`}
                onMouseEnter={() => setHoverImg(img)}
                onMouseLeave={() => setHoverImg(null)} />
              <span className="absolute bottom-0.5 left-1/2 -translate-x-1/2 text-[11px] font-bold px-1 rounded pointer-events-none whitespace-nowrap" style={{ background: "rgba(0,0,0,0.6)", color: "#fff" }}>{t("common.refImageLabel", { index: i + 1 })}</span>
            {hoverImg === img && !isRefDragging && (
                <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 z-50 pointer-events-none">
                  <img src={img.includes('/api/files/') ? `${img}?w=640` : img} className="max-w-[360px] max-h-[360px] rounded-lg shadow-2xl" style={{ background: "var(--canvas-bg)", border: "1px solid var(--canvas-border)", objectFit: "contain" }} />
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
            <MenuItem key={m.value} onClick={() => selectModel(m.value)} selected={modelKey === m.value}>
              <span className="flex items-center gap-1.5">
                <ModelIcon model={m.name} className="size-4 shrink-0" />
                <span className="truncate">{m.name}</span>
                {m.providerName ? <span className="ml-auto max-w-24 shrink-0 truncate text-xs opacity-50">{m.providerName}</span> : null}
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
                  {refMode === "image" && <VideoCameraIcon style={{ fontSize: 14 }} />}
                  {refMode === "text" && <TextToVideoIcon style={{ fontSize: 14 }} />}
                  {t(`video.refMode.${refMode}`)}
                </span>
                <DownOutlined style={{ fontSize: 11, color: "var(--canvas-text-dim)", flexShrink: 0 }} />
              </Button>
            }
            content={
              <>
                <div style={{ padding: "2px 4px 0", fontSize: 11, color: "var(--canvas-text-muted)" }}>{t("video.refModeTitle")}</div>
                {refModeOptions.map((m: string) => (
                  <MenuItem key={m} selected={refMode === m} dimmed={!allowedRefModes.includes(m)}
                    onClick={() => { if (allowedRefModes.includes(m)) { setRefMode(m); setRefModeOpen(false); } }}>
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
                    {m === "image" && (
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                        <VideoCameraIcon style={{ fontSize: 14 }} />
                        {t(`video.refMode.${m}`)}
                      </span>
                    )}
                    {m === "text" && (
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                        <TextToVideoIcon style={{ fontSize: 14 }} />
                        {t(`video.refMode.${m}`)}
                      </span>
                    )}
                    {m !== "full" && m !== "first-last" && m !== "image" && m !== "text" && t(`video.refMode.${m}`)}
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
  index,
  onReorder,
  onDragStateChange,
}: {
  audio: { id: string; src: string; label: string };
  nodeId: string;
  index: number;
  onReorder: (dragged: string, target: string) => void;
  onDragStateChange: (dragging: boolean) => void;
}) {
  const { t } = useTranslation();
  const reveal = useRevealCanvasNode();
  const [hovered, setHovered] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [dragOver, setDragOver] = useState(false);
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
        className={`relative group h-16 w-16 rounded flex items-center justify-center transition-shadow cursor-grab active:cursor-grabbing ${dragOver ? 'ring-2 ring-white shadow-lg' : ''}`}
        style={{ background: "var(--canvas-bg-hover)", border: "1px solid var(--canvas-border)" }}
        draggable
        onDoubleClick={() => {
          const s = useCanvasStore.getState();
          const n = s.nodes.find((x) => x.id === audio.id);
          if (n) reveal(n);
        }}
        onDragStart={(e) => {
          e.dataTransfer.setData('application/x-ref-audio', audio.src);
          e.dataTransfer.setData('text/plain', audio.src);
          e.dataTransfer.effectAllowed = 'move';
          onDragStateChange(true);
          // 锚定卡片中心，保证拖拽图像跟随鼠标
          e.dataTransfer.setDragImage(e.currentTarget as HTMLElement, 32, 32);
        }}
        onDragEnd={() => onDragStateChange(false)}
        onDragOver={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (!e.dataTransfer.types.includes('application/x-ref-audio')) {
            e.dataTransfer.dropEffect = 'none'; // 仅音频可放到音频位置
            return;
          }
          e.dataTransfer.dropEffect = 'move';
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setDragOver(false);
          const dragged = e.dataTransfer.getData('text/plain');
          if (!dragged || dragged === audio.src) return;
          onReorder(dragged, audio.src); // 内部按 audioOrder 校验，非音频自动忽略
        }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => {
          setHovered(false);
          if (playing) stop();
        }}
      >
        <WaveIcon className="pointer-events-none" style={{ color: "var(--canvas-text)", width: 16, height: 16 }} />
        <span className="absolute bottom-0.5 left-1/2 -translate-x-1/2 text-[11px] font-bold px-1 rounded pointer-events-none whitespace-nowrap" style={{ background: "rgba(0,0,0,0.6)", color: "#fff" }}>{t("common.refAudioLabel", { index: index + 1 })}</span>
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
