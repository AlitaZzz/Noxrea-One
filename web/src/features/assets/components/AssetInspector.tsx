/**
 * 资产检查器：右侧常驻的详情 / 操作面板。
 * 单选时展示大图预览、规格 / 位置 / 时间等元信息、可编辑标签与单项操作；
 * 多选时展示已选数量与批量操作（添加到画布 / 移动 / 改类型 / 下载 / 删除）；
 * 未选中时展示空态提示。
 */
"use client";

import {
  CheckOutlined,
  CloseOutlined,
  CopyOutlined,
  EditOutlined,
  FileImageOutlined,
  LoadingOutlined,
  PauseCircleFilled,
  PictureOutlined,
  PlayCircleFilled,
  PlusOutlined,
  VideoCameraOutlined,
} from "@ant-design/icons";
import { Tooltip } from "antd";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import AppButton from "@/components/ui/AppButton";
import { WaveIcon } from "@/components/ui/icons/media/WaveIcon";
import VideoPlayer from "@/features/canvas/shared/VideoPlayer";
import { ASSET_CATEGORIES } from "@/lib/constants";
import { showGlobalNotification } from "@/lib/global-notification";
import { copyText } from "@/lib/utils/text-export";

import type { AssetItem } from "../types";

interface Props {
  /** 当前选中且仍在列表中的素材；1 项为详情态，多项为批量态。 */
  assets: AssetItem[];
  totalCount: number;
  allSelected: boolean;
  /** 单选素材所在文件夹的展示名（未分类已本地化），由父级从文件夹树解析。 */
  folderName?: string;
  onClose: () => void;
  onSelectAll: () => void;
  onInsert: (asset: AssetItem) => void;
  /** 标题内联重命名：持久化成功返回 true，失败时输入态保留。 */
  onRenameConfirm: (asset: AssetItem, name: string) => Promise<boolean>;
  onSingleDelete: (asset: AssetItem) => void;
  onBatchInsert: (assets: AssetItem[]) => void;
  onBatchMove: () => void;
  onBatchType: () => void;
  onBatchDelete: () => void;
  /** 持久化标签编辑；返回是否成功，失败时检查器保留输入并由 store 弹错误提示。 */
  onUpdateTags: (asset: AssetItem, tags: string[]) => Promise<boolean>;
  /** 持久化提示词编辑；返回是否成功，失败时保留编辑态。 */
  onUpdatePrompt: (asset: AssetItem, prompt: string) => Promise<boolean>;
}

/** 单个标签的最大长度，与重命名输入一样只做前端截断。 */
const MAX_TAG_LENGTH = 20;

