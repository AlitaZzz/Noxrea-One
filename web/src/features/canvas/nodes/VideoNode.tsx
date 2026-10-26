/**
 * 视频节点（video-node）渲染组件。
 * poster-first 架构（specs/canvas-video-poster-first.md）：静止态渲染首帧海报
 * （/api/files?w= 派生，无 <video> 元素），hover 挂载会话元素播放（原交互逻辑），
 * 播放/编辑面板/忙状态共用会话元素，会话结束即卸载释放解码器。
 */

"use client";

import type { FrameSelection } from "@noxrea/shared";
import { type CropRectPx } from "@noxrea/shared/crop-rect";
import { storageKeyOf } from "@noxrea/shared/url";
import { type NodeProps } from "@xyflow/react";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  PauseIcon,
  PlayIcon,
  ReloadOutlined,
  UploadOutlined,
  VideoCameraOutlined,
} from "@/components/ui/AppIcon";
import { VolumeMuteIcon } from "@/components/ui/AppIcon";
import { VolumeUpIcon } from "@/components/ui/AppIcon";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useAppFeedback } from "@/components/ui/use-app-feedback";
import { useAssetsStore } from "@/features/assets/store";
import {
  captureFrame as captureFrameApi,
  cropVideo as cropVideoApi,
  detachAudio as detachAudioApi,
  type DetachAudioResult,
  extractClip as extractClipApi,
  readCapturedFrame,
  readDetachAudioResult,
  readEditResultKey,
} from "@/features/canvas/api/file-api";
import ConnectionSideRail from "@/features/canvas/controls/ConnectionSideRail";
import {
  tryClipOnClient,
  tryCropOnClient,
  tryDetachAudioOnClient,
} from "@/features/canvas/editing/client-media/client-video";
import { resolveBusyLabelKey, useMediaEditTask } from "@/features/canvas/editing/use-media-edit-task";
import VideoCropPanel from "@/features/canvas/editing/VideoCropPanel";
import { useCanvasVideo } from "@/features/canvas/hooks/use-canvas-video";
import { createEdge } from "@/features/canvas/node-defaults";
import CanvasImage from "@/features/canvas/shared/CanvasImage";
import { acceptsInput } from "@/features/canvas/shared/connection-rules";
import { IDLE_PLAYBACK, type PlaybackMirror } from "@/features/canvas/shared/media-playback";
import MediaPreviewOverlay from "@/features/canvas/shared/MediaPreviewOverlay";
import { notifyActionFailed } from "@/features/canvas/shared/notify";
import { registerVideoElement } from "@/features/canvas/shared/video-playback-registry";
import { markDirtyImmediate, useCanvasStore, withHistoryBatch } from "@/features/canvas/stores/canvas-store";
import type { VideoNode as VideoNodeType, VideoNodeData } from "@/features/canvas/types";
import {
  createAudioNodeFromRef,
  createImageNodeFromRef,
  createVideoNodeFromRef,
  DERIVED_BASE_GAP_Y,
  useNodeUpload,
} from "@/features/canvas/upload";
import { useUploadProgress } from "@/features/canvas/upload/upload-progress-store";
import { DEFAULT_NODE_HEIGHT, EventNames, isGenerating, NODE_TYPE } from "@/lib/constants";
import { fileRefUrl, withManagedFileWidth } from "@/lib/file-url";
import { useElementMirror } from "@/lib/use-element-mirror";
import { useFileAccessUrl } from "@/lib/use-file-access-url";
import { downloadManagedFile } from "@/lib/utils/download";
import { formatBytes, formatTime } from "@/lib/utils/format";
import { AUDIO_DECISION_MIN_TIME, detectAudioTrack, mediaAspect } from "@/lib/utils/media-utils";

import AgentGhostOverlay from "./AgentGhostOverlay";
import BusyOverlay from "./BusyOverlay";
import GeneratingOverlay from "./GeneratingOverlay";
import NodeTitle from "./NodeTitle";
import UploadFailedOverlay from "./UploadFailedOverlay";

interface VideoControlsProps {
  /** 当前会话视频元素（元素身份变化时监听器随之重挂，重试重挂后控件照常工作） */
  video: HTMLVideoElement | null;
  /** 命令式写入通道（seekTo 改 currentTime）；与 video 指向同一元素 */
  videoRef: { current: HTMLVideoElement | null };
  visible: boolean;
  panelOpen: boolean;
  playing: boolean;
  volume: number;
  hasAudio: boolean;
  togglePlay: () => void;
  toggleMute: () => void;
  applyVolume: (value: number) => void;
}

const VideoControls = memo(function VideoControls({
  video,
  videoRef,
  visible,
  panelOpen,
  playing,
  volume,
  hasAudio,
  togglePlay,
  toggleMute,
  applyVolume,
}: VideoControlsProps) {
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);

  useEffect(() => {
    if (!video) return;
    const sync = () => setProgress(video.currentTime || 0);
    const syncDuration = () => {
      setDuration(Number.isFinite(video.duration) ? video.duration : 0);
      sync();
    };
    syncDuration();
    video.addEventListener("timeupdate", sync);
    video.addEventListener("seeked", sync);
    video.addEventListener("loadedmetadata", syncDuration);
    return () => {
      video.removeEventListener("timeupdate", sync);
      video.removeEventListener("seeked", sync);
      video.removeEventListener("loadedmetadata", syncDuration);
    };
  }, [video]);

  const seekTo = useCallback((value: number) => {
    const video = videoRef.current;
    if (!video || !duration) return;
    const time = Math.max(0, Math.min(duration, value));
    video.currentTime = time;
    setProgress(time);
  }, [duration, videoRef]);

  return (
    <div className={`nodrag absolute bottom-4 left-0 right-0 z-10 flex flex-col gap-2 px-2 video-controls-bar ${visible || panelOpen ? "opacity-100" : "opacity-0 group-hover/body:opacity-100"} transition-opacity`}>
      <Slider
        min={0}
        max={duration || 1}
        step={0.01}
        value={[Math.min(progress, duration || 1)]}
        disabled={!duration}
        aria-label="Video progress"
        className="h-3 w-full"
        onPointerDown={(event) => event.stopPropagation()}
        onValueChange={([value]) => seekTo(value)}
      />
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="video-control-btn shrink-0 text-white hover:text-white/80"
            onClick={(event) => { event.stopPropagation(); togglePlay(); }}
            aria-label={playing ? "pause" : "play"}
          >
            {playing ? <PauseIcon className="size-5" /> : <PlayIcon className="size-5" />}
          </Button>
          <span className="text-sm text-white flex-shrink-0 tabular-nums">
            {formatTime(progress)} / {formatTime(duration)}
          </span>
        </div>
        {hasAudio && <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="video-control-btn shrink-0 text-white hover:text-white/80"
            onClick={(event) => { event.stopPropagation(); toggleMute(); }}
            aria-label={volume === 0 ? "unmute" : "mute"}
          >
            {volume === 0 ? <VolumeMuteIcon className="text-xl" /> : <VolumeUpIcon className="text-xl" />}
          </Button>
          <Slider
            min={0}
            max={1}
            step={0.01}
            value={[volume]}
            aria-label="Volume"
            className="h-3 w-20"
            onPointerDown={(event) => event.stopPropagation()}
            onValueChange={([value]) => applyVolume(value)}
          />
        </div>}
      </div>
    </div>
  );
});

