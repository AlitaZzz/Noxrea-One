/**
 * 音频片段截取面板。
 *
 * 与视频片段截取面板（ClipStripPanel）同构：轨道自带 wavesurfer 波形，
 * [起点, 终点] 双手柄选区即「位置」本身——点击/拖动轨道移动就近的手柄并
 * 连续 scrub，按住选区中段可整段平移，播放被约束在选区内循环，进度以
 * 白色竖线呈现。确认后把区间交给 AudioNode 走既有的事件链路创建派生音频节点。
 *
 * 挂载位置由 InfiniteCanvas 用 RfNodeToolbar(Position.Bottom) 决定：
 * 浮在节点下方居中，且不随画布缩放。面板持有独立的 wavesurfer 实例
 * （节点内的实例跨组件共享不可行），打开即用、关闭即销毁。
 */
"use client";

import { CloseOutlined } from "@ant-design/icons";
import { Button } from "antd";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import WaveSurfer from "wavesurfer.js";

import { FRAME_TRACK_WIDTH } from "@/features/canvas/hooks/use-frame-sprite";
import { getAudioPlaybackTime, pauseAudio } from "@/features/canvas/shared/audio-playback-registry";
import { isEditableTarget } from "@/features/canvas/shared/dom";
import { dispatchNodeAction } from "@/features/canvas/shared/node-action";
import { useCanvasStore } from "@/features/canvas/stores/canvas-store";
import { SEEK_MARGIN_S } from "@/lib/constants";

import { clamp01, clampBandPan, computeInitialRange, isOutsideLoopRange, isRangeLongEnough, MIN_RANGE_S, ratioFromClientX } from "./clip-range";
import PrimaryActionButton from "./PrimaryActionButton";
import useEscapeToClose from "./use-escape-to-close";
import usePlaybackBlocked from "./use-playback-blocked";

/** 面板波形绘制高度（wavesurfer canvas）：轨道总高 40+16=56px 与视频截取
    面板的轨道（h-14）对齐，两个面板上下相邻时高度一致 */
const PANEL_WAVE_HEIGHT = 40;

/** 键盘微调步进（s）：对齐时间标签的显示精度（0.01s），Shift ×10 = 0.1s */
const AUDIO_STEP_S = 0.01;

/** band 原地点击 vs 拖动平移的位移阈值（轨道比例）：1000px 轨道下 ≈5px，
    吸收常规手抖——1px 阈值会被按下到首帧 move 间的微小抖动误判成拖动 */
const BAND_MOVE_THRESHOLD = 0.005;

interface AudioClipStripPanelProps {
  nodeId: string;
  audioSrc: string;
  onClose: () => void;
}

