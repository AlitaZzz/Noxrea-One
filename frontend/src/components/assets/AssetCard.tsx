"use client";

import { useState, useRef } from "react";
import { createPortal } from "react-dom";
import { Tooltip } from "antd";
import { PlayCircleOutlined } from "@ant-design/icons";
import { PlusOutlined, MoreOutlined, DownloadOutlined, EditOutlined, DeleteOutlined, CheckCircleFilled } from "@ant-design/icons";
import type { AssetItem } from "@/lib/types";
import { useI18nStore } from "@/stores/i18n-store";
import { useLayerOverlay } from "@/lib/layer";

interface Props {
  asset: AssetItem;
  selected?: boolean;
  onToggleSelect?: (asset: AssetItem) => void;
  onInsertCanvas?: (asset: AssetItem) => void;
  onRename?: (asset: AssetItem) => void;
  onDelete?: (asset: AssetItem) => void;
}

export default function AssetCard({ asset, selected, onToggleSelect, onInsertCanvas, onRename, onDelete }: Props) {
  const t = useI18nStore((s) => s.t);
  const layerOverlay = useLayerOverlay();
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState({ top: 0, left: 0 });
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const handleMenuEnter = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    if (triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      setMenuPos({ top: rect.bottom + 4, left: rect.right - 160 });
    }
    setMenuOpen(true);
  };
  const handleMenuLeave = () => {
    closeTimer.current = setTimeout(() => setMenuOpen(false), 150);
  };

  const handleInsert = () => {
    onInsertCanvas?.(asset);
  };

  const handleRename = () => {
    setMenuOpen(false);
    onRename?.(asset);
  };

  const handleDownload = async () => {
    setMenuOpen(false);
    const downloadUrl = asset.metadata?.sourceUrl as string;
    if (!downloadUrl) return;
    try {
      const res = await fetch(downloadUrl);
      if (res.ok) {
        const blob = await res.blob();
        const blobUrl = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = blobUrl;
        a.download = asset.name;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(blobUrl);
      }
    } catch {}
  };

  const handleDelete = () => {
    setMenuOpen(false);
    onDelete?.(asset);
  };

  const formatDate = (ts: number) => {
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };

  const menuItemStyle: React.CSSProperties = {
    background: "transparent",
    border: "none",
    cursor: "pointer",
    width: "100%",
    textAlign: "left" as const,
    padding: "6px 12px",
    fontSize: 13,
    color: "var(--canvas-text)",
    borderRadius: 6,
    display: "flex",
    alignItems: "center",
    gap: 8,
  };

  return (
    <div
      className={`relative group rounded-lg border transition-all cursor-pointer ${selected ? "border-blue-500" : "border-white/10 hover:border-white/30"}`}
      style={{
        background: "var(--canvas-bg-elevated)",
        aspectRatio: "1",
        borderColor: selected ? "#1677ff" : undefined,
        borderWidth: selected ? 2 : 1,
      }}
      onClick={(e) => {
        // Only trigger selection when clicking the card body, not menu buttons
        const target = e.target as HTMLElement;
        if (target.closest("button")) return;
        onToggleSelect?.(asset);
      }}
    >
      {/* Selected checkmark */}
      {selected && (
        <div className="absolute top-2 left-2 z-10">
          <CheckCircleFilled style={{ color: "#1677ff", fontSize: 18 }} />
        </div>
      )}

      {/* Cover (overflow-hidden wrapper to clip rounded corners) */}
      <div className="absolute inset-0 rounded-lg overflow-hidden">
        {(() => {
          const meta = asset.metadata as Record<string, unknown> | undefined;
          const sourceUrl = meta?.sourceUrl as string | undefined;
          const coverUrl = meta?.coverUrl as string | undefined;
          const isVideo = !!sourceUrl?.match(/\.(mp4|webm|mov)$/i);

          // Video: show coverUrl thumbnail with play icon overlay
          if (isVideo) {
            const thumbUrl = coverUrl?.includes('/api/files/') ? `${coverUrl}?w=200` : '';
            return (
              <div className="w-full h-full relative">
                {thumbUrl ? (
                  <img src={thumbUrl} alt={asset.name} loading="lazy" className="w-full h-full object-cover" />
                ) : (
                  <div className="w-full h-full bg-black/40" />
                )}
                <div className="absolute inset-0 flex items-center justify-center pointer-events-none group-hover:opacity-0 transition-opacity">
                  <PlayCircleOutlined style={{ fontSize: 28, color: "rgba(255,255,255,0.7)" }} />
                </div>
              </div>
            );
          }
          if (asset.type === "audio") {
            return <div className="w-full h-full flex items-center justify-center text-white/20 text-4xl">🎵</div>;
          }
          const imgUrl = sourceUrl ? (sourceUrl.includes('/api/files/') ? `${sourceUrl}?w=200` : sourceUrl) : '';
          return imgUrl ? (
            <img src={imgUrl} alt={asset.name} loading="lazy" className="w-full h-full object-cover" />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-white/20 text-4xl">🖼</div>
          );
        })()}
      </div>

      {/* Hover overlay — send to canvas */}
      <div className="absolute inset-0 bg-black/0 group-hover:bg-black/50 transition-colors flex items-center justify-center gap-2 opacity-0 group-hover:opacity-100 rounded-lg">
        <Tooltip title={t("asset.send")}>
          <button
            className="w-9 h-9 flex items-center justify-center rounded-full bg-white/20 text-white hover:bg-white/40 transition-colors"
            onClick={(e) => { e.stopPropagation(); handleInsert(); }}
          >
            <PlusOutlined />
          </button>
        </Tooltip>
      </div>

      {/* More menu button + dropdown */}
      <div
        className="absolute top-1 right-1 z-10 opacity-0 group-hover:opacity-100 transition-opacity"
        onMouseEnter={handleMenuEnter}
        onMouseLeave={handleMenuLeave}
      >
        <button
          ref={triggerRef}
          className="w-7 h-7 flex items-center justify-center rounded bg-black/50 text-white/70 hover:text-white hover:bg-black/70 transition-colors"
          onMouseEnter={handleMenuEnter}
        >
          <MoreOutlined />
        </button>

        {menuOpen && createPortal(
          <div
            className="flex flex-col p-2 gap-0.5 rounded-lg shadow-lg border"
            onMouseEnter={handleMenuEnter}
            onMouseLeave={handleMenuLeave}
            style={{
              position: "fixed",
              top: menuPos.top,
              left: menuPos.left,
              background: "var(--canvas-bg)",
              borderColor: "var(--canvas-border)",
              minWidth: 160,
              pointerEvents: "auto",
            }}
          >
            <button
              className="menu-popover-item"
              style={menuItemStyle}
              onClick={handleDownload}
            >
              <DownloadOutlined /> {t("download")}
            </button>
            <button
              className="menu-popover-item"
              style={menuItemStyle}
              onClick={handleRename}
            >
              <EditOutlined /> {t("asset.rename")}
            </button>
            <div style={{ height: 1, background: "var(--canvas-border)", margin: "2px 6px" }} />
            <button
              className="menu-popover-item"
              style={{ ...menuItemStyle, color: "var(--canvas-text-dim)" }}
              onClick={handleDelete}
            >
              <DeleteOutlined /> {t("delete")}
            </button>
          </div>,
          layerOverlay || document.body
        )}
      </div>

      {/* Bottom info bar */}
      <div className="absolute bottom-0 left-0 right-0 px-2 py-1.5 bg-gradient-to-t from-black/80 to-transparent rounded-b-lg">
        <div className="text-white/90 text-xs truncate font-medium">{asset.name}</div>
        <div className="text-white/40 text-[10px]">{formatDate(asset.createdAt)}</div>
      </div>
    </div>
  );
}
