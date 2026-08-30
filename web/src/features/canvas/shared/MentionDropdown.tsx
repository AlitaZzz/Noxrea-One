/**
 * @ 引用候选下拉列表。
 * 展示可引用的图片 / 音频 / 视频素材缩略项。
 * 纯受控组件：选中项由外部（编辑器 suggestion）驱动，键盘事件由 suggestion 的 onKeyDown 统一处理。
 */
"use client";

import { memo, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

import { WaveIcon } from "@/components/ui/icons/media/WaveIcon";

import { type ReferenceItem, refLabel, refLabelKey } from "./reference";

interface Props {
  items: ReferenceItem[];
  position: { x: number; y: number };
  selectedIndex: number;
  onHover: (index: number) => void;
  onSelect: (item: ReferenceItem) => void;
}

const MentionDropdown = memo(function MentionDropdown({ items, position, selectedIndex, onHover, onSelect }: Props) {
  const { t } = useTranslation();
  const listRef = useRef<HTMLDivElement>(null);

  // 键盘导航时让选中项保持可见
  useEffect(() => {
    const el = listRef.current?.children[selectedIndex] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  if (items.length === 0) return null;

  // Clamp position to viewport
  const dropdownWidth = 220;
  const dropdownHeight = Math.min(items.length * 56 + 8, 300);
  const x = Math.min(position.x, window.innerWidth - dropdownWidth - 8);
  const y = position.y + dropdownHeight > window.innerHeight
    ? position.y - dropdownHeight - 8
    : position.y + 4;

  return (
    <>
      <style>{`
        .mention-dropdown-scroll { scrollbar-width: thin; scrollbar-color: rgba(255,255,255,0.2) transparent; }
        .mention-dropdown-scroll::-webkit-scrollbar { width: 6px; }
        .mention-dropdown-scroll::-webkit-scrollbar-thumb {
          background: rgba(255,255,255,0.2);
          border-radius: 3px;
        }
        .mention-dropdown-scroll::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.35); }
      `}</style>
      <div
        ref={listRef}
        className="mention-dropdown-scroll fixed z-[9999] rounded-lg shadow-2xl overflow-x-hidden overflow-y-auto"
        style={{
          left: x,
          top: y,
          width: dropdownWidth,
          maxHeight: 300,
          background: "var(--canvas-bg, #262626)",
          border: "1px solid var(--canvas-border, #3a3a3a)",
        }}
      >
      {items.map((item, i) => (
        <div
          key={`${item.kind}-${item.src}`}
          className="flex items-center gap-3 px-3 py-2 cursor-pointer"
          style={{
            background: i === selectedIndex
              ? "var(--canvas-bg-hover, #3c3c3c)"
              : "transparent",
          }}
          onMouseEnter={() => onHover(i)}
          onMouseDown={(e) => {
            // 阻止默认行为，避免抢走编辑器焦点导致 suggestion 提前退出
            e.preventDefault();
            onSelect(item);
          }}
        >
          {item.kind === "audio" ? (
            <div
              className="w-10 h-10 rounded flex items-center justify-center flex-shrink-0"
              style={{ background: "var(--canvas-bg-hover, #3c3c3c)", border: "1px solid var(--canvas-border, #3a3a3a)", color: "#1d9e75" }}
            >
              <WaveIcon style={{ width: 22, height: 22 }} />
            </div>
          ) : item.kind === "video" ? (
            <video
              src={`${item.thumbnail}#t=0.1`}
              muted
              preload="metadata"
              playsInline
              className="w-10 h-10 rounded object-cover flex-shrink-0"
              style={{ border: "1px solid var(--canvas-border, #3a3a3a)", background: "var(--canvas-bg-hover, #3c3c3c)" }}
            />
          ) : (
            <img
              src={item.thumbnail}
              alt={refLabel(item)}
              className="w-10 h-10 rounded object-cover flex-shrink-0"
              style={{ border: "1px solid var(--canvas-border, #3a3a3a)" }}
            />
          )}
          <span
            className="text-sm font-medium"
            style={{ color: "var(--canvas-text)" }}
          >
            {t(refLabelKey(item), { index: item.index + 1 })}
          </span>
        </div>
      ))}
      </div>
    </>
  );
});

export default MentionDropdown;
