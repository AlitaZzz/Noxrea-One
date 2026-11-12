/**
 * 视频帧序列面板。
 *
 * 打开时加载整条轨道的缩略图（服务端一次解码生成的雪碧图），用户拖动播放头
 * 定位到目标帧，点「截取」才真正抽帧——时间通过 canvas:node-action 事件交给
 * VideoNode，复用既有的后端抽帧与派生节点创建链路。
 *
 * 拖动前必须先拿到预览代理：原视频多为长 GOP，直接 seek 不跟手。代理就绪
 * （含浏览器缓冲）前轨道禁用 scrub，只保留截取入口；雪碧图失败时时间轴改用
 * 代理的真实时长，不用浏览器读到的标称值（截断文件会虚报）。
 *
 * 挂载位置由 CanvasOverlays 的节点级浮层用 RfNodeToolbar(Position.Bottom) 决定：
 * 浮在节点下方居中，且不随画布缩放，轨道尺寸始终稳定。
 */
"use client";

import { storageKeyOf } from "@noxrea/shared/url";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { CloseOutlined, WarningOutlined } from "@/components/ui/AppIcon";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import IconActionButton from "@/components/ui/IconActionButton";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { FRAME_TRACK_HEIGHT, FRAME_TRACK_WIDTH, useFrameSprite } from "@/features/canvas/hooks/use-frame-sprite";
import { useProxyPlayback } from "@/features/canvas/hooks/use-proxy-playback";
import { useVideoTimeSource } from "@/features/canvas/hooks/use-video-time-source";
import { useCanvasInputBlocked } from "@/features/canvas/root/CanvasInputGateContext";
import { isEditableTarget } from "@/features/canvas/shared/dom";
import { dispatchNodeAction } from "@/features/canvas/shared/node-action";
import { getVideoPlaybackTime, pauseVideo, seekVideo } from "@/features/canvas/shared/video-playback-registry";
import { useMediaProgress } from "@/lib/use-media-progress";
import { formatTime } from "@/lib/utils/format";
import { clamp01 } from "@/lib/utils/number";

import { ratioFromClientX } from "./clip-range";
import { MediaRetryNotice } from "./MediaRetryNotice";
import { demoteRetryNotice, proxyNoticeOf, ProxyNoticeTextOverlay } from "./ProxyNotice";
import { resolveTrackDuration } from "./track-duration";
import useEscapeToClose from "./use-escape-to-close";
import { startWindowPointerSession } from "./window-pointer-session";

/** 拿不到真实帧率时的回退步进（秒）：小于常见帧率的一帧，保证不会跳过帧 */
const FALLBACK_FRAME_STEP = 1 / 50;

interface FrameStripPanelProps {
  nodeId: string;
  videoRef: string;
  onClose: () => void;
}

