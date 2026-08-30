/**
 * @ 引用 chip（Tiptap NodeView）。
 * 渲染为不可拆分的原子节点，展示素材缩略图 / 波形与「图片N / 音频N / 视频N」标签。
 */
"use client";

import { type NodeViewProps,NodeViewWrapper } from "@tiptap/react";

import { WaveIcon } from "@/components/ui/icons/media/WaveIcon";

import { type ReferenceItem,refLabel } from "./reference";

export default function MentionChip({ node }: NodeViewProps) {
  const item = node.attrs as unknown as ReferenceItem;

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