export default function AudioClipStripPanel({ nodeId, audioSrc, onClose }: AudioClipStripPanelProps) {
  const { t } = useTranslation();
  const trackRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WaveSurfer | null>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [duration, setDuration] = useState(0);
  // 播放位置（秒）：进度竖线与拖动气泡的实时来源
  const [current, setCurrent] = useState(0);
  // 自动播放被浏览器拦截时置位（init 的自动 play() 被策略拒绝等）：面板无播放
  // 控件，必须提示用户用下一次真实点击（面板内按下轨道）或方向键恢复试听
  const play = useCallback(() => wsRef.current?.play(), []);
  const { playbackBlocked, resume, resumeIfBlocked } = usePlaybackBlocked(play);
  // 面板打开即暂停节点自身播放（避免双声叠加），并记录当时的播放位置作为
  // 选区起点——与视频片段截取面板行为一致（ref 即可：无需触发重渲染）
  const initialPositionRef = useRef(0);
  useEffect(() => {
    pauseAudio(nodeId);
    initialPositionRef.current = getAudioPlaybackTime(nodeId);
  }, [nodeId]);
  // 拖动结束与组件卸载（Esc / 点空白）都要摘掉 window 监听：面板可能在拖动途中被卸载
  const dragCleanupRef = useRef<(() => void) | null>(null);
  // 当前拖动占用的指针 id：并发第二根指针（双指误触）不得启动第二个拖动，
  // 否则两套 applyAt 互相打架、dragCleanupRef 相互覆盖
  const dragPointerRef = useRef<number | null>(null);
  useEffect(() => () => dragCleanupRef.current?.(), []);

  // 区间双手柄与键盘微调目标（默认调终点）。
  // 声明在 wavesurfer 初始化 effect 之前：选区在 ready 回调里同步初始化，
  // 回调需要写 setClipRange
  const [clipRange, setClipRange] = useState<{ inR: number; outR: number } | null>(null);
  const [clipHandle, setClipHandleActive] = useState<"in" | "out">("out");
  const [clipDragging, setClipDragging] = useState<null | "in" | "out" | "band">(null);
  // 进度位置去重：tick 每帧读 currentTime，只有变化超过阈值才触发重渲染
  // （与视频片段截取面板同款，替代 wavesurfer timeupdate 的每帧 setState）
  const lastCurRef = useRef(0);

  // 区间最新值镜像：循环 tick 的 effect 依赖里没有区间值（避免拖动中重建
  // effect 的竞态），拖动/键盘在 setState 的同时更新这里，tick 每帧读到的
  // 始终是最新区间；finish 兜底回调也读这里拿到当前入点。
  const clipLoopRef = useRef({ inR: 0, outR: 1 });

  /** 循环约束的唯一实现：播放越出选区即折回入点。rAF tick（可见时）与
      timeupdate（隐藏标签页里 rAF 停转的后备）共用，规则只写一处防漂移 */
  const enforceLoop = useCallback((d: number) => {
    const ws = wsRef.current;
    if (!ws || !ws.isPlaying()) return;
    const { inR, outR } = clipLoopRef.current;
    const iT = inR * d;
    const oT = outR * d;
    if (isRangeLongEnough(iT, oT) && isOutsideLoopRange(ws.getCurrentTime(), iT, oT)) {
      ws.setTime(iT);
    }
  }, []);

  // 初始化面板自己的 wavesurfer（样式选项与节点内波形一致）
  useEffect(() => {
    if (!containerRef.current) return;

    const ws = WaveSurfer.create({
      container: containerRef.current,
      height: PANEL_WAVE_HEIGHT,
      // 波形形态与节点内一致（细条），仅加粗加大间距、提高透明度：
      // 面板轨道放大到 1000px 后 2px 条偏稀疏单薄，选区亮带对比不足
      waveColor: "#ffffff",
      progressColor: "#c7f43d",
      cursorColor: "#c7f43d",
      cursorWidth: 0,
      barWidth: 3,
      barGap: 2,
      barRadius: 2,
      url: audioSrc,
      interact: false,
    });
    wsRef.current = ws;
    ws.on("ready", () => {
      const d = ws.getDuration();
      setDuration(d);
      setReady(true);
      // 选区在 ready 回调里同步初始化：若留给 effect，operable 翻 true 的提交
      // 与 effect 执行之间存在窗口，期间的轨道点击会把默认区间 {inR:0, outR:1}
      // 当作已初始化写死（init 因 clipRange 非空被跳过），选区错且无自动循环
      if (d > 0) {
        const { inR, outR } = computeInitialRange(d, initialPositionRef.current);
        setClipRange({ inR, outR });
        clipLoopRef.current = { inR, outR };
        ws.setTime(inR * d);
        // 播放被浏览器拦截时 resume 会置 playbackBlocked 提示，
        // 下一次按下轨道/方向键（真实手势）即恢复
        resume();
      }
    });
    ws.on("error", () => setFailed(true));
    // 选区出点在文件末尾时的循环兜底：媒体自然结束（ended 置位）先于 rAF
    // 观察到 cur >= oT——isPlaying() 在 ended 瞬间已为 false，循环 tick 永远
    // 看不到越界。必须监听 finish 把播放头拉回入点续播，否则试听播到文件尾
    // 就永久停止（面板没有播放控件，节点按钮又被 clipActive 锁住）。
    // 区间无效（短于最小区间的音频）时不续播：播完即停，否则 finish 无条件
    // 续播会形成不受控的整文件循环，而面板没有停止控件
    ws.on("finish", () => {
      const d = ws.getDuration();
      const { inR, outR } = clipLoopRef.current;
      if (d > 0 && isRangeLongEnough(inR * d, outR * d)) {
        ws.setTime(inR * d);
        resume();
      }
    });
    // 隐藏标签页里 rAF 停转、tick 失效，而音频会继续播出选区之外：
    // timeupdate（后台仍以低频触发）作为循环约束的后备执行路径
    ws.on("timeupdate", () => {
      const d = ws.getDuration();
      if (d > 0) enforceLoop(d);
    });

    return () => {
      ws.destroy();
      wsRef.current = null;
    };
    // resume / enforceLoop 引用稳定（play thunk 为 useCallback []），
    // 进 deps 不引发重建
  }, [audioSrc, resume, enforceLoop]);

  const operable = ready && !failed && duration > 0;
  const inTime = clipRange ? clipRange.inR * duration : 0;
  const outTime = clipRange ? clipRange.outR * duration : 0;
  // 选区经 ready 回调同步批置（setReady/setDuration/setClipRange 同一回调）：
  // operable 为真时 clipRange 必非空，inTime/outTime 即真实选区
  const rangeValid = operable && isRangeLongEnough(inTime, outTime);
  const progress = duration > 0 ? clamp01(current / duration) : 0;

  // Esc 关闭：与点击画布空白（取消选中后面板自动卸载）形成一致的退出路径
  useEscapeToClose(onClose);

  // 卸载时停掉面板内的试听播放（wavesurfer 随 effect cleanup 销毁，双保险）
  useEffect(() => () => { wsRef.current?.pause(); }, []);

  /** 设置某一只手柄的位置，并钳住最小区间（in 不越过 out，out 不落后于 in）。
      同步把最新区间写进 clipLoopRef：拖动中读取的是这里维护的最新值。
      返回写入后的区间，供键盘微调等调用方在钳制结果上继续操作（如 setTime） */
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
      return nextRange;
    },
    [duration],
  );

  /** 截取预览定位：音频 seek 廉价，直接 setTime。上钳在文件末尾前 SEEK_MARGIN_S：
      ratio 恰为 1.0 时 seek 到精确 duration 会立即触发 finish 折回入点 */
  const clipSeek = useCallback((time: number) => {
    const ws = wsRef.current;
    if (!ws) return;
    const max = duration > 0 ? Math.max(0, duration - SEEK_MARGIN_S) : time;
    ws.setTime(Math.min(Math.max(0, time), max));
  }, [duration]);

  // ← / → 按 0.01s 步进微调当前手柄（Shift ×10 = 0.1s）：对齐时间标签显示精度
  useEffect(() => {
    if (!operable) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      // 面板打开时可能有输入框持有焦点，方向键要留给它们
      if (isEditableTarget(e.target)) return;
      // 上层弹窗打开时方向键归弹窗控件（与 useEscapeToClose 的 modalOpen 守卫一致），
      // 否则隐藏面板会抢走方向键、把弹窗里的滑杆等控件卡住
      const st = useCanvasStore.getState();
      if (st.modalOpen || st.directorOverlayOpen) return;
      e.preventDefault();
      // 自动播放曾被拦截：keydown 是有效的用户激活，键盘微调同样恢复试听
      resumeIfBlocked();
      const step = AUDIO_STEP_S * (e.shiftKey ? 10 : 1);
      const target = (clipHandle === "in" ? clipLoopRef.current.inR : clipLoopRef.current.outR)
        + (e.key === "ArrowRight" ? step : -step) / duration;
      const nextRange = setClipHandle(clipHandle, target);
      // 与拖动逻辑一致：只有入点变化时把播放头带到新起点，
      // 调出点不挪播放头，避免循环 tick 越界折回造成「从头播放」
      if (clipHandle === "in") {
        wsRef.current?.setTime(nextRange.inR * duration);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [operable, clipHandle, duration, setClipHandle, resumeIfBlocked]);

  // 播放被约束在选区内循环：到达终点跳回起点，起点被拖到播放位置之后也拉回，
  // 保证试听始终落在所选片段里。区间最新值经 clipLoopRef 提供（依赖里没有区间
  // 值，拖动不重建 effect——与视频片段截取面板同一款竞态规避）。
  useEffect(() => {
    if (!operable) return;
    let raf = 0;
    const tick = () => {
      const ws = wsRef.current;
      if (ws) {
        const cur = ws.getCurrentTime();
        // 进度线唯一驱动：播放推进 / seek / 点击定位都实时反映，静止时零渲染
        if (Math.abs(cur - lastCurRef.current) > 0.003) {
          lastCurRef.current = cur;
          setCurrent(cur);
        }
        // 循环约束走 enforceLoop（与 timeupdate 共用唯一实现，见其注释）
        enforceLoop(duration);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [operable, duration, enforceLoop]);

  // 截取模式下的拖动：which = "in"/"out" 精确抓取手柄；"track" 点击轨道——
  // 选区外挪动该侧边界（入点左侧 → 入点、出点右侧 → 出点，与「就近」等价）；
  // "band" 按住亮带：拖动整段平移，原地点击（未移动）= 定位播放头试听。
  // 区间更新读 clipLoopRef 镜像（最新值）。
  const clipStartDrag = useCallback(
    (which: "in" | "out" | "track" | "band", e: React.PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (!operable) return;
      if (dragPointerRef.current !== null) return;
      const start = ratioFromClientX(trackRef.current, e.clientX);
      if (start === null) return;
      const pointerId = e.pointerId;
      const { inR, outR } = clipLoopRef.current;
      // 选区内的按下永远由 band/端帽叠层接管（stopPropagation），轨道只看得到
      // 选区外的点击：入点左侧挪入点、出点右侧挪出点（与「就近」等价）
      const mode: "in" | "out" | "band" =
        which === "track" ? (start < inR ? "in" : "out") : which;
      const bandWidth = outR - inR;
      const startIn = inR;
      // 自动播放曾被拦截：本次按下是真实手势，顺带恢复循环试听。
      // band 模式例外：按下时还没有定位目标（原地点击在 onUp 才定位），
      // 先播后跳会有几十毫秒从旧播放头出声的错位爆音，恢复推迟到定位之后
      if (mode !== "band") resumeIfBlocked();
      dragPointerRef.current = pointerId;
      setClipDragging(mode);
      if (mode === "in" || mode === "out") setClipHandleActive(mode);

      // band 模式区分「拖动平移」与「原地点击定位」：位移越过死区才算拖动
      let bandMoved = false;
      const applyAt = (r: number) => {
        if (mode === "band") {
          const moved = Math.abs(r - start) > BAND_MOVE_THRESHOLD;
          // 死区内不改动区间：原地点击保持区间原样，只有真拖动才平移。
          // 从死区进入拖动的瞬间恢复播放：同任务内紧跟 seek，不露旧位置音
          if (moved && !bandMoved) {
            bandMoved = true;
            resumeIfBlocked();
          }
          if (!bandMoved) return;
          const latestIn = clampBandPan(startIn, r - start, bandWidth);
          const nextRange = { inR: latestIn, outR: latestIn + bandWidth };
          setClipRange(nextRange);
          clipLoopRef.current = nextRange;
          // 只有真拖动才把播放头带到新入点；原地点击交给 onUp 定位到点击处，
          // 避免按下瞬间先跳入点、松开又跳点击处的两段跳动
          clipSeek(latestIn * duration);
        } else if (mode === "in") {
          // 拖入点：播放头跟手跳到钳制后的新入点，立即试听新起点
          const nextRange = setClipHandle("in", r);
          clipSeek(nextRange.inR * duration);
        } else {
          // 拖出点不挪播放头：循环继续播到新终点再自然折回。
          // 若 seek 到终点，循环 tick 会判定越界（cur >= 终点）瞬间跳回入点，
          // 表现成每次拖动都「从头播放」
          setClipHandle("out", r);
        }
      };
      applyAt(start);
      const onMove = (ev: PointerEvent) => {
        if (ev.pointerId !== pointerId) return;
        ev.preventDefault();
        const r = ratioFromClientX(trackRef.current, ev.clientX);
        if (r !== null) applyAt(r);
      };
      const cleanup = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onCancel);
        dragPointerRef.current = null;
        dragCleanupRef.current = null;
        setClipDragging(null);
      };
      // 原地点击亮带 = 定位播放头到点击位置（选区内试听）
      const onUp = (ev: PointerEvent) => {
        if (ev.pointerId !== pointerId) return;
        cleanup();
        if (mode === "band" && !bandMoved) {
          clipSeek(start * duration);
          // resume() 未被拦截时行为就是「清除标记（no-op）+ play」，播完即停的
          // 短音频也由这里的 play 重播；若这次 play 被策略拒绝，钩子会置回
          // blocked 点亮恢复提示（手写 play().catch 会把拒绝吞成静默失效）
          resume();
        }
      };
      // pointercancel 是被系统接管而取消的手势：收尾但不执行点击定位。
      // band 模式取消时定位与恢复都还没发生：补一次恢复，避免卡在 blocked 提示
      const onCancel = (ev: PointerEvent) => {
        if (ev.pointerId !== pointerId) return;
        cleanup();
        if (mode === "band") resumeIfBlocked();
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onCancel);
      dragCleanupRef.current = cleanup;
    },
    [operable, clipSeek, duration, setClipHandle, resumeIfBlocked, resume],
  );

  /** 截取确认：把选区（秒）交给节点走提取链路。
      不在这里关闭面板：节点侧通过 busy 守卫拒绝时（clip.busy 提示）面板保持
      打开、选区原样保留可重试；提取被接受后节点会清除 audioClipNodeId 关闭
      面板（与 onClose 幂等）。src 失效（清除/撤销）时宿主 memo 判空，画布会
      自动清除 audioClipNodeId 关闭面板；Esc / 点空白是通用退出路径 */
  const handleConfirm = useCallback(() => {
    if (!rangeValid) return;
    dispatchNodeAction(nodeId, "extract-audio-clip", { start: inTime, end: outTime });
  }, [rangeValid, nodeId, inTime, outTime]);

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
            {(ratio * duration).toFixed(2)}s          </div>
        )}
        <div
          className="absolute left-1/2 top-0 h-full w-1.5 -translate-x-1/2 rounded-full bg-white"
          style={{ opacity: clipHandle === which ? 1 : 0.7 }}
        />
      </div>
    </div>
  );

  // 整块面板不透明：轨道与操作区共用黑色背板，避免按钮直接透出画布内容
  return (
    <div className="canvas-toolbar nodrag nopan nowheel pointer-events-auto flex items-center gap-3 rounded-2xl p-2">
      {/* 左组：✗ 关闭 + 标题 */}
      <div className="flex shrink-0 items-center gap-1">
        <Button type="text" size="middle" style={{ padding: 8 }} icon={<CloseOutlined />} onClick={onClose} />
        <span className="text-[13px]" style={{ color: "var(--canvas-text)" }}>{t("clip.menu")}</span>
      </div>

      <div className="w-px h-5 mx-1" style={{ background: "var(--canvas-border)" }} />

      {/* 波形轨道：wavesurfer 与选区叠层共用同一坐标系（轨道全宽） */}
      <div
        ref={trackRef}
        className="relative cursor-ew-resize touch-none overflow-visible rounded-xl bg-black"
        style={{ width: FRAME_TRACK_WIDTH, height: PANEL_WAVE_HEIGHT + 16 }}
        onPointerDown={operable ? (e) => clipStartDrag("track", e) : undefined}
      >
        <div
          ref={containerRef}
          className="audio-waveform-panel absolute inset-x-0 top-2"
          style={{ opacity: failed ? 0 : 1 }}
        />

        {/* 压暗层：选区之外的一切（含两端），与选区框边缘严丝合缝 */}
        {clipRange && (
          <>
            <div className="pointer-events-none absolute inset-0 z-10">
              <div
                className="absolute inset-y-0 left-0 bg-black/55 rounded-sm"
                style={{ width: `${clipRange.inR * 100}%` }}
              />
              <div
                className="absolute inset-y-0 right-0 bg-black/55 rounded-sm"
                style={{ width: `${(1 - clipRange.outR) * 100}%` }}
              />
            </div>
            {/* 中段整体可拖动：拖动平移区间（时长不变），原地点击定位播放头；
                端帽 z-30 优先接管两端 */}
            <div className="pointer-events-none absolute inset-0 z-10 overflow-visible">
              <div
                className={`pointer-events-auto nodrag nopan absolute inset-y-0 touch-none ${clipDragging === "band" ? "cursor-grabbing" : "cursor-grab"}`}
                style={{ left: `${clipRange.inR * 100}%`, width: `${(clipRange.outR - clipRange.inR) * 100}%` }}
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
                    {((clipRange.outR - clipRange.inR) * duration).toFixed(2)}s
                  </span>
                </div>
              </div>
            </div>
            {/* 播放进度竖线：循环试听当前位置的细线标记（只展示，不接管指针） */}
            <div className="pointer-events-none absolute inset-0 z-20 overflow-visible">
              <div
                className="absolute inset-y-0 w-0.5 -translate-x-1/2 rounded-full bg-white/90"
                style={{ left: `${progress * 100}%` }}
              />
            </div>
            {/* 区间双手柄：白色端帽，z-30 压过着色层 */}
            <div className="pointer-events-none absolute inset-0 z-30 overflow-visible">
              {clipHandleRenderer("in", clipRange.inR)}
              {clipHandleRenderer("out", clipRange.outR)}
            </div>
          </>
        )}

        {/* 面板级提示（互斥场景共用样式，合并渲染）：
            未就绪 → 加载中 / 失败或零时长的不可用；已就绪但自动播放被拦 → 恢复提示。
            blocked 而面板又变为不可操作时（如加载失败）按不可用文案显示 */}
        {(!operable || playbackBlocked) && (
          <div className="pointer-events-none absolute inset-0 z-40 flex items-center justify-center text-xs text-white/60">
            {operable && playbackBlocked
              ? t("clip.autoplayBlocked")
              : failed || (ready && duration <= 0)
                ? t("clip.unavailable")
                : t("clip.loading")}
          </div>
        )}
      </div>

      <div className="w-px h-5 mx-1" style={{ background: "var(--canvas-border)" }} />

      {/* 确认：反色 ↑（与其它编辑工具栏一致） */}
      <PrimaryActionButton onClick={handleConfirm} disabled={!rangeValid} />
    </div>
  );
}
