/**
 * 音频节点（audio-node）渲染组件。
 * 承载音频上传与拖入、生成中状态展示，内嵌 AudioWaveform 波形播放器，
 * 并把解析出的时长回填到节点数据供标题栏显示。
 */
"use client";

import { UploadOutlined } from "@ant-design/icons";
import { Handle, type NodeProps, Position } from "@xyflow/react";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { WaveIcon } from "@/components/ui/icons/media/WaveIcon";
import { markDirtyImmediate, useCanvasStore } from "@/features/canvas/stores/canvas-store";
import { type AudioNode as AudioNodeType, type AudioNodeData } from "@/features/canvas/types";
import { useNodeUpload } from "@/features/canvas/upload";
import { AUDIO_NODE_HEIGHT, AUDIO_NODE_WIDTH, EventNames, isGenerating, NODE_HANDLE_TOP } from "@/lib/constants";
import { sanitizeFileName } from "@/lib/utils/file-name";
import { formatTime } from "@/lib/utils/format";

import AudioWaveform from "./AudioWaveform";
import NodeTitle from "./NodeTitle";
import UploadFailedOverlay from "./UploadFailedOverlay";

function AudioNode({ id, data, selected }: NodeProps<AudioNodeType>) {
  const { t } = useTranslation();
  const [src, setSrc] = useState(data.src || "");

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

  /** 节点内上传 / 替换：走统一上传管道（失败自动回滚并提示） */
  const handleUpload = useNodeUpload(id, { accept: "audio/*" });

  const handleDownload = useCallback(() => {
    if (!src) return;
    const a = document.createElement("a");
    const sep = src.includes("?") ? "&" : "?";
    const params = new URLSearchParams({ download: "true" });
    const fileName = sanitizeFileName(data.label);
    if (fileName) params.set("filename", fileName);
    a.href = `${src}${sep}${params.toString()}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }, [src, data.label]);

  const handleClear = useCallback(() => {
    setSrc("");
    setDuration(0);
    useCanvasStore.getState().updateNodeData(
      id,
      {
        src: "",
        label: "",
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

  const hasAudio = src && src.length > 0;

  return (
    <div className="group relative w-full h-full flex flex-col" style={{ width: AUDIO_NODE_WIDTH, height: AUDIO_NODE_HEIGHT }}>
      {/* 拖入连接点 */}
      <Handle id="in" type="target" position={Position.Left} style={{ top: NODE_HANDLE_TOP, zIndex: 10 }} />
      <Handle id="out" type="source" position={Position.Right} style={{ top: NODE_HANDLE_TOP, zIndex: 10 }} />

      <NodeTitle
        nodeId={id}
        icon={<WaveIcon className="shrink-0" />}
        title={data.label || t("node.audio")}
        trailing={hasAudio && duration > 0 ? formatTime(duration) : null}
      />

      <div
        className={`
          node-body flex-1 flex items-center justify-center overflow-hidden rounded-lg relative group/body
          ${selected ? "node-selected" : ""}
        `}
        style={{ background: "var(--canvas-bg, #262626)" }}
        onContextMenu={(e) => e.preventDefault()}
      >
        {data.upload?.uploading ? (
          <div className="w-full h-full relative flex flex-col items-center justify-center gap-2 px-8" style={{ background: "var(--canvas-bg)", borderRadius: 8 }}>
            {data.upload?.progress != null ? (
              <div className="w-3/4 h-1.5 bg-white/10 rounded-full overflow-hidden">
                <div className="h-full bg-[var(--canvas-success)] rounded-full transition-all duration-300" style={{ width: `${data.upload.progress}%` }} />
              </div>
            ) : (
              <div className="w-3/4 h-1.5 bg-white/10 rounded-full overflow-hidden">
                <div className="h-full bg-[var(--canvas-success)] rounded-full animate-pulse" style={{ width: "60%" }} />
              </div>
            )}
            <span className="text-sm text-white/70 font-medium tabular-nums">
              {t("common.uploading")}
              {data.upload?.progress != null ? ` ${Math.round(data.upload.progress)}%` : ""}
            </span>
          </div>
        ) : data.upload?.error ? (
          <UploadFailedOverlay nodeId={id} error={data.upload.error} previewUrl={data.upload.previewUrl} />
        ) : isGenerating(data.taskBinding) ? (
          <div className="w-full h-full relative flex flex-col items-center justify-center gap-2" style={{ background: "var(--canvas-bg)", borderRadius: 8 }}>
            <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
            <span className="text-sm text-white/70 font-medium">{t("common.generating")}</span>
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
              onClick={(e) => { e.stopPropagation(); void handleUpload(); }}
            >
              <UploadOutlined className="text-lg" /> {t("common.upload")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export default memo(AudioNode);
