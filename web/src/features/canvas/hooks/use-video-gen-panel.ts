/**
 * 视频生成面板的派生数据与副作用逻辑。
 * 根据当前画布连接关系计算上游参考（图片 / 文本 / 音频 / 视频）、最终 prompt
 * 与生成中状态。面板参数（prompt / 模型等）为受控模式：
 * 唯一数据源是节点 genSettings（由面板 writeGenSettings 写入），本 hook 仅消费只读输入。
 *
 * 参考排序架构（单一数据源 + 派生合并）：
 * - 存在性：refImages / upstreamAudio / upstreamVideos 全部实时派生自 edges，不落本地状态；
 * - 显示顺序：refOrder / refAudioOrder / refVideoOrder 各自 mergeOrder(偏好, 实时列表) 纯派生，
 *   任意时刻首帧即正确；排序只在同类型内生效，跨类型拖放被禁止。
 */

import { useMemo } from "react";

import type { VideoGenSettings } from "@/features/canvas/types";

import { EMPTY_ORDER, mergeOrder, useGenSettings } from "../shared/ref-order";
import type { ReferenceItem } from "../shared/reference";
import { useNodeGenerating } from "./use-node-generating";
import { useNodeUpstreamRefs } from "./use-node-upstream-refs";

export interface VideoGenPanelInput {
  nodeId: string;
  prompt: string;
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
}

export function useVideoGenPanel(input: VideoGenPanelInput): VideoGenPanelDerived {
  const { nodeId, prompt } = input;

  // 上游引用（图片 / 文本 / 音频 / 视频）：按内容订阅，位置变化（拖动提交、整理动画）不重渲染。
  const {
    images: refImages,
    texts: upstreamTexts,
    audios: upstreamAudio,
    videos: upstreamVideos,
  } = useNodeUpstreamRefs(nodeId);

  // ── 排序偏好（genSettings，响应式只读）──
  const genSettings = useGenSettings(nodeId);
  const prefs = genSettings as Partial<VideoGenSettings> | undefined;

  // 最终 prompt：上游文本（按连线顺序）+ 当前 prompt。文本参考不可拖动，不参与排序。
  const finalPrompt = useMemo(() => {
    return [...upstreamTexts.map((txt) => txt.content), prompt.trim()].filter(Boolean).join("\n");
  }, [upstreamTexts, prompt]);

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
      index: i,
      kind: "audio",
      label: audioSrcLabel.get(src) || "",
    }));
    const images: ReferenceItem[] = refOrder.map((src, i) => ({
      src,
      index: i,
      kind: "image",
    }));
    const videos: ReferenceItem[] = refVideoOrder.map((src, i) => ({
      src,
      index: i,
      kind: "video",
      label: videoLabelMap.get(src) || "",
    }));
    return [...audios, ...images, ...videos];
  }, [audioOrder, refOrder, refVideoOrder, audioSrcLabel, upstreamVideos]);

  // Button disabled state derived from persistent node.data.task_status
  const isGenerating = useNodeGenerating(nodeId);

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
  };
}