function FrameStripPanel({ nodeId, videoRef, onClose }: FrameStripPanelProps) {
  const { t } = useTranslation();
  const inputBlocked = useCanvasInputBlocked();
  // 媒体接口只接受存储 key：代理 / 抽帧都以此判定；外部 URL 仍可播放但不提供编辑
  const videoKey = storageKeyOf(videoRef);
  // 轨道缩略图：服务端出的整条雪碧图，拿不到时轨道退化为无缩略图形态；能否定位
  // 由预览代理是否可播放另行判定。spriteError 带失败原因（限流 / 繁忙 / 生成失败），
  // 在轨道上提示并由用户手动重试
  const {
    url: spriteUrl,
    spriteWidth,
    cellWidth,
    cellHeight,
    count,
    frameWidth,
    duration: spriteDuration,
    durationSource,
    fps,
    truncated,
    declaredDuration,
    status,
    error: spriteError,
    retry: retrySprite,
  } = useFrameSprite(videoRef);
  // 代理地址同时也是拖动时节点播放器的临时播放源；状态 / 真实时长 / 失败原因与
  // 重试由共享 hook 提供，换源与「浏览器已缓冲」的判定也收敛在那里。
  // 代理可播放前轨道禁用 scrub——原视频长 GOP 拖动卡顿
  const proxyPlayback = useProxyPlayback(nodeId, videoRef);
  const {
    status: proxyStatus,
    duration: proxyDuration,
    error: proxyError,
    retry: retryProxy,
    playable: proxyPlayable,
  } = proxyPlayback;
  const trackRef = useRef<HTMLDivElement>(null);
  // 拖动结束与组件卸载都要摘掉 window 监听：面板可能在拖动途中被卸载
  const dragCleanupRef = useRef<(() => void) | null>(null);
  useEffect(() => () => dragCleanupRef.current?.(), []);
  // 打开瞬间的播放位置作为播放头初始位置，之后不再随节点播放变化
  const initialTimeRef = useRef<number | null>(null);
  if (initialTimeRef.current === null) initialTimeRef.current = getVideoPlaybackTime(nodeId);
  const [ratio, setRatio] = useState(0);
  const initializedRef = useRef(false);
  // 区分「用户操作播放头」与「跟随节点播放」：只有前者需要 seek，
  // 否则跟随播放时会反向 seek，而 seek 里的 pause 会立刻打断播放
  const userDrivenRef = useRef(false);
  const setRatioByUser = useCallback((next: number) => {
    userDrivenRef.current = true;
    setRatio(next);
  }, []);

  // 选帧期间暂停节点播放，避免 hover 播放干扰视觉判断
  useEffect(() => {
    pauseVideo(nodeId);
  }, [nodeId]);

  const duration = resolveTrackDuration(durationSource, spriteDuration, proxyDuration);
  const ready = duration > 0;
  // 可拖动 = 有时长可映射 + 代理可下载 + 浏览器已缓冲换入的代理：缺一都退回
  // 原视频长 GOP scrub，正是要避免的卡顿；时长未知时轨道同样保持禁用
  const canScrub = ready && proxyPlayable;
  const proxyNotice = proxyNoticeOf(proxyPlayback);
  // 帧面板的重试入口留在底部原因条：中央只给不可操作的文字说明
  const centerNotice = demoteRetryNotice(proxyNotice);
  const currentTime = ready ? ratio * duration : 0;

  // 时长就绪后把播放头放到打开时的播放位置（首帧渲染时 duration 仍为 0）
  useEffect(() => {
    if (initializedRef.current || duration <= 0) return;
    initializedRef.current = true;
    setRatioByUser(clamp01((initialTimeRef.current ?? 0) / duration));
  }, [duration, setRatioByUser]);

  // Esc 关闭：与点击画布空白（取消选中后面板自动卸载）形成一致的退出路径
  useEscapeToClose(onClose);

  // ← / → 按一帧步进：轨道像素密度不足以选中长视频的每一帧，用键盘补齐精度
  useEffect(() => {
    if (!canScrub || duration <= 0) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      // 面板打开时可能有输入框持有焦点，方向键要留给它们
      if (isEditableTarget(e.target)) return;
      // 上层浮层打开时方向键归浮层控件（与 useEscapeToClose 的输入门守卫一致），
      // 否则隐藏面板会抢走方向键、把弹窗里的滑杆等控件卡住
      if (inputBlocked) return;
      e.preventDefault();
      const step = fps && fps > 0 ? 1 / fps : FALLBACK_FRAME_STEP;
      userDrivenRef.current = true;
      setRatio((r) => clamp01(r + (e.key === "ArrowRight" ? step : -step) / duration));
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [canScrub, duration, fps, inputBlocked]);

  const handleTrackDown = useCallback(
    (e: React.PointerEvent) => {
      // 禁用态也拦住事件：轨道在节点 HUD 内，不能让按下穿透成画布拖动
      e.preventDefault();
      e.stopPropagation();
      if (!canScrub) return;
      const next = ratioFromClientX(trackRef.current, e.clientX);
      if (next !== null) setRatioByUser(next);
      const onMove = (ev: PointerEvent) => {
        ev.preventDefault();
        const r = ratioFromClientX(trackRef.current, ev.clientX);
        if (r !== null) setRatioByUser(r);
      };
      let detach = () => {};
      // pointercancel / 窗口失焦都按取消收尾：失焦后浏览器可能不再派发
      // pointerup，残留会话会让未按键的移动继续搓擦播放头，并挂起节点时间跟随
      const cleanup = () => {
        detach();
        dragCleanupRef.current = null;
      };
      const onUp = () => cleanup();
      detach = startWindowPointerSession({
        onMove,
        onUp,
        onCancel: cleanup,
        onBlur: cleanup,
      });
      dragCleanupRef.current = cleanup;
    },
    [canScrub, setRatioByUser],
  );

  // 单格按 contain 规则缩放并居中，与之前 img + object-contain 的效果一致：
  // 横屏时上下留边、竖屏时左右留边，不会为了铺满格子而裁掉画面。
  //
  // 内层 div 的尺寸正好等于单格内容，用它把连续的雪碧图裁出当前格。不能直接把
  // 背景画满整格再做居中偏移——雪碧图里格子首尾相连，竖屏时内容窄于格宽，居中
  // 让出的那几像素正好露出下一格的画面。
  //
  // 缩放用 cover（max）而不是 contain（min）：contain 会在竖屏视频的每格左右
  // 留黑边、横屏视频上下留黑边，相邻格子的黑边连成「竖线」观感；cover 铺满
  // 格子后缩略条视觉连续，代价是每格只显示帧的中间部分（识别足够）。
  const scale = cellWidth > 0 && cellHeight > 0
    ? Math.max(frameWidth / cellWidth, FRAME_TRACK_HEIGHT / cellHeight)
    : 0;
  const cellStyle = (index: number) => ({
    left: (frameWidth - cellWidth * scale) / 2,
    top: (FRAME_TRACK_HEIGHT - cellHeight * scale) / 2,
    width: cellWidth * scale,
    height: cellHeight * scale,
    backgroundImage: `url(${spriteUrl})`,
    backgroundSize: `${spriteWidth * scale}px ${cellHeight * scale}px`,
    backgroundPosition: `${-index * cellWidth * scale}px 0`,
    backgroundRepeat: "no-repeat" as const,
  });

  // 节点播放时播放头跟随：复用节点控件栏的播放按钮，边听边看；
  // 暂停后播放头即停在当前帧，再用 ←/→ 微调
  // 跟随范围：节点的任何位置变化（播放推进 / 拖节点进度条 / 点击跳转）都实时
  // 反映到播放头与时间码；面板自身轨道拖动期间挂起——拖动中节点时间的轻微
  // 滞后会把播放头往回拽，松手后恢复。挂起只跳过写入：读取注册表无副作用。
  const readNodeTime = useVideoTimeSource(nodeId);
  useMediaProgress(readNodeTime, ready, (cur) => {
    if (dragCleanupRef.current) return;
    setRatio(clamp01(cur / duration));
  });

  // 拖动播放头时同步 seek 节点播放器，形成 scrubbing 预览；
  // rAF 节流保证一帧最多 seek 一次，避免高频 seek 拖垮解码
  useEffect(() => {
    // 跟随播放引起的 ratio 变化不需要 seek——那会触发 seekVideo 里的 pause，把播放打断。
    // 代理未就绪时也不 seek：原视频长 GOP 拖动不跟手，且 fallback 时长可能是虚报的
    if (!ready || !canScrub || !userDrivenRef.current) return;
    userDrivenRef.current = false;
    const raf = requestAnimationFrame(() => seekVideo(nodeId, ratio * duration));
    return () => cancelAnimationFrame(raf);
  }, [ready, canScrub, nodeId, ratio, duration]);

  const handleCapture = useCallback(() => {
    if (!ready || !videoKey) return;
    // 时间轴末端可能落在音轨尾部（容器时长 > 视频流末帧）；越界请求由服务端
    // 收敛到末帧，前端不做猜测性截断——截断留余量会把贴边选择悄悄改成前一帧
    const time = Math.max(0, currentTime);
    // 不在这里关面板：busy 守卫拒绝时（clip.busy 提示）面板保持打开、播放
    // 位置原样保留可重试；抽帧被接受后节点会清除 frameCaptureNodeId 关闭面板
    dispatchNodeAction(nodeId, "capture-frame", { selection: { kind: "time", seconds: time } });
  }, [ready, currentTime, nodeId, videoKey]);

  // 整块面板不透明：轨道与右侧操作区共用黑色背板，避免按钮直接透出画布内容
  return (
    <Card className="nodrag nopan nowheel pointer-events-auto flex flex-row items-center gap-3 rounded-2xl p-2">
      {/* 左组：✗ 关闭 + 标题 */}
      <div className="flex shrink-0 items-center gap-1">
        <Button size="icon" variant="ghost" onClick={onClose} ><CloseOutlined /></Button>
        <span className="text-[13px] text-foreground">{t("node.captureFrame")}</span>
      </div>

      <Separator orientation="vertical" className="h-5 self-center" />

      <div
        ref={trackRef}
        className={`relative h-14 overflow-visible ${canScrub ? "cursor-ew-resize" : "cursor-default"}`}
        style={{ width: FRAME_TRACK_WIDTH }}
        onPointerDown={handleTrackDown}
      >
        {/* 视觉层统一裁剪进轨道圆角：背板与帧格不得溢出圆角；
            overflow-visible 留给播放头圆点（伸出轨道顶缘）等浮层 */}
        <div className="pointer-events-none absolute inset-0 overflow-hidden rounded-lg">
          {/* 背板铺满整条轨道，格子铺满内容区——与播放头坐标系一致（同片段截取面板） */}
          <div className="absolute inset-0 bg-black" />
          <div className="absolute inset-0 flex overflow-hidden">
            {ready ? (
              count > 0 && spriteUrl ? (
                Array.from(Array(count).keys()).map((i) => (
                  // 帧格只做展示，不挂钩点击定位：定位统一交给轨道的指针事件。
                  // 若在这里定位，松手时浏览器补发的 click 会把播放头吸附回格中心，
                  // 表现为「松手后位置跳一下」（格数少时尤其像吸到整数秒）
                  //
                  // 不再追加 -1px 左边距（contain 时代用于遮蔽格子间接缝）：
                  // cover 模式下内容溢出格子被裁切，边缘本就被自身背景盖住，
                  // 累计 -1px 只会让末尾格子的右缘逐渐偏离轨道右缘、播放头超出雪碧图
                  <div
                    key={i}
                    className="relative h-full shrink-0 overflow-hidden"
                    style={{ width: frameWidth }}
                  >
                    <div className="absolute bg-black" style={cellStyle(i)} />
                  </div>
                ))
              ) : (
                // 雪碧图不可用：退化为空轨道，代理就绪后播放头与时间码仍可定位与截取
                <div className="size-full bg-white/10" />
              )
            ) : centerNotice ? null : (
              <div className="flex size-full items-center justify-center px-4 text-xs text-white/60">
                {/* 雪碧图已失败，或雪碧图已定论、代理已就绪却仍拿不到时长：不再等待 */}
                {status === "error" || (proxyStatus === "ready" && status !== "loading")
                  ? t("capture.unavailable")
                  : t("capture.loading")}
              </div>
            )}
          </div>
        </div>

        {/* 代理未就绪 / 缓冲中：轨道禁用 scrub 的居中说明。失败时中央只留文字，
            底部原因条承担重试；时长未就绪（ready=false）时中央提示同样要出现，
            不能被通用占位文案盖住 */}
        <ProxyNoticeTextOverlay notice={centerNotice} />

        {/* 播放头：白色圆点 + 竖线 */}
        {ready && (
          <div className="pointer-events-none absolute inset-0 z-20 overflow-visible">
            <div
              className="absolute top-0 h-full -translate-x-1/2"
              style={{ left: `${ratio * 100}%` }}
            >
              <div className="relative h-14 w-4 touch-none">
                <div className="absolute -top-1 left-1/2 size-4 -translate-x-1/2 rounded-full bg-white shadow-[0_4px_12px_rgba(0,0,0,0.45)]" />
                <div className="absolute bottom-px left-1/2 top-0.5 w-0.5 -translate-x-1/2 bg-white/95" />
              </div>
            </div>
          </div>
        )}

        {/* 雪碧图 / 代理失败原因 + 手动重试：不静默失败。代理失败时轨道保持禁用，
            不退回原视频长 GOP scrub；限流 / 繁忙时带 Retry-After 倒计时 */}
        {(spriteError || proxyError) && (
          <div className="pointer-events-none absolute inset-x-0 bottom-1.5 z-30 flex flex-col items-center gap-1">
            {spriteError && (
              <div className="max-w-full -translate-y-0">
                <MediaRetryNotice error={spriteError} onRetry={retrySprite} />
              </div>
            )}
            {proxyError && (
              <div className="max-w-full">
                <MediaRetryNotice error={proxyError} onRetry={retryProxy} />
              </div>
            )}
          </div>
        )}
      </div>

      <span className="text-foreground text-sm tabular-nums">{formatTime(currentTime)}</span>

      {/* 截断文件的轨道已收敛到可解码范围：标称时长超出部分是坏数据，提示用户 */}
      {truncated && declaredDuration !== null && (
        <Tooltip><TooltipTrigger asChild>
            <WarningOutlined className="text-chart-4" />
          </TooltipTrigger><TooltipContent>{t("capture.truncated", {
              actual: formatTime(duration),
              declared: formatTime(declaredDuration),
            })}</TooltipContent></Tooltip>
      )}

      <Separator orientation="vertical" className="h-5 self-center" />

      {/* 确认：反色 ↑（与其它编辑工具栏一致） */}
      <IconActionButton onClick={handleCapture} disabled={!ready || !videoKey} />
    </Card>
  );
}

export default FrameStripPanel;