/** 提示词最大长度，与服务端 assetCreateSchema 的上限保持一致。 */
const MAX_PROMPT_LENGTH = 10000;

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
  const [audioPlaying, setAudioPlaying] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const toggleAudio = () => {
    if (!asset.sourceUrl) return;
    if (!audioRef.current) {
      audioRef.current = new Audio(asset.sourceUrl);
      audioRef.current.addEventListener("ended", () => setAudioPlaying(false));
    }
    if (audioPlaying) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
      setAudioPlaying(false);
    } else {
      audioRef.current.currentTime = 0;
      audioRef.current.play().catch(() => {});
      setAudioPlaying(true);
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
          onClick={toggleAudio}
          className="w-full h-full flex flex-col items-center justify-center gap-3 cursor-pointer"
          style={{ color: "rgba(255,255,255,0.55)" }}
        >
          <WaveIcon style={{ fontSize: 44, color: "rgba(255,255,255,0.25)" }} />
          {audioPlaying ? <PauseCircleFilled style={{ fontSize: 22 }} /> : <PlayCircleFilled style={{ fontSize: 22 }} />}
        </button>
      ) : asset.mediaType === "video" && asset.sourceUrl ? (
        // 复用画布节点同款播放器；检查器内不自动播放、默认静音（面板内不应突然出声）
        <VideoPlayer src={asset.sourceUrl} fill autoPlay={false} loop defaultVolume={0} />
      ) : thumbUrl ? (
        // 素材地址是动态/外部 URL，缩放由文件服务的 ?w= 参数负责，不走 next/image
        // eslint-disable-next-line @next/next/no-img-element
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

/** 标签就地编辑：回车添加、点 × 删除；保存期间整块禁用，成功后由父级回写列表。 */
function TagEditor({
  asset,
  label,
  addLabel,
  placeholder,
  removeTitle,
  onUpdateTags,
}: {
  asset: AssetItem;
  label: string;
  addLabel: string;
  placeholder: string;
  removeTitle: string;
  onUpdateTags: Props["onUpdateTags"];
}) {
  const [adding, setAdding] = useState(false);
  const [value, setValue] = useState("");
  const [busy, busySet] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (adding) inputRef.current?.focus();
  }, [adding]);

  const commit = async () => {
    const tag = value.trim();
    if (!tag || busy) return;
    if (asset.tags.some((existing) => existing.toLowerCase() === tag.toLowerCase())) {
      setAdding(false);
      setValue("");
      return;
    }
    busySet(true);
    const ok = await onUpdateTags(asset, [...asset.tags, tag]);
    busySet(false);
    if (ok) {
      setValue("");
      setAdding(false);
    }
  };

  const remove = async (tag: string) => {
    if (busy) return;
    busySet(true);
    await onUpdateTags(asset, asset.tags.filter((existing) => existing !== tag));
    busySet(false);
  };

  const cancel = () => {
    setAdding(false);
    setValue("");
  };

  return (
    <div className="mt-3">
      <div className="text-xs mb-1.5" style={{ color: "var(--canvas-text-muted)" }}>{label}</div>
      <div
        className="flex flex-wrap items-center gap-1.5"
        style={busy ? { opacity: 0.6, pointerEvents: "none" } : undefined}
      >
        {asset.tags.map((tag) => (
          <span
            key={tag}
            className="inline-flex items-center gap-1 rounded text-xs"
            style={{
              padding: "1px 2px 1px 8px",
              background: "var(--canvas-bg-hover)",
              border: "1px solid var(--canvas-border)",
              color: "var(--canvas-text-dim)",
            }}
          >
            <span className="max-w-[150px] truncate">{tag}</span>
            <Tooltip title={removeTitle}>
              <button
                type="button"
                onClick={() => remove(tag)}
                className="flex items-center justify-center w-4 h-4 rounded transition-colors cursor-pointer"
              style={{ color: "var(--canvas-text-muted)" }}
              onMouseEnter={(e) => { e.currentTarget.style.color = "var(--canvas-text)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.color = "var(--canvas-text-muted)"; }}
            >
              <CloseOutlined style={{ fontSize: 9 }} />
            </button>
            </Tooltip>
          </span>
        ))}
        {busy && <LoadingOutlined style={{ fontSize: 12, color: "var(--canvas-accent)" }} />}
        {adding ? (
          <input
            ref={inputRef}
            value={value}
            placeholder={placeholder}
            maxLength={MAX_TAG_LENGTH}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void commit();
              if (e.key === "Escape") cancel();
            }}
            onBlur={cancel}
            className="text-xs rounded outline-none"
            style={{
              width: 100,
              padding: "2px 8px",
              background: "var(--canvas-bg-elevated)",
              border: "1px solid var(--canvas-accent)",
              color: "var(--canvas-text)",
            }}
          />
        ) : (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="inline-flex items-center gap-1 rounded text-xs transition-colors cursor-pointer"
            style={{
              padding: "1px 8px",
              border: "1px dashed var(--canvas-border)",
              color: "var(--canvas-text-muted)",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.borderColor = "var(--canvas-text-muted)";
              e.currentTarget.style.color = "var(--canvas-text)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.borderColor = "var(--canvas-border)";
              e.currentTarget.style.color = "var(--canvas-text-muted)";
            }}
          >
            <PlusOutlined style={{ fontSize: 9 }} />
            {addLabel}
          </button>
        )}
      </div>
    </div>
  );
}

