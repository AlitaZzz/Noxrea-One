/**
 * 视频片段截取面板。
 *
 * 与 FrameStripPanel 同构（雪碧图轨道 + scrub 代理），区别在于轨道上没有独立的
 * 播放头：[起点, 终点] 双手柄与选中区间就是「位置」本身——点击/拖动轨道移动
 * 就近的手柄并连续 scrub，按住选区中段可整段平移，播放被约束在选区内循环，
 * 进度以白色竖线呈现。确认后把区间交给 VideoNode 走既有的事件链路创建派生视频节点。
 *
 * 抽取模式在面板内切换：精确（重编码，帧精确）/ 快速（流拷贝，切点吸附关键帧）。
 *
 * 挂载位置由 InfiniteCanvas 用 RfNodeToolbar(Position.Bottom) 决定：
 * 浮在节点下方居中，且不随画布缩放，轨道尺寸始终稳定。与帧序列面板互斥。
 */
"use client";

import { CheckOutlined, CloseOutlined, WarningOutlined } from "@ant-design/icons";
import { Button, Segmented, Tooltip } from "antd";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { type ClipMode,fetchVideoProxy } from "@/features/canvas/api/file-api";
import { FRAME_TRACK_HEIGHT, useFrameSprite } from "@/features/canvas/hooks/use-frame-sprite";
import { getVideoPlaybackTime, isVideoPlaying, pauseVideo, playVideo, seekVideo, setVideoTime, suppressNativeLoop, swapVideoSource } from "@/features/canvas/shared/video-playback-registry";
import { EventNames } from "@/lib/constants";
import { formatTime } from "@/lib/utils/format";

/** 播放头所在层左右各留 12px（与 inset-x-3 对齐），按内区换算才能跟手 */
const PLAYHEAD_INSET = 12;
/** 拿不到真实帧率时的回退步进（秒）：小于常见帧率的一帧，保证不会跳过帧 */
const FALLBACK_FRAME_STEP = 1 / 50;
/** 最小区间（s）：拖动与键盘步进都被钳住，防止截出过短片段 */
const MIN_RANGE_S = 0.5;
/** 初始区间时长：影片时长的 20%，钳在 [1s, 30s]——短视频不至于一选选走大半部，
    长视频的默认选区也不至于窄到看不清（8 分钟片 5s 只占 1%） */
const INITIAL_RANGE_RATIO = 0.2;
const INITIAL_RANGE_MIN_S = 1;
const INITIAL_RANGE_MAX_S = 30;

/**
 * 计算初始选区：起点在打开时的播放位置，时长为片长 20%（钳 [1s, 30s]）；
 * 贴尾部放不下时整段左滑贴齐片尾。初始化 effect 与「代理就绪前的预览渲染」
 * 共用同一公式，保证预览画出的选区和初始化落下的选区完全一致、无缝接管。
 */
function computeInitialRange(duration: number, startPos: number): { inR: number; outR: number } {
  const minRangeRatio = MIN_RANGE_S / duration;
  const start = clamp01(startPos / duration);
  const rangeRatio =
    Math.min(INITIAL_RANGE_MAX_S, Math.max(INITIAL_RANGE_MIN_S, duration * INITIAL_RANGE_RATIO)) /
    duration;
  const outR = Math.min(1, start + rangeRatio);
  const inR = Math.max(0, outR - rangeRatio);
  // 极短视频（时长不足最小区间）：钳到末尾，rangeValid 自然为 false、确认禁用
  if (outR - inR < minRangeRatio) {
    return { inR: Math.max(0, 1 - minRangeRatio), outR: 1 };
  }
  return { inR, outR };
}

interface ClipStripPanelProps {
  nodeId: string;
  videoSrc: string;
  onClose: () => void;
}

