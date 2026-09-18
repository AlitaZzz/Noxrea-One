/**
 * 音频波形播放器展示组件（基于 wavesurfer.js）。
 * 纯受控 UI：负责波形绘制、进度光标与播放按钮，播放态由父组件传入，
 * 通过回调向上抛出进度与就绪时长；另导出通用的时间格式化函数。
 *
 * 片段截取模式（clipMode）：波形上叠加 [起点, 终点] 双手柄选区，播放被约束在
 * 选区内循环，键盘 ←/→ 按 0.01s 步进（Shift ×10）；✓/✗ 工具栏由本组件通过
 * RfNodeToolbar 挂在节点上方（与其它编辑工具栏统一）。
 */
"use client";

import { CheckOutlined, CloseOutlined } from "@ant-design/icons";
import { NodeToolbar as RfNodeToolbar, Position } from "@xyflow/react";
import { useCallback, useEffect, useRef, useState } from "react";
import WaveSurfer from "wavesurfer.js";

import { PauseIcon } from "@/components/ui/icons/media/PauseIcon";
import { PlayIcon } from "@/components/ui/icons/media/PlayIcon";
import AudioClipPanel from "@/features/canvas/editing/AudioClipPanel";
import { clamp01, computeInitialRange, MIN_RANGE_S } from "@/features/canvas/editing/clip-range";
import { formatTime } from "@/lib/utils/format";

/** 波形绘制高度（wavesurfer canvas），固定上限，不随容器拉伸 */
const WAVEFORM_HEIGHT = 64;

/** 进度竖线高度：刻意高于波形，上下各冒出一截；容器不够高时由 maxHeight 兜底 */
const CURSOR_HEIGHT = 96;

/** 键盘微调步进（s）：对齐时间标签的显示精度（0.01s），Shift ×10 = 0.1s */
const AUDIO_STEP_S = 0.01;

interface AudioWaveformProps {
  url: string;
  /** 音频总时长（秒），用于底部时间显示 */
  duration?: number;
  /** 外部控制播放/暂停（true = 播放） */
  playing?: boolean;
  onToggle?: (next: boolean) => void;
  /** 进度变化回调（0~1） */
  onProgress?: (progress: number) => void;
  /** 波形就绪（音源元数据加载完成）回调，返回时长（秒） */
  onReady?: (duration: number) => void;
  /** 片段截取模式：波形上叠加双手柄选区与循环试听；
      ✓/✗ 工具栏由本组件通过 RfNodeToolbar 挂在节点上方 */
  clipMode?: boolean;
  nodeId?: string;
  /** 截取确认：携带选区 [start, end]（秒） */
  onClipConfirm?: (start: number, end: number) => void;
  /** 取消截取 */
  onClipCancel?: () => void;
}

/**
 * 基于 wavesurfer.js 的音频波形播放器，参考统一设计：
 * 波形区 + 进度光标 + 底部时间栏与圆形播放按钮 + 右上角重新上传。
 */
