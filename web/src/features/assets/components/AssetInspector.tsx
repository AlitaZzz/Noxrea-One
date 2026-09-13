/**
 * 资产检查器：选中素材后从右侧滑出的操作面板。
 * 单选时展示大图预览、类型、创建时间与单项操作；
 * 多选时展示已选数量与批量操作（添加到画布 / 移动 / 改类型 / 下载 / 删除）。
 * 未选中时由父级将面板宽度收为 0，本组件只负责有选中态的内容。
 */
"use client";

import { CloseOutlined, PictureOutlined, VideoCameraOutlined } from "@ant-design/icons";
import { PauseCircleFilled, PlayCircleFilled } from "@ant-design/icons";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import AppButton from "@/components/ui/AppButton";
import { WaveIcon } from "@/components/ui/icons/media/WaveIcon";
import { ASSET_CATEGORIES } from "@/lib/constants";

import type { AssetItem } from "../types";

interface Props {
  /** 当前选中且仍在列表中的素材；1 项为详情态，多项为批量态。 */
  assets: AssetItem[];
  totalCount: number;
  allSelected: boolean;
  onClose: () => void;
  onSelectAll: () => void;
  onInsert: (asset: AssetItem) => void;
  onRename: (asset: AssetItem) => void;
  onSingleDelete: (asset: AssetItem) => void;
  onBatchInsert: (assets: AssetItem[]) => void;
  onBatchMove: () => void;
  onBatchType: () => void;
  onBatchDelete: () => void;
}

function downloadAsset(asset: AssetItem) {
  if (!asset.sourceUrl) return;
  const a = document.createElement("a");
  a.href = asset.sourceUrl;
  a.download = asset.name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

function formatDateTime(ts: number) {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function typeLabelKey(type: string): string | undefined {
  return ASSET_CATEGORIES.find((c) => c.key === type)?.labelKey;
}

/** 单项预览：图片 / 视频抽帧 / 音频波形，音频支持就地试听。 */
function Preview({ asset }: { asset: AssetItem }) {
  const [playing, setPlaying] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const togglePlay = () => {
    if (!asset.sourceUrl) return;
    if (!audioRef.current) {
      audioRef.current = new Audio(asset.sourceUrl);
      audioRef.current.addEventListener("ended", () => setPlaying(false));
    }
    if (playing) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
      setPlaying(false);
    } else {
      audioRef.current.currentTime = 0;
      audioRef.current.play().catch(() => {});
      setPlaying(true);
    }
  };

  const thumbUrl = asset.sourceUrl?.includes("/api/files/")
    ? `${asset.sourceUrl}?w=400`
    : asset.sourceUrl;

  return (
    <div
      className="relative w-full rounded-lg overflow-hidden flex items-center justify-center"
      style={{ aspectRatio: "1", background: "#000" }}
    >
      {asset.mediaType === "audio" ? (
        <button
          type="button"
          onClick={togglePlay}
          className="w-full h-full flex flex-col items-center justify-center gap-3"
          style={{ color: "rgba(255,255,255,0.55)" }}
        >
          <WaveIcon style={{ fontSize: 44, color: "rgba(255,255,255,0.25)" }} />
          {playing ? <PauseCircleFilled style={{ fontSize: 22 }} /> : <PlayCircleFilled style={{ fontSize: 22 }} />}
        </button>
      ) : thumbUrl ? (
        <img src={thumbUrl} alt={asset.name} className="w-full h-full object-cover" />
      ) : (
        asset.mediaType === "video"
          ? <VideoCameraOutlined style={{ fontSize: 40, color: "rgba(255,255,255,0.25)" }} />
          : <PictureOutlined style={{ fontSize: 40, color: "rgba(255,255,255,0.25)" }} />
      )}
      {asset.mediaType === "video" && (
        <div className="absolute top-2 left-2 flex items-center justify-center w-6 h-6 rounded bg-black/50 pointer-events-none">
          <VideoCameraOutlined style={{ fontSize: 12, color: "rgba(255,255,255,0.8)" }} />
        </div>
      )}
    </div>
  );
}

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 py-2 text-xs">
      <span style={{ color: "var(--canvas-text-muted)" }}>{label}</span>
      <span className="text-right truncate" style={{ color: "var(--canvas-text)" }}>{value}</span>
    </div>
  );
}

