/**
 * 视频节点（video-node）渲染组件。
 * poster-first 架构（specs/canvas-video-poster-first.md）：静止态渲染首帧海报
 * （/api/files?w= 派生，无 <video> 元素），hover 挂载会话元素播放（原交互逻辑），
 * 播放/编辑面板/忙状态共用会话元素，会话结束即卸载释放解码器。
 */

"use client";

import type { FrameSelection } from "@noxrea/shared";
import { type NodeProps } from "@xyflow/react";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  LoadingOutlined,
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
  type CapturedFrameInfo,
  captureFrame as captureFrameApi,
  type CropRectPx,
  cropVideo as cropVideoApi,
  detachAudio as detachAudioApi,
  type DetachAudioResult,
  extractClip as extractClipApi,
  retryAfterOf,
  toFileKey,
} from "@/features/canvas/api/file-api";
import ConnectionSideRail from "@/features/canvas/controls/ConnectionSideRail";
import VideoCropPanel from "@/features/canvas/editing/VideoCropPanel";
import { useCanvasVideo } from "@/features/canvas/hooks/use-canvas-video";
import { createEdge } from "@/features/canvas/node-defaults";
import CanvasImage from "@/features/canvas/shared/CanvasImage";
import { acceptsInput } from "@/features/canvas/shared/connection-rules";
import MediaPreviewOverlay from "@/features/canvas/shared/MediaPreviewOverlay";
import { notifyActionFailed, notifyNodeBusy } from "@/features/canvas/shared/notify";
import { registerVideoElement } from "@/features/canvas/shared/video-playback-registry";
import { markDirtyImmediate, useCanvasStore, withHistoryBatch } from "@/features/canvas/stores/canvas-store";
import type { VideoNode as VideoNodeType, VideoNodeData } from "@/features/canvas/types";
import {
  createAudioNodeFromUrl,
  createNodeFromUrl,
  createVideoNodeFromUrl,
  DERIVED_BASE_GAP_Y,
  useNodeUpload,
} from "@/features/canvas/upload";
import { useUploadProgress } from "@/features/canvas/upload/upload-progress-store";
import { DEFAULT_NODE_HEIGHT, EventNames, isGenerating, NODE_TYPE } from "@/lib/constants";
import { withManagedFileWidth } from "@/lib/file-url";
import { sanitizeFileName } from "@/lib/utils/file-name";
import { formatTime } from "@/lib/utils/format";
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
  // 画布交互状态（连线 / 拖动让位 hover 预览用，真相源在 store 状态机）
  const interaction = useCanvasStore((s) => s.interaction);
  const { notification } = useAppFeedback();
  // 播放源唯一真相是 data.src（撤销/清除整体替换 data，无需本地镜像与对账）
  const src = data.src || "";
  const generating = isGenerating(data.taskBinding);
  let loadingSrc = src;
  if (data.upload?.uploading) loadingSrc = data.upload.previewUrl || "";
  else if (data.upload?.error || generating) loadingSrc = "";
  // 本地处理忙状态：抽帧 / 分离音频 / 片段截取 / 画面裁剪互斥共用（同一节点
  // 同一时刻只跑一个），startedAt 驱动忙浮层的实时耗时
  const [busy, setBusy] = useState<{
    kind: "capture" | "detach" | "clip" | "crop";
    startedAt: number;
  } | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const [playback, setPlayback] = useState({ src: loadingSrc, playing: false });
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
  // 时播放镜像作废——load() 恢复源不触发 pause 事件，必须在此显式作废，勿"清理"
  if (playback.src !== loadingSrc || (playback.playing && !sessionActive)) {
    setPlayback({ src: loadingSrc, playing: false });
  }
  const playing = playback.src === loadingSrc && playback.playing;
  const setPlaying = useCallback((value: boolean) => setPlayback({ src: loadingSrc, playing: value }), [loadingSrc]);
  const playbackAttemptRef = useRef(0);
  /** 用户经控件条接管播放：鼠标离开不打断（与原逻辑一致），但页面隐藏/失焦/画布交互仍卸载 */
  const takeoverRef = useRef(false);
  const { element: sessionElement, setElement: setSessionElement, status: sessionStatus } = useCanvasVideo(loadingSrc, sessionActive);
  // 失败重试：换 key 重挂元素，重新走一次加载（失败不粘滞，无定时器定终身）。
  // hover 会话存在时重新武装自动播放，重试成功即恢复起播；面板会话（session
  // 为空）重试不自动播放
  const [sessionEpoch, setSessionEpoch] = useState(0);
  const retrySession = useCallback(() => {
    setSessionEpoch((epoch) => epoch + 1);
    setSession((s) => (s ? { ...s, autoplay: true } : s));
  }, []);

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

  const captureAbortRef = useRef<AbortController | null>(null);
  useEffect(() => () => captureAbortRef.current?.abort(), [src]);

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
      // 时长回填节点数据（skipHistory，探测属渲染副产物），供资源管理器等列表展示；
      // 选帧期间播放器是代理视频，同音轨结论一样不能据此写入
      const d = v.duration;
      if (!capturingFrame() && Number.isFinite(d) && d > 0 && data.duration !== d) {
        useCanvasStore.getState().updateNodeData(
          id,
          { duration: d } as Partial<VideoNodeData>,
          undefined,
          { skipHistory: true },
        );
      }
    }
    // 同上：换源后的 metadata 来自代理（转码产物），不能据此判定原视频的音轨
    if (capturingFrame()) return;
    resolveAudioTrack();
  }, [resolveAudioTrack, capturingFrame, data.duration, id]);

  const captureFrame = useCallback(async (selection: FrameSelection) => {
    if (!src) {
      // 确认不自关契约的兜底：源已失效时抽帧无从进行——关掉仍打开的帧截取面板，
      // 不留无响应的确认键（抽帧是服务端操作，不需要本地视频元素）
      useCanvasStore.getState().setFrameCaptureNodeId(null);
      return;
    }
    // 其他派生操作仍在服务端处理中：给出 busy 反馈而不是静默吞掉（与截取一致）
    if (busy || captureAbortRef.current) {
      notifyNodeBusy(notification, t, id);
      return;
    }
    const controller = new AbortController();
    captureAbortRef.current = controller;
    setBusy({ kind: "capture", startedAt: Date.now() });
    // 抽帧被接受：关闭帧截取面板（面板不在确认时自关——busy 守卫拒绝时面板
    // 保持打开、播放位置原样保留可重试，与截取面板的「确认不自关」契约一致）
    useCanvasStore.getState().setFrameCaptureNodeId(null);
    try {
      const videoKey = toFileKey(src);
      const res = await captureFrameApi(videoKey, selection, controller.signal);
      if (controller.signal.aborted) return;
      if (!res.ok) {
        // 后端按错误码给出结论（视频缺失 / 组件未就绪 / 抽帧失败），优先用本地化文案；
        // 限流 / 繁忙响应带 Retry-After，文案附带可重试秒数
        const errJson = await res.json().catch(() => null);
        if (controller.signal.aborted) return;
        notifyActionFailed(notification, t, errJson?.error as string | undefined, "error.capture_frame.capture_failed", id, retryAfterOf(res));
        return;
      }
      const json = await res.json() as { data?: CapturedFrameInfo };
      if (controller.signal.aborted) return;
      const frame = json.data;
      if (!frame?.url) {
        notifyActionFailed(notification, t, undefined, "error.capture_frame.capture_failed", id);
        return;
      }

      const currentNode = useCanvasStore.getState().nodes.find((node) => node.id === id);
      if (currentNode?.type !== NODE_TYPE.VIDEO || currentNode.data.src !== src) return;
      const { width: nw, height: nh, time: capturedTime } = frame;
      const label = `${data.label || t("common.frame")} #${Math.round(capturedTime * 10) / 10}s`;
      await createNodeFromUrl(id, frame.url, nw, nh, label, useCanvasStore.getState(), { source: "derived" }, undefined, label);
    } catch (e) {
      if (controller.signal.aborted) return;
      console.error("Frame capture failed:", e);
      notifyActionFailed(notification, t, undefined, "error.capture_frame.capture_failed", id);
    } finally {
      captureAbortRef.current = null;
      setBusy(null);
    }
  }, [src, data.label, id, t, notification, busy]);

  /**
   * 分离音频：服务端无损拆出音轨与静音视频。
   *
   * 连线策略：两个产物节点都直接连回原视频（原视频 → 静音视频、原视频 → 音频），
   * 与宫格切分一致，不做链式挂接、也不迁移源节点的旧边。
   *
   * 历史栈：先用 write:false 仅构建两个节点，再一次 addNodes + setEdges 同批
   * 写入——addNodes 压一条「分离前」快照，setEdges 被节流不重复压栈，
   * 撤销一次即整体删除两个派生节点及其连线。
   */
  const handleDetachAudio = useCallback(async () => {
    if (!src) return;
    // 其他派生操作仍在服务端处理中：给出 busy 反馈而不是静默吞掉（与截取一致）
    if (busy) {
      notifyNodeBusy(notification, t, id);
      return;
    }
    const videoKey = toFileKey(src);
    setBusy({ kind: "detach", startedAt: Date.now() });
    try {
      const res = await detachAudioApi(videoKey);
      const json = await res.json();

      if (!res.ok || !json?.data) {
        // 后端按错误码给出确定结论（无音轨 / 组件缺失等），优先用其本地化文案；
        // 限流 / 繁忙响应带 Retry-After，文案附带可重试秒数
        const code = json?.error as string | undefined;
        notifyActionFailed(notification, t, code, "detach.failed", id, retryAfterOf(res));
        // 确认无音轨后同步禁用入口，避免用户反复点击撞同一个错误
        if (code === "detach_audio.no_audio_track") commitHasAudio(false);
        return;
      }

      const { audio, video } = json.data as DetachAudioResult;
      const v = videoRef.current;
      const nw = v?.videoWidth || data.naturalWidth || 0;
      const nh = v?.videoHeight || data.naturalHeight || 0;
      const store = useCanvasStore.getState();

      // 1. 仅构建两个节点（write:false 不写 store），随后同批写入
      const mutedNode = createVideoNodeFromUrl(
        id,
        video.url,
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
      const audioNode = createAudioNodeFromUrl(
        id,
        audio.url,
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
    } catch (e) {
      console.error("Audio detach failed:", e);
      notifyActionFailed(notification, t, undefined, "detach.failed", id);
    } finally {
      setBusy(null);
    }
  }, [
    src,
    busy,
    t,
    commitHasAudio,
    data.naturalWidth,
    data.naturalHeight,
    id,
    notification,
  ]);

  /** 节点内上传 / 替换：走统一上传管道（失败自动回滚并提示） */
  const handleUpload = useNodeUpload(id, { accept: "video/*", clearFields: ["hasAudio"] });

  /**
   * 截取片段：服务端按 [start, end] 帧精确重编码截出一段视频，
   * 产物作为派生视频节点连回源节点。
   *
   * 历史栈策略与分离音频一致：write:false 仅构建节点，再一次 addNodes + setEdges
   * 同批写入，撤销一次即整体删除。
   */
  const handleExtractClip = useCallback(async (start: number, end: number) => {
    if (!src) return;
    // 分离音频/裁剪/上一次截取仍在服务端处理中：面板保持打开、选区原样保留
    // 可重试，这里给出 busy 反馈而不是静默吞掉（面板无法感知节点本地的 busy 态）
    if (busy) {
      notifyNodeBusy(notification, t, id);
      return;
    }
    const videoKey = toFileKey(src);
    setBusy({ kind: "clip", startedAt: Date.now() });
    // 退出截取模式：选区已被接受，面板随之卸载（与音频截取确认同一约定）
    useCanvasStore.getState().setClipCaptureNodeId(null);
    try {
      const res = await extractClipApi(videoKey, start, end);
      const json = await res.json();

      if (!res.ok || !json?.data) {
        // 后端按错误码给出确定结论（范围无效 / 超时等），优先用其本地化文案；
        // 限流 / 繁忙响应带 Retry-After，文案附带可重试秒数
        notifyActionFailed(notification, t, json?.error as string | undefined, "error.clip.extract_failed", id, retryAfterOf(res));
        return;
      }

      const { url } = json.data as { url: string };
      const v = videoRef.current;
      const nw = v?.videoWidth || data.naturalWidth || 0;
      const nh = v?.videoHeight || data.naturalHeight || 0;
      const store = useCanvasStore.getState();
      const range = `${formatTime(start)}-${formatTime(end)}`;

      const clipNode = createVideoNodeFromUrl(
        id,
        url,
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
    } catch (e) {
      console.error("Clip extraction failed:", e);
      notifyActionFailed(notification, t, undefined, "error.clip.extract_failed", id);
    } finally {
      setBusy(null);
    }
  }, [src, busy, t, data.naturalWidth, data.naturalHeight, id, notification]);

  /**
   * 裁剪画面：服务端按源像素矩形 crop 并重编码整段视频，
   * 产物作为派生视频节点连回源节点（历史栈策略与片段截取一致）。
   */
  const handleCropVideoApply = useCallback(async (rect: CropRectPx) => {
    if (!src) {
      // 源已失效（清除/撤销）：裁剪无从进行，关掉仍打开的裁剪面板而不是留一个
      // 无响应的确认键（croppingNodeId 的宿主校验兜底见 InfiniteCanvas）
      useCanvasStore.getState().setCroppingNodeId(null);
      return;
    }
    // 其他派生操作仍在服务端处理中：给出 busy 反馈而不是静默吞掉（与截取一致）
    if (busy) {
      notifyNodeBusy(notification, t, id);
      return;
    }
    const videoKey = toFileKey(src);
    setBusy({ kind: "crop", startedAt: Date.now() });
    // 裁剪被接受：关闭裁剪面板（面板不在确认时自关——busy 拒绝时面板保持
    // 打开、选区原样保留可重试，与截取面板的「确认不自关」契约一致）
    useCanvasStore.getState().setCroppingNodeId(null);
    try {
      const res = await cropVideoApi(videoKey, rect);
      const json = await res.json();

      if (!res.ok || !json?.data) {
        notifyActionFailed(notification, t, json?.error as string | undefined, "error.crop.failed", id, retryAfterOf(res));
        return;
      }

      const { url } = json.data as { url: string };
      const store = useCanvasStore.getState();
      const size = `${rect.width}×${rect.height}`;

      const cropNode = createVideoNodeFromUrl(
        id,
        url,
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
    } catch (e) {
      console.error("Video crop failed:", e);
      notifyActionFailed(notification, t, undefined, "error.crop.failed", id);
    } finally {
      setBusy(null);
    }
  }, [src, busy, t, id, notification]);

  const addAsset = useAssetsStore((s) => s.addAsset);

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

  const handleSaveToAssets = useCallback(async () => {
    if (!src) return;
    const node = useCanvasStore.getState().nodes.find(n => n.id === id);
    const d = node?.data as VideoNodeData | undefined;
    // 缩略图不再在保存时生成：素材库读取时通过 sourceUrl?w= 由后端按需抽帧
    await addAsset({
      name: data.label || t("node.video"),
      type: "other",
      mediaType: "video",
      sourceUrl: src,
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
  // 画面裁剪面板：由 croppingNodeId 驱动（与图片裁剪共用状态，互斥天然成立）。
  // 抓帧动作以回调形式交给面板，在其挂载时自取当前帧（裁剪是空间操作，
  // 与播放位置无关），避免在 effect 里同步 setState 造成级联渲染
  const captureFrameSnapshot = useCallback((): { src: string; w: number; h: number } | null => {
    const v = videoRef.current;
    if (!v || !v.videoWidth) return null;
    const canvas = document.createElement("canvas");
    canvas.width = v.videoWidth;
    canvas.height = v.videoHeight;
    canvas.getContext("2d")?.drawImage(v, 0, 0);
    return { src: canvas.toDataURL("image/jpeg", 0.92), w: v.videoWidth, h: v.videoHeight };
  }, []);

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
        {data.upload?.uploading ? (
          <div className="absolute inset-0 rounded-lg overflow-hidden">
            {data.upload?.previewUrl && (
              <video src={data.upload.previewUrl} muted playsInline className="absolute inset-0 w-full h-full object-cover" style={{ filter: "blur(24px)", animation: "breathe 3s ease-in-out infinite" }} />
            )}
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/35 px-8">
              {uploadProgress != null ? (
                <div className="w-3/4 h-1.5 bg-white/10 rounded-full overflow-hidden">
                  <div className="h-full bg-primary rounded-full transition-all duration-300" style={{ width: `${uploadProgress}%` }} />
                </div>
              ) : (
                <div className="w-3/4 h-1.5 bg-white/10 rounded-full overflow-hidden">
                  <div className="h-full bg-primary rounded-full animate-pulse" style={{ width: "60%" }} />
                </div>
              )}
              <span className="text-sm text-white/70 font-medium tabular-nums">
                {t("common.uploading")}
                {uploadProgress != null ? ` ${Math.round(uploadProgress)}%` : ""}
              </span>
            </div>
          </div>
        ) : data.upload?.error ? (
          <UploadFailedOverlay nodeId={id} error={data.upload.error} previewUrl={data.upload.previewUrl} />
        ) : generating ? (
          <GeneratingOverlay absolute={false} startedAt={data.taskBinding?.startedAt} />
        ) : hasVideo && sessionActive ? (
          <div className="w-full h-full relative">
            {/* 海报垫底：会话元素从挂载到解出首帧之间是透明的，卸掉海报会闪黑场。
                视频解出画面后自然盖住海报（同比例 object-contain，边缘对齐），
                挂载→播放→卸载全程无闪烁 */}
            {posterUrl ? (
              <CanvasImage
                nodeId={id}
                src={posterUrl}
                aspect={posterAspect}
                alt={data.label || t("node.video")}
                className="absolute inset-0 size-full object-contain"
                draggable={false}
                placeholderIcon={VideoCameraOutlined}
              />
            ) : (
              <div className="absolute inset-0 bg-black" />
            )}
            {/* 片段截取面板打开期间关闭原生 loop（见 clipOpen 定义处的说明）：
                用响应式属性而非命令式改 DOM，元素重挂也自动带上 */}
            <video
              key={`${sessionEpoch}:${loadingSrc}`}
              ref={setVideoRef}
              src={loadingSrc}
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
            {/* 静止态：首帧海报。无 <video> 元素，浏览器没有可逐出的常驻媒体缓冲；
                hover 播放由 body 的 mouseenter/mouseleave 挂载/卸载会话元素 */}
            {posterUrl ? (
              <CanvasImage
                nodeId={id}
                src={posterUrl}
                aspect={posterAspect}
                alt={data.label || t("node.video")}
                className="size-full object-contain"
                draggable={false}
                placeholderIcon={VideoCameraOutlined}
              />
            ) : (
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

        {/* 会话加载/失败浮层：裁剪面板等会话就绪前给出等待与重试；失败不粘滞，
            重试换 key 重挂元素。 */}
        {((cropOpen && sessionStatus !== "ready") || (sessionActive && sessionStatus === "failed")) && (
          <div className="nodrag nowheel absolute inset-0 z-20 flex flex-col items-center justify-center gap-2 bg-black/70 p-3 text-center text-white" role={sessionStatus === "failed" ? "alert" : "status"}>
            {sessionStatus !== "failed" && <LoadingOutlined className="size-5" />}
            <span className="text-sm">{t(sessionStatus === "failed" ? "media.loadFailed" : "media.loading")}</span>
            <div className="flex flex-wrap justify-center gap-2">
              {sessionStatus === "failed" && <Button size="sm" onClick={retrySession}><ReloadOutlined />{t("media.retry")}</Button>}
              {cropOpen && <Button size="sm" variant="secondary" onClick={() => useCanvasStore.getState().setCroppingNodeId(null)}>{t("common.cancel")}</Button>}
            </div>
          </div>
        )}
        {busy && (
          <BusyOverlay
            label={
              busy.kind === "clip"
                ? t("clip.processing")
                : busy.kind === "detach"
                  ? t("detach.processing")
                  : busy.kind === "crop"
                    ? t("crop.processing")
                    : t("capture.processing")
            }
            startedAt={busy.startedAt}
          />
        )}
      </div>

      {/* 画面裁剪面板：挂 body 之外以露出顶部工具条（与图片裁剪同构） */}
      {cropOpen && sessionStatus === "ready" && (
        <div className="pointer-events-none absolute inset-0 overflow-visible">
          <VideoCropPanel
            nodeId={id}
            captureFrame={captureFrameSnapshot}
            onClose={() => useCanvasStore.getState().setCroppingNodeId(null)}
          />
        </div>
      )}

      {/* 输入轨渲染与否用连线判定的同一能力口径（acceptsInput），避免轨道与可连性分叉 */}
      {acceptsInput(NODE_TYPE.VIDEO, data.source) && <ConnectionSideRail side="left" type="target" />}
      <ConnectionSideRail side="right" type="source" />
      {src && (
        <MediaPreviewOverlay
          open={previewOpen}
          items={[{ url: src, mediaType: "video" }]}
          index={0}
          onClose={() => setPreviewOpen(false)}
        />
      )}
    </div>
  );
}

export default memo(VideoNode);