export default function AudioWaveform({
  url,
  duration = 0,
  playing = false,
  onToggle,
  onProgress,
  onReady,
  clipMode = false,
  nodeId,
  onClipConfirm,
  onClipCancel,
}: AudioWaveformProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WaveSurfer | null>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [current, setCurrent] = useState(0);
  // wavesurfer 的真实播放态：截取模式的循环试听由组件内部直接调 ws.play()，
  // 不经过父组件的 playing 属性——按钮图标必须镜像实例的真实状态
  const [wsPlaying, setWsPlaying] = useState(false);

  // 用 ref 保存最新回调，避免重建 wavesurfer 实例
  const onProgressRef = useRef(onProgress);
  const onReadyRef = useRef(onReady);
  const onToggleRef = useRef(onToggle);
  useEffect(() => {
    onProgressRef.current = onProgress;
    onReadyRef.current = onReady;
    onToggleRef.current = onToggle;
  }, [onProgress, onReady, onToggle]);

  // 初始化 / 切换音源
  useEffect(() => {
    if (!containerRef.current) return;
    setReady(false);
    setFailed(false);
    setCurrent(0);

    const ws = WaveSurfer.create({
      container: containerRef.current,
      height: WAVEFORM_HEIGHT,
      // 波形用不透明白色绘制，整体透明度交给 CSS（.canvases 层）控制：
      // 进度层是 source-in 叠加，若 waveColor 自带 alpha 会把进度色一并变淡。
      waveColor: "#ffffff",
      progressColor: "#c7f43d",
      cursorColor: "#c7f43d",
      cursorWidth: 0,
      barWidth: 2,
      barGap: 1,
      barRadius: 2,
      url,
      interact: false,
    });
    wsRef.current = ws;

    ws.on("ready", () => {
      setReady(true);
      onReadyRef.current?.(ws.getDuration());
    });
    ws.on("error", () => setFailed(true));
    ws.on("play", () => {
      setWsPlaying(true);
      // 同步父组件的播放态镜像：保证退出截取/自然播完后按钮行为一致
      onToggleRef.current?.(true);
    });
    ws.on("pause", () => {
      setWsPlaying(false);
      onToggleRef.current?.(false);
    });
    ws.on("finish", () => {
      setWsPlaying(false);
      onToggleRef.current?.(false);
    });
    ws.on("timeupdate", (c: number) => {
      setCurrent(c);
      const d = ws.getDuration();
      if (d > 0) onProgressRef.current?.(c / d);
    });

    return () => {
      ws.destroy();
      wsRef.current = null;
    };
  }, [url]);

  // 同步外部播放状态
  useEffect(() => {
    const ws = wsRef.current;
    if (!ws || !ready) return;
    if (playing) ws.play();
    else ws.pause();
  }, [playing, ready]);

  const toggle = useCallback(() => {
    if (!ready || failed) return;
    // 以实例的真实播放态为准取反（截取模式内部调 ws.play() 不经过父组件）
    onToggle?.(!wsPlaying);
  }, [ready, failed, wsPlaying, onToggle]);

  // ── 片段截取模式 ──────────────────────────────────────────────
  // 区间双手柄与键盘微调目标；clipLoopRef 是区间的最新值镜像：
  // 循环 tick 的 effect 依赖里没有区间值（避免拖动中重建 effect 的竞态），
  // 拖动/键盘在 setState 的同时更新这里，tick 每帧读到的始终是最新区间
  const [clipRange, setClipRange] = useState<{ inR: number; outR: number } | null>(null);
  const [clipHandle, setClipHandleActive] = useState<"in" | "out">("out");
  const [clipDragging, setClipDragging] = useState<null | "in" | "out" | "band">(null);
  const [clipInit, setClipInit] = useState(false);
  const [clipInitRange, setClipInitRange] = useState<{ inR: number; outR: number } | null>(null);
  const clipLoopRef = useRef({ inR: 0, outR: 1 });

  const clipOperable = clipMode && ready && !failed && duration > 0;
  const clipRangeValid = clipRange !== null && duration > 0 && (clipRange.outR - clipRange.inR) * duration >= MIN_RANGE_S - 1e-6;

  // 进入/退出截取模式时清空选区（渲染期派生调整：按 prop 变化调整 state，
  // React 官方写法——effect 内同步 setState 会触发级联渲染告警）
  const [prevClipMode, setPrevClipMode] = useState(clipMode);
  if (prevClipMode !== clipMode) {
    setPrevClipMode(clipMode);
    setClipRange(null);
    setClipDragging(null);
    setClipInit(false);
  }

  // 就绪后初始化选区（渲染期派生调整）：起点在当前播放位置
  // （取自 timeupdate 维护的 current 状态），时长为片长 20%（钳 [1s, 30s]）；
  // clipLoopRef 的落位与播放头归位在下方 effect 里执行（渲染期禁止访问 ref）
  if (clipOperable && !clipInit) {
    setClipInit(true);
    const start = current;
    const { inR, outR } = computeInitialRange(duration, start);
    setClipRange({ inR, outR });
    setClipInitRange({ inR, outR });
  }

  // 选区初始化落位：镜像写入 clipLoopRef（循环 tick 的最新值来源），
  // 播放头归位到入点并开始循环试听
  useEffect(() => {
    if (!clipInit || !clipInitRange) return;
    clipLoopRef.current = { ...clipInitRange };
    const ws = wsRef.current;
    if (!ws) return;
    ws.setTime(clipInitRange.inR * duration);
    ws.play();
  }, [clipInit, clipInitRange, duration]);

  // 退出截取模式时停止试听播放（回到节点的常规播放形态，播放头停在当前位置）
  useEffect(() => {
    if (clipMode) return;
    wsRef.current?.pause();
  }, [clipMode]);
  const setClipHandle = useCallback(
    (which: "in" | "out", next: number) => {
      const minRangeRatio = duration > 0 ? MIN_RANGE_S / duration : 0;
      const prev = clipLoopRef.current;
      const v = which === "in"
        ? clamp01(Math.min(next, prev.outR - minRangeRatio))
        : clamp01(Math.max(next, prev.inR + minRangeRatio));
      const nextRange = which === "in" ? { ...prev, inR: v } : { ...prev, outR: v };
      setClipRange(nextRange);
      clipLoopRef.current = nextRange;
    },
    [duration],
  );

  /** 截取预览定位：音频 seek 廉价，直接 setTime */
  const clipSeek = useCallback((time: number) => {
    wsRef.current?.setTime(Math.max(0, time));
  }, []);

  const clipRatioFromClientX = useCallback((clientX: number) => {
    const el = seekRef.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0) return null;
    return clamp01((clientX - rect.left) / rect.width);
  }, []);

  // ← / → 按 0.01s 步进微调当前手柄（Shift ×10 = 0.1s）：对齐时间标签显示精度
  useEffect(() => {
    if (!clipOperable) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      // 面板打开时可能有输入框持有焦点，方向键要留给它们
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      e.preventDefault();
      const step = AUDIO_STEP_S * (e.shiftKey ? 10 : 1);
      const prev = clipLoopRef.current;
      const current = clipHandle === "in" ? prev.inR : prev.outR;
      const minRangeRatio = duration > 0 ? MIN_RANGE_S / duration : 0;
      const target = current + (e.key === "ArrowRight" ? step : -step) / duration;
      const v = clipHandle === "in"
        ? clamp01(Math.min(target, prev.outR - minRangeRatio))
        : clamp01(Math.max(target, prev.inR + minRangeRatio));
      const nextRange = clipHandle === "in" ? { ...prev, inR: v } : { ...prev, outR: v };
      setClipRange(nextRange);
      clipLoopRef.current = nextRange;
      wsRef.current?.setTime((clipHandle === "in" ? nextRange.inR : nextRange.outR) * duration);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [clipOperable, clipHandle, duration]);

  // 播放被约束在选区内循环：到达终点跳回起点，起点被拖到播放位置之后也拉回，
  // 保证试听始终落在所选片段里。区间最新值经 clipLoopRef 提供（依赖里没有区间
  // 值，拖动不重建 effect——与视频片段截取面板同一款竞态规避）。
  useEffect(() => {
    if (!clipOperable || duration <= 0) return;
    // 首次 tick：把播放头归位到入点并开始循环试听（选区初始化在渲染期已完成）
    let entered = false;
    let raf = 0;
    const tick = () => {
      const ws = wsRef.current;
      if (ws) {
        const cur = ws.getCurrentTime();
        const { inR, outR } = clipLoopRef.current;
        const iT = inR * duration;
        const oT = outR * duration;
        if (!entered) {
          entered = true;
          ws.setTime(iT);
          ws.play();
        } else if (ws.isPlaying() && oT - iT >= MIN_RANGE_S - 1e-6 && (cur >= oT || cur < iT - 0.05)) {
          ws.setTime(iT);
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [clipOperable, duration]);

  // 截取模式下的拖动：which = "in"/"out" 精确抓取手柄；"track" 点击轨道移动
  // 就近手柄；"band" 按住亮带整段平移。区间更新读 clipLoopRef 镜像（最新值）。
  const clipStartDrag = useCallback(
    (which: "in" | "out" | "track" | "band", e: React.PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const start = clipRatioFromClientX(e.clientX);
      if (start === null) return;
      const bandWidth = clipLoopRef.current.outR - clipLoopRef.current.inR;
      const startIn = clipLoopRef.current.inR;
      const active: "in" | "out" =
        which === "out" || (which === "track" && Math.abs(start - clipLoopRef.current.outR) < Math.abs(start - clipLoopRef.current.inR))
          ? "out"
          : "in";
      setClipDragging(which === "track" ? active : which);
      if (which !== "band") setClipHandleActive(active);

      const applyAt = (r: number) => {
        if (which === "band") {
          const latestIn = Math.min(Math.max(0, startIn + (r - start)), 1 - bandWidth);
          const nextRange = { inR: latestIn, outR: latestIn + bandWidth };
          setClipRange(nextRange);
          clipLoopRef.current = nextRange;
          clipSeek(latestIn * duration);
        } else {
          setClipHandle(active, r);
          clipSeek(r * duration);
        }
      };
      applyAt(start);
      const onMove = (ev: PointerEvent) => {
        ev.preventDefault();
        const r = clipRatioFromClientX(ev.clientX);
        if (r !== null) applyAt(r);
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        setClipDragging(null);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [clipRatioFromClientX, clipSeek, duration, setClipHandle],
  );

  /** 截取确认：把选区（秒）交给父级走提取链路 */
  const handleClipConfirm = useCallback(() => {
    if (!clipRangeValid || !clipRange) return;
    onClipConfirm?.(clipRange.inR * duration, clipRange.outR * duration);
  }, [clipRangeValid, clipRange, duration, onClipConfirm]);

  // 在波形区按下/拖动即可定位播放进度（进度光标）；截取模式由选区叠层接管
  const seekRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);

  const seekFromEvent = useCallback(
    (e: React.PointerEvent) => {
      const ws = wsRef.current;
      const el = seekRef.current;
      if (!ws || !el) return;
      const rect = el.getBoundingClientRect();
      const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
      ws.seekTo(ratio);
    },
    []
  );

  const handleSeekMove = useCallback(
    (e: React.PointerEvent) => {
      if (!draggingRef.current) return;
      e.stopPropagation();
      seekFromEvent(e);
    },
    [seekFromEvent]
  );

  const handleSeekUp = useCallback((e: React.PointerEvent) => {
    draggingRef.current = false;
    (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
  }, []);

  // 竖线（进度光标）位置：仅在竖线上切换指针样式
  const progress = duration > 0 ? Math.min(1, Math.max(0, current / duration)) : 0;

  const handleCursorDown = useCallback(
    (e: React.PointerEvent) => {
      if (!ready || failed || clipMode) return;
      e.stopPropagation();
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      draggingRef.current = true;
    },
    [ready, failed, clipMode]
  );

  // 截取选区的渲染几何：以波形容器（seekRef）为坐标系
  const clipBand = clipMode && clipRange ? clipRange : null;
  const clipInteractive = clipMode && ready && !failed;

  const clipHandleRenderer = (which: "in" | "out", ratio: number) => (
    <div
      className="pointer-events-auto absolute inset-y-0"
      style={{ left: `${ratio * 100}%` }}
    >
      <div
        className="nodrag nopan absolute top-0 h-full w-3.5 -translate-x-1/2 cursor-ew-resize touch-none"
        onPointerDown={(e) => clipStartDrag(which, e)}
      >
        {clipDragging === which && (
          <div
            className="absolute bottom-full left-1/2 mb-1 -translate-x-1/2 rounded-md px-2 py-0.5 text-xs tabular-nums text-white"
            style={{ background: "var(--canvas-bg-elevated)", boxShadow: "0 4px 12px rgba(0,0,0,0.45)" }}
          >
            {((which === "in" ? clipRange?.inR ?? 0 : clipRange?.outR ?? 0) * duration).toFixed(2)}s
          </div>
        )}
        <div
          className="absolute left-1/2 top-0 h-full w-1.5 -translate-x-1/2 rounded-full bg-white"
          style={{ opacity: clipHandle === which ? 1 : 0.7 }}
        />
      </div>
    </div>
  );

  return (
    <>
      {/* 截取工具栏：编辑目录的 AudioClipPanel（时间段 + ✓/✗），与其它编辑工具栏统一 */}
      {clipMode && (
        <AudioClipPanel
          nodeId={nodeId}
          range={clipRange ? { start: clipRange.inR * duration, end: clipRange.outR * duration } : null}
          onConfirm={handleClipConfirm}
          onCancel={onClipCancel}
        />
      )}
      <div className="relative h-full w-full">
      {/* 底部留白大于顶部：控制栏（时间 / 播放按钮）不贴节点下沿 */}
      <div className="flex h-full flex-col px-2 pt-2 pb-5">
        {/* 波形区（点击不定位，可拖动节点；仅竖线可拖动定位） */}
        <div
          className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden"
          style={{
            // 背景透明：直接复用节点 body 底色，不再叠一层深灰
            background: "transparent",
            borderRadius: 8,
            padding: "8px 12px",
          }}
        >
          {/* 波形与竖线放在同一个容器里：竖线按百分比定位，
              只有与波形等宽才能和波形时间轴对齐（原先的 px-2 包裹层会让两者错位）。
              容器自身高于波形：波形在其中垂直居中，竖线占满容器高度。 */}
          <div
            ref={seekRef}
            className={`relative flex w-full items-center ${clipInteractive ? "cursor-ew-resize" : ""}`}
            style={{ height: CURSOR_HEIGHT, maxHeight: "100%" }}
            onPointerDown={clipInteractive ? (e) => clipStartDrag("track", e) : undefined}
          >
            <div
              ref={containerRef}
              className="audio-waveform w-full"
              style={{ opacity: failed ? 0 : 1, minHeight: WAVEFORM_HEIGHT }}
            />
            {/* 自定义进度竖线：仅在该竖线上切换指针样式并支持拖动（截取模式由选区接管） */}
            {ready && !failed && !clipMode && (
              <div
                className="absolute top-0 bottom-0 nodrag"
                style={{
                  left: `${progress * 100}%`,
                  width: 12,
                  transform: "translateX(-50%)",
                  cursor: "col-resize",
                  touchAction: "none",
                  zIndex: 5,
                }}
                onPointerDown={handleCursorDown}
                onPointerMove={handleSeekMove}
                onPointerUp={handleSeekUp}
                onPointerCancel={handleSeekUp}
              >
                {/* 进度竖线：占满竖线容器，因此高于波形本身 */}
                <div
                  className="absolute left-1/2 top-0 bottom-0 -translate-x-1/2"
                  style={{ width: 2, background: "#c7f43d", borderRadius: 1 }}
                />
              </div>
            )}

            {/* ── 片段截取叠层：压暗 / 选区 / 双手柄（以波形容器为坐标系）──
                手柄与亮带自带 stopPropagation，压过容器的就近手柄判定 */}
            {clipBand && (
              <>
                <div className="pointer-events-none absolute inset-0 z-10">
                  <div
                    className="absolute inset-y-0 left-0 bg-black/55 rounded-sm"
                    style={{ width: `${clipBand.inR * 100}%` }}
                  />
                  <div
                    className="absolute inset-y-0 right-0 bg-black/55 rounded-sm"
                    style={{ width: `${(1 - clipBand.outR) * 100}%` }}
                  />
                </div>
                <div className="pointer-events-none absolute inset-0 z-10 overflow-visible">
                  <div
                    className={`pointer-events-auto nodrag nopan absolute inset-y-0 touch-none ${clipDragging === "band" ? "cursor-grabbing" : "cursor-grab"}`}
                    style={{ left: `${clipBand.inR * 100}%`, width: `${(clipBand.outR - clipBand.inR) * 100}%` }}
                    onPointerDown={(e) => clipStartDrag("band", e)}
                  >
                    <div
                      className="absolute inset-0"
                      style={{
                        border: "2px solid var(--canvas-accent)",
                        background: "color-mix(in srgb, var(--canvas-accent) 14%, transparent)",
                      }}
                    />
                    <div className="absolute inset-0 flex items-center justify-center">
                      <span
                        className="rounded-md px-2 py-0.5 text-xs tabular-nums text-white"
                        style={{ background: "var(--canvas-bg-elevated)", boxShadow: "0 4px 12px rgba(0,0,0,0.45)" }}
                      >
                        {((clipBand.outR - clipBand.inR) * duration).toFixed(2)}s
                      </span>
                    </div>
                  </div>
                </div>
                <div className="pointer-events-none absolute inset-0 z-20 overflow-visible">
                  <div
                    className="absolute inset-y-0 w-0.5 -translate-x-1/2 rounded-full bg-white/90"
                    style={{ left: `${progress * 100}%` }}
                  />
                </div>
                <div className="pointer-events-none absolute inset-0 z-30 overflow-visible">
                  {clipHandleRenderer("in", clipBand.inR)}
                  {clipHandleRenderer("out", clipBand.outR)}
                </div>
              </>
            )}
          </div>
          {failed && (
            <div className="absolute inset-0 flex items-center justify-center text-xs text-red-400">
              音频加载失败
            </div>
          )}
        </div>

        {/* 底部控制栏：时间 + 播放按钮（截取模式下播放按钮控制选区循环试听） */}
        <div className="relative mt-2 flex items-center px-3">
          <div className="whitespace-nowrap text-sm tabular-nums text-white/70">
            {formatTime(current)} / {formatTime(duration)}
          </div>
          <button
              type="button"
              onClick={toggle}
              disabled={!ready || failed}
              className="nodrag absolute left-1/2 flex -translate-x-1/2 items-center justify-center gap-0.5 transition-opacity disabled:opacity-50"
              style={{
                width: 24,
                height: 24,
                padding: 0,
                borderRadius: "100%",
                border: "0.5px solid rgb(82, 82, 82)",
                background: "rgba(31, 31, 31, 0.9)",
                boxShadow: "rgba(0,0,0,0.12) 0px 4px 10px 0px, rgba(0,0,0,0.2) 0px 2px 4px 0px",
                backdropFilter: "blur(16px)",
                color: "rgba(255,255,255,0.9)",
                cursor: "pointer",
              }}
            >
              {wsPlaying ? (
                <PauseIcon />
              ) : (
                <PlayIcon />
              )}
            </button>
        </div>
      </div>
    </div>
    </>
  );
}
