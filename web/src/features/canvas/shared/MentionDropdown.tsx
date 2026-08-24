/**
 * @ 引用候选下拉列表。
 * 展示可引用的图片 / 音频素材缩略项，支持键盘上下选择与外部点击关闭，
 * 并对外导出引用项类型 ReferenceItem。
 */
"use client";

import { memo, useCallback, useEffect, useRef, useState } from "react";

import { WaveIcon } from "@/components/ui/icons/media/WaveIcon";

export interface ReferenceItem {
  src: string;
  thumbnail: string;
  index: number; // 0-based index within its kind list
  kind: "image" | "audio";
  label?: string; // audio label (filename), unused for images
}

interface Props {
  items: ReferenceItem[];
  position: { x: number; y: number };
  onSelect: (item: ReferenceItem) => void;
  onClose: () => void;
}

const MentionDropdown = memo(function MentionDropdown({ items, position, onSelect, onClose }: Props) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (listRef.current && !listRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const timer = setTimeout(() => document.addEventListener("mousedown", handler), 100);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("mousedown", handler);
    };
  }, [onClose]);

  // Keyboard navigation
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setSelectedIndex((prev) => Math.min(prev + 1, items.length - 1));
          break;
        case "ArrowUp":
          e.preventDefault();
          setSelectedIndex((prev) => Math.max(prev - 1, 0));
          break;
        case "Enter":
          e.preventDefault();
          if (items[selectedIndex]) {
            onSelect(items[selectedIndex]);
          }
          return;
        case "Escape":
          e.preventDefault();
          onClose();
          return;
        default:
          return;
      }
      // Scroll selected into view
      const el = listRef.current?.children[selectedIndex] as HTMLElement | undefined;
      el?.scrollIntoView({ block: "nearest" });
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [items, selectedIndex, onSelect, onClose]);

  // Reset selection when items change
  useEffect(() => {
    setSelectedIndex(0);
  }, [items]);

  const handleMouseEnter = useCallback((i: number) => {
    setSelectedIndex(i);
  }, []);

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
          onMouseEnter={() => handleMouseEnter(i)}
          onMouseDown={(e) => {
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
          ) : (
            <img
              src={item.thumbnail}
              alt={`图${item.index + 1}`}
              className="w-10 h-10 rounded object-cover flex-shrink-0"
              style={{ border: "1px solid var(--canvas-border, #3a3a3a)" }}
            />
          )}
          <span
            className="text-sm font-medium"
            style={{ color: "var(--canvas-text)" }}
          >
            {item.kind === "audio" ? `音${item.index + 1}` : `图${item.index + 1}`}
            {item.kind === "audio" && item.label ? ` · ${item.label}` : ""}
          </span>
        </div>
      ))}
      </div>
    </>
  );
});

export default MentionDropdown;
