/**
 * 视频生成面板的派生数据与副作用逻辑。
 * 负责根据当前画布连接关系计算上游参考（图片 / 文本 / 音频）、最终 prompt、
 * 生成中状态，以及把面板参数持久化到节点数据与组件卸载时的清理计时。
 * 纯 UI 状态（prompt / 模型选择等）仍由面板组件持有，本 hook 仅消费这些输入。
 */

import { useEffect, useMemo, useRef, useState } from "react";

import { isGenerating as isGeneratingBinding,NODE_TYPE } from "@/lib/constants";
import type { MediaGenFields, VideoGenSettings } from "@/lib/types/nodes";
import { flushAndWait, markDirtyImmediate, useCanvasStore } from "@/stores/canvas-store";
import { useHistoryStore } from "@/stores/history-store";

import type { ReferenceItem } from "../chat/MentionPrompt";

export interface VideoGenPanelInput {
  nodeId: string;
  prompt: string;
  modelKey: string;
  resolution: string;
  ratio: string;
  seconds: number;
  generateAudio: boolean;
  n: number;
  refOrder: string[];
  audioOrder: string[];
}

export interface VideoGenPanelDerived {
  refImages: string[];
  upstreamTexts: { id: string; content: string }[];
  upstreamAudio: { id: string; src: string; label: string }[];
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
    seconds: number; generateAudio: boolean; refOrder: string[]; refAudioOrder: string[]; n: number;
  }>;
  timerRef: React.MutableRefObject<ReturnType<typeof setInterval> | null>;
}

export function useVideoGenPanel(input: VideoGenPanelInput): VideoGenPanelDerived {
  const { nodeId, prompt, modelKey, resolution, ratio, seconds, generateAudio, n, refOrder, audioOrder } = input;

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
      .map((node) => ({ id: node.id, content: ((node.data as { content?: string }).content || "").trim() }))
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

  // 构建 @ 提及的参考列表（图片基于 refOrder、音频基于 audioOrder，均保证编号稳定）。
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

  // Button disabled state derived from persistent node.data.task_status。
  const isGenerating = useMemo(() => {
    const node = canvasNodes.find((node) => node.id === nodeId);
    return isGeneratingBinding((node?.data as MediaGenFields)?.taskBinding);
  }, [canvasNodes, nodeId]);

  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState("");

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const latestSettingsRef = useRef({
    prompt, modelKey, resolution, ratio, seconds, generateAudio, refOrder, refAudioOrder: audioOrder, n,
  });
  useEffect(() => {
    latestSettingsRef.current = { prompt, modelKey, resolution, ratio, seconds, generateAudio, refOrder, refAudioOrder: audioOrder, n };
  }, [prompt, modelKey, resolution, ratio, seconds, generateAudio, refOrder, audioOrder, n]);

  // Persist settings to node data on change (debounced)。
  useEffect(() => {
    const timer = setTimeout(() => {
      useCanvasStore.getState().updateNodeData(nodeId, {
        genSettings: { prompt, modelKey, resolution, ratio, seconds, generateAudio, refOrder, refAudioOrder: audioOrder, n },
      }, undefined, { skipHistory: true });
    }, 300);
    return () => clearTimeout(timer);
  }, [prompt, modelKey, resolution, ratio, seconds, generateAudio, refOrder, audioOrder, n, nodeId]);

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
          saved.n === latest.n &&
          JSON.stringify(saved.refOrder) === JSON.stringify(latest.refOrder) &&
          JSON.stringify(saved.refAudioOrder) === JSON.stringify(latest.refAudioOrder)) return;
      useCanvasStore.getState().updateNodeData(nodeId, { genSettings: { ...latest } }, undefined, { skipHistory: true });
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
    upstreamTexts,
    upstreamAudio,
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