export default function AssetInspector({
  assets, totalCount, allSelected, onClose, onSelectAll,
  onInsert, onRename, onSingleDelete,
  onBatchInsert, onBatchMove, onBatchType, onBatchDelete,
}: Props) {
  const { t } = useTranslation();
  const single = assets.length === 1 ? assets[0] : null;
  const typeKey = single ? typeLabelKey(single.type) : undefined;

  return (
    <div className="h-full flex flex-col" style={{ width: 300 }}>
      {/* Header */}
      <div className="flex items-center gap-2 px-4 pt-4 pb-3 shrink-0">
        <div className="flex-1 min-w-0 text-sm font-semibold truncate" style={{ color: "var(--canvas-text)" }}>
          {single ? single.name : t("asset.selectedN", { count: assets.length })}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="shrink-0 flex items-center justify-center w-7 h-7 rounded-md transition-colors"
          style={{ color: "var(--canvas-text-muted)" }}
          onMouseEnter={(e) => { e.currentTarget.style.background = "var(--canvas-bg-hover)"; e.currentTarget.style.color = "var(--canvas-text)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "var(--canvas-text-muted)"; }}
        >
          <CloseOutlined style={{ fontSize: 13 }} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-4 pb-4 min-h-0">
        {single ? (
          <>
            <Preview asset={single} />
            <div className="mt-2" style={{ borderTop: "1px solid var(--canvas-border)" }}>
              <MetaRow label={t("asset.typeLabel")} value={typeKey ? t(typeKey) : single.type} />
              <MetaRow label={t("asset.createdAtLabel")} value={formatDateTime(single.createdAt)} />
            </div>
            <div className="mt-4 flex flex-col gap-2">
              <AppButton variant="primary" block onClick={() => onInsert(single)}>
                {t("asset.addToCanvas")}
              </AppButton>
              <div className="flex gap-2">
                <AppButton block onClick={() => onRename(single)}>{t("asset.rename")}</AppButton>
                <AppButton block onClick={() => downloadAsset(single)}>{t("common.download")}</AppButton>
              </div>
              <AppButton variant="danger" block onClick={() => onSingleDelete(single)}>
                {t("common.delete")}
              </AppButton>
            </div>
          </>
        ) : (
          <>
            <div className="text-xs pb-3" style={{ color: "var(--canvas-text-muted)" }}>
              {t("asset.selectedOfTotal", { selected: assets.length, total: totalCount })}
            </div>
            <div className="flex flex-col gap-2">
              <AppButton variant="primary" block onClick={() => onBatchInsert(assets)}>
                {t("asset.addToCanvas")}（{assets.length}）
              </AppButton>
              <AppButton block onClick={onBatchMove}>{t("asset.moveTo")}</AppButton>
              <AppButton block onClick={onBatchType}>{t("asset.changeType")}</AppButton>
              <AppButton block onClick={() => assets.forEach(downloadAsset)}>
                {t("common.download")}（{assets.length}）
              </AppButton>
              <div className="my-1" style={{ borderTop: "1px solid var(--canvas-border)" }} />
              <AppButton variant="danger" block onClick={onBatchDelete}>
                {t("common.delete")}（{assets.length}）
              </AppButton>
              <button
                type="button"
                onClick={onSelectAll}
                className="mt-1 text-xs self-center transition-colors"
                style={{ color: "var(--canvas-text-muted)" }}
                onMouseEnter={(e) => { e.currentTarget.style.color = "var(--canvas-text)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.color = "var(--canvas-text-muted)"; }}
              >
                {allSelected ? t("common.deselectAll") : t("common.selectAll")}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
