"use client";

import { UploadOutlined } from "@ant-design/icons";
import { WaveIcon } from "@/components/common/icons/WaveIcon";
import { Handle, type NodeProps, Position } from "@xyflow/react";
import { memo, useCallback, useEffect, useRef, useState } from "react";

import { useEditableTitle } from "@/hooks/use-editable-title";
import { apiUploadWithProgress } from "@/lib/api";
import { AUDIO_NODE_HEIGHT, AUDIO_NODE_WIDTH, NODE_HANDLE_TOP, NODE_TITLE_HEIGHT } from "@/lib/constants";
import AudioWaveform from "./AudioWaveform";
import { EventNames } from "@/lib/event-names";
import { isGenerating, NODE_TYPE, type AudioNode as AudioNodeType, type AudioNodeData } from "@/lib/types";
import { NODE_TYPE_COLOR } from "@/lib/node-colors";
import { markDirtyImmediate, useCanvasStore } from "@/stores/canvas-store";
import { useI18nStore } from "@/stores/i18n-store";

function formatTime(s: number): string {
  if (!s || !isFinite(s)) return "0:00";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

function AudioNode({ id, data, selected }: NodeProps<AudioNodeType>) {
  useI18nStore((s) => s.lang);
  const t = useI18nStore((s) => s.t);
  const [src, setSrc] = useState(data.src || "");
  const [isDragOver, setIsDragOver] = useState(false);
  const [duration, setDuration] = useState(data.duration || 0);
  const [playing, setPlaying] = useState(false);

  // Sync local src/duration when data changes externally (e.g. from undo/clear),
  // adjusted during render to avoid cascading renders.
  const [prevDataSrc, setPrevDataSrc] = useState(data.src || "");
  if (data.src !== prevDataSrc) {
    setPrevDataSrc(data.src);
    setSrc(data.src || "");
    setDuration(data.duration || 0);
  }

  const handleAudioReady = useCallback((d: number) => {
    setDuration(d || 0);
    // 回填 duration 到节点数据，供标题栏显示
    useCanvasStore.getState().updateNodeData(
      id,
      { duration: d || 0 } as Partial<AudioNodeData>,
      undefined,
      { skipHistory: true }
    );
  }, [id]);

  const handleFile = useCallback(
    async (file: File) => {
      if (!file.type.startsWith("audio/")) return;

      // 生成本次上传的版本标记，防止异步回调竞态（与 VideoNode 一致）
      const uploadVersion = Date.now();
      const store = useCanvasStore.getState();
      const nodeBefore = store.nodes.find((n) => n.id === id);
      if (nodeBefore) {
        store.updateNodeData(
          id,
          { upload: { uploading: true, progress: 0, version: uploadVersion } },
          undefined,
          { skipHistory: true }
        );
      }

      try {
        const formData = new FormData();
        formData.append("file", file);
        const json = await apiUploadWithProgress<{ url: string }>(
          "/api/files/upload?category=audios",
          formData,
          (pct) => {
            useCanvasStore.getState().updateNodeData(
              id,
              { upload: { uploading: true, progress: pct, version: uploadVersion } },
              undefined,
              { skipHistory: true }
            );
          }
        );
        if (json.code === 200 && json.data?.url) {
          const url = json.data.url;
          const s = useCanvasStore.getState();
          const currentNode = s.nodes.find((n) => n.id === id);
          if (!currentNode) return;
          if ((currentNode.data as AudioNodeData).upload?.version !== uploadVersion) return;

          const latestData = currentNode.data as AudioNodeData;
          // 上传完成：清空 upload 状态，写回 src/label/alt
          window.dispatchEvent(
            new CustomEvent(EventNames.NODE_UPDATE_DATA, {
              detail: {
                nodeId: id,
                data: {
                  ...latestData,
                  src: url,
                  label: file.name,
                  alt: file.name,
                  upload: undefined,
                },
                style: { width: AUDIO_NODE_WIDTH, height: AUDIO_NODE_HEIGHT },
                immediate: true,
              },
            })
          );
        } else {
          const s = useCanvasStore.getState();
          const currentNode = s.nodes.find((n) => n.id === id);
          if (currentNode && (currentNode.data as AudioNodeData).upload?.version === uploadVersion) {
            s.updateNodeData(id, { upload: undefined }, undefined, { skipHistory: true });
          }
        }
      } catch (e) {
        console.error("Audio upload failed:", e);
        const s = useCanvasStore.getState();
        const currentNode = s.nodes.find((n) => n.id === id);
        if (currentNode && (currentNode.data as AudioNodeData).upload?.version === uploadVersion) {
          s.updateNodeData(id, { upload: undefined }, undefined, { skipHistory: true });
        }
      }
    },
    [id]
  );

  const handleDownload = useCallback(() => {
    if (!src) return;
    const a = document.createElement("a");
    const sep = src.includes("?") ? "&" : "?";
    const params = new URLSearchParams({ download: "true" });
    if (data.alt) params.set("filename", data.alt);
    a.href = `${src}${sep}${params.toString()}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }, [src, data.alt]);

  const handleClear = useCallback(() => {
    setSrc("");
    setDuration(0);
    useCanvasStore.getState().updateNodeData(
      id,
      {
        src: "",
        label: "",
        alt: "",
        duration: undefined,
        upload: undefined,
      } as Partial<AudioNodeData>,
      { width: AUDIO_NODE_WIDTH, height: AUDIO_NODE_HEIGHT }
    );
    markDirtyImmediate();
  }, [id]);

  // Listen for node action events from NodeToolbar
  useEffect(() => {
    function onNodeAction(e: Event) {
      const detail = (e as CustomEvent).detail;
      if (detail.nodeId !== id) return;
      switch (detail.action) {
        case "download":
          handleDownload();
          break;
        case "clear":
          handleClear();
          break;
      }
    }
    window.addEventListener(EventNames.CANVAS_NODE_ACTION, onNodeAction);
    return () => window.removeEventListener(EventNames.CANVAS_NODE_ACTION, onNodeAction);
  }, [id, handleDownload, handleClear]);

  const { editing: editingTitle, draft: titleDraft, setDraft: setTitleDraft, handleDblClick: handleTitleDblClick, handleSave: handleTitleSave } =
    useEditableTitle(id, data.alt || data.label || t("audio.node"), { syncAlt: true });

  const hasAudio = src && src.length > 0;
  const fileInputRef = useRef<HTMLInputElement>(null);

  return (
    <div className="group relative w-full h-full flex flex-col" style={{ width: AUDIO_NODE_WIDTH, height: AUDIO_NODE_HEIGHT }}>
      {/* 拖入连接点 */}
      <Handle id="in" type="target" position={Position.Left} style={{ width: 10, height: 10, background: NODE_TYPE_COLOR[NODE_TYPE.AUDIO], top: NODE_HANDLE_TOP, transform: "translate(-50%, -50%)", zIndex: 10 }} />
      <Handle id="out" type="source" position={Position.Right} style={{ width: 10, height: 10, background: NODE_TYPE_COLOR[NODE_TYPE.AUDIO], top: NODE_HANDLE_TOP, transform: "translate(50%, -50%)", zIndex: 10 }} />

      <div className="flex items-center justify-between px-3 py-1 text-[13px] font-medium text-white/80" style={{ height: NODE_TITLE_HEIGHT, flexShrink: 0 }}>
        {editingTitle ? (
          <span className="flex items-center gap-0.5 flex-1 min-w-0">
            <WaveIcon className="shrink-0" />
            <input
              className="nodrag flex-1 min-w-0 bg-transparent outline-none text-[13px] font-medium text-white/80"
              value={titleDraft}
              onChange={(e) => setTitleDraft(e.target.value)}
              onBlur={handleTitleSave}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleTitleSave();
              }}
              autoFocus
            />
          </span>
        ) : (
          <span className="truncate cursor-default" onDoubleClick={handleTitleDblClick}>
            <WaveIcon className="mr-1" />
            {data.label || data.alt || t("audio.node")}
          </span>
        )}
        {hasAudio && duration > 0 && (
          <span className="text-white/30 text-xs whitespace-nowrap ml-2">{formatTime(duration)}</span>
        )}
      </div>

      <div
        className={`
          node-body flex-1 flex items-center justify-center overflow-hidden rounded-lg relative group/body
          ${selected ? "node-selected" : ""}
          ${isDragOver ? "node-drag-over" : ""}
        `}
        style={{ background: "var(--canvas-bg, #262626)" }}
        onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setIsDragOver(true); }}
        onDragLeave={(e) => { e.preventDefault(); e.stopPropagation(); setIsDragOver(false); }}
        onDrop={(e) => {
          e.preventDefault(); e.stopPropagation(); setIsDragOver(false);
          const file = e.dataTransfer.files?.[0];
          if (file) handleFile(file);
        }}
        onContextMenu={(e) => e.preventDefault()}
      >
        {data.upload?.uploading ? (
          <div className="w-full h-full relative flex flex-col items-center justify-center gap-2 px-8" style={{ background: "var(--canvas-bg)", borderRadius: 8 }}>
            {data.upload?.progress != null ? (
              <div className="w-3/4 h-1.5 bg-white/10 rounded-full overflow-hidden">
                <div className="h-full bg-blue-500 rounded-full transition-all duration-300" style={{ width: `${data.upload.progress}%` }} />
              </div>
            ) : (
              <div className="w-3/4 h-1.5 bg-white/10 rounded-full overflow-hidden">
                <div className="h-full bg-blue-500 rounded-full animate-pulse" style={{ width: "60%" }} />
              </div>
            )}
            <span className="text-sm text-white/70 font-medium">{t("uploading")}</span>
          </div>
        ) : isGenerating(data.taskBinding) ? (
          <div className="w-full h-full relative flex flex-col items-center justify-center gap-2" style={{ background: "var(--canvas-bg)", borderRadius: 8 }}>
            <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
            <span className="text-sm text-white/70 font-medium">{t("generating")}</span>
          </div>
        ) : hasAudio ? (
          <AudioWaveform
            url={src}
            duration={duration}
            playing={playing}
            onToggle={setPlaying}
            onReady={handleAudioReady}
          />
        ) : (
          <div className="flex flex-col items-center justify-center gap-2 p-4 text-white/40">
            <WaveIcon className="text-5xl" />
            <span className="text-base text-center">{t("drop.upload")}</span>
            <button
              className="node-upload-btn nodrag flex items-center gap-2 px-6 py-3 rounded-lg text-base"
              onClick={(e) => { e.stopPropagation(); fileInputRef.current?.click(); }}
            >
              <UploadOutlined className="text-lg" /> {t("upload")}
            </button>
          </div>
        )}
      </div>

      {/* 隐藏的文件选择输入，由工具栏"上传"按钮触发 */}
      <input
        ref={fileInputRef}
        type="file"
        accept="audio/*"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) handleFile(file);
          e.target.value = "";
        }}
      />
    </div>
  );
}

export default memo(AudioNode);
