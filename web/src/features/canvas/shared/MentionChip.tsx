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

import { findPreset, localizeText, presetIconOf, usePromptPresets } from "./prompt-presets";
import { type ReferenceItemAttrs, refLabelKey } from "./reference";

export default function MentionChip({ node }: NodeViewProps) {
  const { i18n, t } = useTranslation();
  const { data: presets } = usePromptPresets();
  const item = node.attrs as ReferenceItemAttrs;

  if (item.kind === "preset") {
    const preset = presets ? findPreset(presets, item.presetId || "") : undefined;
    // 目录由画布门页预取，正常路径 presets 必然就绪；查不到 = 预设已被删除
    // （旧画布数据残留令牌）——显示占位文案而非裸 id，提交时 expandPresetTokens 会拒绝。
    // 图标统一走 presetIconOf（未知 id 兜底 Wand2）
    return (
      <NodeViewWrapper as="span" className="mention-chip">
        {createElement(presetIconOf(item.presetId || ""), { className: "mention-preset-icon" })}
        <span>{preset ? localizeText(preset.label, i18n.language) : t("canvas.presetRemoved")}</span>
      </NodeViewWrapper>
    );
  }

  // chip 展示标签走 i18n；提示词存储格式仍由 refLabel 序列化（locale 稳定），两者双轨
  const label = t(refLabelKey(item), { index: item.index + 1 });

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
        <img src={item.thumbnail} alt={label} className="mention-thumb" />
      )}
      <span>{label}</span>
    </NodeViewWrapper>
  );
}
