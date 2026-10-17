/**
 * 音频节点（audio-node）渲染组件。
 * 承载音频上传与拖入、生成中状态展示，内嵌 AudioWaveform 波形播放器，
 * 并把解析出的时长回填到节点数据供标题栏显示。
 */

"use client";

import { type NodeProps } from "@xyflow/react";
import dynamic from "next/dynamic";
import { memo, useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";

import { UploadOutlined } from "@/components/ui/AppIcon";
import { WaveIcon } from "@/components/ui/AppIcon";
import { Button } from "@/components/ui/button";
import { useAppFeedback } from "@/components/ui/use-app-feedback";
import {
  applyAudioSpeed as applyAudioSpeedApi,
  extractAudioClip as extractAudioClipApi,
  readEditEnvelope,
  toFileKey,
} from "@/features/canvas/api/file-api";
import ConnectionSideRail from "@/features/canvas/controls/ConnectionSideRail";
import { tryApplyAudioSpeedOnClient, tryExtractAudioClipOnClient } from "@/features/canvas/editing/client-media/client-video";
import { resolveBusyLabelKey, useMediaEditTask } from "@/features/canvas/editing/use-media-edit-task";
import { pauseAudio } from "@/features/canvas/shared/audio-playback-registry";
import { markDirtyImmediate, useCanvasStore } from "@/features/canvas/stores/canvas-store";
import { type AudioNode as AudioNodeType, type AudioNodeData } from "@/features/canvas/types";
import { createAudioNodeFromUrl } from "@/features/canvas/upload";
import { useNodeUpload } from "@/features/canvas/upload";
import { useUploadProgress } from "@/features/canvas/upload/upload-progress-store";
import { AUDIO_NODE_HEIGHT, AUDIO_NODE_WIDTH, EventNames, isGenerating } from "@/lib/constants";
import { fileRefUrl } from "@/lib/file-url";
import { downloadManagedFile } from "@/lib/utils/download";
import { formatTime } from "@/lib/utils/format";

import AgentGhostOverlay from "./AgentGhostOverlay";
import BusyOverlay from "./BusyOverlay";
import GeneratingOverlay from "./GeneratingOverlay";
import NodeTitle from "./NodeTitle";
import UploadFailedOverlay from "./UploadFailedOverlay";

const AudioWaveform = dynamic(() => import("./AudioWaveform"), { ssr: false });

function AudioNode({ id, data, selected }: NodeProps<AudioNodeType>) {
  const { t } = useTranslation();
  // Agent 提议-确认的幻影蒙层（删除/整理预览）
  const agentGhost = useCanvasStore((s) => s.agentPreviewNodeIds.includes(id));
  const uploadProgress = useUploadProgress(id);
  const { notification } = useAppFeedback();
  // src / duration 唯一真相是 data（撤销/清除整体替换 data，无需本地镜像与对账）
  const src = data.src || "";
  const duration = data.duration || 0;

  // 本地处理忙浮层（音频片段截取 / 音频变速）。busy 形状与任务编排（守卫 /
  // 取消 / 客户端失败切服务端兜底）统一由 useMediaEditTask 提供
  const { busy, runEditTask, cancelActive, expectSource } = useMediaEditTask(id);
  // 换源替换 / 卸载：中止进行中的本地处理任务
  useEffect(() => () => cancelActive(), [cancelActive, src]);
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

  // 波形就绪：回填 duration 到节点数据（唯一真相），供标题栏与进度显示
  const handleAudioReady = useCallback((d: number) => {
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
    downloadManagedFile(src, data.label);
  }, [src, data.label]);

  /** 片段截取：优先走客户端管线（纯重封装，零解码，specs/client-video-editing.md），
      探测不支持或管线失败自动回退服务端；产物作为派生音频节点连回源节点
      （历史栈策略与视频片段截取一致：addNodes 压一条截取前快照） */
  const handleExtractAudioClip = useCallback(
    async (start: number, end: number) => {
      if (!src) return;
      const audioKey = toFileKey(src);
      if (!audioKey) return;
      runEditTask({
        kind: "audio-clip",
        // 退出截取模式：关闭选区面板（面板卸载即停试听；与 onClose 幂等），
        // 节点进入忙浮层状态
        onAccept: () => useCanvasStore.getState().setAudioClipNodeId(null),
        // 客户端管线：用户取消静默复位；不支持 / 管线失败回退服务端；其余异常向上抛。
        // 产物投影为与服务端响应同形的 url，onSuccess 单一形状消费
        clientTask: async ({ signal, onProgress }) =>
          (await tryExtractAudioClipOnClient(audioKey, { start, end }, { signal, onProgress })).url,
        serverTask: async ({ signal }) => {
          const res = await extractAudioClipApi(audioKey, start, end, signal);
          // data 形状为 { url }：投影出 url 作为 onSuccess 的单一形状
          return (await readEditEnvelope<{ url: string }>(res, signal, {
            notification,
            t,
            errorKey: "error.clip.extract_failed",
            nodeId: id,
          }))?.url;
        },
        onSuccess: (url) => {
          // 源已被替换：旧源的派生产物不再写入
          if (!expectSource(src)) return;
          const rangeLabel = `${formatTime(start)}-${formatTime(end)}`;
          createAudioNodeFromUrl(
            id,
            url,
            t("clip.suffix", { range: rangeLabel }),
            useCanvasStore.getState(),
            { source: "derived" },
          );
          markDirtyImmediate();
        },
        errorKey: "error.clip.extract_failed",
        logLabel: "Audio clip extraction failed:",
      });
    },
    [src, id, notification, t, runEditTask, expectSource],
  );

  /** 变速：优先走客户端管线（解码 + soundtouchjs 时间拉伸 + AAC 编码，
      specs/client-video-editing.md），探测不支持或管线失败自动回退服务端；
      派生音频节点连回源节点 */
  const handleApplyAudioSpeed = useCallback(
    async (speed: number) => {
      if (!src) return;
      const audioKey = toFileKey(src);
      if (!audioKey) return;
      runEditTask({
        kind: "audio-speed",
        // 客户端管线：用户取消静默复位；不支持 / 管线失败回退服务端；其余异常向上抛。
        // 产物投影为与服务端响应同形的 url，onSuccess 单一形状消费
        clientTask: async ({ signal, onProgress }) =>
          (await tryApplyAudioSpeedOnClient(audioKey, speed, { signal, onProgress })).url,
        serverTask: async ({ signal }) => {
          const res = await applyAudioSpeedApi(audioKey, speed, signal);
          // data 形状为 { url }：投影出 url 作为 onSuccess 的单一形状
          return (await readEditEnvelope<{ url: string }>(res, signal, {
            notification,
            t,
            errorKey: "error.speed.failed",
            nodeId: id,
          }))?.url;
        },
        onSuccess: (url) => {
          // 源已被替换：旧源的派生产物不再写入
          if (!expectSource(src)) return;
          const speedLabel = `${Number(speed.toFixed(2))}x`;
          createAudioNodeFromUrl(
            id,
            url,
            t("node.speedSuffix", { speed: speedLabel }),
            useCanvasStore.getState(),
            { source: "derived" },
          );
          markDirtyImmediate();
        },
        errorKey: "error.speed.failed",
        logLabel: "Audio speed change failed:",
      });
    },
    [src, id, notification, t, runEditTask, expectSource],
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
  }, [id, handleDownload, handleApplyAudioSpeed, handleExtractAudioClip]);

  const hasAudio = src && src.length > 0;
  const generating = isGenerating(data.taskBinding);

  return (
    <div
      className="group relative w-full h-full flex flex-col node-tilt"
      style={{ width: AUDIO_NODE_WIDTH, height: AUDIO_NODE_HEIGHT }}
    >
      {/* 拖入连接点 */}
      <ConnectionSideRail side="left" type="target" />
      <ConnectionSideRail side="right" type="source" />

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
          node-surface text-foreground
        `}
        onContextMenu={(e) => e.preventDefault()}
      >
        {agentGhost && <AgentGhostOverlay />}
        {data.upload?.uploading ? (
          <div className="relative h-full w-full flex flex-col items-center justify-center gap-2 px-8">
            {uploadProgress != null ? (
              <div className="w-3/4 h-1.5 rounded-full bg-muted overflow-hidden">
                <div className="h-full bg-primary rounded-full transition-all duration-300" style={{ width: `${uploadProgress}%` }} />
              </div>
            ) : (
              <div className="w-3/4 h-1.5 rounded-full bg-muted overflow-hidden">
                <div className="h-full bg-primary rounded-full animate-pulse" style={{ width: "60%" }} />
              </div>
            )}
            <span className="text-sm text-muted-foreground font-medium tabular-nums">
              {t("common.uploading")}
              {uploadProgress != null ? ` ${Math.round(uploadProgress)}%` : ""}
            </span>
          </div>
        ) : data.upload?.error ? (
          <UploadFailedOverlay nodeId={id} error={data.upload.error} previewUrl={data.upload.previewUrl} />
        ) : generating ? (
          <GeneratingOverlay absolute={false} startedAt={data.taskBinding?.startedAt} />
        ) : hasAudio ? (
          <AudioWaveform
            url={fileRefUrl(src)}
            nodeId={id}
            clipActive={clipActive}
            duration={duration}
            onReady={handleAudioReady}
          />
        ) : (
          <div className="flex flex-col items-center justify-center gap-2 p-4 text-muted-foreground">
            <WaveIcon className="text-5xl" />
            <span className="text-base text-center">{t("drop.upload")}</span>
            <Button
              type="button"
              size="lg"
              variant="secondary"
              className="nodrag px-6"
              onClick={(e) => { e.stopPropagation(); void handleUpload(); }}
            >
              <UploadOutlined className="size-5" /> {t("common.upload")}
            </Button>
          </div>
        )}
        {busy && (
          <BusyOverlay
            label={t(resolveBusyLabelKey(busy.kind))}
            startedAt={busy.startedAt}
            progress={busy.progress}
            onCancel={busy.onCancel}
          />
        )}
      </div>
    </div>
  );
}

export default memo(AudioNode);