/** 提示词就地查看 / 编辑：只读折行展示，点击编辑后切换为多行输入。 */
function PromptEditor({
  asset,
  label,
  editLabel,
  emptyHint,
  placeholder,
  onUpdatePrompt,
}: {
  asset: AssetItem;
  label: string;
  editLabel: string;
  emptyHint: string;
  placeholder: string;
  onUpdatePrompt: Props["onUpdatePrompt"];
}) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const startEdit = () => {
    setValue(asset.prompt);
    setEditing(true);
  };
  const cancel = () => {
    if (busy) return;
    setEditing(false);
    setValue("");
  };
  const save = async () => {
    if (busy) return;
    const next = value.trim();
    if (next === asset.prompt.trim()) {
      cancel();
      return;
    }
    setBusy(true);
    const ok = await onUpdatePrompt(asset, next);
    setBusy(false);
    if (ok) setEditing(false);
  };
  const copy = async () => {
    // 编辑态复制草稿，只读态复制已保存内容
    const text = editing ? value.trim() : asset.prompt;
    if (!text || copied) return;
    const ok = await copyText(text);
    if (ok) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } else {
      showGlobalNotification().error({ title: t("common.copyFailed"), placement: "bottomRight", duration: 3 });
    }
  };

  return (
    <div className="mt-3">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-xs" style={{ color: "var(--canvas-text-muted)" }}>{label}</span>
        <div className="flex items-center gap-3">
          <Tooltip title={copied ? t("common.copied") : t("common.copy")}>
            <button
              type="button"
              onClick={copy}
              disabled={editing ? !value.trim() : !asset.prompt}
              className="inline-flex items-center text-xs transition-colors cursor-pointer disabled:opacity-40 disabled:pointer-events-none"
              style={{ color: copied ? "var(--canvas-accent)" : "var(--canvas-text-muted)" }}
              onMouseEnter={(e) => { if (!copied) e.currentTarget.style.color = "var(--canvas-text)"; }}
              onMouseLeave={(e) => { if (!copied) e.currentTarget.style.color = "var(--canvas-text-muted)"; }}
            >
              {copied ? <CheckOutlined style={{ fontSize: 11 }} /> : <CopyOutlined style={{ fontSize: 11 }} />}
            </button>
          </Tooltip>
          {editing ? (
            <>
              <Tooltip title={t("common.save")}>
                <button
                  type="button"
                  onClick={save}
                  disabled={busy}
                  className="inline-flex items-center text-xs transition-colors cursor-pointer disabled:opacity-40 disabled:pointer-events-none"
                  style={{ color: "var(--canvas-accent)" }}
                >
                  {busy ? <LoadingOutlined style={{ fontSize: 11 }} /> : <CheckOutlined style={{ fontSize: 12 }} />}
                </button>
              </Tooltip>
              <Tooltip title={t("common.cancel")}>
                <button
                  type="button"
                  onClick={cancel}
                  disabled={busy}
                  className="inline-flex items-center text-xs transition-colors cursor-pointer disabled:opacity-40 disabled:pointer-events-none"
                  style={{ color: "var(--canvas-text-muted)" }}
                  onMouseEnter={(e) => { e.currentTarget.style.color = "var(--canvas-text)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.color = "var(--canvas-text-muted)"; }}
                >
                  <CloseOutlined style={{ fontSize: 11 }} />
                </button>
              </Tooltip>
            </>
          ) : (
            <button
              type="button"
              onClick={startEdit}
              className="inline-flex items-center gap-1 text-xs transition-colors cursor-pointer"
              style={{ color: "var(--canvas-text-muted)" }}
              onMouseEnter={(e) => { e.currentTarget.style.color = "var(--canvas-text)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.color = "var(--canvas-text-muted)"; }}
            >
              <EditOutlined style={{ fontSize: 10 }} />
              {editLabel}
            </button>
          )}
        </div>
      </div>
      {editing ? (
        <>
          <textarea
            autoFocus
            value={value}
            maxLength={MAX_PROMPT_LENGTH}
            disabled={busy}
            placeholder={placeholder}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") cancel();
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void save();
            }}
            rows={5}
            className="w-full text-xs rounded outline-none resize-y"
            style={{
              padding: "6px 8px",
              background: "var(--canvas-bg-elevated)",
              border: "1px solid var(--canvas-accent)",
              color: "var(--canvas-text)",
              lineHeight: 1.5,
            }}
          />
        </>
      ) : (
        <div
          className="text-xs rounded whitespace-pre-wrap break-words"
          style={{
            maxHeight: 120,
            overflowY: "auto",
            padding: "6px 8px",
            background: "var(--canvas-bg-hover)",
            border: "1px solid var(--canvas-border)",
            color: asset.prompt ? "var(--canvas-text-dim)" : "var(--canvas-text-muted)",
            lineHeight: 1.5,
            minHeight: 30,
          }}
        >
          {asset.prompt || emptyHint}
        </div>
      )}
    </div>
  );
}

export default function AssetInspector({
  assets, totalCount, allSelected, folderName, onClose, onSelectAll,
  onInsert, onRenameConfirm, onSingleDelete,
  onBatchInsert, onBatchMove, onBatchType, onBatchDelete,
  onUpdateTags, onUpdatePrompt,
}: Props) {
  const { t } = useTranslation();
  const single = assets.length === 1 ? assets[0] : null;
  const typeKey = single ? typeLabelKey(single.type) : undefined;
  const hasSelection = assets.length > 0;

  // 标题内联重命名；切换选中素材时（render 阶段检测 id 变化）退出编辑态，
  // 避免输入框绑定到已切换的对象。
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [nameValue, setNameValue] = useState("");
  const [renameSaving, setRenameSaving] = useState(false);
  const [trackedId, setTrackedId] = useState(single?.id);
  if (trackedId !== single?.id) {
    setTrackedId(single?.id);
    setRenamingId(null);
    setNameValue("");
    setRenameSaving(false);
  }
  const renaming = single != null && renamingId === single.id;

  const startRename = () => {
    if (!single) return;
    setNameValue(single.name);
    setRenamingId(single.id);
  };
  const cancelRename = () => {
    if (renameSaving) return;
    setRenamingId(null);
    setNameValue("");
  };
  const submitRename = async () => {
    if (!single || renameSaving) return;
    const name = nameValue.trim();
    if (!name || name === single.name) {
      cancelRename();
      return;
    }
    setRenameSaving(true);
    const ok = await onRenameConfirm(single, name);
    setRenameSaving(false);
    if (ok) setRenamingId(null);
  };

  return (
    <div className="h-full flex flex-col" style={{ width: 300 }}>
      {/* Header：未选中时整个隐藏（空态提示已在内容区居中展示）；
          单选重命名时标题位直接变为内联输入框 */}
      {hasSelection && (
      <div className="flex items-center gap-2 px-3 pt-4 pb-3 shrink-0">
        {renaming && single ? (
          <input
            autoFocus
            value={nameValue}
            maxLength={100}
            disabled={renameSaving}
            onChange={(e) => setNameValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submitRename();
              if (e.key === "Escape") cancelRename();
            }}
            onBlur={cancelRename}
            className="flex-1 min-w-0 text-sm font-semibold rounded outline-none"
            style={{
              padding: "2px 8px",
              background: "var(--canvas-bg-elevated)",
              border: "1px solid var(--canvas-accent)",
              color: "var(--canvas-text)",
            }}
          />
        ) : (
          <div className="flex-1 min-w-0 text-sm font-semibold truncate" style={{ color: "var(--canvas-text)" }}>
            {single ? single.name : t("asset.selectedN", { count: assets.length })}
          </div>
        )}
        <Tooltip title={t("asset.clearSelection")}>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 flex items-center justify-center w-7 h-7 rounded-md transition-colors cursor-pointer"
            style={{ color: "var(--canvas-text-muted)" }}
            onMouseEnter={(e) => { e.currentTarget.style.background = "var(--canvas-bg-hover)"; e.currentTarget.style.color = "var(--canvas-text)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "var(--canvas-text-muted)"; }}
          >
            <CloseOutlined style={{ fontSize: 13 }} />
          </button>
        </Tooltip>
      </div>
      )}

      <div className="flex-1 overflow-y-auto px-3 pb-4 min-h-0">
        {!hasSelection ? (
          <div className="h-full flex flex-col items-center justify-center gap-2 pb-10">
            <FileImageOutlined style={{ fontSize: 36, color: "var(--canvas-text-muted)", opacity: 0.5 }} />
            <div className="text-sm" style={{ color: "var(--canvas-text-muted)" }}>{t("asset.noDetail")}</div>
            <div className="text-xs text-center px-2" style={{ color: "var(--canvas-text-muted)", opacity: 0.7 }}>
              {t("asset.noDetailHint")}
            </div>
          </div>
        ) : single ? (
          <>
            <Preview asset={single} />
            <div className="mt-2" style={{ borderTop: "1px solid var(--canvas-border)" }}>
              <MetaRow label={t("asset.typeLabel")} value={typeKey ? t(typeKey) : single.type} />
              {(single.mediaType === "image" || single.mediaType === "video") && single.width > 0 && single.height > 0 && (
                <MetaRow label={t("asset.dimensionsLabel")} value={`${single.width} × ${single.height}`} />
              )}
              {folderName && (
                <MetaRow label={t("asset.locationLabel")} value={folderName} />
              )}
              <MetaRow label={t("asset.createdAtLabel")} value={formatDateTime(single.createdAt)} />
              <MetaRow label={t("asset.updatedAtLabel")} value={formatDateTime(single.updatedAt)} />
            </div>
            <TagEditor
              asset={single}
              label={t("asset.tagsLabel")}
              addLabel={t("asset.addTag")}
              placeholder={t("asset.tagPlaceholder")}
              removeTitle={t("asset.removeTag")}
              onUpdateTags={onUpdateTags}
            />
            <PromptEditor
              key={single.id}
              asset={single}
              label={t("asset.promptLabel")}
              editLabel={t("asset.editPrompt")}
              emptyHint={t("asset.promptEmpty")}
              placeholder={t("asset.promptPlaceholder")}
              onUpdatePrompt={onUpdatePrompt}
            />
            <div className="mt-4 flex flex-col gap-2">
              <AppButton variant="primary" block onClick={() => onInsert(single)}>
                {t("asset.addToCanvas")}
              </AppButton>
              <div className="flex gap-2">
                {renaming ? (
                  <AppButton
                    block
                    variant="primary"
                    loading={renameSaving}
                    onClick={submitRename}
                    // 阻止输入框先 blur 取消编辑，导致点击保存按钮无效
                    onMouseDown={(e) => e.preventDefault()}
                  >
                    {t("common.save")}
                  </AppButton>
                ) : (
                  <AppButton block onClick={startRename}>{t("asset.rename")}</AppButton>
                )}
                <AppButton block onClick={() => downloadAsset(single)}>{t("common.download")}</AppButton>
              </div>
              {/* 移动 / 改类型复用批量弹窗：单选时集合中只有当前素材 */}
              <div className="flex gap-2">
                <AppButton block onClick={onBatchMove}>{t("asset.moveTo")}</AppButton>
                <AppButton block onClick={onBatchType}>{t("asset.changeType")}</AppButton>
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
                className="mt-1 text-xs self-center transition-colors cursor-pointer"
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
