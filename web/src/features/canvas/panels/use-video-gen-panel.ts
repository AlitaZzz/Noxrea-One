/**
 * 视频生成面板的派生数据与副作用逻辑。
 * 负责根据当前画布连接关系计算上游参考（图片 / 文本 / 音频 / 视频）、最终 prompt、
 * 生成中状态，以及把面板参数持久化到节点数据与组件卸载时的清理计时。
 * 纯 UI 状态（prompt / 模型选择等）仍由面板组件持有，本 hook 仅消费这些输入。
 *
 * 参考排序架构（单一数据源 + 派生合并）：
 * - 存在性：refImages / upstreamAudio / upstreamVideos 全部实时派生自 edges，不落本地状态；
 * - 排序偏好：genSettings.refOrder / refAudioOrder / refVideoOrder 仅持久化用户排序，
 *   唯一写者是拖拽排序事件（writeOrderPref），本 hook 只读不写、断线不触碰偏好；
 * - 显示顺序：mergeOrder(偏好, 实时列表) 纯派生，任意时刻首帧即正确。
 */

import { useEffect, useMemo, useRef, useState } from "react";

import { flushAndWait, markDirtyImmediate, useCanvasStore } from "@/features/canvas/stores/canvas-store";
import { useHistoryStore } from "@/features/canvas/stores/history-store";
import type { MediaGenFields, VideoGenSettings } from "@/features/canvas/types";
import { isGenerating as isGeneratingBinding, NODE_TYPE } from "@/lib/constants";

import type { ReferenceItem } from "../shared/MentionPrompt";
import { EMPTY_ORDER, mergeOrder, useGenSettings } from "../shared/ref-order";

export interface VideoGenPanelInput {
  nodeId: string;
  prompt: string;
  modelKey: string;
  resolution: string;
  ratio: string;
  seconds: number;
  generateAudio: boolean;
  n: number;
  /** 参考方式：text（文生）/image（图生）/first-last/full，text = 文生视频 */
  refMode: string;
}

export interface VideoGenPanelDerived {
  refImages: string[];
  /** 图片参考显示顺序（排序偏好 + 连线派生合并） */
  refOrder: string[];
  /** 音频参考显示顺序（排序偏好 + 连线派生合并） */
  audioOrder: string[];
  /** 视频参考显示顺序（排序偏好 + 连线派生合并） */
  refVideoOrder: string[];
  upstreamTexts: { id: string; content: string }[];
  upstreamAudio: { id: string; src: string; label: string }[];
  /** 上游 VIDEO 节点引用（参考视频） */
  upstreamVideos: { id: string; src: string; label: string }[];
  audioSrcLabel: Map<string, string>;
  references: ReferenceItem[];
  finalPrompt: string;
  isGenerating: boolean;
  elapsed: number;
  error: string;
  setElapsed: React.Dispatch<React.SetStateAction<number>>;
  setError: React.Dispatch<React.SetStateAction<string>>;
  latestSettingsRef: React.MutableRefObject<{
    prompt: string; modelKey: string; resolution: string; ratio: string;
    seconds: number; generateAudio: boolean; refMode: string; n: number;
  }>;
  timerRef: React.MutableRefObject<ReturnType<typeof setInterval> | null>;
}

