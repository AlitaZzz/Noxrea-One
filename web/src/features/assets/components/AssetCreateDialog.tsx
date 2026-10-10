/**
 * 资产上传弹窗。
 * 支持多文件选择与拖入，限并发上传并展示单文件进度，
 * 宽高 / 时长等元数据由服务端落盘时探测入库，这里只负责上传与批量创建资产。
 */

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { CloseOutlined, PictureOutlined, PlayCircleOutlined, PlusOutlined, VideoCameraOutlined } from "@/components/ui/AppIcon";
import { AssetsIcon } from "@/components/ui/AppIcon";
import { WaveIcon } from "@/components/ui/AppIcon";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogClose, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { CircularProgress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { TreeSelect } from "@/components/ui/tree-select";
import { useAppFeedback } from "@/components/ui/use-app-feedback";
import { ASSET_NAME_MAX_LENGTH } from "@/features/assets/api";
import { normalizeFolderId, ROOT_FOLDER_ID, useFolderTree } from "@/features/assets/hooks/use-folder-tree";
import { splitMatch, useTreeMatchTitle } from "@/features/assets/hooks/use-tree-match";
import type { AddAssetsBatchResult } from "@/features/assets/store";
import type { AssetFolder, AssetType, CreateAssetInput } from "@/features/assets/types";
import { runMediaUpload } from "@/features/canvas/upload";
import { expandAccept } from "@/features/canvas/upload/pick-files";
import { withManagedFileWidth } from "@/lib/file-url";
import { kindOfBlob, loadUploadLimits, type UploadLimits } from "@/lib/upload-formats";
import { isOffline } from "@/lib/utils/upload";

const ASSET_TYPE_OPTIONS: { value: AssetType; labelKey: string }[] = [
  { value: "character", labelKey: "asset.cat.character" },
  { value: "scene", labelKey: "asset.cat.scene" },
  { value: "object", labelKey: "asset.cat.object" },
  { value: "style", labelKey: "asset.cat.style" },
  { value: "audio", labelKey: "asset.cat.audio" },
  { value: "other", labelKey: "asset.cat.other" },
];

interface UploadFile {
  id: string;
  file: File;
  previewUrl: string;
  url: string | null;
  uploadProgress: number;
  errorMessage?: string;
  status: "ready" | "uploading" | "done" | "error";
}


function uid() {
  return `up_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * 由文件名推导资产名。
 * 服务端要求 1–200 字符：去掉扩展名为空（如 ".png"）或超长时兜底，否则整批会因单个字段被拒。
 */
function deriveAssetName(fileName: string): string {
  const base = fileName.replace(/\.[^.]+$/, "").trim();
  const fallback = base || fileName.trim() || "Untitled";
  return fallback.slice(0, ASSET_NAME_MAX_LENGTH);
}

interface Props {
  open: boolean;
  onClose: () => void;
  onCreate: (inputs: CreateAssetInput[]) => Promise<AddAssetsBatchResult>;
  folders?: AssetFolder[];
  /** 打开上传时资产库正在浏览的文件夹（null = 个人资产库根目录），作为保存位置初值 */
  defaultFolderId?: string | null;
}

export default function AssetCreateDialog({ open, onClose, onCreate, folders, defaultFolderId = null }: Props) {
  const { t } = useTranslation();
  const { message } = useAppFeedback();
  const [files, setFiles] = useState<UploadFile[]>([]);
  const [category, setCategory] = useState<AssetType>("other");
  const [saveFolderId, setSaveFolderId] = useState<string | null>(null);
  // 每次打开都同步资产库当前浏览位置（组件常驻挂载，useState 初值只在首次生效）；
  // 渲染期间按 open 变化调整状态（React 官方模式），避免 effect 里同步 setState
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setSaveFolderId(normalizeFolderId(folders, defaultFolderId));
  }
  const [saving, setSaving] = useState(false);
  const [limits, setLimits] = useState<UploadLimits | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // 保存位置文件夹树的搜索态（命中片段高亮，逻辑见 use-tree-match）
  const { query: folderTreeQuery, onSearch: onTreeSearch, reset: resetTreeSearch } = useTreeMatchTitle();

  const updateFile = useCallback((id: string, partial: Partial<UploadFile>) => {
    setFiles((prev) => prev.map((f) => (f.id === id ? { ...f, ...partial } : f)));
  }, []);

  // ---- blob: URL 生命周期 ----
  // 每个 createObjectURL 都会把整份文件常驻内存，直到 revoke 或页面关闭。
  // 这里集中登记，清空列表 / 关闭弹窗 / 组件卸载时统一回收。
  const objectUrlsRef = useRef<Set<string>>(new Set());
  const trackUrl = useCallback((url: string) => {
    objectUrlsRef.current.add(url);
    return url;
  }, []);
  const releaseUrls = useCallback(() => {
    for (const url of objectUrlsRef.current) URL.revokeObjectURL(url);
    objectUrlsRef.current.clear();
  }, []);
  /** 单次使用后即可回收，重复 revoke 无害 */
  const revokeUrl = useCallback((url: string) => {
    URL.revokeObjectURL(url);
    objectUrlsRef.current.delete(url);
  }, []);

  // 弹窗关闭（destroyOnHidden 会卸载）或组件卸载时兜底回收
  useEffect(() => () => releaseUrls(), [releaseUrls]);

  // 格式/体积说明的数据源在服务端（白名单 + MAX_UPLOAD_SIZE_MB），弹窗打开时拉取；
  // 拉取失败只是隐藏说明，不影响上传功能
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    loadUploadLimits()
      .then((d) => { if (!cancelled) setLimits(d); })
      .catch(() => { /* 隐藏说明即可 */ });
    return () => { cancelled = true; };
  }, [open]);

  // ---- 上传：统一走画布上传管道（raw sink，复用并发 / 重试 / 离线判定 / 错误分类）----
  const pendingRef = useRef(0);
  const resolveAllRef = useRef<() => void>(() => {});
  const allDoneRef = useRef<Promise<void>>(Promise.resolve());

  const waitAllDone = useCallback((): Promise<void> => {
    if (pendingRef.current > 0) return allDoneRef.current;
    return Promise.resolve();
  }, []);

  // Clear local state only — used after save (files are now referenced by asset records)
  const clearState = useCallback(() => {
    // 卡片已全部移除，blob: URL 不再被引用，必须显式回收
    releaseUrls();
    setFiles([]);
    setCategory("other");
    setSaveFolderId(normalizeFolderId(folders, defaultFolderId));
    setSaving(false);
    resetTreeSearch();
  }, [defaultFolderId, folders, releaseUrls, resetTreeSearch]);

  // Clear local state — 不删物理文件，去重体系下取消上传时文件继续保留
  const reset = useCallback(() => {
    clearState();
  }, [clearState]);

  const addFiles = useCallback(async (newFiles: FileList | File[]) => {
    const list = Array.from(newFiles);
    if (list.length === 0) return;
    if (isOffline()) {
      message.warning(t("error.upload.offline"));
      return;
    }

    const entries: UploadFile[] = list.map((file) => ({
      id: uid(),
      file,
      previewUrl: trackUrl(URL.createObjectURL(file)),
      url: null,
      uploadProgress: 0,
      status: "ready",
    }));

    // 立即渲染卡片
    setFiles((prev) => [...prev, ...entries]);

    // 不支持的类型直接标红，不送管道（整批不支持时管道会弹全局提示，语义不符）
    const uploadable = entries.filter((e) => kindOfBlob(e.file, e.file.name) !== null);
    const supported = new Set(uploadable);
    for (const e of entries) {
      if (!supported.has(e)) {
        updateFile(e.id, {
          status: "error",
          errorMessage: t("error.upload.unsupported_type"),
        });
      }
    }
    if (uploadable.length === 0) return;

    // 记录本批上传，供 waitAllDone 等待
    const wasIdle = pendingRef.current === 0;
    if (wasIdle) {
      allDoneRef.current = new Promise((r) => { resolveAllRef.current = r; });
    }
    pendingRef.current += 1;

    // 上传交给管道（raw sink：只上传拿 URL，不碰画布；silent 由本组件自行标红/标失败）
    const { settled } = await runMediaUpload({
      items: uploadable.map((e) => ({ blob: e.file, filename: e.file.name })),
      sink: { kind: "raw" },
      source: "upload",
      silent: true,
      onProgress: (index, pct) => {
        updateFile(uploadable[index].id, { status: "uploading", uploadProgress: pct });
      },
    });

    settled
      .then(async ({ results, errors }) => {
        for (let i = 0; i < uploadable.length; i++) {
          const entry = uploadable[i];
          const result = results[i];
          if (!result?.url) {
            updateFile(entry.id, {
              status: "error",
              errorMessage: errors[i]?.message ?? t("file.uploadFailed"),
            });
            continue;
          }
          updateFile(entry.id, { url: result.url, status: "done", uploadProgress: 100 });
        }
      })
      .finally(() => {
        pendingRef.current -= 1;
        if (pendingRef.current === 0) resolveAllRef.current();
      });
  }, [updateFile, message, t, trackUrl]);

  const removeFile = useCallback((id: string) => {
    const target = files.find((f) => f.id === id);
    if (target) {
      revokeUrl(target.previewUrl);
    }
    setFiles((prev) => prev.filter((f) => f.id !== id));
  }, [files, revokeUrl]);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      if (e.dataTransfer.files.length > 0) {
        addFiles(e.dataTransfer.files);
      }
    },
    [addFiles],
  );

  const handleSave = useCallback(async () => {
    setSaving(true);

    // 等待所有上传任务完成
    await waitAllDone();

    // 读取最终状态
    const { doneFiles, errCount } = await new Promise<{
      doneFiles: UploadFile[];
      errCount: number;
    }>((resolve) => {
      setFiles((f) => {
        resolve({
          doneFiles: f.filter((x) => x.status === "done" && x.url),
          errCount: f.filter((x) => x.status === "error").length,
        });
        return f;
      });
    });

    if (doneFiles.length === 0) {
      if (errCount > 0) message.warning(t("asset.batchUploadFailed", { failed: errCount }));
      setSaving(false);
      return;
    }

    const inputs: CreateAssetInput[] = doneFiles.map((f) => {
      const kind = kindOfBlob(f.file, f.file.name);
      return {
        name: deriveAssetName(f.file.name),
        type: category,
        mediaType: kind === "video" ? "video" : kind === "audio" ? "audio" : "image",
        description: "",
        sourceUrl: f.url || undefined,
        folderId: saveFolderId && saveFolderId !== ROOT_FOLDER_ID ? saveFolderId : undefined,
      };
    });

    const result = await onCreate(inputs);

    // 请求失败：保留弹窗与已上传列表，用户可直接重试（错误提示由 store 统一弹出）。
    if (!result.ok) {
      setSaving(false);
      return;
    }

    // 重复来源由后端跳过，成功 / 跳过 / 失败分别提示，避免「整批失败」或「部分丢失」的错觉。
    const saved = result.items.length;
    const skipped = result.skippedCount;
    if (errCount > 0) {
      message.warning(t("asset.batchSaveFailed", { saved, skipped, failed: errCount }));
    } else if (saved === 0 && skipped > 0) {
      message.info(t("asset.batchSaveAllSkipped"));
    } else if (skipped > 0) {
      message.info(t("asset.batchSaveSkipped", { saved, skipped }));
    } else {
      message.success(t("asset.batchSaveDone", { saved }));
    }

    clearState();
    onClose();
  }, [category, clearState, saveFolderId, onCreate, onClose, waitAllDone, message, t]);

  const hasActiveWork = files.some((f) => f.status === "ready" || f.status === "uploading");
  const saveDisabled = files.length === 0 || hasActiveWork || saveFolderId === null;

  // 文件选择器的 accept 直接用服务端白名单扩展名，让选文件阶段就拦住服务端会拒的类型；
  // 约束未加载完成前回退到 MIME 通配 + 常见扩展名兜底
  const fileAccept = useMemo(
    () => limits
      ? Object.values(limits.formats).flat().map((e) => `.${e}`).join(",")
      : expandAccept("image/*,video/*,audio/*"),
    [limits],
  );

  // 保存位置树：与移动弹窗共用 useFolderTree（个人资产库为根 + 普通文件夹递归），
  // 可搜索折叠 TreeSelect，命中片段白色高亮。
  const renderFolderTitle = useCallback((name: string) => {
    const m = splitMatch(name, folderTreeQuery);
    if (!m) return <>{name}</>;
    return (
      <>
        {m.pre}
        <span className="app-tree-match">{m.hit}</span>
        {m.post}
      </>
    );
  }, [folderTreeQuery]);
  const folderTreeData = useFolderTree(folders, renderFolderTitle);

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => { if (!nextOpen) { reset(); onClose(); } }}>
      <DialogContent global className="ui-select-none sm:max-w-none w-[min(920px,calc(100vw-2rem))] gap-0 p-0">
        <DialogHeader className="border-b px-6 py-6">
          <DialogTitle className="flex items-center gap-2">
            <AssetsIcon className="text-muted-foreground" />
            <span>{t("asset.uploadTitle")}</span>
          </DialogTitle>
        </DialogHeader>
        <div className="p-6">
      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept={fileAccept}
        className="hidden"
        onChange={(e) => {
          if (e.target.files?.length) addFiles(e.target.files);
          e.target.value = "";
        }}
      />

      <div className="flex h-[440px]">
        {/* Left — upload zone + preview */}
        <div className="flex-1 flex flex-col min-w-0">
          <div className="flex-1 min-h-0 flex">
            {/* 外层托盘只管边框圆角（overflow hidden 防止滚动内容顶穿圆角），内层滚动 */}
            <div className="flex min-h-0 flex-1 overflow-hidden rounded-md border border-border p-3">
              <div className="flex flex-1 flex-wrap content-start gap-3 overflow-y-auto">
                {/* Drop zone — always first card */}
                <Button
                  type="button"
                  variant="outline"
                  aria-label={t("asset.uploadTitle")}
                  onDrop={handleDrop}
                  onDragOver={(e) => e.preventDefault()}
                  onClick={() => fileInputRef.current?.click()}
                  className="size-[130px] shrink-0 flex-col rounded-md border-dashed p-0"
                >
                  <PlusOutlined className="size-7 text-muted-foreground" />
                </Button>

                {/* Uploaded files */}
                {files.map((f) => {
                  const kind = kindOfBlob(f.file, f.file.name);
                  return (
                  <Card key={f.id} className="group relative size-[130px] shrink-0 gap-0 overflow-hidden rounded-md border-border/50 bg-popover p-0 shadow-none">
                    {kind === "image" ? (
                      <img src={f.url ? withManagedFileWidth(f.url, 200) : f.previewUrl} alt="" draggable={false} className="w-full h-full object-cover" />
                    ) : kind === "video" ? (
                      <div className="w-full h-full relative flex items-center justify-center bg-black/50">
                        {f.url ? (
                          <img
                            src={withManagedFileWidth(f.url, 200)}
                            alt=""
                            draggable={false}
                            className="absolute inset-0 w-full h-full object-cover"
                            onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
                          />
                        ) : null}
                        <PlayCircleOutlined className="relative z-[1] size-7 text-white/70" />
                      </div>
                    ) : (
                      <div className="w-full h-full flex items-center justify-center">
                        <WaveIcon className="size-9 text-white/30" />
                      </div>
                    )}

                    {/* 上传进行中 → 进度圈 */}
                    {f.status === "uploading" && (
                      <div className="absolute inset-0 flex items-center justify-center bg-black/60">
                        {/* 字节发完仍在等服务端落盘，保持进度显示。 */}
                        <CircularProgress
                          value={f.uploadProgress}
                          size={48}
                          className="text-white"
                        />
                      </div>
                    )}

                    {f.status === "error" && (
                      <div className="absolute inset-0 flex items-center justify-center bg-black/60 px-2 text-center text-xs text-destructive-foreground">
                        {f.errorMessage ?? t("file.uploadFailed")}
                      </div>
                    )}

                    {f.status === "done" && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        aria-label={t("common.delete")}
                        className="absolute top-1 right-1 rounded-full bg-transparent p-0 text-white opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 hover:bg-white/15 hover:text-white"
                        onClick={(e) => { e.stopPropagation(); removeFile(f.id); }}
                      >
                        <CloseOutlined className="size-3" />
                      </Button>
                    )}

                    <div className="absolute bottom-0 left-0 right-0 px-1.5 py-1 bg-gradient-to-t from-black/80 to-transparent">
                      <div className="text-white/70 text-[10px] truncate">{f.file.name}</div>
                    </div>
                  </Card>
                  );
                })}
              </div>
            </div>
          </div>
        </div>

        {/* Right — settings panel（无右内边距：控件右缘与 footer 按钮同在 body/footer 的 24px 边距上） */}
        <div className="flex flex-col w-64 shrink-0 pt-4 pl-4 gap-5">
          {/* Save location — 必选：不默认落位，由用户显式选择（个人资产库 = 根目录） */}
          <div>
            <Label className="mb-2 block text-xs text-muted-foreground">
              {t("asset.saveLocation")} <span className="text-destructive">*</span>
            </Label>
          <TreeSelect
              value={saveFolderId}
              onChange={(v) => setSaveFolderId(v ?? null)}
              placeholder={t("asset.saveLocationPlaceholder")}
              searchPlaceholder={t("asset.folderSearchPlaceholder")}
              allowClear
              searchable
              emptyContent={t("common.noData")}
              onSearch={onTreeSearch}
              expandAll
              popupHeight={280}
              nodes={folderTreeData}
            />
          </div>

          {/* Category */}
          <div>
            <Label className="mb-2 block text-xs text-muted-foreground">{t("asset.type")}</Label>
            <Select value={category} onValueChange={(value) => setCategory(value as AssetType)}>
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                {ASSET_TYPE_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value}>{t(option.labelKey)}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        </div>
        </div>
        </div>
        <DialogFooter
          className="border-t px-6 py-4 sm:flex-row sm:items-center sm:justify-between"
        >
          {limits ? (
            <span className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground">
              <span>{t("asset.formatPrefix")}</span>
              {([
                { icon: <PictureOutlined />, label: t("asset.formatGroupImage") },
                { icon: <VideoCameraOutlined />, label: t("asset.formatGroupVideo") },
                { icon: <WaveIcon />, label: t("asset.formatGroupAudio") },
              ]).map((g, i) => (
                <span key={g.label} className="flex items-center gap-1">
                  {i > 0 && <span>/</span>}
                  <span className="text-muted-foreground">{g.icon}</span>
                  {g.label}
                </span>
              ))}
              <span>· {t("asset.formatSize", { limit: limits.maxSizeMb })}</span>
            </span>
          ) : <span />}
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <DialogClose asChild>
              <Button variant="outline">
                {t("common.cancel")}
              </Button>
            </DialogClose>
            <Button loading={saving} disabled={saveDisabled} onClick={handleSave}>
              {t("common.save")}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