function VideoNode({ id, data, selected }: NodeProps<VideoNodeType>) {
  const { t } = useTranslation();
  // Agent 提议-确认的幻影蒙层（删除/整理预览）
  const agentGhost = useCanvasStore((s) => s.agentPreviewNodeIds.includes(id));
  const uploadProgress = useUploadProgress(id);
  const uploadPct = uploadProgress?.phase === "uploading" ? uploadProgress.pct : null;
  const uploadHashBytes = uploadProgress?.phase === "hashing" && uploadProgress.loadedBytes > 0
    ? formatBytes(uploadProgress.loadedBytes)
    : null;
  // 画布交互状态（连线 / 拖动让位 hover 预览用，真相源在 store 状态机）
  const interaction = useCanvasStore((s) => s.interaction);
  const { notification } = useAppFeedback();
  // 播放源唯一真相是 data.src（撤销/清除整体替换 data，无需本地镜像与对账）；
  // 元素消费用最终访问地址（key → 描述接口 → 签名直连 / 流式）；媒体接口入参直接使用持久化值域的 key
  const src = data.src || "";
  const generating = isGenerating(data.taskBinding);
  let logicalSrc = fileRefUrl(src);
  if (data.upload?.uploading) logicalSrc = data.upload.previewUrl || "";
  else if (data.upload?.error || generating) logicalSrc = "";
  const {
    url: accessSrc,
    failed: accessFailed,
    refresh: refreshAccess,
    retrySigned,
    reloadToken: accessReloadToken,
  } = useFileAccessUrl(logicalSrc);
  const loadingSrc = accessSrc ?? "";
  // 本地处理忙状态：抽帧 / 分离音频 / 片段截取 / 画面裁剪互斥共用（同一节点
  // 同一时刻只跑一个）。busy 形状与任务编排（守卫 / 取消 / 客户端失败切服务端
  // 兜底）统一由 useMediaEditTask 提供（specs/client-video-editing.md 降级契约）
  const { busy, runEditTask, cancelActive, expectSource } = useMediaEditTask(id);
  const [previewOpen, setPreviewOpen] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  // 元素重挂纪元（失败重试）：与签名重挂令牌、源地址一起构成元素的真实身份。
  // 播放镜像必须按元素身份记账而不是只按源地址——签名重描述成功后地址可能不变、
  // 只有令牌 +1，元素已换成新实例（暂停在 0），旧镜像会停在「暂停」或残留播放态
  const [sessionEpoch, setSessionEpoch] = useState(0);
  const elementRevision = `${sessionEpoch}:${accessReloadToken}:${loadingSrc}`;
  const [playback, patchPlayback] = useElementMirror<PlaybackMirror>(elementRevision, IDLE_PLAYBACK);
  const panelOpen = useCanvasStore(
    (s) => s.frameCaptureNodeId === id || s.clipCaptureNodeId === id,
  );
  // Clip preview owns looping; native loop would briefly jump back to zero.
  const clipOpen = useCanvasStore((s) => s.clipCaptureNodeId === id);
  const cropOpen = useCanvasStore((s) => s.croppingNodeId === id);
  // hover 播放会话：悬停延迟后置位。autoplay 标记内嵌在会话对象里——会话是
  // 播放意图的唯一载体，置空即整体消失，不存在游离的待消费意图
  const [session, setSession] = useState<{ src: string; autoplay: boolean } | null>(null);
  // 渲染期派生状态重置（React 官方模式）：源被替换/上传完成时旧会话整体作废，勿"清理"
  if (session && session.src !== loadingSrc) setSession(null);
  // 会话元素挂载条件只看显式需求：hover 会话 / 编辑面板 / 裁剪 / 忙状态。
  // playing 是元素内播放事件的 UI 镜像，只驱动控件图标与遮罩——它不得参与
  // 挂载判定：面板经注册表播放/恢复源时 load() 不触发 pause 事件，playing
  // 会卡在 true，元素将赖着不卸载（表现为图标停在暂停、hover 失效）
  const sessionActive = session !== null || panelOpen || cropOpen || busy !== null;
  // 渲染期派生状态重置（React 官方模式）：元素已不在会话中（面板退出/会话结束）
  // 时播放镜像作废——load() 恢复源不触发 pause 事件，必须在此显式作废，勿"清理"。
  // 元素换实例（sessionEpoch / reloadToken / 源地址任一变化）的作废由 useElementMirror
  // 按元素身份（elementRevision）完成
  if (playback.playing && !sessionActive) patchPlayback(IDLE_PLAYBACK);
  const playing = playback.playing;
  const setPlaying = useCallback(
    (value: boolean) => patchPlayback({ playing: value }),
    [patchPlayback],
  );
  const playbackAttemptRef = useRef(0);
  /** 用户经控件条接管播放：鼠标离开不打断（与原逻辑一致），但页面隐藏/失焦/画布交互仍卸载 */
  const takeoverRef = useRef(false);
  const { element: sessionElement, setElement: setSessionElement, status: sessionStatus } = useCanvasVideo(loadingSrc, sessionActive);
  // 失败重试：换 key 重挂元素，重新走一次加载（失败不粘滞，无定时器定终身）。
  // hover 会话存在时重新武装自动播放，重试成功即恢复起播；面板会话（session
  // 为空）重试不自动播放
  const retrySession = useCallback(() => {
    void refreshAccess();
    setSessionEpoch((epoch) => epoch + 1);
    setSession((s) => (s ? { ...s, autoplay: true } : s));
  }, [refreshAccess]);
  // signed URL 加载失败先重新描述一次（过期 / 跨窗口），仍失败才显示失败浮层；
  // stream / 外部 URL 重试同一地址不会改变结果。闩锁与重挂令牌由 Hook 统一提供。
  useEffect(() => {
    if (sessionStatus !== "failed" || !loadingSrc) return;
    void retrySigned();
  }, [sessionStatus, loadingSrc, retrySigned]);
  // 退出画面裁剪态：裁剪面板的关闭键与会话失败浮层的取消入口共用
  const closeCrop = useCallback(() => useCanvasStore.getState().setCroppingNodeId(null), []);

  /**
   * 音量：0~1。= 0 等价于静音；切换静音时用 lastVolume 记住上次非零值。
   * 默认 50%。用户主动拖过滑块后保留偏好（仅本次挂载）。
   * 会话元素可能反复重挂，volumeRef 保证重挂时恢复当前偏好而非默认值。
   */
  const [volume, setVolume] = useState(0.5);
  const [lastVolume, setLastVolume] = useState(0.5);
  const volumeRef = useRef(0.5);
  // ref 不在渲染期写入：音量偏好经 effect 同步，会话元素重挂时由 ref 回调读取恢复
  useEffect(() => {
    volumeRef.current = volume;
    const v = videoRef.current;
    if (v) v.volume = volume;
  }, [volume]);
  /**
   * 自动播放被策略拦截时的静音降级标记（业界通行做法：带声 play() 被拒 →
   * 静音重试保证播放仍会动）。控件条点击 / 拖音量等手势交互即解除。
   * muted 受控于 React 渲染，故起播尝试用 state 表达降级而非只改 DOM——
   * autoplay effect 里的 el.muted 直写是为了让当次 play() 立即生效，
   * 随后的重渲染由 state 收敛到同一值，两者不冲突。
   */
  const [autoplayMuted, setAutoplayMuted] = useState(false);

  const handlePlaybackStopped = useCallback(() => {
    playbackAttemptRef.current += 1;
    setPlaying(false);
  }, [setPlaying]);

  /**
   * 结束 hover 会话。只有 hover 会话（session 非空）归本组件结束；面板会话
   * （session 为空，元素由片段循环预览等面板逻辑驱动）的播放/暂停交还面板，
   * mouseleave 不得打断面板内部行为。
   * force=false（鼠标离开）：控件条接管的播放不打断（与原逻辑一致）。
   * force=true（页面隐藏/失焦/画布交互/起播失败）：无视接管，hover 会话一律
   * 卸载——隐藏期间不存在挂 src 的常驻缓冲，浏览器无从逐出，这是本次根因
   * 修复的一部分。保留判定读 DOM 真实播放状态（paused/ended），不依赖可能
   * 过期的 React 状态。
   */
  const endSession = useCallback((force: boolean) => {
    if (session === null) return;
    const v = videoRef.current;
    if (!force && takeoverRef.current && v && !v.paused && !v.ended) return;
    takeoverRef.current = false;
    playbackAttemptRef.current += 1;
    v?.pause();
    setPlaying(false);
    setSession(null);
  }, [session, setPlaying]);

  // 会话元素挂载后消费 hover 的自动播放意图：先尝试带声播放，被自动播放策略
  // 拦截才静音降级（业界通行做法）。降级不做成粘性——否则首个节点会永久锁死
  // 在静音，直到用户手动碰音量。意图在起播时即写回会话对象消费（autoplay:
  // false），effect 因元素/会话身份变化重入时不会重复起播；重试经 retrySession
  // 重新武装，会话置空即整体失效——不存在游离的待消费意图
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !session?.autoplay) return;
    setSession((s) => (s && s.autoplay ? { src: s.src, autoplay: false } : s));
    const attempt = ++playbackAttemptRef.current;
    const isCurrent = () => videoRef.current === v && playbackAttemptRef.current === attempt;
    v.muted = false;
    setAutoplayMuted(false);
    v.play().then(() => { if (isCurrent()) setPlaying(true); }).catch((error: unknown) => {
      if (!isCurrent()) return;
      if (!(error instanceof DOMException) || error.name !== "NotAllowedError") {
        // 起播失败（解码不支持/被中止）：静默回到海报；媒体 error 事件会走失败遮罩
        endSession(true);
        return;
      }
      v.muted = true;
      setAutoplayMuted(true);
      v.play().then(() => { if (isCurrent()) setPlaying(true); }).catch(() => {
        if (isCurrent()) endSession(true);
      });
    });
  }, [sessionElement, session, endSession, setPlaying]);

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    // 用户经控件条接管：鼠标离开不打断（页面隐藏/失焦仍会卸载，见 endSession）
    takeoverRef.current = true;
    setAutoplayMuted(false);
    if (v.paused) {
      v.play().catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        notifyActionFailed(notification, t, undefined, "media.playFailed", id);
      });
    } else {
      v.pause();
    }
  }, [notification, t, id]);

  /** 同步音量到 video 元素，并把最终值绑回 state（拖动结束也会走 setVolume） */
  const applyVolume = useCallback((value: number) => {
    const v = videoRef.current;
    const clamped = Math.max(0, Math.min(1, value));
    if (v) v.volume = clamped;
    setVolume(clamped);
    setAutoplayMuted(false);
    if (clamped > 0) setLastVolume(clamped);
  }, []);

  /** 静音切换：保留上次非零音量，再次点击恢复 */
  const toggleMute = useCallback(() => {
    applyVolume(volume === 0 ? lastVolume || 0.5 : 0);
  }, [volume, lastVolume, applyVolume]);

  // 换源替换 / 卸载：中止进行中的本地处理任务（抽帧请求 / 客户端管线）——
  // 旧源的产物不得写入已换成新源的节点
  useEffect(() => () => cancelActive(), [cancelActive, src]);

  /** 选帧 / 片段截取面板打开期间：hover 播放整体让位，
      不顶掉面板的循环预览与所选帧 */
  const capturingFrame = useCallback(() => {
    const s = useCanvasStore.getState();
    return s.frameCaptureNodeId === id || s.clipCaptureNodeId === id;
  }, [id]);

  // 连线 / 拖动进行中：hover 播放整体让位——拖线悬停或拖动节点时视频不该自行开播
  // （交互状态机瞬态真相源在 store，节点组件与 InfiniteCanvas 共用同一状态）
  const interactionBusy =
    interaction.mode === "connecting" || interaction.mode === "dragging-nodes";

  /** 鼠标扫过一排视频节点时会连续误触播放，延迟 300ms 只对真正的停留作出响应 */
  const HOVER_PLAY_DELAY = 300;
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * hover 守卫的"最新值"镜像：定时器回调读 ref 而不是调度时闭包——延迟 300ms 内
   * 打开面板、进入交互、上传完成等任何使 hover 失格的状态变化都能正确拦截。
   * 空串 = 当前失格。
   */
  const hoverEligibleSrcRef = useRef("");
  useEffect(() => {
    hoverEligibleSrcRef.current =
      !loadingSrc || sessionActive || interactionBusy || sessionStatus === "failed" ? "" : loadingSrc;
  }, [loadingSrc, sessionActive, interactionBusy, sessionStatus]);

  const handleMouseEnter = useCallback(() => {
    if (!hoverEligibleSrcRef.current) return;
    if (hoverTimerRef.current) { clearTimeout(hoverTimerRef.current); hoverTimerRef.current = null; }
    hoverTimerRef.current = setTimeout(() => {
      hoverTimerRef.current = null;
      const src = hoverEligibleSrcRef.current;
      if (!src) return;
      takeoverRef.current = false;
      setSession({ src, autoplay: true });
    }, HOVER_PLAY_DELAY);
  }, []);

  const handleMouseLeave = useCallback(() => {
    if (hoverTimerRef.current) { clearTimeout(hoverTimerRef.current); hoverTimerRef.current = null; }
    endSession(false);
  }, [endSession]);

  useEffect(() => {
    if (!interactionBusy) return;
    // 未触发的悬停延迟一并取消；会话无条件卸载（含控件条接管的播放）
    if (hoverTimerRef.current) { clearTimeout(hoverTimerRef.current); hoverTimerRef.current = null; }
    endSession(true);
  }, [interactionBusy, endSession]);

  // 页面隐藏（切走应用/最小化）或窗口失焦时无条件结束会话（含控件条接管的播放）：
  // 隐藏期间不存在挂 src 的常驻缓冲，浏览器无从逐出——本次根因修复的一部分
  useEffect(() => {
    const stop = () => {
      if (document.visibilityState === "visible" && document.hasFocus()) return;
      if (hoverTimerRef.current) { clearTimeout(hoverTimerRef.current); hoverTimerRef.current = null; }
      endSession(true);
    };
    document.addEventListener("visibilitychange", stop);
    window.addEventListener("blur", stop);
    return () => {
      document.removeEventListener("visibilitychange", stop);
      window.removeEventListener("blur", stop);
    };
  }, [endSession]);

  // 面板/裁剪打开即收编会话元素所有权：hover 会话立即结束，元素交由面板逻辑
  // 驱动（循环预览/scrub/快照），此后 mouseleave/隐藏不再走 hover 的结束逻辑。
  // 面板/裁剪退出：元素整体卸载回封面，控件播放状态由渲染期派生重制作废——
  // 播放状态属于播放器实例，实例拆除时不得泄漏到静止态（行业通行做法）
  useEffect(() => {
    if (panelOpen || cropOpen) endSession(true);
  }, [panelOpen, cropOpen, endSession]);

  useEffect(() => () => {
    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
  }, []);

  /**
   * 回填音轨结论到节点数据。
   * skipHistory：探测属于渲染副产物，不该占用撤销栈。
   */
  const commitHasAudio = useCallback(
    (value: boolean) => {
      if (data.hasAudio === value) return;
      useCanvasStore.getState().updateNodeData(
        id,
        { hasAudio: value } as Partial<VideoNodeData>,
        undefined,
        { skipHistory: true },
      );
    },
    [data.hasAudio, id],
  );

  /**
   * 浏览器能直接读出音轨时（Firefox 的 mozHasAudio、Safari 的 audioTracks）立即定论。
   *
   * 只采纳「有音轨」的确定结论：「无音轨」在 Chrome 上依赖播放后才可靠的解码计数，
   * 误判会直接禁掉「分离音频」入口，因此等用户真正播放时由 onTimeUpdate 补判；
   * 始终没播放的视频，最终由「分离音频」的后端结论兜底。
   */
  const resolveAudioTrack = useCallback(() => {
    const v = videoRef.current;
    if (!v || data.hasAudio !== undefined) return;
    if (detectAudioTrack(v) === true) commitHasAudio(true);
  }, [commitHasAudio, data.hasAudio]);

  const onTimeUpdate = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    // 选帧期间播放器被临时切到代理视频（转码产物，音轨已重编码为 aac），
    // 探测结论只代表代理、且换源期间元数据不稳定，不能据此给原视频下结论，
    // 否则可能错误启用 / 禁用「分离音频」入口，必须跳过
    if (capturingFrame()) return;

    const detected = detectAudioTrack(v, true);
    if (detected === null) return;
    // 结论一旦确定就不再改：Chrome 的解码计数在播放初期可能还没涨上来，
    // 反复覆盖会把先前正确的结论冲掉、误禁分离入口
    if (data.hasAudio !== undefined) return;
    // 有音轨可立即定论。判定「无音轨」必须确实在播放中：只拖进度条时视频仍是
    // 暂停态，解码器还没解出音频，计数为 0 会被误判成无音轨，从而错误禁掉
    // 「分离音频」入口
    if (detected || (!v.paused && v.currentTime > AUDIO_DECISION_MIN_TIME)) {
      commitHasAudio(detected);
    }
  }, [commitHasAudio, capturingFrame, data.hasAudio]);
  const onLoadedMeta = useCallback(() => {
    const v = videoRef.current;
    if (v) {
      // 时长 / 尺寸回填节点数据（skipHistory，探测属渲染副产物），供资源管理器
      // 等列表展示与裁剪面板换算。尺寸仅在探测缺失时回填（服务端探测值是权威，
      // 不覆盖）；元数据从未回填的源由此获得可用尺寸，裁剪入口不再永久禁用。
      // 选帧期间播放器是代理视频，同音轨结论一样不能据此写入
      if (!capturingFrame()) {
        const patch: Partial<VideoNodeData> = {};
        const d = v.duration;
        if (Number.isFinite(d) && d > 0 && data.duration !== d) patch.duration = d;
        if (!data.naturalWidth && v.videoWidth > 0 && v.videoHeight > 0) {
          patch.naturalWidth = v.videoWidth;
          patch.naturalHeight = v.videoHeight;
        }
        if (patch.duration !== undefined || patch.naturalWidth !== undefined) {
          useCanvasStore.getState().updateNodeData(id, patch, undefined, { skipHistory: true });
        }
      }
    }
    // 同上：换源后的 metadata 来自代理（转码产物），不能据此判定原视频的音轨
    if (capturingFrame()) return;
    resolveAudioTrack();
  }, [resolveAudioTrack, capturingFrame, data.duration, data.naturalWidth, id]);

  const captureFrame = useCallback(async (selection: FrameSelection) => {
    const videoKey = storageKeyOf(src);
    if (!videoKey) {
      // 确认不自关契约的兜底：源已失效或不是存储 key（外部 URL）时抽帧无从
      // 进行——关掉仍打开的帧截取面板，不留无响应的确认键（抽帧是只接受
      // 存储 key 的服务端操作，不需要本地视频元素）
      useCanvasStore.getState().setFrameCaptureNodeId(null);
      return;
    }
    runEditTask({
      kind: "capture",
      // 抽帧被接受：关闭帧截取面板（面板不在确认时自关——busy 守卫拒绝时面板
      // 保持打开、播放位置原样保留可重试，与截取面板的「确认不自关」契约一致）
      onAccept: () => useCanvasStore.getState().setFrameCaptureNodeId(null),
      // 纯服务端任务（无客户端管线）：不提供取消入口，但支持换源中止
      serverTask: async ({ signal }) => {
        const res = await captureFrameApi(videoKey, selection, signal);
        return readCapturedFrame(res, signal, {
          notification,
          t,
          errorKey: "error.capture_frame.capture_failed",
          nodeId: id,
        });
      },
      onSuccess: async (frame) => {
        // 源已被替换：旧源的抽帧产物不再写入
        if (!expectSource(src)) return;
        const { width: nw, height: nh, time: capturedTime } = frame;
        const label = `${data.label || t("common.frame")} #${Math.round(capturedTime * 10) / 10}s`;
        // 投影只暴露持久化 key；响应 url 不进入节点构建
        await createImageNodeFromRef(id, frame.key, nw, nh, label, useCanvasStore.getState(), { source: "derived" }, undefined, label);
      },
      errorKey: "error.capture_frame.capture_failed",
      logLabel: "Frame capture failed:",
    });
  }, [src, data.label, id, t, notification, runEditTask, expectSource]);

  /**
   * 分离音频：优先走客户端管线（纯重封装，零解码，specs/client-video-editing.md），
   * 探测不支持或管线失败自动回退服务端。两个产物都作为派生节点连回源节点。
   *
   * 连线策略：两个产物节点都直接连回原视频（原视频 → 静音视频、原视频 → 音频），
   * 与宫格切分一致，不做链式挂接、也不迁移源节点的旧边。
   *
   * 历史栈：先用 write:false 仅构建两个节点，再一次 addNodes + setEdges 同批
   * 写入——addNodes 压一条「分离前」快照，setEdges 被节流不重复压栈，
   * 撤销一次即整体删除两个派生节点及其连线。
   */
  const handleDetachAudio = useCallback(async () => {
    const videoKey = storageKeyOf(src);
    if (!videoKey) return;
    runEditTask({
      kind: "detach",
      // 客户端管线：用户取消静默复位；不支持（非 ISO-BMFF 容器 / 非 AAC 音轨 /
      // 无音轨）/ 管线失败回退服务端；其余异常向上抛。
      // 客户端产物补齐派生节点所需的 mime / ext，与服务端响应同形
      clientTask: async ({ signal, onProgress }) => {
        const result = await tryDetachAudioOnClient(videoKey, { signal, onProgress });
        return {
          audio: { ...result.audio, mime: "audio/mp4", ext: ".m4a" },
          video: { ...result.video, mime: "video/mp4", ext: ".mp4" },
        } satisfies DetachAudioResult;
      },
      serverTask: async ({ signal }) => {
        const res = await detachAudioApi(videoKey, signal);
        return readDetachAudioResult(res, signal, {
          notification,
          t,
          errorKey: "detach.failed",
          nodeId: id,
          // 确认无音轨后同步禁用入口，避免用户反复点击撞同一个错误
          onErrorCode: (code) => {
            if (code === "detach_audio.no_audio_track") commitHasAudio(false);
          },
        });
      },
      onSuccess: async (detached) => {
        // 源已被替换：旧源的派生产物不再写入（各编辑动作 onSuccess 同一守卫）
        if (!expectSource(src)) return;
        const { audio, video } = detached;
        const v = videoRef.current;
        const nw = v?.videoWidth || data.naturalWidth || 0;
        const nh = v?.videoHeight || data.naturalHeight || 0;
        const store = useCanvasStore.getState();

        // 1. 仅构建两个节点（write:false 不写 store），随后同批写入
        const mutedNode = createVideoNodeFromRef(
          id,
          video.key,
          nw,
          nh,
          t("detach.mutedSuffix"),
          store,
          { source: "derived" },
          undefined,
          undefined,
          { write: false },
        );
        // 音频节点排在静音视频正下方，避免同批产物重叠
        const audioNode = createAudioNodeFromRef(
          id,
          audio.key,
          t("detach.audioSuffix"),
          store,
          { source: "derived" },
          {
            x: mutedNode.position.x,
            y:
              mutedNode.position.y +
              ((mutedNode.style?.height as number) || DEFAULT_NODE_HEIGHT) +
              DERIVED_BASE_GAP_Y,
          },
          undefined,
          { write: false },
        );

        // 2. 两个产物节点都直接连回原视频，节点与边同批写入：
        //    批量守卫合并为一条撤销（离散操作必定入栈，撤销一次即整体删除）
        withHistoryBatch(() => {
          store.addNodes([mutedNode, audioNode]);
          store.setEdges([
            ...store.edges,
            createEdge(id, mutedNode.id),
            createEdge(id, audioNode.id),
          ]);
        });

        commitHasAudio(true);
        markDirtyImmediate();
      },
      errorKey: "detach.failed",
      logLabel: "Audio detach failed:",
    });
  }, [
    src,
    t,
    commitHasAudio,
    data.naturalWidth,
    data.naturalHeight,
    id,
    notification,
    runEditTask,
    expectSource,
  ]);

  /** 节点内上传 / 替换：走统一上传管道（失败自动回滚并提示） */
  const handleUpload = useNodeUpload(id, { accept: "video/*", clearFields: ["hasAudio"] });

  /**
   * 截取片段：优先走客户端管线（WebCodecs 硬件编码，specs/client-video-editing.md），
   * 探测不支持或管线失败自动回退服务端；产物作为派生视频节点连回源节点。
   *
   * 历史栈策略与分离音频一致：write:false 仅构建节点，再一次 addNodes + setEdges
   * 同批写入，撤销一次即整体删除。
   */
  const handleExtractClip = useCallback(async (start: number, end: number) => {
    const videoKey = storageKeyOf(src);
    if (!videoKey) return;
    runEditTask({
      kind: "clip",
      // 退出截取模式：选区已被接受，面板随之卸载（与音频截取确认同一约定）
      onAccept: () => useCanvasStore.getState().setClipCaptureNodeId(null),
      // 客户端管线：用户取消静默复位；不支持 / 管线失败回退服务端；其余异常向上抛。
      // 产物投影为与服务端响应同形的存储 key（节点 src 持久化值域），onSuccess 单一形状消费
      clientTask: async ({ signal, onProgress }) =>
        (await tryClipOnClient(videoKey, { start, end }, { signal, onProgress })).key,
      serverTask: async ({ signal }) => {
        const res = await extractClipApi(videoKey, start, end, signal);
        // 单产物响应只取持久化值域 key；url 是渲染期派生物，不得写入节点
        return readEditResultKey(res, signal, {
          notification,
          t,
          errorKey: "error.clip.extract_failed",
          nodeId: id,
        });
      },
      onSuccess: (key) => {
        // 源已被替换：旧源的派生产物不再写入
        if (!expectSource(src)) return;
        const v = videoRef.current;
        const nw = v?.videoWidth || data.naturalWidth || 0;
        const nh = v?.videoHeight || data.naturalHeight || 0;
        const store = useCanvasStore.getState();
        const range = `${formatTime(start)}-${formatTime(end)}`;

        const clipNode = createVideoNodeFromRef(
          id,
          key,
          nw,
          nh,
          t("clip.suffix", { range }),
          store,
          { source: "derived" },
          undefined,
          undefined,
          { write: false },
        );

        // 批量守卫合并为一条撤销（离散操作必定入栈，撤销一次即整体删除）
        withHistoryBatch(() => {
          store.addNodes([clipNode]);
          store.setEdges([...store.edges, createEdge(id, clipNode.id)]);
        });

        markDirtyImmediate();
      },
      errorKey: "error.clip.extract_failed",
      logLabel: "Clip extraction failed:",
    });
  }, [src, t, data.naturalWidth, data.naturalHeight, id, notification, runEditTask, expectSource]);

  /**
   * 裁剪画面：优先走客户端管线（WebCodecs 硬件编码，specs/client-video-editing.md），
   * 探测不支持或管线失败自动回退服务端；产物作为派生视频节点连回源节点
   * （历史栈策略与片段截取一致）。
   */
  const handleCropVideoApply = useCallback(async (rect: CropRectPx) => {
    const videoKey = storageKeyOf(src);
    if (!videoKey) {
      // 源已失效或不是存储 key（外部 URL）：裁剪无从进行，关掉仍打开的裁剪面板
      // 而不是留一个无响应的确认键（croppingNodeId 的宿主校验兜底见 InfiniteCanvas）
      useCanvasStore.getState().setCroppingNodeId(null);
      return;
    }
    runEditTask({
      kind: "crop",
      // 裁剪被接受：关闭裁剪面板（面板不在确认时自关——busy 拒绝时面板保持
      // 打开、选区原样保留可重试，与截取面板的「确认不自关」契约一致）
      onAccept: () => useCanvasStore.getState().setCroppingNodeId(null),
      // 客户端管线：用户取消静默复位；不支持 / 管线失败回退服务端；其余异常向上抛。
      // 产物投影为与服务端响应同形的存储 key（裁剪尺寸取调用方 rect，与服务端路径一致）
      clientTask: async ({ signal, onProgress }) =>
        (await tryCropOnClient(videoKey, rect, { signal, onProgress })).key,
      serverTask: async ({ signal }) => {
        const res = await cropVideoApi(videoKey, rect, signal);
        // 单产物响应只取持久化值域 key；url 是渲染期派生物，不得写入节点
        return readEditResultKey(res, signal, {
          notification,
          t,
          errorKey: "error.crop.failed",
          nodeId: id,
        });
      },
      onSuccess: (key) => {
        // 源已被替换：旧源的派生产物不再写入
        if (!expectSource(src)) return;
        const store = useCanvasStore.getState();
        const size = `${rect.width}×${rect.height}`;

        const cropNode = createVideoNodeFromRef(
          id,
          key,
          rect.width,
          rect.height,
          t("crop.suffix", { size }),
          store,
          { source: "derived" },
          undefined,
          undefined,
          { write: false },
        );

        // 批量守卫合并为一条撤销（离散操作必定入栈，撤销一次即整体删除）
        withHistoryBatch(() => {
          store.addNodes([cropNode]);
          store.setEdges([...store.edges, createEdge(id, cropNode.id)]);
        });

        markDirtyImmediate();
      },
      errorKey: "error.crop.failed",
      logLabel: "Video crop failed:",
    });
  }, [src, t, id, notification, runEditTask, expectSource]);

  const addAsset = useAssetsStore((s) => s.addAsset);

  const handleDownload = useCallback(() => {
    void downloadManagedFile(src, data.label);
  }, [src, data.label]);

  const handleSaveToAssets = useCallback(async () => {
    if (!src) return;
    const node = useCanvasStore.getState().nodes.find(n => n.id === id);
    const d = node?.data as VideoNodeData | undefined;
    // 缩略图不再在保存时生成：素材库读取时通过 fileKey?w= 由后端按需抽帧
    await addAsset({
      name: data.label || t("node.video"),
      type: "other",
      mediaType: "video",
      fileKey: src,
      sourceType: d?.source,
      description: "",
      prompt: d?.genSettings?.prompt ?? "",
    });
  }, [src, data.label, id, addAsset, t]);

  // Listen for node action events from NodeToolbar
  useEffect(() => {
    function onNodeAction(e: Event) {
      const detail = (e as CustomEvent).detail;
      if (detail.nodeId !== id) return;
      switch (detail.action) {
        case "download": handleDownload(); break;
        case "save-asset": handleSaveToAssets(); break;
        case "preview-fullscreen": if (src) setPreviewOpen(true); break;
        case "capture-frame": {
          void captureFrame(detail.selection);
          break;
        }
        case "detach-audio":
          void handleDetachAudio();
          break;
        case "extract-clip":
          void handleExtractClip(detail.start as number, detail.end as number);
          break;
        case "crop-video":
          // 打开画面裁剪面板（复用 croppingNodeId，与图片裁剪互斥天然成立）；
          // 编辑面板互斥由 store 的 setter 统一收口
          if (src) useCanvasStore.getState().setCroppingNodeId(id);
          break;
        case "crop-video-apply":
          void handleCropVideoApply(detail.rect as CropRectPx);
          break;
      }
    }
    window.addEventListener(EventNames.CANVAS_NODE_ACTION, onNodeAction);
    return () => window.removeEventListener(EventNames.CANVAS_NODE_ACTION, onNodeAction);
  }, [id, src, handleDownload, handleSaveToAssets, captureFrame, handleDetachAudio, handleExtractClip, handleCropVideoApply]);

  // 换源后旧探测结论失效，清空以便重新判定。
  // 首次挂载必须跳过：结论已随画布持久化，清掉会逼着每个节点刷新时重新探测一次
  const prevSrcRef = useRef<string | null>(null);
  useEffect(() => {
    const prev = prevSrcRef.current;
    prevSrcRef.current = src;
    if (prev === null || prev === src) return;
    const store = useCanvasStore.getState();
    const node = store.nodes.find((n) => n.id === id);
    if (!node) return;
    if ((node.data as VideoNodeData).hasAudio === undefined) return;
    store.updateNodeData(
      id,
      { hasAudio: undefined } as Partial<VideoNodeData>,
      undefined,
      { skipHistory: true },
    );
  }, [id, src]);

  const hasVideo = src && src.length > 0;
  // 海报：内容寻址派生品，非托管地址（外链导入等）无海报，显示图标占位
  const posterUrl = hasVideo ? withManagedFileWidth(src, 1280) : undefined;
  const posterAspect = mediaAspect(data.naturalWidth, data.naturalHeight);

  // 把会话 video 元素登记进注册表：帧序列面板渲染在画布层，拿不到本组件的 videoRef，
  // 需要通过它读取「打开面板时的播放位置」。走 store 会把播放进度写进撤销栈，故不用。
  //
  // 必须用 callback ref：元素挂在条件渲染链上（会话结束即卸载），callback ref 在
  // 元素挂载 / 卸载的瞬间同步注册表，不依赖任何派生值。
  const videoCleanupRef = useRef<(() => void) | null>(null);
  const setVideoRef = useCallback((el: HTMLVideoElement | null) => {
    setSessionElement(el);
    videoCleanupRef.current?.();
    videoCleanupRef.current = null;
    videoRef.current = el;
    if (el) {
      // 会话元素可能反复重挂：恢复当前音量偏好（state 初值 0.5，但 DOM volume 默认是 1）
      el.volume = volumeRef.current;
      videoCleanupRef.current = registerVideoElement(id, el);
    }
  }, [id, setSessionElement]);

  return (
    <div className="group relative w-full h-full flex flex-col node-tilt">
      <NodeTitle
        nodeId={id}
        icon={<VideoCameraOutlined className="shrink-0" />}
        title={data.label}
        display={data.label || t("node.video")}
        trailing={hasVideo && data.naturalWidth > 0 ? `${data.naturalWidth}×${data.naturalHeight}` : null}
      />

      <div
        className={`
          node-body flex-1 flex items-center justify-center overflow-hidden rounded-lg relative group/body
          ${selected ? "node-selected" : ""}
          ${hasVideo ? "bg-transparent" : "node-surface"}
        `}
        onContextMenu={(e) => e.preventDefault()}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
      >
        {agentGhost && <AgentGhostOverlay />}
        {data.source === "upload" && hasVideo && !data.upload?.uploading && !generating && (
          <div className="absolute top-2 right-2 z-20 nodrag">
            <Tooltip><TooltipTrigger asChild>
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  className="rounded-md bg-black/50 p-0 text-white/70 hover:bg-black/70 hover:text-white"
                  onClick={handleUpload}
                >
                  <UploadOutlined className="size-4" />
                </Button>
              </TooltipTrigger><TooltipContent>{t("common.replace")}</TooltipContent></Tooltip>
          </div>
        )}
        {hasVideo && posterUrl && (
          /* 海报垫底：跨模式常驻（静态 / 会话 / 生成中共用同一元素，模式切换不重挂），
              会话视频从挂载到解出首帧之间是透明的，垫底海报避免闪黑场；
              视频解出画面后自然盖住海报（同比例 object-contain，边缘对齐） */
          <CanvasImage
            nodeId={id}
            src={posterUrl}
            aspect={posterAspect}
            alt={data.label || t("node.video")}
            className="absolute inset-0 size-full object-contain"
            draggable={false}
            placeholderIcon={VideoCameraOutlined}
          />
        )}
        {data.upload?.uploading ? (
          <div className="absolute inset-0 rounded-lg overflow-hidden">
            {data.upload?.previewUrl && (
              <video src={data.upload.previewUrl} crossOrigin="anonymous" muted playsInline className="absolute inset-0 w-full h-full object-cover" style={{ filter: "blur(24px)", animation: "breathe 3s ease-in-out infinite" }} />
            )}
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/35 px-8">
              {/* 哈希/未开始阶段只有空轨道：确定态填充只随真实传输出现，进度永不回退 */}
              <div className="w-3/4 h-1.5 bg-white/10 rounded-full overflow-hidden">
                {uploadPct != null && (
                  <div className="h-full bg-primary rounded-full transition-all duration-300" style={{ width: `${uploadPct}%` }} />
                )}
              </div>
              <span className="text-sm text-white/70 font-medium tabular-nums">
                {uploadProgress?.phase === "hashing"
                  ? t("common.verifying") + (uploadHashBytes ? ` · ${uploadHashBytes}` : "")
                  : t("common.uploading") + (uploadPct != null ? ` ${Math.round(uploadPct)}%` : "")}
              </span>
            </div>
          </div>
        ) : data.upload?.error ? (
          <UploadFailedOverlay nodeId={id} error={data.upload.error} previewUrl={data.upload.previewUrl} />
        ) : generating ? (
          <GeneratingOverlay absolute={false} startedAt={data.taskBinding?.startedAt} />
        ) : hasVideo && sessionActive ? (
          <div className="w-full h-full relative">
            {/* 海报已由上方跨模式常驻元素垫底；无海报时保留黑底兜底 */}
            {!posterUrl && <div className="absolute inset-0 bg-black" />}
            {/* 片段截取面板打开期间关闭原生 loop（见 clipOpen 定义处的说明）：
                用响应式属性而非命令式改 DOM，元素重挂也自动带上。
                src 只在解析出访问地址后输出：`src=""` 会被浏览器解析成页面自身 URL
                并当媒体请求（ResolvedMedia 同款约定）；元素先挂载，地址就绪后由
                elementRevision 变化触发重挂加载 */}
            <video
              key={elementRevision}
              ref={setVideoRef}
              src={accessSrc}
              crossOrigin="anonymous"
              className="absolute inset-0 w-full h-full rounded-lg"
              loop={!clipOpen}
              muted={volume === 0 || autoplayMuted}
              playsInline
              preload="auto"
              onTimeUpdate={onTimeUpdate}
              onLoadedMetadata={onLoadedMeta}
              // 播放状态以 video 的真实事件为准：拖动轨道、换源等都会直接
              // 调用 pause()，只改 DOM 的话按钮图标会停在过期的状态上
              onPlay={() => setPlaying(true)}
              onPause={handlePlaybackStopped}
              // 不监听 ended：hover 播放 loop 常开（见 loop 属性），ended 不会触发；
              // 片段面板（loop 关闭）的 ended 由注册表监听器处理，与本组件无关
              onContextMenu={(e) => e.preventDefault()}
            />
            {/* 底部渐变遮罩：与控件栏同步显隐，静止时保持画面纯净 */}
            <div className={`pointer-events-none absolute bottom-0 left-0 right-0 h-24 z-[5] video-controls-scrim transition-opacity ${playing || panelOpen ? "opacity-100" : "opacity-0 group-hover/body:opacity-100"}`} />
            <VideoControls
              video={sessionElement}
              videoRef={videoRef}
              visible={playing}
              panelOpen={panelOpen}
              playing={playing}
              volume={volume}
              hasAudio={data.hasAudio !== false}
              togglePlay={togglePlay}
              toggleMute={toggleMute}
              applyVolume={applyVolume}
            />
          </div>
        ) : hasVideo ? (
          <div className="w-full h-full relative">
            {/* 静止态：首帧海报已由上方跨模式常驻元素垫底。无 <video> 元素，浏览器没有
                可逐出的常驻媒体缓冲；hover 播放由 body 的 mouseenter/mouseleave
                挂载/卸载会话元素 */}
            {!posterUrl && (
              <div className="absolute inset-0 flex items-center justify-center bg-black text-white/40" role="img" aria-label={data.label || t("node.video")}>
                <VideoCameraOutlined className="size-8" />
              </div>
            )}
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center gap-2 p-4 text-muted-foreground">
            <VideoCameraOutlined className="text-5xl" />
            <span className="text-base text-center">{t("drop.video")}</span>
            <Button
              type="button"
              size="lg"
              variant="secondary"
              className="nodrag px-6"
              onClick={handleUpload}>
              <UploadOutlined className="size-5" /> {t("common.upload")}
            </Button>
          </div>
        )}

        {/* 会话失败浮层：视频加载失败时给出原因与重试；裁剪态另附取消——失败时裁剪面板
            让位（其自带关闭键随之不可见），浮层是退出裁剪态的直接入口。加载中的等待不做
            黑幕遮挡——海报垫底即可视，裁剪面板直接叠加在海报 / 视频上（空间操作无需等帧） */}
        {sessionActive && (sessionStatus === "failed" || accessFailed) && (
          <div className="nodrag nowheel absolute inset-0 z-20 flex flex-col items-center justify-center gap-2 bg-black/70 p-3 text-center text-white" role="alert">
            <span className="text-sm">{t("media.loadFailed")}</span>
            <div className="flex flex-wrap justify-center gap-2">
              <Button size="sm" onClick={retrySession}><ReloadOutlined />{t("media.retry")}</Button>
              {cropOpen && <Button size="sm" variant="secondary" onClick={closeCrop}>{t("common.cancel")}</Button>}
            </div>
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

      {/* 画面裁剪面板：挂 body 之外以露出顶部工具条（与图片裁剪同构） */}
      {cropOpen && sessionStatus !== "failed" && !accessFailed && (
        <div className="pointer-events-none absolute inset-0 overflow-visible">
          <VideoCropPanel
            nodeId={id}
            videoSize={
              data.naturalWidth && data.naturalHeight
                ? { w: data.naturalWidth, h: data.naturalHeight }
                : undefined
            }
            onClose={closeCrop}
          />
        </div>
      )}

      {/* 输入轨渲染与否用连线判定的同一能力口径（acceptsInput），避免轨道与可连性分叉 */}
      {acceptsInput(NODE_TYPE.VIDEO, data.source) && <ConnectionSideRail side="left" type="target" />}
      <ConnectionSideRail side="right" type="source" />
      {src && (
        <MediaPreviewOverlay
          open={previewOpen}
          items={[{ ref: src, mediaType: "video" }]}
          index={0}
          onClose={() => setPreviewOpen(false)}
        />
      )}
    </div>
  );
}

export default memo(VideoNode);