export function useVideoGenPanel(input: VideoGenPanelInput): VideoGenPanelDerived {
  const { nodeId, prompt, modelKey, resolution, ratio, seconds, generateAudio, n, refMode } = input;

  const canvasNodes = useCanvasStore((s) => s.nodes);
  const canvasEdges = useCanvasStore((s) => s.edges);

  // Upstream reference images - derived live from current edges.
  const refImages = useMemo(() => {
    const upstreamIds = new Set(canvasEdges.filter((e) => e.target === nodeId).map((e) => e.source));
    return canvasNodes
      .filter((node) => upstreamIds.has(node.id) && node.type === NODE_TYPE.IMAGE)
      .map((node) => (node.data as { src?: string }).src)
      .filter(Boolean) as string[];
  }, [nodeId, canvasNodes, canvasEdges]);

  // Upstream reference texts (TEXT 节点，按连接顺序，去重)。
  const upstreamTexts = useMemo(() => {
    const seen = new Set<string>();
    return canvasEdges
      .filter((e) => e.target === nodeId)
      .map((e) => canvasNodes.find((node) => node.id === e.source))
      .filter((node): node is NonNullable<typeof node> => !!node && node.type === NODE_TYPE.TEXT)
      .map((node) => ({ id: node.id, content: ((node.data as { plainText?: string }).plainText || "").trim() }))
      .filter((txt) => txt.content !== "" && !seen.has(txt.id) && seen.add(txt.id));
  }, [nodeId, canvasNodes, canvasEdges]);

  // 最终 prompt：上游文本 + 当前 prompt。
  const finalPrompt = useMemo(() => {
    return [...upstreamTexts.map((txt) => txt.content), prompt.trim()].filter(Boolean).join("\n");
  }, [upstreamTexts, prompt]);

  // Upstream reference audio (AUDIO 节点，按连接顺序，按节点 id 与 src 双重去重)。
  const upstreamAudio = useMemo(() => {
    const seenIds = new Set<string>();
    const seenSrcs = new Set<string>();
    return canvasEdges
      .filter((e) => e.target === nodeId)
      .map((e) => canvasNodes.find((node) => node.id === e.source))
      .filter((node): node is NonNullable<typeof node> => !!node && node.type === NODE_TYPE.AUDIO)
      .map((node) => ({
        id: node.id,
        src: ((node.data as { src?: string }).src || "").trim(),
        label: ((node.data as { label?: string }).label || "").trim(),
      }))
      .filter(
        (a) =>
          a.src !== "" &&
          !seenIds.has(a.id) &&
          !seenSrcs.has(a.src) &&
          (seenIds.add(a.id), seenSrcs.add(a.src), true),
      );
  }, [nodeId, canvasNodes, canvasEdges]);

  // 上游音频 src→label 映射，用于回填持久化顺序的 label。
  const audioSrcLabel = useMemo(() => {
    const m = new Map<string, string>();
    upstreamAudio.forEach((a) => {
      if (a.src) m.set(a.src, a.label);
    });
    return m;
  }, [upstreamAudio]);

  // Upstream reference videos (VIDEO 节点，按连接顺序，按节点 id 与 src 双重去重)。
  const upstreamVideos = useMemo(() => {
    const seenIds = new Set<string>();
    const seenSrcs = new Set<string>();
    return canvasEdges
      .filter((e) => e.target === nodeId)
      .map((e) => canvasNodes.find((node) => node.id === e.source))
      .filter((node): node is NonNullable<typeof node> => !!node && node.type === NODE_TYPE.VIDEO)
      .map((node) => ({
        id: node.id,
        src: ((node.data as { src?: string }).src || "").trim(),
        label: ((node.data as { label?: string }).label || "").trim(),
      }))
      .filter(
        (v) =>
          v.src !== "" &&
          !seenIds.has(v.id) &&
          !seenSrcs.has(v.src) &&
          (seenIds.add(v.id), seenSrcs.add(v.src), true),
      );
  }, [nodeId, canvasNodes, canvasEdges]);

  // ── 参考排序：偏好（genSettings，响应式只读）+ 实时列表，纯派生合并 ──
  const genSettings = useGenSettings(nodeId);
  const prefs = genSettings as Partial<VideoGenSettings> | undefined;
  const refOrderPref = prefs?.refOrder ?? EMPTY_ORDER;
  const audioOrderPref = prefs?.refAudioOrder ?? EMPTY_ORDER;
  const refVideoOrderPref = prefs?.refVideoOrder ?? EMPTY_ORDER;

  const audioSrcs = useMemo(() => upstreamAudio.map((a) => a.src), [upstreamAudio]);
  const videoSrcs = useMemo(() => upstreamVideos.map((v) => v.src), [upstreamVideos]);

  const refOrder = useMemo(() => mergeOrder(refOrderPref, refImages), [refOrderPref, refImages]);
  const audioOrder = useMemo(() => mergeOrder(audioOrderPref, audioSrcs), [audioOrderPref, audioSrcs]);
  const refVideoOrder = useMemo(() => mergeOrder(refVideoOrderPref, videoSrcs), [refVideoOrderPref, videoSrcs]);

  // 构建 @ 提及的参考列表。顺序与参考区一致：音频 -> 视频 -> 图片；
  // 各自编号基于对应 order（audioOrder / refVideoOrder / refOrder），排序后编号随之稳定。
  const references = useMemo<ReferenceItem[]>(() => {
    const videoLabelMap = new Map(upstreamVideos.map((v) => [v.src, v.label]));
    const audios: ReferenceItem[] = audioOrder.map((src, i) => ({
      src,
      thumbnail: src,
      index: i,
      kind: "audio",
      label: audioSrcLabel.get(src) || "",
    }));
    const videos: ReferenceItem[] = refVideoOrder.map((src, i) => ({
      src,
      thumbnail: src,
      index: i,
      kind: "video",
      label: videoLabelMap.get(src) || "",
    }));
    const images: ReferenceItem[] = refOrder.map((src, i) => ({
      src,
      thumbnail: src.includes("/api/files/") ? `${src}?w=128` : src,
      index: i,
      kind: "image",
    }));
    return [...audios, ...videos, ...images];
  }, [refOrder, audioOrder, refVideoOrder, audioSrcLabel, upstreamVideos]);

  // Button disabled state derived from persistent node.data.task_status。
  const isGenerating = useMemo(() => {
    const node = canvasNodes.find((node) => node.id === nodeId);
    return isGeneratingBinding((node?.data as MediaGenFields)?.taskBinding);
  }, [canvasNodes, nodeId]);

  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState("");

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const latestSettingsRef = useRef({
    kind: "video" as const, prompt, modelKey, resolution, ratio, seconds, generateAudio, refMode, n,
  });
  useEffect(() => {
    latestSettingsRef.current = { kind: "video", prompt, modelKey, resolution, ratio, seconds, generateAudio, refMode, n };
  }, [prompt, modelKey, resolution, ratio, seconds, generateAudio, refMode, n]);

  // Persist settings to node data on change (debounced)。
  // 参考排序偏好不经过此通道：它在排序事件时已即时写入，此处从 store 透传，避免双写。
  useEffect(() => {
    const timer = setTimeout(() => {
      const node = useCanvasStore.getState().nodes.find((n) => n.id === nodeId);
      const cur = ((node?.data as MediaGenFields | undefined)?.genSettings ?? {}) as Partial<VideoGenSettings>;
      useCanvasStore.getState().updateNodeData(nodeId, {
        genSettings: {
          kind: "video", prompt, modelKey, resolution, ratio, seconds, generateAudio,
          refOrder: cur.refOrder ?? [], refAudioOrder: cur.refAudioOrder ?? [], refVideoOrder: cur.refVideoOrder ?? [],
          refMode, n,
        },
      }, undefined, { skipHistory: true });
    }, 300);
    return () => clearTimeout(timer);
  }, [prompt, modelKey, resolution, ratio, seconds, generateAudio, refMode, n, nodeId]);

  // Flush pending settings on component unmount (not on dep changes)。
  useEffect(() => {
    return () => {
      const latest = latestSettingsRef.current;
      const node = useCanvasStore.getState().nodes.find((node) => node.id === nodeId);
      const saved = (node?.data as MediaGenFields)?.genSettings as Partial<VideoGenSettings> | undefined;
      if (saved &&
          saved.prompt === latest.prompt && saved.modelKey === latest.modelKey &&
          saved.resolution === latest.resolution && saved.ratio === latest.ratio &&
          saved.seconds === latest.seconds && saved.generateAudio === latest.generateAudio &&
          saved.refMode === latest.refMode && saved.n === latest.n) return;
      const cur = saved ?? {};
      useCanvasStore.getState().updateNodeData(nodeId, {
        genSettings: {
          ...latest,
          refOrder: cur.refOrder ?? [], refAudioOrder: cur.refAudioOrder ?? [], refVideoOrder: cur.refVideoOrder ?? [],
        },
      }, undefined, { skipHistory: true });
      markDirtyImmediate();
    };
  }, []);

  // Cleanup timer on unmount。
  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  // 暴露 flushAndWait 给提交逻辑使用（保持与原组件一致的行为）。
  void flushAndWait;
  void useHistoryStore;

  return {
    refImages,
    refOrder,
    audioOrder,
    refVideoOrder,
    upstreamTexts,
    upstreamAudio,
    upstreamVideos,
    audioSrcLabel,
    references,
    finalPrompt,
    isGenerating,
    elapsed,
    error,
    setElapsed,
    setError,
    latestSettingsRef,
    timerRef,
  };
}
