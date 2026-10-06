/**
 * 单个资产卡片。
 * 正方形封面（图片 / 视频抽帧 / 音频波形）底部叠加名称与日期；
 * 右上角为多选勾选框（悬停显示、选中常驻）。
 * 单击卡片本体 = 选中该项（右侧检查器展示详情），双击 = 插入画布；单击勾选框 = 增减多选。
 * 抽屉场景不传选择回调：单击不作为，插入走悬停中央「+」（showInsertButton）/ 双击 / Enter。
 */
"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { PictureOutlined, PlusOutlined, VideoCameraOutlined } from "@/components/ui/AppIcon";
import { PauseCircleFilled, PlayCircleFilled } from "@/components/ui/AppIcon";
import { WaveIcon } from "@/components/ui/AppIcon";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { ASSET_DRAG_TYPE } from "@/features/assets/add-asset";
import type { AssetItem } from "@/features/assets/types";

import { AssetHoverPreview } from "./AssetHoverPreview";

interface Props {
  asset: AssetItem;
  /** 抽屉场景关闭多选与选择能力：单击不作为，插入走悬停「+」/ 双击 / Enter。 */
  selectable?: boolean;
  /** 是否启用悬浮大图预览，保持抽屉既有的快速查看体验。 */
  showHoverPreview?: boolean;
  /** 悬停显示中央「+」插入按钮（抽屉等插入为第一意图的场景）；弹窗管理场景不传。 */
  showInsertButton?: boolean;
  /** 允许拖拽到画布插入（抽屉场景传入）；拖拽数据为 ASSET_DRAG_TYPE + AssetItem JSON。 */
  draggable?: boolean;
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
  showInsertButton = false,
  draggable = false,
  selected,
  selectMode = false,
  onSelect,
  onToggleSelect,
  onInsertCanvas,
}: Props) {
  const { t } = useTranslation();
  const [playing, setPlaying] = useState(false);
  const [dragging, setDragging] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  // 音频无封面图：离屏 ghost 作拖拽图像（setDragImage 不接受 display:none 元素，须真实渲染在视口外）
  const audioGhostRef = useRef<HTMLDivElement | null>(null);

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

  const togglePlay = () => {
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
    if (playing) stopAudio();
  };

  /** Enter / 空格：弹窗内单选，抽屉内插入画布（键盘用户的插入路径）。 */
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
    <Card className={`group gap-0 rounded-lg border-0 bg-transparent p-0 shadow-none transition-all ${dragging ? "opacity-50" : ""}`}>
      <AssetHoverPreview asset={asset} enabled={showHoverPreview && !dragging && Boolean(sourceUrl)}>
        {/* 封面区：Card 只负责容器布局，主选择 / 插入行为由独立 Button 承担。 */}
        <div
          className={`relative aspect-square w-full overflow-hidden rounded-lg border bg-popover transition-colors ${selected ? "border-primary ring-2 ring-primary/20" : "border-border group-hover:border-ring"}`}
          onMouseLeave={handleCardLeave}
        >
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={asset.name}
          aria-pressed={selected}
          draggable={draggable}
          onKeyDown={handleKeyDown}
          onDragStart={(e) => {
            // 封面 <img> 会被浏览器原生拖拽（拖影跟随光标、看似可拖入画布但落点无效）：
            // 非拖拽模式（弹窗）直接取消；抽屉模式才是真正的资产拖拽。
            if (!draggable) {
              e.preventDefault();
              return;
            }
            e.dataTransfer.effectAllowed = "copy";
            e.dataTransfer.setData(ASSET_DRAG_TYPE, JSON.stringify(asset));
            e.dataTransfer.setData("text/plain", asset.sourceUrl ?? asset.name);
            setDragging(true);
            const cover = e.currentTarget.parentElement?.querySelector("img");
            if (cover instanceof HTMLImageElement) {
              e.dataTransfer.setDragImage(cover, cover.offsetWidth / 2, cover.offsetHeight / 2);
            } else if (audioGhostRef.current) {
              e.dataTransfer.setDragImage(audioGhostRef.current, 28, 28);
            }
          }}
          onDragEnd={() => setDragging(false)}
          onClick={(e) => {
            if (selectable) onSelect?.(asset, e.ctrlKey || e.metaKey);
          }}
          onDoubleClick={() => onInsertCanvas?.(asset)}
          className={`absolute inset-0 z-0 size-full rounded-lg p-0 ${draggable ? "cursor-grab active:cursor-grabbing" : "cursor-pointer"}`}
        />

        <div aria-hidden="true" className="pointer-events-none absolute inset-0 z-[1]">
          {isVideo ? (
            <span className="relative block size-full bg-black/40">
              {thumbUrl && (
                <img
                  src={thumbUrl}
                  alt=""
                  loading="lazy"
                  className="size-full object-cover"
                  onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
                />
              )}
              <span className="absolute left-1.5 top-1.5 flex size-6 items-center justify-center rounded bg-black/50">
                <VideoCameraOutlined className="size-3 text-white/80" />
              </span>
            </span>
          ) : isAudio ? (
            <span className="flex size-full items-center justify-center">
              <WaveIcon className="size-8 text-muted-foreground/40" />
            </span>
          ) : thumbUrl ? (
            <img src={thumbUrl} alt="" loading="lazy" className="size-full object-cover" />
          ) : (
            <span className="flex size-full items-center justify-center">
              <PictureOutlined className="size-8 text-muted-foreground/40" />
            </span>
          )}
        </div>

        {/* 名称与日期叠加在封面底部，避免卡片信息把网格行高撑开。 */}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 flex items-end gap-1 bg-black/55 px-2 py-1.5 text-white">
          <div className="min-w-0 flex-1">
            <div className="truncate text-xs font-medium">{asset.name}</div>
            <div className="mt-0.5 text-[10px] text-white/70">{formatDate(asset.createdAt)}</div>
          </div>
          {isAudio && (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={playing ? t("common.stop") : t("common.play")}
              title={playing ? t("common.stop") : t("common.play")}
              className="pointer-events-auto shrink-0 text-white hover:bg-white/15 hover:text-white"
              onClick={togglePlay}
            >
              {playing ? <PauseCircleFilled /> : <PlayCircleFilled />}
            </Button>
          )}
        </div>

        {/* 多选勾选框：未选中仅悬停显示，选中后常驻白色实底（与全局中性 Checkbox 一致） */}
        {selectable && onToggleSelect && (
          <Checkbox
            checked={Boolean(selected)}
            aria-label={asset.name}
            onCheckedChange={() => onToggleSelect(asset)}
            className={`absolute right-1.5 top-1.5 z-20 size-[18px] rounded-[5px] transition-all ${
              selected
                ? "opacity-100 border-primary bg-primary text-primary-foreground"
                : selectMode
                  ? "opacity-100 border-white/60 bg-black/45 text-white hover:border-white"
                  : "opacity-0 border-white/60 bg-black/45 text-white group-hover:opacity-100 hover:border-white"
            }`}
          />
        )}

        {/* 悬停蒙层 + 快速插入：仅插入为第一意图的抽屉场景显示；拖拽期间隐藏，避免与拖拽图像叠加 */}
        {showInsertButton && !dragging && (
          <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-lg bg-black/0 transition-colors group-hover:bg-black/50">
            <Button
              type="button"
              size="icon-lg"
              variant="secondary"
              aria-label={t("asset.addToCanvas")}
              className="pointer-events-auto opacity-0 transition-opacity group-hover:opacity-100"
              onClick={() => onInsertCanvas?.(asset)}
            >
              <PlusOutlined className="size-5" />
            </Button>
          </div>
        )}

        </div>
      </AssetHoverPreview>

      {/* 音频拖拽图像：仅作为 setDragImage 快照源，固定在视口外不影响布局 */}
      {draggable && isAudio && (
        <div
          ref={audioGhostRef}
          aria-hidden
          className="fixed -top-[200px] -left-[200px] flex size-14 items-center justify-center rounded-lg border border-border bg-popover"
        >
          <WaveIcon className="size-7 text-muted-foreground/40" />
        </div>
      )}
    </Card>
  );
}
