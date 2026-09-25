/**
 * @ 引用 chip（Tiptap NodeView）。
 * 渲染为不可拆分的原子节点：素材 chip 展示缩略图 / 波形与「图片N / 音频N / 视频N」标签，
 * 预设 chip 展示预设图标与名称。
 */
"use client";

import { type NodeViewProps, NodeViewWrapper } from "@tiptap/react";
import { createElement } from "react";
import { useTranslation } from "react-i18next";

import { WaveIcon } from "@/components/ui/icons/media/WaveIcon";

import { findPreset, presetIconOf, usePromptPresets } from "./prompt-presets";
import { type ReferenceItemAttrs, refLabel } from "./reference";

export default function MentionChip({ node }: NodeViewProps) {
  const { t } = useTranslation();
  const { data: presets } = usePromptPresets();
  const item = node.attrs as ReferenceItemAttrs;

  if (item.kind === "preset") {
    const preset = presets ? findPreset(presets, item.presetId || "") : undefined;
    return (
      <NodeViewWrapper as="span" className="mention-chip">
        {preset ? createElement(presetIconOf(preset.id), { className: "mention-preset-icon" }) : null}
        <span>{preset ? t(preset.labelKey) : item.presetId}</span>
      </NodeViewWrapper>
    );
  }

  return (
    <NodeViewWrapper as="span" className="mention-chip">
      {item.kind === "audio" ? (
        <span className="mention-wave">
          <WaveIcon style={{ width: 20, height: 20 }} />
        </span>
      ) : item.kind === "video" ? (
        <video
          src={`${item.thumbnail}#t=0.1`}
          muted
          preload="metadata"
          playsInline
          className="mention-thumb"
        />
      ) : (
        <img src={item.thumbnail} alt={refLabel(item)} className="mention-thumb" />
      )}
      <span>{refLabel(item)}</span>
    </NodeViewWrapper>
  );
}
