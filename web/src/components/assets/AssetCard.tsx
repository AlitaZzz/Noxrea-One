/**
 * 单个资产卡片。
 * 按资产类型渲染图片 / 视频 / 音频缩略预览（视频悬停自动播放、音频内联试听），
 * 提供选中态与右上角更多菜单（插入画布、重命名、下载、删除）。
 */
"use client";

import { PictureOutlined, VideoCameraOutlined } from "@ant-design/icons";
import { CheckCircleFilled,DeleteOutlined, DownloadOutlined, EditOutlined, MoreOutlined, PauseCircleFilled, PlayCircleFilled, PlusOutlined } from "@ant-design/icons";
import { Tooltip } from "antd";
import { useRef,useState } from "react";
import { createPortal } from "react-dom";

import { WaveIcon } from "@/components/ui/icons/media/WaveIcon";
import { MenuDivider,MenuItem } from "@/components/ui/MenuPopover";
import { useLayerOverlay } from "@/components/ui/modal/layer-context";
import type { AssetItem } from "@/lib/types/assets";
import { useI18nStore } from "@/stores/i18n-store";

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
  const [playing, setPlaying] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

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

  const handleDownload = () => {
    setMenuOpen(false);
    const downloadUrl = asset.metadata?.sourceUrl as string;
    if (!downloadUrl) return;
    const a = document.createElement("a");
    a.href = downloadUrl;
    a.download = asset.name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const handleDelete = () => {
    setMenuOpen(false);
    onDelete?.(asset);
  };

  const stopAudio = () => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
    }
    setPlaying(false);
  };

  const togglePlay = (e: React.MouseEvent) => {
    e.stopPropagation();
    const url = asset.metadata?.sourceUrl as string | undefined;
    if (!url) return;
    if (!audioRef.current) {
      audioRef.current = new Audio(url);
      audioRef.current.addEventListener("ended", () => setPlaying(false));
    }
    if (playing) {
      stopAudio();
    } else {
      audioRef.current.currentTime = 0;
      audioRef.current.play().catch(() => {});
      setPlaying(true);
    }
  };

  const handleCardLeave = () => {
    if (playing) {
      stopAudio();
    }
  };

  const formatDate = (ts: number) => {
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };

  return (
    <div
      className={`relative group rounded-lg border transition-all cursor-pointer ${selected ? "border-blue-500" : "border-white/10 hover:border-white/30"}`}
      style={{
        background: "var(--canvas-bg-elevated)",
        aspectRatio: "1",
        borderColor: selected ? "var(--canvas-accent)" : undefined,
        borderWidth: selected ? 2 : 1,
      }}
      onMouseLeave={handleCardLeave}
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
          <CheckCircleFilled style={{ color: "var(--canvas-accent)", fontSize: 18 }} />
        </div>
      )}

      {/* Cover (overflow-hidden wrapper to clip rounded corners) */}
      <div className="absolute inset-0 rounded-lg overflow-hidden">
        {(() => {
          const meta = asset.metadata as Record<string, unknown> | undefined;
          const sourceUrl = meta?.sourceUrl as string | undefined;
          const coverUrl = meta?.coverUrl as string | undefined;
          const isVideo = asset.mediaType === "video";
          const isAudio = asset.mediaType === "audio";

          // Video: show coverUrl thumbnail with play icon on top-left
          if (isVideo) {
            const thumbUrl = coverUrl?.includes('/api/files/') ? `${coverUrl}?w=200` : '';
            return (
              <div className="w-full h-full relative">
                {thumbUrl ? (
                  <img src={thumbUrl} alt={asset.name} loading="lazy" className="w-full h-full object-cover" />
                ) : (
                  <div className="w-full h-full bg-black/40" />
                )}
                <div className="absolute top-1 left-1 flex items-center justify-center w-6 h-6 rounded bg-black/50">
                  <VideoCameraOutlined style={{ fontSize: 12, color: "rgba(255,255,255,0.8)" }} />
                </div>
              </div>
            );
          }
          if (isAudio) {
            return (
              <div className="w-full h-full flex items-center justify-center">
                <WaveIcon style={{ fontSize: 28, color: "rgba(255,255,255,0.15)" }} />
              </div>
            );
          }
          const imgUrl = sourceUrl ? (sourceUrl.includes('/api/files/') ? `${sourceUrl}?w=200` : sourceUrl) : '';
          return imgUrl ? (
            <img src={imgUrl} alt={asset.name} loading="lazy" className="w-full h-full object-cover" />
          ) : (
            <div className="w-full h-full flex items-center justify-center">
              <PictureOutlined style={{ fontSize: 28, color: "rgba(255,255,255,0.15)" }} />
            </div>
          );
        })()}
      </div>

      {/* Hover overlay — send to canvas */}
      <div className="absolute inset-0 bg-black/0 group-hover:bg-black/50 transition-colors flex items-center justify-center gap-2 opacity-0 group-hover:opacity-100 rounded-lg">
        <button
          className="w-9 h-9 flex items-center justify-center rounded-full bg-white/20 text-white hover:bg-white/40 transition-colors cursor-pointer"
          onClick={(e) => { e.stopPropagation(); handleInsert(); }}
        >
          <PlusOutlined />
        </button>
      </div>

      {/* More menu button + dropdown */}
      <div
        className="absolute top-1 right-1 z-10 opacity-0 group-hover:opacity-100 transition-opacity"
        onMouseEnter={handleMenuEnter}
        onMouseLeave={handleMenuLeave}
      >
        <button
          ref={triggerRef}
          className="w-7 h-7 flex items-center justify-center rounded bg-black/50 text-white/70 hover:text-white hover:bg-black/70 transition-colors cursor-pointer"
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
            <style>{`.menu-popover-item:hover { background: var(--canvas-bg-hover) !important; }`}</style>
            <MenuItem onClick={handleDownload}><DownloadOutlined /> {t("download")}</MenuItem>
            <MenuItem onClick={handleRename}><EditOutlined /> {t("asset.rename")}</MenuItem>
            <MenuDivider />
            <MenuItem dimmed onClick={handleDelete}><DeleteOutlined /> {t("delete")}</MenuItem>
          </div>,
          layerOverlay || document.body
        )}
      </div>

      {/* Bottom info bar */}
      <div className="absolute bottom-0 left-0 right-0 px-2 py-1.5 bg-gradient-to-t from-black/80 to-transparent rounded-b-lg">
        <div className="flex items-center gap-1">
          <div className="text-white/90 text-xs truncate font-medium flex-1 min-w-0">{asset.name}</div>
          {asset.mediaType === "audio" && (
            <button
              className="shrink-0 w-5 h-5 flex items-center justify-center rounded-full text-white/80 hover:text-white hover:bg-white/30 transition-colors cursor-pointer"
              onClick={togglePlay}
            >
              {playing ? <PauseCircleFilled style={{ fontSize: 14 }} /> : <PlayCircleFilled style={{ fontSize: 14 }} />}
            </button>
          )}
        </div>
        <div className="text-white/40 text-[10px]">{formatDate(asset.createdAt)}</div>
      </div>
    </div>
  );
}
