/**
 * 资产检查器：右侧常驻的详情 / 选择面板。
 * 单选时展示大图预览、规格 / 位置 / 时间等元信息、可编辑标签与单项操作；
 * 多选时只显示已选数量（批量操作在网格上方的批量条）；
 * 未选中时展示空态提示。
 */
"use client";

import {
  CheckOutlined,
  CloseOutlined,
  CopyOutlined,
  EditOutlined,
  LoadingOutlined,
  PictureOutlined,
  PlusOutlined,
  SelectOutlined,
  VideoCameraOutlined,
} from "@ant-design/icons";
import { Tooltip } from "antd";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import AppButton from "@/components/ui/AppButton";
import { WaveIcon } from "@/components/ui/icons/media/WaveIcon";
import AudioWaveform from "@/features/canvas/nodes/AudioWaveform";
import VideoPlayer from "@/features/canvas/shared/VideoPlayer";
import { ASSET_CATEGORIES } from "@/lib/constants";
import { showGlobalNotification } from "@/lib/global-notification";
import { copyText } from "@/lib/utils/text-export";

import { downloadAsset } from "../download";
import type { AssetItem } from "../types";

interface Props {
  /** 当前选中且仍在列表中的素材；1 项为详情态，多项时检查器留空（批量操作在网格上方批量条）。 */
  assets: AssetItem[];
  /** 单选素材的完整位置路径（根空间 / 祖先链 / 当前文件夹），由父级从文件夹树解析。 */
  folderPath?: string;
  onInsert: (asset: AssetItem) => void;
  /** 标题内联重命名：持久化成功返回 true，失败时输入态保留。 */
  onRenameConfirm: (asset: AssetItem, name: string) => Promise<boolean>;
  onSingleDelete: (asset: AssetItem) => void;
  onBatchMove: () => void;
  onBatchType: () => void;
  /** 持久化标签编辑；返回是否成功，失败时检查器保留输入并由 store 弹错误提示。 */
  onUpdateTags: (asset: AssetItem, tags: string[]) => Promise<boolean>;
  /** 持久化提示词编辑；返回是否成功，失败时保留编辑态。 */
  onUpdatePrompt: (asset: AssetItem, prompt: string) => Promise<boolean>;
}

/** 单个标签的最大长度，与服务端 zod 校验保持一致。 */
const MAX_TAG_LENGTH = 20;

/** 每个素材允许的标签数量上限，与服务端 zod 校验保持一致。 */
const MAX_TAGS = 6;

/** 提示词最大长度，与服务端 assetCreateSchema 的上限保持一致。 */
const MAX_PROMPT_LENGTH = 10000;

/**
 * 标题与重命名输入框的共享盒模型与字体度量。
 * 两种状态是不同元素，必须逐属性一致（尤其 input 默认不继承字体/行高），
 * 切换时文字基线才不会上下跳；头部容器另以固定高度兜底。
 */
