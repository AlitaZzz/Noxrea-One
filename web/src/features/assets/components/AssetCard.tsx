/**
 * 单个资产卡片。
 * 上半部分为正方形封面（图片 / 视频抽帧 / 音频波形），名称与日期排在封面下方；
 * 右上角为多选勾选框（悬停显示、选中常驻）。
 * 单击卡片本体 = 选中该项（右侧检查器展示详情），双击 = 插入画布；单击勾选框 = 增减多选。
 * 抽屉场景不传选择回调，卡片本体点击直接插入画布。
 */
"use client";

import { CheckOutlined, PictureOutlined, VideoCameraOutlined } from "@ant-design/icons";
import { PauseCircleFilled, PlayCircleFilled } from "@ant-design/icons";
import { useEffect, useRef, useState } from "react";

import { WaveIcon } from "@/components/ui/icons/media/WaveIcon";
import type { AssetItem } from "@/features/assets/types";

import { AssetHoverPreview, useAssetHoverPreview } from "./AssetHoverPreview";

interface Props {
  asset: AssetItem;
  /** 抽屉场景关闭多选与选择能力，卡片本体点击直接插入画布。 */
  selectable?: boolean;
  /** 是否启用悬浮大图预览，保持抽屉既有的快速查看体验。 */
  showHoverPreview?: boolean;
  /** 悬浮预览的水平锚点；窄侧栏传入抽屉右缘，让预览显示到侧栏外。 */
  hoverPreviewAnchorX?: number;
  selected?: boolean;
  /** 多选模式：勾选框常驻显示（不再仅悬停出现）。 */
  selectMode?: boolean;
  /** 单击卡片本体：弹窗中为单选（additive=true 即 Ctrl/⌘ 点击时增减）；抽屉不传。 */
  onSelect?: (asset: AssetItem, additive?: boolean) => void;
  /** 单击勾选框：切换该项的多选状态。 */
  onToggleSelect?: (asset: AssetItem) => void;
  onInsertCanvas?: (asset: AssetItem) => void;
}

export default function AssetCard({
  asset,
  selectable = true,
  showHoverPreview = false,
  hoverPreviewAnchorX = 0,
  selected,
  selectMode = false,
  onSelect,
  onToggleSelect,
  onInsertCanvas,
}: Props) {
  const preview = useAssetHoverPreview(hoverPreviewAnchorX);
  const [playing, setPlaying] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // 卡片卸载（分页回收 / 删除）时释放音频元素，避免长列表试听泄漏。
  useEffect(() => () => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.src = "";
      audioRef.current = null;
    }
  }, []);

  const stopAudio = () => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
    }
    setPlaying(false);
  };

  const togglePlay = (e: React.MouseEvent) => {
    e.stopPropagation();
    const url = asset.sourceUrl;
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
    preview.onLeave();
    if (playing) stopAudio();
  };

  /** Enter / 空格：弹窗内单选，抽屉内直接插入画布。 */
  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    if (selectable) onSelect?.(asset);
    else onInsertCanvas?.(asset);
  };
  const formatDate = (ts: number) => {
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };

  const isVideo = asset.mediaType === "video";
  const isAudio = asset.mediaType === "audio";
  const sourceUrl = asset.sourceUrl;
  const thumbUrl = sourceUrl?.includes("/api/files/") ? `${sourceUrl}?w=300` : sourceUrl;

  return (
    <div
      tabIndex={0}
      role="button"
      aria-label={asset.name}
      aria-pressed={selected}
      onKeyDown={handleKeyDown}
      className="group rounded-lg transition-all cursor-pointer outline-none"
      onMouseLeave={handleCardLeave}
      onMouseEnter={(event) => { if (showHoverPreview && sourceUrl) preview.onEnter(asset, event); }}
      onClick={(e) => {
        if (selectable) onSelect?.(asset, e.ctrlKey || e.metaKey);
        else onInsertCanvas?.(asset);
      }}
      onDoubleClick={(e) => {
        // 勾选框 / 音频播放等内部按钮连点会冒泡到这里，不应触发插入
        if (selectable && !(e.target as HTMLElement).closest("button")) onInsertCanvas?.(asset);
      }}
    >
      {/* 封面区 */}
      <div
        className={`relative w-full rounded-lg overflow-hidden border transition-colors ${selected ? "" : "border-white/10 group-hover:border-white/30"}`}
        style={{ aspectRatio: "1", background: "var(--canvas-bg-elevated)", borderColor: selected ? "#fff" : undefined, borderWidth: selected ? 2 : 1 }}
      >
        {isVideo ? (
          <div className="w-full h-full relative bg-black/40">
            {thumbUrl && (
              <img
                src={thumbUrl}
                alt={asset.name}
                loading="lazy"
                className="w-full h-full object-cover"
                onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
              />
            )}
            <div className="absolute top-1.5 left-1.5 flex items-center justify-center w-6 h-6 rounded bg-black/50 pointer-events-none">
              <VideoCameraOutlined style={{ fontSize: 12, color: "rgba(255,255,255,0.8)" }} />
            </div>
          </div>
        ) : isAudio ? (
          <div className="w-full h-full flex items-center justify-center">
            <WaveIcon style={{ fontSize: 32, color: "rgba(255,255,255,0.15)" }} />
          </div>
        ) : thumbUrl ? (
          <img src={thumbUrl} alt={asset.name} loading="lazy" className="w-full h-full object-cover" />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <PictureOutlined style={{ fontSize: 32, color: "rgba(255,255,255,0.15)" }} />
          </div>
        )}

        {/* 多选勾选框：未选中仅悬停显示，选中后常驻白色实底（与全局中性 Checkbox 一致） */}
        {selectable && onToggleSelect && (
          <button
            type="button"
            aria-label={asset.name}
            onClick={(e) => { e.stopPropagation(); onToggleSelect(asset); }}
            className={`absolute top-1.5 right-1.5 z-10 flex items-center justify-center w-[18px] h-[18px] rounded-[5px] border cursor-pointer transition-all ${
              selected
                ? "opacity-100 bg-white border-white"
                : selectMode
                  ? "opacity-100 bg-black/45 border-white/60 hover:border-white"
                  : "opacity-0 group-hover:opacity-100 bg-black/45 border-white/60 hover:border-white"
            }`}
          >
            {selected && <CheckOutlined style={{ fontSize: 11, color: "#1d1d21", fontWeight: 700 }} />}
          </button>
        )}

        {showHoverPreview && (
          <AssetHoverPreview asset={preview.asset} visible={preview.visible} x={preview.x} y={preview.y} />
        )}
      </div>

      {/* 封面下方信息 */}
      <div className="px-1 pt-1.5 pb-1">
        <div className="flex items-center gap-1">
          <div className="text-xs truncate font-medium flex-1 min-w-0" style={{ color: "var(--canvas-text)" }}>{asset.name}</div>
          {isAudio && (
            <button
              type="button"
              className="shrink-0 leading-none"
              style={{ color: "var(--canvas-text-muted)" }}
              onClick={(e) => { e.stopPropagation(); togglePlay(e); }}
            >
              {playing ? <PauseCircleFilled /> : <PlayCircleFilled />}
            </button>
          )}
        </div>
        <div className="text-[10px] mt-0.5" style={{ color: "var(--canvas-text-muted)" }}>{formatDate(asset.createdAt)}</div>
      </div>
    </div>
  );
}
