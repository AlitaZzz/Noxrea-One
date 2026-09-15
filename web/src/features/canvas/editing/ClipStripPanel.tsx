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
import { getVideoPlaybackTime, isVideoPlaying, pauseVideo, playVideo, seekVideo, setVideoTime, swapVideoSource } from "@/features/canvas/shared/video-playback-registry";
import { EventNames } from "@/lib/constants";
import { formatTime } from "@/lib/utils/format";

/** 播放头所在层左右各留 12px（与 inset-x-3 对齐），按内区换算才能跟手 */
const PLAYHEAD_INSET = 12;
/** 拿不到真实帧率时的回退步进（秒）：小于常见帧率的一帧，保证不会跳过帧 */
const FALLBACK_FRAME_STEP = 1 / 50;
/** 最小区间（s）：拖动与键盘步进都被钳住，防止截出过短片段 */
const MIN_RANGE_S = 0.5;
/** 打开面板时的默认区间长度（s） */
const DEFAULT_RANGE_S = 5;

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
    duration,
    fps,
    truncated,
    declaredDuration,
    status,
  } = useFrameSprite(videoSrc);
  // 代理地址单独留存：它同时也是拖动时节点播放器的临时播放源
  const [proxyUrl, setProxyUrl] = useState<string | null>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  // 拖动结束与组件卸载都要摘掉 window 监听：面板可能在拖动途中被卸载
  const dragCleanupRef = useRef<(() => void) | null>(null);
  useEffect(() => () => dragCleanupRef.current?.(), []);
  // 打开瞬间的播放位置作为区间起点的初始值，之后不再随节点播放变化
  const initialTimeRef = useRef<number | null>(null);
  if (initialTimeRef.current === null) initialTimeRef.current = getVideoPlaybackTime(nodeId);
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
            const json = (await res.json()) as { data?: { url?: string } };
            return json.data?.url ?? null;
          })
          .catch(() => null)
      : Promise.resolve<string | null>(null);
    void request.then((url) => {
      if (cancelled) return;
      setProxyUrl(url);
    });
    return () => {
      cancelled = true;
    };
  }, [videoSrc]);

  // 选帧期间暂停节点播放，避免 hover 播放干扰视觉判断
  useEffect(() => {
    pauseVideo(nodeId);
  }, [nodeId]);

  // 选帧期间把节点播放器切到预览代理；循环播放中的换源在元数据就绪后续播，
  // 暂停中的换源保持暂停；关闭面板自动恢复原视频
  useEffect(() => {
    if (!proxyUrl) return;
    return swapVideoSource(nodeId, proxyUrl, { resume: isVideoPlaying(nodeId) });
  }, [nodeId, proxyUrl]);

  // 时长就绪后初始化：区间起点放在打开时的播放位置，终点向后扩默认区间；
  // 末尾放不下最小区间时向前借（贴尾打开也能拿到合法区间）。
  // 随后立即开始循环播放所选片段（面板打开即预览，无需手动点播放）
  useEffect(() => {
    if (initializedRef.current || duration <= 0) return;
    initializedRef.current = true;
    const minRangeRatio = MIN_RANGE_S / duration;
    const start = clamp01((initialTimeRef.current ?? 0) / duration);
    const end = clamp01(start + DEFAULT_RANGE_S / duration);
    const inR = clamp01(end - minRangeRatio);
    setInRatio(inR);
    // 超短视频（duration < MIN_RANGE_S）：钳到 1 后宽度仍不足最小区间，
    // rangeValid 自然为 false、确认禁用；不钳位会让选区宽度溢出轨道
    setOutRatio(clamp01(Math.max(end, inR + minRangeRatio)));
    seekVideo(nodeId, inR * duration);
    playVideo(nodeId);
  }, [duration, nodeId]);

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

  /** 设置某一只手柄的位置，并钳住最小区间（in 不越过 out，out 不落后于 in） */
  const setHandle = useCallback(
    (which: "in" | "out", next: number) => {
      const minRangeRatio = duration > 0 ? MIN_RANGE_S / duration : 0;
      if (which === "in") {
        setInRatio(clamp01(Math.min(next, outRatio - minRangeRatio)));
      } else {
        setOutRatio(clamp01(Math.max(next, inRatio + minRangeRatio)));
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
    [ratioFromClientX, inRatio, outRatio, duration, nodeId, setHandle, seekPreview],
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
    if (duration <= 0) return;
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
  }, [duration, fps, inRatio, outRatio, activeHandle, setHandle, seekPreview]);

  // 时长是唯一的前置条件：拿不到雪碧图也要能定位与截取，只是轨道上没有画面
  const ready = duration > 0;
  const inTime = ready ? inRatio * duration : 0;
  const outTime = ready ? outRatio * duration : 0;
  const rangeValid = ready && outTime - inTime >= MIN_RANGE_S - 1e-6;

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
  // 回跳必须用 setVideoTime：seekVideo 会 pause，一用循环就变成「只播一圈」
  useEffect(() => {
    if (!ready || duration <= 0) return;
    let raf = 0;
    const tick = () => {
      if (isVideoPlaying(nodeId)) {
        const cur = getVideoPlaybackTime(nodeId);
        if (rangeValid && (cur >= outTime || cur < inTime - 0.05)) {
          setVideoTime(nodeId, inTime);
          setPlayedRatio(inRatio);
        } else {
          setPlayedRatio(clamp01(cur / duration));
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      cancelAnimationFrame(seekRafRef.current);
    };
  }, [ready, duration, nodeId, rangeValid, inTime, outTime, inRatio]);

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
    [ratioFromClientX, inRatio, outRatio, duration, nodeId, seekPreview],
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
            {formatTime((which === "in" ? inRatio : outRatio) * duration)}
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

  // 整块面板不透明：轨道与右侧操作区共用黑色背板，避免按钮直接透出画布内容
  return (
    <div className="canvas-toolbar nodrag nopan nowheel pointer-events-auto flex items-center gap-3 rounded-2xl p-2">
      <div
        ref={trackRef}
        className="relative h-14 w-250 cursor-ew-resize overflow-visible"
        onPointerDown={handleTrackDown}
      >
        <div className="flex size-full overflow-hidden rounded-xl bg-black">{trackCells}</div>

        {/* 区间外压暗 + 选中段青柠描边：不在缩略图上叠实色（半透明色叠彩色
            缩略图会发浑），靠区间外压暗做对比；带子中间常驻显示当前截取时长 */}
        {ready && (
          <div className="pointer-events-none absolute inset-0 z-10 overflow-visible">
            <div className="absolute inset-x-3 inset-y-0">
              <div className="absolute inset-y-0 left-0 bg-black/55" style={{ width: `${inRatio * 100}%` }} />
              <div className="absolute inset-y-0 right-0 bg-black/55" style={{ width: `${(1 - outRatio) * 100}%` }} />
              {/* 中段整体可拖动：按住平移区间（时长不变），端帽 z-30 优先接管两端 */}
              <div
                className="pointer-events-auto absolute inset-y-0 cursor-grab touch-none"
                style={{ left: `${inRatio * 100}%`, width: `${(outRatio - inRatio) * 100}%` }}
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
                    {(outTime - inTime).toFixed(1)}s
                  </span>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* 播放进度竖线：循环扫播当前位置的细线标记（只展示，不接管指针） */}
        {ready && (
          <div className="pointer-events-none absolute inset-0 z-20 overflow-visible">
            <div className="absolute inset-x-3 inset-y-0">
              <div
                className="absolute inset-y-0 w-0.5 -translate-x-1/2 rounded-full bg-white/90"
                style={{ left: `${playedRatio * 100}%` }}
              />
            </div>
          </div>
        )}

        {/* 区间双手柄：白色端帽，z-30 压过着色层；
            手柄容器自带 pointer-events-auto，从 none 的层里把指针事件接回来 */}
        {ready && (
          <div className="pointer-events-none absolute inset-0 z-30 overflow-visible">
            <div className="absolute inset-x-3 inset-y-0 overflow-visible">
              {handleRenderer("in", inRatio)}
              {handleRenderer("out", outRatio)}
            </div>
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
