/**
 * 视频生成面板的派生数据与副作用逻辑。
 * 根据当前画布连接关系计算上游参考（图片 / 文本 / 音频 / 视频）、最终 prompt、
 * 生成中状态与计时清理。面板参数（prompt / 模型等）为受控模式：
 * 唯一数据源是节点 genSettings（由面板 writeGenSettings 写入），本 hook 仅消费只读输入。
 *
 * 参考排序架构（单一数据源 + 派生合并）：
 * - 存在性：refImages / upstreamAudio / upstreamVideos 全部实时派生自 edges，不落本地状态；
 * - 显示顺序：refOrder / refAudioOrder / refVideoOrder 各自 mergeOrder(偏好, 实时列表) 纯派生，
 *   任意时刻首帧即正确；排序只在同类型内生效，跨类型拖放被禁止。
 */

import { useEffect, useMemo, useRef, useState } from "react";

import { useCanvasStore } from "@/features/canvas/stores/canvas-store";
import type { MediaGenFields, VideoGenSettings } from "@/features/canvas/types";
import { isGenerating as isGeneratingBinding, NODE_TYPE } from "@/lib/constants";

import { EMPTY_ORDER, mergeOrder, useGenSettings } from "../shared/ref-order";
import type { ReferenceItem } from "../shared/reference";

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
  /** 上游 TEXT 节点引用（按连线顺序） */
  upstreamTexts: { id: string; content: string }[];
  upstreamAudio: { id: string; src: string; label: string }[];
  /** 上游 VIDEO 节点引用（参考视频） */
  upstreamVideos: { id: string; src: string; label: string }[];
  references: ReferenceItem[];
  finalPrompt: string;
  isGenerating: boolean;
  elapsed: number;
  error: string;
  setElapsed: React.Dispatch<React.SetStateAction<number>>;
  setError: React.Dispatch<React.SetStateAction<string>>;
  timerRef: React.MutableRefObject<ReturnType<typeof setInterval> | null>;
}

export function useVideoGenPanel(input: VideoGenPanelInput): VideoGenPanelDerived {
  const { nodeId, prompt } = input;

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

  // ── 排序偏好（genSettings，响应式只读）──
  const genSettings = useGenSettings(nodeId);
  const prefs = genSettings as Partial<VideoGenSettings> | undefined;

  // 最终 prompt：上游文本（按连线顺序）+ 当前 prompt。文本参考不可拖动，不参与排序。
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

  // 上游音频 src→label 映射，用于 @ 引用回填展示名。
  const audioSrcLabel = useMemo(() => {
    const m = new Map<string, string>();
    upstreamAudio.forEach((a) => {
      if (a.src) m.set(a.src, a.label);
    });
    return m;
  }, [upstreamAudio]);

  // ── 参考排序：偏好（genSettings，响应式只读）+ 实时列表，纯派生合并 ──
  // 参考区按类型分组（文本 → 音频 → 图片 → 视频），排序只在同类型内生效，跨类型拖放被禁止。
  const refOrderPref = prefs?.refOrder ?? EMPTY_ORDER;
  const audioOrderPref = prefs?.refAudioOrder ?? EMPTY_ORDER;
  const refVideoOrderPref = prefs?.refVideoOrder ?? EMPTY_ORDER;

  const audioSrcs = useMemo(() => upstreamAudio.map((a) => a.src), [upstreamAudio]);
  const videoSrcs = useMemo(() => upstreamVideos.map((v) => v.src), [upstreamVideos]);

  const refOrder = useMemo(() => mergeOrder(refOrderPref, refImages), [refOrderPref, refImages]);
  const audioOrder = useMemo(() => mergeOrder(audioOrderPref, audioSrcs), [audioOrderPref, audioSrcs]);
  const refVideoOrder = useMemo(() => mergeOrder(refVideoOrderPref, videoSrcs), [refVideoOrderPref, videoSrcs]);

  // 构建 @ 提及的参考列表：顺序与参考区一致（音频 → 图片 → 视频），编号按各自 order
  const references = useMemo<ReferenceItem[]>(() => {
    const videoLabelMap = new Map(upstreamVideos.map((v) => [v.src, v.label]));
    const audios: ReferenceItem[] = audioOrder.map((src, i) => ({
      src,
      thumbnail: src,
      index: i,
      kind: "audio",
      label: audioSrcLabel.get(src) || "",
    }));
    const images: ReferenceItem[] = refOrder.map((src, i) => ({
      src,
      thumbnail: src.includes("/api/files/") ? `${src}?w=128` : src,
      index: i,
      kind: "image",
    }));
    const videos: ReferenceItem[] = refVideoOrder.map((src, i) => ({
      src,
      thumbnail: src,
      index: i,
      kind: "video",
      label: videoLabelMap.get(src) || "",
    }));
    return [...audios, ...images, ...videos];
  }, [audioOrder, refOrder, refVideoOrder, audioSrcLabel, upstreamVideos]);

  // Button disabled state derived from persistent node.data.task_status。
  const isGenerating = useMemo(() => {
    const node = canvasNodes.find((node) => node.id === nodeId);
    return isGeneratingBinding((node?.data as MediaGenFields)?.taskBinding);
  }, [canvasNodes, nodeId]);

  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState("");

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Cleanup timer on unmount。
  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  return {
    refImages,
    refOrder,
    audioOrder,
    refVideoOrder,
    upstreamTexts,
    upstreamAudio,
    upstreamVideos,
    references,
    finalPrompt,
    isGenerating,
    elapsed,
    error,
    setElapsed,
    setError,
    timerRef,
  };
}
