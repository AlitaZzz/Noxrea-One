/**
 * 音频节点（audio-node）渲染组件。
 * 承载音频上传与拖入、生成中状态展示，内嵌 AudioWaveform 波形播放器，
 * 并把解析出的时长回填到节点数据供标题栏显示。
 */
"use client";

import { UploadOutlined } from "@ant-design/icons";
import { Handle, type NodeProps, Position } from "@xyflow/react";
import { App } from "antd";
import { memo, useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { WaveIcon } from "@/components/ui/icons/media/WaveIcon";
import {
  applyAudioSpeed as applyAudioSpeedApi,
  extractAudioClip as extractAudioClipApi,
  toFileKey,
} from "@/features/canvas/api/file-api";
import { pauseAudio } from "@/features/canvas/shared/audio-playback-registry";
import { notifyActionFailed, notifyNodeBusy } from "@/features/canvas/shared/notify";
import { markDirtyImmediate, useCanvasStore } from "@/features/canvas/stores/canvas-store";
import { type AudioNode as AudioNodeType, type AudioNodeData } from "@/features/canvas/types";
import { createAudioNodeFromUrl } from "@/features/canvas/upload";
import { useNodeUpload } from "@/features/canvas/upload";
import { AUDIO_NODE_HEIGHT, AUDIO_NODE_WIDTH, EventNames, isGenerating, NODE_HANDLE_TOP } from "@/lib/constants";
import { sanitizeFileName } from "@/lib/utils/file-name";
import { formatTime } from "@/lib/utils/format";

import AgentGhostOverlay from "./AgentGhostOverlay";
import AudioWaveform from "./AudioWaveform";
import BusyOverlay from "./BusyOverlay";
import GeneratingOverlay from "./GeneratingOverlay";
import NodeTitle from "./NodeTitle";
import UploadFailedOverlay from "./UploadFailedOverlay";

function AudioNode({ id, data, selected }: NodeProps<AudioNodeType>) {
  const { t } = useTranslation();
  // Agent 提议-确认的幻影蒙层（删除/整理预览）
  const agentGhost = useCanvasStore((s) => s.agentPreviewNodeIds.includes(id));
  const { notification } = App.useApp();
  const [src, setSrc] = useState(data.src || "");

  const [duration, setDuration] = useState(data.duration || 0);
  // 本地处理忙浮层（音频片段截取：ffmpeg 流 copy，通常秒级完成）
  const [busy, setBusy] = useState<{ kind: string; startedAt: number } | null>(null);
  // 片段截取模式：选区操作全部在节点下方的 AudioClipStripPanel 内进行。
  // 打开瞬间的暂停由面板挂载 effect 经注册表执行；这里把 clipActive 下传给
  // 波形组件锁住节点自身的播放按钮与进度拖动，避免与面板循环试听双声叠加
  const clipActive = useCanvasStore((s) => s.audioClipNodeId === id);

  // 取消选中（点画布空白 / 点其他节点）即停止播放——这是取消选中暂停的唯一路径。
  // 放在 effect 里而不是渲染阶段的 setState 调整块：pause() 是对外部媒体系统的
  // 命令式副作用（相邻 prevDataSrc 块的渲染期调整只做 setState，是官方许可的形态）
  useEffect(() => {
    if (!selected) pauseAudio(id);
  }, [selected, id]);

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

  /** 片段截取：服务端音频流 copy 截取 [start, end]，产物作为派生音频节点
      连回源节点（历史栈策略与视频片段截取一致：addNodes 压一条截取前快照） */
  const handleExtractAudioClip = useCallback(
    async (start: number, end: number) => {
      if (!src) return;
      // 变速/上一次截取仍在服务端处理中：面板保持打开、选区原样保留可重试，
      // 这里给出 busy 反馈而不是静默吞掉（面板无法感知节点本地的 busy 态）
      if (busy) {
        notifyNodeBusy(notification, t, id);
        return;
      }
      const audioKey = toFileKey(src);
      if (!audioKey) return;
      setBusy({ kind: "audio-clip", startedAt: Date.now() });
      // 退出截取模式：关闭选区面板（面板卸载即停试听；与 onClose 幂等），
      // 节点进入忙浮层状态
      useCanvasStore.getState().setAudioClipNodeId(null);
      try {
        const res = await extractAudioClipApi(audioKey, start, end);
        const json = await res.json();

        if (!res.ok || !json?.data) {
          // 后端按错误码给出确定结论（范围无效 / 超时等），优先用其本地化文案
          notifyActionFailed(notification, t, json?.error as string | undefined, "error.clip.extract_failed", id);
          return;
        }

        const { url } = json.data as { url: string };
        const rangeLabel = `${formatTime(start)}-${formatTime(end)}`;
        createAudioNodeFromUrl(
          id,
          url,
          t("clip.suffix", { range: rangeLabel }),
          useCanvasStore.getState(),
          { source: "derived" },
        );
        markDirtyImmediate();
      } catch (e) {
        console.error("Audio clip extraction failed:", e);
        notifyActionFailed(notification, t, undefined, "error.clip.extract_failed", id);
      } finally {
        setBusy(null);
      }
    },
    [src, busy, id, notification, t],
  );

  /** 变速：服务端 atempo 重编码（保留音调）生成变速产物，派生音频节点连回源节点 */
  const handleApplyAudioSpeed = useCallback(
    async (speed: number) => {
      if (!src) return;
      // 截取/变速仍在服务端处理中：请求无法排队，必须给反馈而不是静默吞掉
      if (busy) {
        notifyNodeBusy(notification, t, id);
        return;
      }
      const audioKey = toFileKey(src);
      if (!audioKey) return;
      setBusy({ kind: "audio-speed", startedAt: Date.now() });
      try {
        const res = await applyAudioSpeedApi(audioKey, speed);
        const json = await res.json();

        if (!res.ok || !json?.data) {
          notifyActionFailed(notification, t, json?.error as string | undefined, "error.speed.failed", id);
          return;
        }

        const { url } = json.data as { url: string };
        const speedLabel = `${Number(speed.toFixed(2))}x`;
        createAudioNodeFromUrl(
          id,
          url,
          t("node.speedSuffix", { speed: speedLabel }),
          useCanvasStore.getState(),
          { source: "derived" },
        );
        markDirtyImmediate();
      } catch (e) {
        console.error("Audio speed change failed:", e);
        notifyActionFailed(notification, t, undefined, "error.speed.failed", id);
      } finally {
        setBusy(null);
      }
    },
    [src, busy, id, notification, t],
  );

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
        case "apply-audio-speed":
          void handleApplyAudioSpeed(detail.speed as number);
          break;
        case "extract-audio-clip":
          void handleExtractAudioClip(detail.start as number, detail.end as number);
          break;
      }
    }
    window.addEventListener(EventNames.CANVAS_NODE_ACTION, onNodeAction);
    return () => window.removeEventListener(EventNames.CANVAS_NODE_ACTION, onNodeAction);
  }, [id, handleDownload, handleClear, handleApplyAudioSpeed, handleExtractAudioClip]);

  const hasAudio = src && src.length > 0;

  return (
    <div className="group relative w-full h-full flex flex-col" style={{ width: AUDIO_NODE_WIDTH, height: AUDIO_NODE_HEIGHT }}>
      {/* 拖入连接点 */}
      <Handle id="in" type="target" position={Position.Left} style={{ top: NODE_HANDLE_TOP, zIndex: 10 }} />
      <Handle id="out" type="source" position={Position.Right} style={{ top: NODE_HANDLE_TOP, zIndex: 10 }} />

      <NodeTitle
        nodeId={id}
        icon={<WaveIcon className="shrink-0" />}
        title={data.label}
        display={data.label || t("node.audio")}
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
        {agentGhost && <AgentGhostOverlay />}
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
          <GeneratingOverlay absolute={false} startedAt={data.taskBinding?.startedAt} />
        ) : hasAudio ? (
          <AudioWaveform
            url={src}
            nodeId={id}
            clipActive={clipActive}
            duration={duration}
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
        {busy && <BusyOverlay label={t("clip.processing")} startedAt={busy.startedAt} />}
      </div>
    </div>
  );
}

export default memo(AudioNode);
