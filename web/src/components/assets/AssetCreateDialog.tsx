/**
 * 资产上传弹窗。
 * 支持多文件选择与拖入，限并发上传并展示单文件进度，
 * 自动提取图片 / 视频尺寸与视频封面，最后按所选分类与文件夹批量创建资产。
 */
"use client";

import { CloseOutlined, PlayCircleOutlined, PlusOutlined } from "@ant-design/icons";
import { App, Button,Progress, Select } from "antd";
import { type ReactNode,useCallback, useEffect, useRef, useState } from "react";

import AppModal from "@/components/ui/AppModal";
import { WaveIcon } from "@/components/ui/icons/media/WaveIcon";
import ModalButton from "@/components/ui/ModalButton";
import { apiUpload, apiUploadWithProgress, captureFrame } from "@/lib/api";
import type { AssetFolder, AssetType, CreateAssetInput } from "@/lib/types/assets";
import { useI18nStore } from "@/stores/i18n-store";

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
  coverUrl?: string;
  uploadProgress: number;
  status: "ready" | "processing" | "uploading" | "done" | "error";
  width: number;
  height: number;
}

const MAX_CONCURRENCY = 3;

function uid() {
  return `up_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}

function extOf(name: string) {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
}

function isImage(file: File) {
  if (file.type.startsWith("image/")) return true;
  return ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"].includes(extOf(file.name));
}
function isVideo(file: File) {
  if (file.type.startsWith("video/")) return true;
  return ["mp4", "webm", "mov", "avi", "mkv", "m4v"].includes(extOf(file.name));
}
function isAudio(file: File) {
  if (file.type.startsWith("audio/")) return true;
  return ["mp3", "wav", "ogg", "m4a", "aac", "flac", "webm"].includes(extOf(file.name));
}

interface UploadResult { url: string; key: string; }

async function uploadFile(file: File, onProgress: (pct: number) => void): Promise<UploadResult> {
  const formData = new FormData();
  formData.append("file", file);
  try {
    const res = await apiUploadWithProgress<UploadResult>("/api/files/upload?category=assets", formData, onProgress);
    return res.data ?? { url: "", key: "" };
  } catch { return { url: "", key: "" }; }
}

interface Props {
  open: boolean;
  onClose: () => void;
  onCreate: (inputs: CreateAssetInput[]) => Promise<void>;
  folders?: AssetFolder[];
}

export default function AssetCreateDialog({ open, onClose, onCreate, folders }: Props) {
  const t = useI18nStore((s) => s.t);
  const { message } = App.useApp();
  const [files, setFiles] = useState<UploadFile[]>([]);
  const [category, setCategory] = useState<AssetType>("other");
  const [saveFolderId, setSaveFolderId] = useState<string | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const updateFile = useCallback((id: string, partial: Partial<UploadFile>) => {
    setFiles((prev) => prev.map((f) => (f.id === id ? { ...f, ...partial } : f)));
  }, []);

  // ---- 统一上传队列（全局并发 MAX_CONCURRENCY）----
  const queueRef = useRef<UploadFile[]>([]);
  const activeRef = useRef(0);
  const resolveAllRef = useRef<() => void>(() => {});
  const allDonePromiseRef = useRef<Promise<void>>(Promise.resolve());
  const scheduleNextRef = useRef<() => void>(() => {});

  // 声明在 scheduleNext 之前，避免互相递归的「声明前访问」。
  const processEntry = useCallback(async (
    entry: UploadFile,
    onUpdate: (id: string, partial: Partial<UploadFile>) => void,
  ) => {
    const { id, file } = entry;
    onUpdate(id, { status: "processing" });

    // 获取图片/视频尺寸（用 Promise.race 包装，超时 5s 不阻塞上传）
    const dimPromise = (async () => {
      try {
        if (isImage(file)) {
          return await new Promise<{ w: number; h: number }>((resolve) => {
            const img = new Image();
            img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
            img.onerror = () => resolve({ w: 0, h: 0 });
            img.src = URL.createObjectURL(file);
          });
        }
        if (isVideo(file)) {
          return await new Promise<{ w: number; h: number }>((resolve) => {
            const v = document.createElement("video");
            v.preload = "metadata";
            v.onloadedmetadata = () => resolve({ w: v.videoWidth, h: v.videoHeight });
            v.onerror = () => resolve({ w: 0, h: 0 });
            v.src = URL.createObjectURL(file);
          });
        }
      } catch { /* ignore */ }
      return { w: 0, h: 0 };
    })();

    const timeoutPromise = new Promise<{ w: number; h: number }>((resolve) =>
      setTimeout(() => resolve({ w: 0, h: 0 }), 5000),
    );

    const [, uploadResult] = await Promise.all([
      // Task 1: 获取尺寸（5s 超时，不阻塞上传）
      Promise.race([dimPromise, timeoutPromise]).then((dims) => {
        if (dims.w > 0) onUpdate(id, { width: dims.w, height: dims.h });
      }),

      // Task 2: 上传原文件
      new Promise<UploadResult>(async (resolve) => {
        try {
          onUpdate(id, { status: "uploading" });
          const result = await uploadFile(file, (pct: number) => {
            onUpdate(id, { uploadProgress: pct });
          });
          resolve(result);
        } catch {
          resolve({ url: "", key: "" });
        }
      }),
    ]);

    if (uploadResult.url) {
      onUpdate(id, { url: uploadResult.url, status: "done", uploadProgress: 100 });

      // For video, capture a frame as cover thumbnail
      if (isVideo(file) && uploadResult.key) {
        (async () => {
          try {
            const res = await captureFrame(uploadResult.key, 0.1);
            if (res.ok) {
              const json = await res.json();
              if (json.data?.url) onUpdate(id, { coverUrl: json.data.url });
            }
          } catch { /* frame capture failure is non-fatal */ }
        })();
      }
    } else {
      onUpdate(id, { status: "error" });
    }
  }, []);

  const scheduleNext = useCallback(() => {
    while (activeRef.current < MAX_CONCURRENCY && queueRef.current.length > 0) {
      const entry = queueRef.current.shift()!;
      activeRef.current++;
      processEntry(entry, updateFile).finally(() => {
        activeRef.current--;
        scheduleNextRef.current();
        if (activeRef.current === 0) {
          resolveAllRef.current();
        }
      });
    }
  }, []);

  useEffect(() => {
    scheduleNextRef.current = scheduleNext;
  }, [scheduleNext]);

  const enqueueUpload = useCallback((entry: UploadFile) => {
    const wasIdle = activeRef.current === 0;
    if (wasIdle) {
      allDonePromiseRef.current = new Promise(r => { resolveAllRef.current = r; });
    }
    queueRef.current.push(entry);
    scheduleNext();
  }, [scheduleNext]);

  const waitAllDone = useCallback((): Promise<void> => {
    if (activeRef.current > 0 || queueRef.current.length > 0) {
      return allDonePromiseRef.current;
    }
    return Promise.resolve();
  }, []);

  // Clear local state — 不删物理文件，去重体系下取消上传时文件继续保留
  const reset = () => {
    clearState();
  };

  // Clear local state only — used after save (files are now referenced by asset records)
  const clearState = () => {
    setFiles([]);
    setCategory("other");
    setSaveFolderId(undefined);
    setSaving(false);
  };

  const addFiles = useCallback(async (newFiles: FileList | File[]) => {
    const entries: UploadFile[] = Array.from(newFiles).map((file) => ({
      id: uid(),
      file,
      previewUrl: URL.createObjectURL(file),
      url: null,
      uploadProgress: 0,
      status: "ready",
      width: 0,
      height: 0,
    }));

    // 立即渲染卡片
    setFiles((prev) => [...prev, ...entries]);

    // 加入统一队列（共享并发池，不等待）
    for (const entry of entries) {
      enqueueUpload(entry);
    }
  }, [enqueueUpload]);

  const removeFile = useCallback((id: string) => {
    const target = files.find((f) => f.id === id);
    if (target) {
      URL.revokeObjectURL(target.previewUrl);
    }
    setFiles((prev) => prev.filter((f) => f.id !== id));
  }, [files]);

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

    if (errCount > 0) {
      message.warning(`${doneFiles.length} files will be saved, ${errCount} files failed`);
    }

    if (doneFiles.length === 0) {
      setSaving(false);
      return;
    }

    const inputs: CreateAssetInput[] = doneFiles.map((f) => ({
      name: f.file.name.replace(/\.[^.]+$/, ""),
      type: category,
      mediaType: isVideo(f.file) ? "video" : isAudio(f.file) ? "audio" : "image",
      width: f.width,
      height: f.height,
      description: "",
      metadata: isVideo(f.file)
        ? { sourceUrl: f.url, coverUrl: f.coverUrl }
        : isAudio(f.file) ? { sourceUrl: f.url } : { sourceUrl: f.url },
      folderId: saveFolderId,
    }));
    await onCreate(inputs);
    clearState();
    onClose();
  }, [category, saveFolderId, onCreate, onClose, waitAllDone]);

  const hasActiveWork = files.some((f) => f.status === "ready" || f.status === "processing" || f.status === "uploading");
  const saveDisabled = files.length === 0 || hasActiveWork;

  return (
    <AppModal
      title={<span style={{ color: "var(--canvas-text)", fontSize: 16, fontWeight: 600 }}>{t("asset.uploadTitle")}</span>}
      open={open}
      onCancel={() => { reset(); onClose(); }}
      footer={null}
      width={780}
      centered
      destroyOnHidden
      className="asset-dialog"
      styles={{
        header: { background: "var(--canvas-bg)" },
        body: { background: "var(--canvas-bg)", padding: 0 },
      }}
      closeIcon={<span style={{ color: "var(--canvas-text-dim)" }}>✕</span>}
    >
      <style>{`
        .asset-dialog .ant-input:hover,
        .asset-dialog .ant-input:focus,
        .upload-drop-zone:hover {
          background: var(--canvas-bg-hover) !important;
        }
        .asset-dialog .ant-select.ant-select { height: 36px !important; }
        .asset-dialog .ant-select-selector.ant-select-selector {
          background: var(--canvas-bg) !important;
          border-color: var(--canvas-border) !important;
          color: var(--canvas-text) !important;
          border-radius: 8px !important;
          font-size: 13px !important;
          height: 36px !important;
        }
      `}</style>
      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept="image/*,video/*,audio/*"
        className="hidden"
        onChange={(e) => {
          if (e.target.files?.length) addFiles(e.target.files);
          e.target.value = "";
        }}
      />

      <div className="flex" style={{ height: 440 }}>
        {/* Left — upload zone + preview */}
        <div className="flex-1 flex flex-col p-4 min-w-0">
          <div
            className="overflow-auto flex-1"
          >
            <div className="flex flex-wrap" style={{ gap: 12 }}>
              {/* Drop zone — always first card */}
              <div
                onDrop={handleDrop}
                onDragOver={(e) => e.preventDefault()}
                onClick={() => fileInputRef.current?.click()}
                className="upload-drop-zone flex items-center justify-center border-2 border-dashed rounded-lg cursor-pointer transition-colors shrink-0"
                style={{
                  borderColor: "var(--canvas-border)",
                  background: "var(--canvas-bg-elevated)",
                  width: 130,
                  height: 130,
                }}
              >
                <PlusOutlined style={{ fontSize: 28, color: "var(--canvas-text-muted)" }} />
              </div>

              {/* Uploaded files */}
              {files.map((f) => (
                <div
                  key={f.id}
                  className="relative group rounded-lg overflow-hidden border border-white/10 shrink-0"
                  style={{ background: "var(--canvas-bg-elevated)", width: 130, height: 130 }}
                >
                {isImage(f.file) ? (
                  <img src={f.url ? `${f.url}?w=200` : f.previewUrl} alt="" className="w-full h-full object-cover" />
                ) : isVideo(f.file) ? (
                  <div className="w-full h-full relative flex items-center justify-center bg-black/50">
                    {f.coverUrl ? (
                      <img src={`${f.coverUrl}?w=200`} alt="" className="absolute inset-0 w-full h-full object-cover" />
                    ) : null}
                    <PlayCircleOutlined style={{ fontSize: 28, color: "rgba(255,255,255,0.7)", position: "relative", zIndex: 1 }} />
                  </div>
                ) : (
                  <div className="w-full h-full flex items-center justify-center">
                    <WaveIcon style={{ fontSize: 36, color: "rgba(255,255,255,0.3)" }} />
                  </div>
                )}

                {/* 上传进行中 → 进度圈 */}
                {(f.status === "uploading" || (f.status === "processing" && f.uploadProgress > 0 && f.uploadProgress < 100)) && (
                  <div className="absolute inset-0 bg-black/60 flex items-center justify-center">
                    <Progress
                      type="circle"
                      percent={f.uploadProgress}
                      size={48}
                      strokeColor="#fff"
                      railColor="rgba(255,255,255,0.2)"
                    />
                  </div>
                )}
                {/* 上传完成但元数据未完成 → 处理中标识 */}
                {f.status === "processing" && f.uploadProgress === 100 && (
                  <div className="absolute inset-0 bg-black/40 flex items-center justify-center">
                    <div className="flex flex-col items-center gap-1">
                      <div className="w-5 h-5 border-2 border-white/60 border-t-transparent rounded-full animate-spin" />
                      <span className="text-white/50 text-[10px]">Processing...</span>
                    </div>
                  </div>
                )}

                {f.status === "error" && (
                  <div className="absolute inset-0 bg-black/60 flex items-center justify-center text-red-400 text-xs">
                    Upload failed
                  </div>
                )}

                {f.status === "done" && (
                  <button
                    className="absolute top-1 right-1 w-5 h-5 flex items-center justify-center rounded-full bg-black/70 text-white/80 transition-colors opacity-0 group-hover:opacity-100 cursor-pointer"
                    onMouseEnter={(e) => (e.currentTarget as HTMLElement).style.background = "var(--canvas-accent)"}
                    onMouseLeave={(e) => (e.currentTarget as HTMLElement).style.background = ""}
                    onClick={(e) => { e.stopPropagation(); removeFile(f.id); }}
                  >
                    <CloseOutlined style={{ fontSize: 10 }} />
                  </button>
                )}

                <div className="absolute bottom-0 left-0 right-0 px-1.5 py-1 bg-gradient-to-t from-black/80 to-transparent">
                  <div className="text-white/70 text-[10px] truncate">{f.file.name}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
        </div>

        {/* Right — settings panel */}
        <div
          className="flex flex-col w-52 shrink-0 border-l p-4 gap-5"
          style={{ borderColor: "var(--canvas-border)" }}
        >
          {/* Save location */}
          <div>
            <label className="block text-xs text-white/40 mb-2">{t("asset.saveLocation")}</label>
            <Select
              value={saveFolderId ?? "__root__"}
              onChange={(v) => setSaveFolderId(v === "__root__" ? undefined : v)}
              getPopupContainer={(t) => t.parentElement || document.body}
              style={{ width: "100%" }}
              options={(() => {
                const opts: { value: string; label: ReactNode }[] = [
                  { value: "__root__", label: <span>{t("asset.space.personal")}</span> },
                ];
                const build = (parentId: string | undefined, depth: number) => {
                  const children = (folders || []).filter(
                    (f) => f.spaceKey === "personal" && (f.parentId || undefined) === parentId,
                  );
                  for (const f of children) {
                    opts.push({
                      value: f.id,
                      label: <span style={{ whiteSpace: "pre" }}>{"  ".repeat(depth + 1) + f.name}</span>,
                    });
                    build(f.id, depth + 1);
                  }
                };
                build(undefined, 0);
                return opts;
              })()}
            />
          </div>

          {/* Category */}
          <div>
            <label className="block text-xs text-white/40 mb-2">{t("asset.type")}</label>
            <Select
              value={category}
              onChange={(v) => setCategory(v)}
              getPopupContainer={(t) => t.parentElement || document.body}
              options={ASSET_TYPE_OPTIONS.map((opt) => ({
                value: opt.value,
                label: <span>{t(opt.labelKey)}</span>,
              }))}
              style={{ width: "100%" }}
            />
          </div>

          <div className="flex-1" />

          {/* Bottom buttons */}
          <div className="flex flex-col gap-2">
            <Button
              block
              onClick={handleSave}
              disabled={saveDisabled} loading={saving}
              style={{
                background: "var(--canvas-text)",
                border: "1px solid var(--canvas-border)",
                color: "var(--canvas-bg)",
                borderRadius: 8, height: 36, fontWeight: 500,
                opacity: saveDisabled ? 0.35 : 1,
              }}
            >
              {t("save")}
            </Button>
            <Button
              block
              onClick={() => { reset(); onClose(); }}
              style={{
                background: "var(--canvas-bg-elevated)",
                border: "1px solid var(--canvas-border)",
                color: "var(--canvas-text)",
                borderRadius: 8, height: 36,
              }}
            >
              {t("cancel")}
            </Button>
          </div>
        </div>
      </div>
    </AppModal>
  );
}