function ClipStripPanel({ nodeId, videoSrc, onClose }: ClipStripPanelProps) {
  const { t } = useTranslation();
  // 轨道缩略图：服务端出的整条雪碧图，拿不到时退化为无缩略图但可定位的轨道
  const {
    url: spriteUrl,
    spriteWidth,
    cellWidth,
    cellHeight,
    count,
    frameWidth,
    duration: spriteDuration,
    fps,
    durationSource,
    truncated,
    declaredDuration,
    status,
  } = useFrameSprite(videoSrc);
  // 代理地址单独留存：它同时也是拖动时节点播放器的临时播放源
  const [proxyUrl, setProxyUrl] = useState<string | null>(null);
  // 代理生命周期：pending = 转码中 / ready = 已挂到节点上 / failed = 生成失败（面板禁用）
  const [proxyState, setProxyState] = useState<"pending" | "ready" | "failed">("pending");
  // 代理文件的真实时长（服务端转码完探测，随响应返回）
  const [proxyDuration, setProxyDuration] = useState<number | null>(null);
  // 代理缓冲就绪（canplay）：首次打开时代理刚生成、浏览器缓存全冷，立即拖动
  // 会触发一串 Range 拉取 + 解码跟不上指针（重开时代理已入缓存故无此问题），
  // 因此缓冲就绪前保持禁用，拖动发生时数据必在本地
  const [bufferReady, setBufferReady] = useState(false);
  // 雪碧图失败时的兜底时长来自浏览器读原视频 moov（截断视频会虚报标称值），
  // 不可信：此时时间轴改用代理的真实时长——代理只含可解码内容，且正是正在
  // 播放的实体。代理时长未知（转码中/失败）时按 0 处理，面板保持禁用
  const duration = durationSource === "fallback" ? proxyDuration ?? 0 : spriteDuration;
  const trackRef = useRef<HTMLDivElement>(null);
  // 拖动结束与组件卸载都要摘掉 window 监听：面板可能在拖动途中被卸载
  const dragCleanupRef = useRef<(() => void) | null>(null);
  useEffect(() => () => dragCleanupRef.current?.(), []);
  // 打开瞬间的播放位置：区间起点与预览渲染的基准（惰性初始化，仅取一次）
  const [initialPosition] = useState(() => getVideoPlaybackTime(nodeId));
  // 区间双手柄与键盘微调目标（默认调终点：从当前播放位置向后扩一段是最常见操作）
  const [activeHandle, setActiveHandle] = useState<"in" | "out">("out");
  const [inRatio, setInRatio] = useState(0);
  const [outRatio, setOutRatio] = useState(1);
  const [mode, setMode] = useState<ClipMode>("precise");
  // 播放进度：只以「选区内已播部分加亮」呈现，不设独立播放头
  const [playedRatio, setPlayedRatio] = useState(0);
  // 拖动状态：null = 未拖动；"in"/"out" = 拖手柄（浮出时间气泡）；"band" = 整段平移
  const [dragging, setDragging] = useState<null | "in" | "out" | "band">(null);
  // 预览 seek 的 rAF 节流句柄：拖动时一帧最多 seek 一次，避免高频 seek 拖垮解码
  const seekRafRef = useRef(0);
  // 拖动开始前是否在循环播放：scrub 中的 seek 会暂停视频，松手后据此恢复循环
  const wasPlayingRef = useRef(false);
  // 区间最新值的 ref 镜像：tick 的 effect 依赖里没有区间值（见 tick 处说明），
  // 初始化/拖动在 setState 的同时更新这里，tick 每帧读到的始终是最新区间
  const loopStateRef = useRef({ inRatio: 0, outRatio: 1 });
  // 初始化是否已写入真实区间：写入前选区/进度线不得渲染——operable 翻 true 的
  // 那次渲染里 inRatio/outRatio 还是 0→1 默认值，直接渲染会闪现「满轨道全选」
  const [rangeInitialized, setRangeInitialized] = useState(false);
  const initializedRef = useRef(false);

  // 取预览代理：拖动时用低分辨率短 GOP 副本做 scrub，seek 最多解码 1 秒画面。
  // 不做「超时就放弃」的竞速：转码完成后自动切过去，swapVideoSource 会把当前
  // 时间点写回，切换不跳位（与 FrameStripPanel 一致）。
  useEffect(() => {
    let cancelled = false;
    const videoKey = videoSrc.replace(/^\/api\/files\//, "").split("?")[0];
    // 拿不到源键（例如本地预览地址）时不请求代理，节点继续用原视频 scrub
    const request = videoKey
      ? fetchVideoProxy(videoKey)
          .then(async (res) => {
            if (!res.ok) return null;
            const json = (await res.json()) as { data?: { url?: string; duration?: number } };
            return json.data?.url
              ? { url: json.data.url, duration: json.data.duration ?? null }
              : null;
          })
          .catch(() => null)
      : Promise.resolve<{ url: string; duration: number | null } | null>(null);
    void request.then((result) => {
      if (cancelled) return;
      setProxyUrl(result?.url ?? null);
      setProxyDuration(result?.duration ?? null);
      setProxyState(result ? "ready" : "failed");
    });
    return () => {
      cancelled = true;
    };
  }, [videoSrc]);

  // 选帧期间暂停节点播放，避免 hover 播放干扰视觉判断
  useEffect(() => {
    pauseVideo(nodeId);
  }, [nodeId]);

  // 面板期间关闭节点 <video> 的原生 loop：区间循环由回跳逻辑控制，
  // 原生 loop 到头会先跳回 0、再被拉回入点，每圈多两次 seek 且画面闪跳
  useEffect(() => suppressNativeLoop(nodeId), [nodeId]);

  // 选帧期间把节点播放器切到预览代理；循环播放中的换源在元数据就绪后续播，
  // 暂停中的换源保持暂停；关闭面板自动恢复原视频。
  // onReady：代理缓冲就绪（canplay）才解锁交互——首次打开时代理刚生成、
  // 浏览器缓存全冷，立即拖动会触发一串 Range 拉取 + 解码跟不上指针
  // （重开时代理已入缓存故无此问题）。监听在 swapVideoSource 内部挂载，
  // 等待的必然是换入的代理而非换源前就绪的旧元素
  useEffect(() => {
    if (!proxyUrl) return;
    return swapVideoSource(nodeId, proxyUrl, {
      resume: isVideoPlaying(nodeId),
      onReady: () => setBufferReady(true),
    });
  }, [nodeId, proxyUrl]);

  // 可操作 = 雪碧图时长可信 + 代理已就绪 + 代理缓冲就绪：三者缺一，时间轴与
  // 画面都不可信（拖原视频长 GOP 必然不跟手、冷缓存 seek 跟不上指针），
  // 拖动/键盘/确认全部禁用——宁等不乱。代理失败时面板禁用，重开面板重试。
  const ready = duration > 0;
  const operable = ready && proxyState === "ready" && proxyUrl !== null && bufferReady;
  const inTime = ready ? inRatio * duration : 0;
  const outTime = ready ? outRatio * duration : 0;
  // rangeValid 必须等初始化写入真实区间：operable 翻 true 的那一帧里
  // inRatio/outRatio 还是 0→1 默认值，不加守卫会允许「截取整段」的误操作窗口
  const rangeValid = operable && rangeInitialized && outTime - inTime >= MIN_RANGE_S - 1e-6;

  // 时长就绪且代理已挂上后初始化：区间用与预览渲染相同的公式（computeInitialRange），
  // 落下的选区和代理转码期间预览的完全一致；随后立即开始循环播放所选片段
  useEffect(() => {
    if (initializedRef.current || !operable) return;
    initializedRef.current = true;
    const { inR, outR } = computeInitialRange(duration, initialPosition);
    setInRatio(inR);
    setOutRatio(outR);
    loopStateRef.current = { inRatio: inR, outRatio: outR };
    setRangeInitialized(true);
    seekVideo(nodeId, inR * duration);
    playVideo(nodeId);
  }, [operable, duration, nodeId, initialPosition]);

  // Esc 关闭：与点击画布空白（取消选中后面板自动卸载）形成一致的退出路径
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const ratioFromClientX = useCallback((clientX: number) => {
    const el = trackRef.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    const inner = rect.width - PLAYHEAD_INSET * 2;
    if (inner <= 0) return null;
    return clamp01((clientX - rect.left - PLAYHEAD_INSET) / inner);
  }, []);

  /** 设置某一只手柄的位置，并钳住最小区间（in 不越过 out，out 不落后于 in）。
      同步把最新区间写进 loopStateRef：tick 的 effect 依赖里没有区间值，
      拖动中读取的是这里维护的最新值 */
  const setHandle = useCallback(
    (which: "in" | "out", next: number) => {
      const minRangeRatio = duration > 0 ? MIN_RANGE_S / duration : 0;
      if (which === "in") {
        const v = clamp01(Math.min(next, outRatio - minRangeRatio));
        setInRatio(v);
        loopStateRef.current.inRatio = v;
      } else {
        const v = clamp01(Math.max(next, inRatio + minRangeRatio));
        setOutRatio(v);
        loopStateRef.current.outRatio = v;
      }
    },
    [duration, inRatio, outRatio],
  );

  /** 预览 seek：rAF 节流（一帧最多一次），并把播放进度推进到该处 */
  const seekPreview = useCallback(
    (time: number) => {
      cancelAnimationFrame(seekRafRef.current);
      seekRafRef.current = requestAnimationFrame(() => seekVideo(nodeId, time));
      setPlayedRatio(duration > 0 ? clamp01(time / duration) : 0);
    },
    [nodeId, duration],
  );

  /** 点击/拖动轨道：移动「就近的那只手柄」，画面连续 scrub 跟手（帧截取同款）；
      scrub 中的 seek 会暂停视频，松手后恢复循环播放 */
  const handleTrackDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      // 雪碧图或代理未就绪：时间轴与画面都不可信（拖原视频长 GOP 必然不跟手），
      // 操作整体禁用——宁等不乱
      if (!operable) return;
      const next = ratioFromClientX(e.clientX);
      if (next === null) return;
      // 就近吸附：离起点近动起点，离终点近动终点，拖动中持续跟手
      const which: "in" | "out" = Math.abs(next - inRatio) <= Math.abs(next - outRatio) ? "in" : "out";
      wasPlayingRef.current = isVideoPlaying(nodeId);
      setActiveHandle(which);
      setDragging(which);
      setHandle(which, next);
      seekPreview(next * duration);
      let latest = next;
      const onMove = (ev: PointerEvent) => {
        ev.preventDefault();
        const r = ratioFromClientX(ev.clientX);
        if (r === null) return;
        latest = r;
        setHandle(which, r);
        seekPreview(r * duration);
      };
      const cleanup = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        dragCleanupRef.current = null;
      };
      // 松手：补一次精确 seek（最后一次 rAF 可能落后于最终指针位置），再恢复循环
      const onUp = () => {
        cleanup();
        setDragging(null);
        seekPreview(latest * duration);
        if (wasPlayingRef.current) playVideo(nodeId);
      };
      dragCleanupRef.current = onUp;
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [ratioFromClientX, operable, inRatio, outRatio, duration, nodeId, setHandle, seekPreview],
  );

  /** 手柄按下：精确抓取某只手柄并阻止冒泡（不触发轨道的就近吸附） */
  const handleHandleDown = useCallback(
    (which: "in" | "out") =>
      (e: React.PointerEvent) => {
        e.preventDefault();
        e.stopPropagation();
        wasPlayingRef.current = isVideoPlaying(nodeId);
        setActiveHandle(which);
        setDragging(which);
        const next = ratioFromClientX(e.clientX);
        let latest: number | null = next;
        if (next !== null) {
          setHandle(which, next);
          seekPreview(next * duration);
        }
        const onMove = (ev: PointerEvent) => {
          ev.preventDefault();
          const r = ratioFromClientX(ev.clientX);
          if (r === null) return;
          latest = r;
          setHandle(which, r);
          seekPreview(r * duration);
        };
        const cleanup = () => {
          window.removeEventListener("pointermove", onMove);
          window.removeEventListener("pointerup", onUp);
          dragCleanupRef.current = null;
        };
        // 与轨道拖动一致：松手补精确 seek，再恢复循环
        const onUp = () => {
          cleanup();
          setDragging(null);
          if (latest !== null) seekPreview(latest * duration);
          if (wasPlayingRef.current) playVideo(nodeId);
        };
        dragCleanupRef.current = onUp;
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
      },
    [ratioFromClientX, duration, nodeId, setHandle, seekPreview],
  );

  // ← / → 按一帧步进微调当前手柄：轨道像素密度不足以精确到帧，用键盘补齐精度
  useEffect(() => {
    if (!operable) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      // 面板打开时可能有输入框持有焦点，方向键要留给它们
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      e.preventDefault();
      const step = fps && fps > 0 ? 1 / fps : FALLBACK_FRAME_STEP;
      const current = activeHandle === "in" ? inRatio : outRatio;
      const minRangeRatio = MIN_RANGE_S / duration;
      const target = current + (e.key === "ArrowRight" ? step : -step) / duration;
      const clamped = activeHandle === "in"
        ? clamp01(Math.min(target, outRatio - minRangeRatio))
        : clamp01(Math.max(target, inRatio + minRangeRatio));
      setHandle(activeHandle, clamped);
      seekPreview(clamped * duration);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [duration, fps, inRatio, outRatio, activeHandle, operable, setHandle, seekPreview]);

  // 单格按 contain 规则缩放并居中，与 FrameStripPanel 的渲染规则一致：
  // 横屏时上下留边、竖屏时左右留边，不会为了铺满格子而裁掉画面。
  const scale = cellWidth > 0 && cellHeight > 0
    ? Math.min(frameWidth / cellWidth, FRAME_TRACK_HEIGHT / cellHeight)
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

  // 播放被约束在选区内循环：到达终点跳回起点，起点被拖到播放位置之后也拉回，
  // 保证扫播始终落在所选片段里；播放中同步推进进度竖线。
  // 回跳必须用 setVideoTime：seekVideo 会 pause，一用循环就变成「只播一圈」。
  //
  // effect 依赖只有 operable/duration/nodeId——若把区间放进依赖，拖动的每次
  // pointermove 都会重建本 effect，其 cleanup 会把 seekPreview 刚调度、尚未
  // 执行的 seek 一并 cancel（共用 rAF 句柄的时序竞态），表现为拖动时画面偶尔
  // 完全不动、松手才跳一下，且是否复现取决于 effect flush 与 rAF 的先后，
  // 纯随机。cleanup 只准取消自己的 rAF。
  useEffect(() => {
    if (!operable || duration <= 0) return;
    let raf = 0;
    const tick = () => {
      if (isVideoPlaying(nodeId)) {
        const cur = getVideoPlaybackTime(nodeId);
        const { inRatio: iR, outRatio: oR } = loopStateRef.current;
        const iT = iR * duration;
        const oT = oR * duration;
        if (oT - iT >= MIN_RANGE_S - 1e-6 && (cur >= oT || cur < iT - 0.05)) {
          setVideoTime(nodeId, iT);
          setPlayedRatio(iR);
        } else {
          setPlayedRatio(clamp01(cur / duration));
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [operable, duration, nodeId]);

  const handleConfirm = useCallback(() => {
    if (!rangeValid) return;
    window.dispatchEvent(
      new CustomEvent(EventNames.CANVAS_NODE_ACTION, {
        detail: { nodeId, action: "extract-clip", start: inTime, end: outTime, mode },
      }),
    );
    onClose();
  }, [rangeValid, nodeId, inTime, outTime, mode, onClose]);

  /** 整段平移：按住亮带中段拖动，时长不变地平移整个区间（两端同步钳在轨道内）。
      画面连续 scrub 到新区间的入点帧（与拖手柄一致），松手后恢复循环播放 */
  const handleBandDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (!operable) return; // 雪碧图/代理未就绪：禁用操作（与轨道拖动同一守卫）
      const start = ratioFromClientX(e.clientX);
      if (start === null) return;
      wasPlayingRef.current = isVideoPlaying(nodeId);
      setDragging("band");
      const width = outRatio - inRatio;
      const startIn = inRatio;
      let latestIn = startIn;
      seekPreview(startIn * duration);
      const onMove = (ev: PointerEvent) => {
        ev.preventDefault();
        const r = ratioFromClientX(ev.clientX);
        if (r === null) return;
        latestIn = Math.min(Math.max(0, startIn + (r - start)), 1 - width);
        setInRatio(latestIn);
        setOutRatio(latestIn + width);
        loopStateRef.current = { inRatio: latestIn, outRatio: latestIn + width };
        seekPreview(latestIn * duration);
      };
      const cleanup = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        dragCleanupRef.current = null;
      };
      // 松手：补一次精确 seek（最后一次 rAF 可能落后于最终指针位置），再恢复循环
      const onUp = () => {
        cleanup();
        setDragging(null);
        seekPreview(latestIn * duration);
        if (wasPlayingRef.current) playVideo(nodeId);
      };
      dragCleanupRef.current = onUp;
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [ratioFromClientX, operable, inRatio, outRatio, duration, nodeId, seekPreview],
  );

  const handleRenderer = (which: "in" | "out", ratio: number) => (
    <div
      className="pointer-events-auto absolute inset-y-0"
      style={{ left: `${ratio * 100}%` }}
    >
      <div
        className="absolute top-0 h-full w-3.5 -translate-x-1/2 cursor-ew-resize touch-none"
        onPointerDown={handleHandleDown(which)}
      >
        {/* 拖动中的时间气泡：跟随当前拖动的手柄，悬停在轨道上方 */}
        {dragging === which && (
          <div
            className="absolute bottom-full left-1/2 mb-1 -translate-x-1/2 rounded-md px-2 py-0.5 text-xs tabular-nums text-white"
            style={{ background: "var(--canvas-bg-elevated)", boxShadow: "0 4px 12px rgba(0,0,0,0.45)" }}
          >
            {/* 时间用 2 位小数（10ms）：低于一帧时长（30fps ≈ 33ms），配得上帧级定位 */}
            {((which === "in" ? inRatio : outRatio) * duration).toFixed(2)}s
          </div>
        )}
        {/* 端帽：白色竖条，激活侧全亮（色带用青柠，端帽保持中性白） */}
        <div
          className="absolute left-1/2 top-0 h-full w-1.5 -translate-x-1/2 rounded-full bg-white"
          style={{ opacity: activeHandle === which ? 1 : 0.7 }}
        />
      </div>
    </div>
  );

  // 雪碧图格子的元素引用做记忆化：拖动手柄的高频重渲染里，元素引用不变则整块
  // 跳过 diff，每次拖动只重渲染填充/竖线/手柄这几层轻量 div，进一步压低跟手延迟
  const trackCells = useMemo(() => {
    if (!ready) {
      return (
        <div className="flex size-full items-center justify-center px-4 text-xs text-white/60">
          {status === "error" ? t("capture.unavailable") : t("capture.loading")}
        </div>
      );
    }
    if (count > 0 && spriteUrl) {
      return Array.from(Array(count).keys()).map((i) => (
        <div
          key={i}
          className="relative h-full shrink-0 overflow-hidden"
          style={{ width: frameWidth, marginLeft: i === 0 ? 0 : -1 }}
        >
          <div className="absolute bg-black" style={cellStyle(i)} />
        </div>
      ));
    }
    // 雪碧图不可用：退化为空轨道，双手柄与时间码仍可定位与截取
    return <div className="size-full bg-white/10" />;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, count, spriteUrl, frameWidth, cellWidth, cellHeight, scale, spriteWidth, status, t]);

  // 代理转码期间的选区预览：与初始化同一公式（computeInitialRange），先把最终
  // 形态画出来（仅展示、不可交互），代理就绪后初始化落下的区间与预览完全
  // 一致、无缝接管——不再出现「先全亮像全选、代理好了才出现选区」的观感
  const previewRange =
    ready && !rangeInitialized ? computeInitialRange(duration, initialPosition) : null;
  const bandRange = rangeInitialized
    ? { inR: inRatio, outR: outRatio }
    : previewRange;

  // 整块面板不透明：轨道与右侧操作区共用黑色背板，避免按钮直接透出画布内容
  return (
    <div className="canvas-toolbar nodrag nopan nowheel pointer-events-auto flex items-center gap-3 rounded-2xl p-2">
      <div
        ref={trackRef}
        className="relative h-14 w-250 cursor-ew-resize overflow-visible"
        onPointerDown={handleTrackDown}
      >
        <div className="flex size-full overflow-hidden rounded-xl bg-black">{trackCells}</div>

        {/* 压暗层铺满整条轨道、贴住选区框边缘：若沿用选区的内缩坐标系
            （inset-x-3，给播放头圆点留 12px），两端各剩 12px 格子永远压不到暗，
            观感是「最左侧没被压暗」；宽度用 calc 按内缩坐标系换算 */}
        {bandRange && (
          <>
            <div className="pointer-events-none absolute inset-0 z-10">
              <div
                className="absolute inset-y-0 left-0 bg-black/55"
                style={{ width: `calc(12px + (100% - 24px) * ${bandRange.inR})` }}
              />
              <div
                className="absolute inset-y-0 right-0 bg-black/55"
                style={{ width: `calc(12px + (100% - 24px) * ${1 - bandRange.outR})` }}
              />
            </div>
            <div className="pointer-events-none absolute inset-0 z-10 overflow-visible">
              <div className="absolute inset-x-3 inset-y-0">
                {/* 中段整体可拖动：按住平移区间（时长不变），端帽 z-30 优先接管两端 */}
                <div
                  className={`pointer-events-auto absolute inset-y-0 touch-none ${operable ? "cursor-grab" : "cursor-default"}`}
                  style={{ left: `${bandRange.inR * 100}%`, width: `${(bandRange.outR - bandRange.inR) * 100}%` }}
                  onPointerDown={handleBandDown}
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
                      {((bandRange.outR - bandRange.inR) * duration).toFixed(2)}s
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </>
        )}

        {/* 播放进度竖线：循环扫播当前位置的细线标记（只展示，不接管指针） */}
        {operable && rangeInitialized && (
          <div className="pointer-events-none absolute inset-0 z-20 overflow-visible">
            <div className="absolute inset-x-3 inset-y-0">
              <div
                className="absolute inset-y-0 w-0.5 -translate-x-1/2 rounded-full bg-white/90"
                style={{ left: `${playedRatio * 100}%` }}
              />
            </div>
          </div>
        )}

        {/* 区间双手柄：白色端帽，z-30 压过着色层（未初始化/代理未就绪不渲染）；
            手柄容器自带 pointer-events-auto，从 none 的层里把指针事件接回来 */}
        {operable && rangeInitialized && (
          <div className="pointer-events-none absolute inset-0 z-30 overflow-visible">
            <div className="absolute inset-x-3 inset-y-0 overflow-visible">
              {handleRenderer("in", inRatio)}
              {handleRenderer("out", outRatio)}
            </div>
          </div>
        )}

        {/* 代理未就绪/缓冲中/失败的面板级提示：可操作前提是雪碧图 + 代理 + 缓冲都就绪 */}
        {ready && !operable && (
          <div className="pointer-events-none absolute inset-0 z-40 flex items-center justify-center">
            <span
              className="rounded-md px-3 py-1 text-xs text-white/85"
              style={{ background: "rgba(0,0,0,0.65)" }}
            >
              {proxyState === "failed"
                ? t("clip.proxyFailed")
                : proxyState === "pending"
                  ? t("clip.proxyLoading")
                  : t("clip.buffering")}
            </span>
          </div>
        )}
      </div>

      {/* 截取时长已常驻显示在轨道亮带中间，这里不再重复时间码 */}

      <div className="w-px h-5 mx-1" style={{ background: "var(--canvas-border)" }} />

      {/* 截断文件的轨道已收敛到可解码范围：标称时长超出部分是坏数据，提示用户 */}
      {truncated && declaredDuration !== null && (
        <Tooltip
          title={t("capture.truncated", {
            actual: formatTime(duration),
            declared: formatTime(declaredDuration),
          })}
        >
          <WarningOutlined style={{ color: "var(--canvas-warning)" }} />
        </Tooltip>
      )}

      {/* 每个模式各自的 tooltip（antd Segmented 原生 option.tooltip）；
          title:"" 显式覆盖 rc-segmented 默认塞到 item 上的原生 title（= label 文本），
          否则悬停会出现浏览器原生黑块提示 */}
      <Segmented
        size="small"
        value={mode}
        onChange={(v) => setMode(v as ClipMode)}
        options={[
          { label: t("clip.modePrecise"), value: "precise", title: "", tooltip: t("clip.modePreciseHint") },
          { label: t("clip.modeFast"), value: "fast", title: "", tooltip: t("clip.modeFastHint") },
        ]}
      />

      <div className="w-px h-5 mx-1" style={{ background: "var(--canvas-border)" }} />

      {/* 取消 / 确认：与裁剪、标注编辑条使用同一套图标语义（X 取消、✓ 确认） */}
      <Tooltip title={t("common.cancel")}>
        <Button type="text" size="middle" style={{ padding: 8 }} icon={<CloseOutlined />} onClick={onClose} />
      </Tooltip>
      <Tooltip title={t("clip.confirm")}>
        <Button
          type="text"
          size="middle"
          style={{ padding: 8, color: rangeValid ? "var(--canvas-success)" : undefined }}
          icon={<CheckOutlined />}
          disabled={!rangeValid}
          onClick={handleConfirm}
        />
      </Tooltip>
    </div>
  );
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

export default ClipStripPanel;