const renameBoxStyle = {
  height: 26,
  padding: "2px 8px",
  fontSize: 14,
  fontWeight: 600,
  lineHeight: "20px",
  fontFamily: "inherit",
  boxSizing: "border-box",
  color: "var(--canvas-text)",
} as const;

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
  const [audioDuration, setAudioDuration] = useState(0);

  const thumbUrl = asset.sourceUrl?.includes("/api/files/")
    ? `${asset.sourceUrl}?w=400`
    : asset.sourceUrl;

  return (
    <div
      className="relative w-full rounded-lg overflow-hidden flex items-center justify-center"
      style={{ aspectRatio: "1", maxHeight: 280, background: "#000" }}
    >
      {asset.mediaType === "audio" && asset.sourceUrl ? (
        <AudioWaveform
          url={asset.sourceUrl}
          duration={audioDuration}
          playing={audioPlaying}
          onToggle={setAudioPlaying}
          onReady={setAudioDuration}
        />
      ) : asset.mediaType === "video" && asset.sourceUrl ? (
        // 复用画布节点同款播放器；检查器内不自动播放，用户主动点播放时默认有声
        <VideoPlayer src={asset.sourceUrl} fill autoPlay={false} loop defaultVolume={1} />
      ) : thumbUrl ? (
        // 素材地址是动态/外部 URL，缩放由文件服务的 ?w= 参数负责，不走 next/image
        // eslint-disable-next-line @next/next/no-img-element
        <img src={thumbUrl} alt={asset.name} draggable={false} className="w-full h-full object-cover" />
      ) : (
        asset.mediaType === "video"
          ? <VideoCameraOutlined style={{ fontSize: 40, color: "rgba(255,255,255,0.25)" }} />
          : asset.mediaType === "audio"
            ? <WaveIcon style={{ fontSize: 40, color: "rgba(255,255,255,0.25)" }} />
            : <PictureOutlined style={{ fontSize: 40, color: "rgba(255,255,255,0.25)" }} />
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
  const { t } = useTranslation();
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
    if (asset.tags.length >= MAX_TAGS) return;
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
            className="inspector-edit-input text-xs rounded"
            style={{
              width: 100,
              padding: "2px 8px",
              background: "var(--canvas-bg-elevated)",
              color: "var(--canvas-text)",
            }}
          />
        ) : asset.tags.length >= MAX_TAGS ? (
          <Tooltip title={t("asset.tagLimit", { max: MAX_TAGS })}>
            <span
              className="inline-flex items-center gap-1 rounded text-xs cursor-not-allowed"
              style={{
                padding: "1px 8px",
                border: "1px dashed var(--canvas-border)",
                color: "var(--canvas-text-muted)",
                opacity: 0.4,
              }}
            >
              <PlusOutlined style={{ fontSize: 9 }} />
              {addLabel}
            </span>
          </Tooltip>
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
    if (!asset.prompt || copied) return;
    const ok = await copyText(asset.prompt);
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
            <>
              <Tooltip title={copied ? t("common.copied") : t("common.copy")}>
                <button
                  type="button"
                  onClick={copy}
                  disabled={!asset.prompt}
                  className="inline-flex items-center text-xs transition-colors cursor-pointer disabled:opacity-40 disabled:pointer-events-none"
                  style={{ color: copied ? "var(--canvas-accent)" : "var(--canvas-text-muted)" }}
                  onMouseEnter={(e) => { if (!copied) e.currentTarget.style.color = "var(--canvas-text)"; }}
                  onMouseLeave={(e) => { if (!copied) e.currentTarget.style.color = "var(--canvas-text-muted)"; }}
                >
                  {copied ? <CheckOutlined style={{ fontSize: 11 }} /> : <CopyOutlined style={{ fontSize: 11 }} />}
                </button>
              </Tooltip>
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
            </>
          )}
        </div>
      </div>
      {editing ? (
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
          rows={6}
          className="inspector-edit-input w-full text-xs rounded resize-y"
          style={{
            padding: "8px 10px",
            background: "var(--canvas-bg-elevated)",
            color: "var(--canvas-text)",
            lineHeight: 1.6,
          }}
        />
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
  assets, folderPath,
  onInsert, onRenameConfirm, onSingleDelete,
  onBatchMove, onBatchType,
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
  /** Esc/保存成功导致的卸载性 blur 跳过自动保存；只有真正点击外部才保存 */
  const skipBlurSaveRef = useRef(false);
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
    skipBlurSaveRef.current = false;
    setNameValue(single.name);
    setRenamingId(single.id);
  };
  const exitRename = () => {
    // 输入框随之卸载，标记卸载 blur 不是「点击外部」；选区随元素销毁，无高亮残留
    skipBlurSaveRef.current = true;
    setRenamingId(null);
    setNameValue("");
  };
  const cancelRename = () => {
    if (renameSaving) return;
    exitRename();
  };
  const submitRename = async () => {
    if (!single || renameSaving || renamingId !== single.id) return;
    const name = nameValue.trim();
    if (!name || name === single.name) {
      exitRename();
      return;
    }
    setRenameSaving(true);
    const ok = await onRenameConfirm(single, name);
    setRenameSaving(false);
    if (ok) exitRename();
  };

  return (
    <div className="h-full w-full flex flex-col">
      {/* Header：仅单选时展示标题与内联重命名（清除选择已移至列表工具条行）；
          多选时无需标题，内容区已有「已选 X / 共 Y」；未选中时空态在内容区居中 */}
      {single && (
      <div className="flex items-center gap-2 px-3 pt-3 pb-3 shrink-0" style={{ height: 50 }}>
        {renaming ? (
          <input
            autoFocus
            value={nameValue}
            maxLength={100}
            disabled={renameSaving}
            onChange={(e) => setNameValue(e.target.value)}
            onFocus={(e) => e.target.select()}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void submitRename();
              }
              if (e.key === "Escape") {
                // antd Modal 既可能经 React onKeyDown 冒泡、也可能在 document 原生层监听 Esc
                e.stopPropagation();
                e.preventDefault();
                e.nativeEvent.stopImmediatePropagation();
                cancelRename();
              }
            }}
            // 只有焦点自然移到别处（点击外部）才保存；
            // Esc/保存成功是组件卸载触发的 blur，由 skipBlurSaveRef 排除
            onBlur={() => {
              if (skipBlurSaveRef.current) {
                skipBlurSaveRef.current = false;
                return;
              }
              void submitRename();
            }}
            className="inspector-edit-input flex-1 min-w-0 rounded"
            style={{ ...renameBoxStyle, background: "var(--canvas-bg-elevated)" }}
            aria-label={t("asset.rename")}
          />
        ) : (
          <div
            className="flex-1 min-w-0 flex items-center rounded"
            style={{ ...renameBoxStyle, border: "1px solid transparent" }}
          >
            <Tooltip title={single.name}>
              <span className="truncate" style={{ userSelect: "none" }}>
                {single.name}
              </span>
            </Tooltip>
          </div>
        )}
        {!renaming && (
          <Tooltip title={t("asset.rename")}>
            <button
              type="button"
              onClick={startRename}
              className="shrink-0 flex items-center justify-center w-7 h-7 rounded-md transition-colors cursor-pointer"
              style={{ color: "var(--canvas-text-muted)" }}
              onMouseEnter={(e) => { e.currentTarget.style.background = "var(--canvas-bg-hover)"; e.currentTarget.style.color = "var(--canvas-text)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "var(--canvas-text-muted)"; }}
            >
              <EditOutlined style={{ fontSize: 13 }} />
            </button>
          </Tooltip>
        )}
      </div>
      )}

      <div className={`flex-1 overflow-y-auto px-3 pb-4 min-h-0${single ? "" : " pt-3"}`}>
        {!hasSelection ? (
          // 空态与资产网格空态同款：圆角容器包原图标，替代裸图标
          <div className="h-full flex flex-col items-center justify-center gap-3 pb-10 select-none">
            <div
              className="flex items-center justify-center w-16 h-16 rounded-2xl"
              style={{ background: "var(--canvas-bg-elevated)", border: "1px solid var(--canvas-border)" }}
            >
              <SelectOutlined style={{ fontSize: 26, color: "var(--canvas-text-dim)" }} />
            </div>
            <div className="text-[13px]" style={{ color: "var(--canvas-text-dim)" }}>{t("asset.noDetail")}</div>
            <div className="text-xs text-center px-2" style={{ color: "var(--canvas-text-muted)" }}>
              {t("asset.noDetailHint")}
            </div>
          </div>
        ) : single ? (
          <>
            <Preview key={`preview-${single.id}`} asset={single} />
            <div className="mt-2" style={{ borderTop: "1px solid var(--canvas-border)" }}>
              <MetaRow label={t("asset.typeLabel")} value={typeKey ? t(typeKey) : single.type} />
              {(single.mediaType === "image" || single.mediaType === "video") && single.width > 0 && single.height > 0 && (
                <MetaRow label={t("asset.dimensionsLabel")} value={`${single.width} × ${single.height}`} />
              )}
              {folderPath && (
                <MetaRow label={t("asset.locationLabel")} value={folderPath} />
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
              key={`prompt-${single.id}`}
              asset={single}
              label={t("asset.promptLabel")}
              editLabel={t("asset.editPrompt")}
              emptyHint={t("asset.promptEmpty")}
              placeholder={t("asset.promptPlaceholder")}
              onUpdatePrompt={onUpdatePrompt}
            />
          </>
        ) : null}
      </div>

      {/* 单项操作按钮固定在检查器底部，不随上方内容滚动；多选时批量操作在网格上方批量条 */}
      {single && (
        <div className="shrink-0 px-3 pt-1 pb-4">
          <div className="flex flex-col gap-2">
            <AppButton variant="primary" block onClick={() => onInsert(single)}>
              {t("asset.addToCanvas")}
            </AppButton>
            <div className="flex gap-2">
              <AppButton block onClick={() => downloadAsset(single)}>{t("common.download")}</AppButton>
              <AppButton block onClick={onBatchMove}>{t("asset.moveTo")}</AppButton>
              <AppButton block onClick={onBatchType}>{t("asset.changeType")}</AppButton>
            </div>
            <AppButton variant="danger" block onClick={() => onSingleDelete(single)}>
              {t("common.delete")}
            </AppButton>
          </div>
        </div>
      )}
    </div>
  );
}
