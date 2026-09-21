/**
 * 视频片段截取面板。
 *
 * 与 FrameStripPanel 同构（雪碧图轨道 + scrub 代理），区别在于轨道上没有独立的
 * 播放头：[起点, 终点] 双手柄与选中区间就是「位置」本身——点击/拖动轨道移动
 * 就近的手柄并连续 scrub，按住选区中段可整段平移，播放被约束在选区内循环，
 * 进度以白色竖线呈现。确认后把区间交给 VideoNode 走既有的事件链路创建派生视频节点。
 *
 * 挂载位置由 InfiniteCanvas 用 RfNodeToolbar(Position.Bottom) 决定：
 * 浮在节点下方居中，且不随画布缩放，轨道尺寸始终稳定。与帧序列面板互斥。
 */
"use client";

import { CloseOutlined, WarningOutlined } from "@ant-design/icons";
import { Button, Tooltip } from "antd";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { fetchVideoProxy, toFileKey } from "@/features/canvas/api/file-api";
import { FRAME_TRACK_HEIGHT, FRAME_TRACK_WIDTH, useFrameSprite } from "@/features/canvas/hooks/use-frame-sprite";
import { isEditableTarget } from "@/features/canvas/shared/dom";
import { dispatchNodeAction } from "@/features/canvas/shared/node-action";
import { getVideoPlaybackTime, isVideoPlaying, onVideoEnded, pauseVideo, playVideo, seekVideo, setVideoTime, swapVideoSource } from "@/features/canvas/shared/video-playback-registry";
import { useCanvasStore } from "@/features/canvas/stores/canvas-store";
import { formatTime } from "@/lib/utils/format";

import { clamp01, clampBandPan, computeInitialRange, isOutsideLoopRange, isRangeLongEnough, MIN_RANGE_S, ratioFromClientX } from "./clip-range";
import PrimaryActionButton from "./PrimaryActionButton";
import useEscapeToClose from "./use-escape-to-close";
import usePlaybackBlocked from "./use-playback-blocked";

/** 拿不到真实帧率时的回退步进（秒）：小于常见帧率的一帧，保证不会跳过帧 */
const FALLBACK_FRAME_STEP = 1 / 50;

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
  // 自动播放被浏览器拦截时置位：提示用户用下一次轨道按下/方向键恢复（与音频
  // 截取面板的 blocked 机制对等）。ended 循环续播的 play() 拒绝也走这里，
  // 否则出点在文件尾的循环会静默死亡且无任何提示
  const play = useCallback(() => playVideo(nodeId), [nodeId]);
  const { playbackBlocked, resume, resumeIfBlocked } = usePlaybackBlocked(play);
  const trackRef = useRef<HTMLDivElement>(null);
  // 拖动结束与组件卸载都要摘掉 window 监听：面板可能在拖动途中被卸载
  const dragCleanupRef = useRef<(() => void) | null>(null);
  // 当前拖动占用的指针 id：并发第二根指针不得启动第二个拖动，否则两套
  // onMove 互相打架、dragCleanupRef 相互覆盖（与音频截取面板同一守卫）
  const dragPointerRef = useRef<number | null>(null);
  // 打开瞬间的播放位置：区间起点与预览渲染的基准（惰性初始化，仅取一次）
  const [initialPosition] = useState(() => getVideoPlaybackTime(nodeId));
  // 区间双手柄与键盘微调目标（默认调终点：从当前播放位置向后扩一段是最常见操作）
  const [activeHandle, setActiveHandle] = useState<"in" | "out">("out");
  const [inRatio, setInRatio] = useState(0);
  const [outRatio, setOutRatio] = useState(1);
  // 播放进度：只以「选区内已播部分加亮」呈现，不设独立播放头
  const [playedRatio, setPlayedRatio] = useState(0);
  // 拖动状态：null = 未拖动；"in"/"out" = 拖手柄（浮出时间气泡）；"band" = 整段平移
  const [dragging, setDragging] = useState<null | "in" | "out" | "band">(null);
  // 预览 seek 的 rAF 节流句柄：拖动时一帧最多 seek 一次，避免高频 seek 拖垮解码
  const seekRafRef = useRef(0);
  // 挂起 seek 的取消闭包：卸载收尾以函数调用形式取用（与 dragCleanupRef 同款，
  // 直接在 effect 清理里读 seekRafRef.current 会触发 react-hooks/immutability）
  const cancelPendingSeekRef = useRef<() => void>(() => {});
  useEffect(() => () => {
    // 键盘路径的 seekPreview 会留下挂起的 rAF（cancelDrag 只覆盖拖动路径）：
    // 卸载换回原视频后它仍会触发 seekVideo，把原视频拽到截取位置并 pause
    cancelPendingSeekRef.current();
    dragCleanupRef.current?.();
  }, []);
  // 拖动开始前是否在循环播放：scrub 中的 seek 会暂停视频，松手后据此恢复循环
  const wasPlayingRef = useRef(false);
  // 区间最新值的 ref 镜像：tick 的 effect 依赖里没有区间值（见 tick 处说明），
  // 初始化/拖动在 setState 的同时更新这里，tick 每帧读到的始终是最新区间
  const loopStateRef = useRef({ inRatio: 0, outRatio: 1 });
  // 节点位置的变更检测基准：tick 由此判断位置是否变化（变化才触发渲染）
  const lastCurRef = useRef(0);
  // 初始化是否已写入真实区间：写入前选区/进度线不得渲染——operable 翻 true 的
  // 那次渲染里 inRatio/outRatio 还是 0→1 默认值，直接渲染会闪现「满轨道全选」
  const [rangeInitialized, setRangeInitialized] = useState(false);
  const initializedRef = useRef(false);

  // 取预览代理：拖动时用低分辨率短 GOP 副本做 scrub，seek 最多解码 1 秒画面。
  // 不做「超时就放弃」的竞速：转码完成后自动切过去，swapVideoSource 会把当前
  // 时间点写回，切换不跳位（与 FrameStripPanel 一致）。
  useEffect(() => {
    let cancelled = false;
    const videoKey = toFileKey(videoSrc);
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

  // 选帧期间把节点播放器切到预览代理；循环播放中的换源在元数据就绪后续播，
  // 暂停中的换源保持暂停；关闭面板自动恢复原视频。
  // onReady：代理缓冲就绪（canplay）才解锁交互——首次打开时代理刚生成、
  // 浏览器缓存全冷，立即拖动会触发一串 Range 拉取 + 解码跟不上指针
  // （重开时代理已入缓存故无此问题）。监听在 swapVideoSource 内部挂载，
  // 等待的必然是换入的代理而非换源前就绪的旧元素。error 也回调（ok=false）：
  // 浏览器解码不了代理文件时 canplay 永远不来，只避免冻结的话会解锁一个
  // 画面死住但可操作的面板——落回 proxyState="failed" 的禁用态，重开重试
  useEffect(() => {
    if (!proxyUrl) return;
    return swapVideoSource(nodeId, proxyUrl, {
      resume: isVideoPlaying(nodeId),
      onReady: (ok) => {
        if (ok) setBufferReady(true);
        else setProxyState("failed");
      },
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
  const rangeValid = operable && rangeInitialized && isRangeLongEnough(inTime, outTime);

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
    resume();
  }, [operable, duration, nodeId, initialPosition, resume]);

  // Esc 关闭：与点击画布空白（取消选中后面板自动卸载）形成一致的退出路径
  useEscapeToClose(onClose);

  /** 设置某一只手柄的位置，并钳住最小区间（in 不越过 out，out 不落后于 in）。
      钳制基准读 loopStateRef 镜像而非 state 闭包（与音频面板的 setClipHandle
      同款）：operable 翻 true 的提交与初始化 effect 的 setState 重渲染之间存在
      一帧窗口，期间的轨道事件读 state 会拿到 {0,1} 默认区间、把初始化覆盖掉。
      同步把最新区间写进 loopStateRef：tick 的 effect 依赖里没有区间值，
      拖动中读取的是这里维护的最新值。返回钳制后的比例，供键盘微调等调用方
      在钳制结果上继续操作（如重新定位播放头）——钳制公式只写这一份 */
  const setHandle = useCallback(
    (which: "in" | "out", next: number) => {
      const minRangeRatio = duration > 0 ? MIN_RANGE_S / duration : 0;
      const { inRatio: prevIn, outRatio: prevOut } = loopStateRef.current;
      if (which === "in") {
        const v = clamp01(Math.min(next, prevOut - minRangeRatio));
        setInRatio(v);
        loopStateRef.current.inRatio = v;
        return v;
      }
      const v = clamp01(Math.max(next, prevIn + minRangeRatio));
      setOutRatio(v);
      loopStateRef.current.outRatio = v;
      return v;
    },
    [duration],
  );

  /** 预览 seek：rAF 节流（一帧最多一次），并把播放进度推进到该处 */
  const seekPreview = useCallback(
    (time: number) => {
      cancelAnimationFrame(seekRafRef.current);
      const raf = requestAnimationFrame(() => seekVideo(nodeId, time));
      seekRafRef.current = raf;
      cancelPendingSeekRef.current = () => cancelAnimationFrame(raf);
      setPlayedRatio(duration > 0 ? clamp01(time / duration) : 0);
    },
    [nodeId, duration],
  );

  /** 拖动松手收尾：按拖动前的播放状态决定定位方式。拖动前在播放时，恢复路径
      必须先取消挂起的 rAF seek 再用 setVideoTime 同步定位——seekVideo 会 pause，
      若让挂起的 rAF 在 resume() 之后执行，正好把刚恢复的播放在下一帧按停，
      而 wasPlayingRef 在下次按下时捕获到的已是 false，面板内再无恢复路径。
      播放中的恢复只有入点侧重新定位播放头（出点变化不挪播放头，否则循环 tick
      判定越界立刻折回入点，表现成「微调出点就从头播放」——与键盘分支、音频
      面板及拖动中途的 seekPreview 门控同一规则）。暂停 scrub 的收尾才走
      seekPreview 的 rAF 节流（含出点侧，属预览行为，暂停时不回跳无副作用） */
  const finishDragPreview = useCallback(
    (which: "in" | "out", time: number) => {
      if (wasPlayingRef.current) {
        cancelAnimationFrame(seekRafRef.current);
        if (which === "in") {
          setVideoTime(nodeId, time);
          setPlayedRatio(duration > 0 ? clamp01(time / duration) : 0);
        }
        resume();
      } else {
        seekPreview(time);
      }
    },
    [nodeId, duration, seekPreview, resume],
  );

  /** 点击/拖动轨道：移动「就近的那只手柄」（帧截取同款）。入点侧与暂停中的
      scrub 跟手预览；出点侧循环播放中不 scrub（与 finishDragPreview 的 out
      分支同一规则）：seekVideo 会暂停并把播放头拖到出点，松手 resume 后循环
      tick 判定越界立即折回入点，表现成「微调出点就从头播放」。按下与拖动共用 */
  const handleTrackDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      // 雪碧图或代理未就绪、或初始化尚未写入真实区间：时间轴与画面都不可信
      // （拖原视频长 GOP 必然不跟手），操作整体禁用——宁等不乱。rangeInitialized
      // 严格蕴含 operable：初始化 effect 在 paint 后异步执行，operable 翻 true
      // 与 effect 之间的窗口内按下会以默认区间 {0,1} 起拖、随后被 init 整体覆写
      if (!rangeInitialized) return;
      const next = ratioFromClientX(trackRef.current, e.clientX);
      if (next === null) return;
      const pointerId = e.pointerId;
      if (dragPointerRef.current !== null) return;
      dragPointerRef.current = pointerId;
      // 自动播放曾被拦截：本次按下是真实手势，顺带恢复循环
      resumeIfBlocked();
      // 就近吸附读镜像（同 setHandle 的竞态规避）：离起点近动起点，离终点近动
      // 终点，拖动中持续跟手
      const { inRatio: curIn, outRatio: curOut } = loopStateRef.current;
      const which: "in" | "out" = Math.abs(next - curIn) <= Math.abs(next - curOut) ? "in" : "out";
      wasPlayingRef.current = isVideoPlaying(nodeId);
      setActiveHandle(which);
      setDragging(which);
      // 挪手柄 + 出点侧循环播放中不 scrub（与 finishDragPreview 的 out 分支同一
      // 规则）：seekVideo 会暂停并把播放头拖到出点，松手 resume 后循环 tick
      // 判定越界立即折回入点，表现成「微调出点就从头播放」。按下与拖动共用
      const scrub = (r: number) => {
        setHandle(which, r);
        if (which === "in" || !wasPlayingRef.current) seekPreview(r * duration);
      };
      let latest = next;
      scrub(next);
      const onMove = (ev: PointerEvent) => {
        if (ev.pointerId !== pointerId) return;
        ev.preventDefault();
        const r = ratioFromClientX(trackRef.current, ev.clientX);
        if (r === null) return;
        latest = r;
        scrub(r);
      };
      const cleanup = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onCancel);
        dragPointerRef.current = null;
        dragCleanupRef.current = null;
      };
      // 中断收尾（pointercancel / 面板卸载共用）：必须先取消挂起的 rAF seek——
      // seekVideo 会 pause，若它在 resume() 之后执行，正好把刚恢复的播放在
      // 下一帧按停，而该次 play() 的拒绝是 AbortError（usePlaybackBlocked 只认
      // NotAllowedError），面板内再无任何恢复路径（与 finishDragPreview 同一竞态）
      const cancelDrag = () => {
        cancelAnimationFrame(seekRafRef.current);
        cleanup();
        setDragging(null);
        if (wasPlayingRef.current) resume();
      };
      // 松手：补一次精确定位（最后一次 rAF 可能落后于最终指针位置），再恢复循环
      const onUp = (ev: PointerEvent) => {
        if (ev.pointerId !== pointerId) return;
        cleanup();
        setDragging(null);
        finishDragPreview(which, latest * duration);
      };
      // pointercancel 是被系统接管而取消的手势：收尾但不做定位，scrub 已 pause
      // 的播放按拖动前状态还回，否则取消一次就永久静音
      const onCancel = (ev: PointerEvent) => {
        if (ev.pointerId !== pointerId) return;
        cancelDrag();
      };
      dragCleanupRef.current = cancelDrag;
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onCancel);
    },
    [rangeInitialized, duration, nodeId, setHandle, seekPreview, finishDragPreview, resumeIfBlocked, resume],
  );

  /** 手柄按下：精确抓取某只手柄并阻止冒泡（不触发轨道的就近吸附） */
  const handleHandleDown = useCallback(
    (which: "in" | "out") =>
      (e: React.PointerEvent) => {
        e.preventDefault();
        e.stopPropagation();
        // 与轨道拖动同一守卫：初始化窗口内起拖会以默认区间 {0,1} 被覆写
        if (!rangeInitialized) return;
        const pointerId = e.pointerId;
        if (dragPointerRef.current !== null) return;
        dragPointerRef.current = pointerId;
        // 自动播放曾被拦截：本次按下是真实手势，顺带恢复循环
        resumeIfBlocked();
        wasPlayingRef.current = isVideoPlaying(nodeId);
        setActiveHandle(which);
        setDragging(which);
        const next = ratioFromClientX(trackRef.current, e.clientX);
        let latest: number | null = next;
        // 挪手柄 + 出点侧循环播放中不 scrub：seekVideo 会暂停并把播放头拖到
        // 出点，松手 resume 后循环 tick 判定越界立即折回入点，表现成「微调
        // 出点就从头播放」。暂停 scrub 与入点侧照常跟手预览；按下与拖动共用
        const scrub = (r: number) => {
          setHandle(which, r);
          if (which === "in" || !wasPlayingRef.current) seekPreview(r * duration);
        };
        if (next !== null) {
          scrub(next);
        }
        const onMove = (ev: PointerEvent) => {
          if (ev.pointerId !== pointerId) return;
          ev.preventDefault();
          const r = ratioFromClientX(trackRef.current, ev.clientX);
          if (r === null) return;
          latest = r;
          scrub(r);
        };
        const cleanup = () => {
          window.removeEventListener("pointermove", onMove);
          window.removeEventListener("pointerup", onUp);
          window.removeEventListener("pointercancel", onCancel);
          dragPointerRef.current = null;
          dragCleanupRef.current = null;
        };
        // 中断收尾（pointercancel / 面板卸载共用）：先取消挂起的 rAF seek 再
        // 恢复播放，竞态理由与轨道拖动的 cancelDrag 一致
        const cancelDrag = () => {
          cancelAnimationFrame(seekRafRef.current);
          cleanup();
          setDragging(null);
          if (wasPlayingRef.current) resume();
        };
        // 与轨道拖动一致：松手补精确定位，再恢复循环
        const onUp = (ev: PointerEvent) => {
          if (ev.pointerId !== pointerId) return;
          cleanup();
          setDragging(null);
          if (latest !== null) finishDragPreview(which, latest * duration);
          else if (wasPlayingRef.current) resume();
        };
        // pointercancel：收尾但不做定位，scrub 已 pause 的播放按拖动前状态还回
        const onCancel = (ev: PointerEvent) => {
          if (ev.pointerId !== pointerId) return;
          cancelDrag();
        };
        dragCleanupRef.current = cancelDrag;
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
        window.addEventListener("pointercancel", onCancel);
      },
    [rangeInitialized, duration, nodeId, setHandle, seekPreview, finishDragPreview, resume, resumeIfBlocked],
  );

  // ← / → 按一帧步进微调当前手柄：轨道像素密度不足以精确到帧，用键盘补齐精度
  useEffect(() => {
    // 与拖动入口同一守卫：初始化写入真实区间之前不响应微调
    if (!rangeInitialized) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      // 面板打开时可能有输入框持有焦点，方向键要留给它们
      if (isEditableTarget(e.target)) return;
      // 上层弹窗打开时方向键归弹窗控件（与 useEscapeToClose 的 modalOpen 守卫一致），
      // 否则隐藏面板会抢走方向键、把弹窗里的滑杆等控件卡住
      const st = useCanvasStore.getState();
      if (st.modalOpen || st.directorOverlayOpen) return;
      e.preventDefault();
      // 自动播放曾被拦截：keydown 是有效的用户激活，键盘微调同样恢复播放。
      // 恢复手势的定位必须用 setVideoTime（seekVideo 会 pause，会把刚恢复的
      // 播放在下一帧按停；键盘路径没有拖动 onUp 的兜底恢复，提示亮过即静默）。
      // 「是否在播放」直接问 isVideoPlaying 即可：NotAllowedError 拒绝后 paused
      // 仍是 false（规范只让 pause() 置位），恢复成功与否不改变该判定
      resumeIfBlocked();
      const step = fps && fps > 0 ? 1 / fps : FALLBACK_FRAME_STEP;
      const current = activeHandle === "in" ? loopStateRef.current.inRatio : loopStateRef.current.outRatio;
      const target = current + (e.key === "ArrowRight" ? step : -step) / duration;
      const clamped = setHandle(activeHandle, target);
      if (isVideoPlaying(nodeId)) {
        // 改用 setVideoTime 只定位不打断（seekVideo 会 pause 的理由见上）。且
        // 只有入点变化才重新定位播放头（与拖动/音频面板一致）：调出点不挪
        // 播放头，否则循环 tick 判定越界立刻折回入点，表现成「从头播放」
        if (activeHandle === "in") {
          setVideoTime(nodeId, clamped * duration);
          setPlayedRatio(clamped);
        }
      } else {
        seekPreview(clamped * duration);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [rangeInitialized, duration, fps, activeHandle, setHandle, seekPreview, resumeIfBlocked, nodeId]);

  // 单格按 cover 规则缩放居中（裁掉超出部分）：contain 会在竖屏视频的每格左右
  // 留黑边、横屏视频上下留黑边，相邻格子的黑边连成「竖线」观感；cover 铺满格子
  // 后缩略条视觉连续，代价是每格只显示帧的中间部分（识别足够）
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
      const cur = getVideoPlaybackTime(nodeId);
      const { inRatio: iR, outRatio: oR } = loopStateRef.current;
      const iT = iR * duration;
      const oT = oR * duration;
      // 播放中的循环回跳：到选区终点跳回起点（起点被拖到播放位置之后也拉回）；
      // 暂停时不回跳——用户可以把播放头停在选区外的位置查看画面
      if (isVideoPlaying(nodeId) && isRangeLongEnough(iT, oT) && isOutsideLoopRange(cur, iT, oT)) {
        setVideoTime(nodeId, iT);
        lastCurRef.current = iT;
        setPlayedRatio(iR);
      } else if (Math.abs(cur - lastCurRef.current) > 0.003) {
        // 任何来源的位置变化（播放推进 / 拖节点进度条 / 点击跳转）都实时反映到进度线
        lastCurRef.current = cur;
        setPlayedRatio(clamp01(cur / duration));
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [operable, duration, nodeId]);

  // 选区出点在文件末尾时的循环兜底：媒体自然结束（ended 置位）先于 rAF 观察到
  // cur >= oT——isVideoPlaying 在 ended 瞬间已为 false，上面的 tick 永远看不到
  // 越界。必须监听 ended 把播放头拉回入点续播，否则循环播到文件尾就永久停止
  // （面板没有播放控件，节点按钮又被截取模式锁住）；续播被浏览器拒绝时
  // resume 置 blocked 提示，下一次轨道按下/方向键即恢复
  useEffect(() => {
    if (!operable || duration <= 0) return;
    return onVideoEnded(nodeId, () => {
      const { inRatio: iR, outRatio: oR } = loopStateRef.current;
      // 区间无效（短于最小区间的视频）时不续播：播完即停，否则 ended 无条件
      // 续播会形成不受控的整文件循环，而面板没有停止控件（与音频面板 finish 一致）
      if (!isRangeLongEnough(iR * duration, oR * duration)) return;
      setVideoTime(nodeId, iR * duration);
      resume();
    });
  }, [operable, duration, nodeId, resume]);

  /** 截取确认：把选区（秒）交给节点走提取链路。
      不在这里关闭面板：节点侧通过 busy 守卫拒绝时（clip.busy 提示）面板保持
      打开、选区原样保留可重试；提取被接受后节点会清除 clipCaptureNodeId 关闭
      面板（与 onClose 幂等）。src 失效（清除/撤销）时宿主 memo 判空，画布会
      自动清除 clipCaptureNodeId 关闭面板；Esc / 点空白是通用退出路径 */
  const handleConfirm = useCallback(() => {
    if (!rangeValid) return;
    dispatchNodeAction(nodeId, "extract-clip", { start: inTime, end: outTime });
  }, [rangeValid, nodeId, inTime, outTime]);

  /** 整段平移：按住亮带中段拖动，时长不变地平移整个区间（两端同步钳在轨道内）。
      画面连续 scrub 到新区间的入点帧（与拖手柄一致），松手后恢复循环播放 */
  const handleBandDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      // 与轨道拖动同一守卫：初始化窗口内平移会以默认区间 {0,1} 起拖、随后被覆写
      if (!rangeInitialized) return;
      const start = ratioFromClientX(trackRef.current, e.clientX);
      if (start === null) return;
      const pointerId = e.pointerId;
      if (dragPointerRef.current !== null) return;
      dragPointerRef.current = pointerId;
      // 按下不 resumeIfBlocked：平移先 rAF 定位到新入点，恢复推迟到松手/
      // 中断的收尾（wasPlayingRef 兜底）。若此处先 resume，挂起的 seekVideo
      // 会把刚恢复的播放在下一帧按停——拖动中途 seekPreview 门控同一竞态
      wasPlayingRef.current = isVideoPlaying(nodeId);
      setDragging("band");
      // 区间读镜像（同 setHandle 的竞态规避）
      const { inRatio: curIn, outRatio: curOut } = loopStateRef.current;
      const width = curOut - curIn;
      const startIn = curIn;
      let latestIn = startIn;
      seekPreview(startIn * duration);
      const onMove = (ev: PointerEvent) => {
        if (ev.pointerId !== pointerId) return;
        ev.preventDefault();
        const r = ratioFromClientX(trackRef.current, ev.clientX);
        if (r === null) return;
        latestIn = clampBandPan(startIn, r - start, width);
        setInRatio(latestIn);
        setOutRatio(latestIn + width);
        loopStateRef.current = { inRatio: latestIn, outRatio: latestIn + width };
        seekPreview(latestIn * duration);
      };
      const cleanup = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onCancel);
        dragPointerRef.current = null;
        dragCleanupRef.current = null;
      };
      // 中断收尾（pointercancel / 面板卸载共用）：先取消挂起的 rAF seek 再
      // 恢复播放，竞态理由与轨道拖动的 cancelDrag 一致
      const cancelDrag = () => {
        cancelAnimationFrame(seekRafRef.current);
        cleanup();
        setDragging(null);
        if (wasPlayingRef.current) resume();
      };
      // 松手：补一次精确定位（最后一次 rAF 可能落后于最终指针位置），再恢复循环
      const onUp = (ev: PointerEvent) => {
        if (ev.pointerId !== pointerId) return;
        cleanup();
        setDragging(null);
        finishDragPreview("in", latestIn * duration);
      };
      // pointercancel：收尾但不做定位，scrub 已 pause 的播放按拖动前状态还回
      const onCancel = (ev: PointerEvent) => {
        if (ev.pointerId !== pointerId) return;
        cancelDrag();
      };
      dragCleanupRef.current = cancelDrag;
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onCancel);
    },
    [rangeInitialized, duration, nodeId, seekPreview, finishDragPreview, resume],
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
          style={{ width: frameWidth }}
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
      {/* 左组：✗ 关闭 + 标题 */}
      <div className="flex shrink-0 items-center gap-1">
        <Button type="text" size="middle" style={{ padding: 8 }} icon={<CloseOutlined />} onClick={onClose} />
        <span className="text-[13px]" style={{ color: "var(--canvas-text)" }}>{t("clip.menu")}</span>
      </div>

      <div className="w-px h-5 mx-1" style={{ background: "var(--canvas-border)" }} />

      <div
        ref={trackRef}
        className="relative h-14 cursor-ew-resize touch-none overflow-visible"
        style={{ width: FRAME_TRACK_WIDTH }}
        onPointerDown={handleTrackDown}
      >
        {/* 格子/压暗/选区/手柄共用同一坐标系（轨道全宽），雪碧图贴满轨道两端 */}
        <div className="absolute inset-0 rounded-xl bg-black" />
        <div className="absolute inset-0 flex overflow-hidden">{trackCells}</div>

        {/* 压暗层：选区之外的一切（含两端），与选区框边缘严丝合缝 */}
        {bandRange && (
          <>
            <div className="pointer-events-none absolute inset-0 z-10">
              <div
                className="absolute inset-y-0 left-0 bg-black/55"
                style={{ width: `${bandRange.inR * 100}%` }}
              />
              <div
                className="absolute inset-y-0 right-0 bg-black/55"
                style={{ width: `${(1 - bandRange.outR) * 100}%` }}
              />
            </div>
            <div className="pointer-events-none absolute inset-0 z-10 overflow-visible">
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
          </>
        )}

        {/* 播放进度竖线：循环扫播当前位置的细线标记（只展示，不接管指针） */}
        {operable && rangeInitialized && (
          <div className="pointer-events-none absolute inset-0 z-20 overflow-visible">
            <div
              className="absolute inset-y-0 w-0.5 -translate-x-1/2 rounded-full bg-white/90"
              style={{ left: `${playedRatio * 100}%` }}
            />
          </div>
        )}

        {/* 区间双手柄：白色端帽，z-30 压过着色层（未初始化/代理未就绪不渲染）；
            手柄容器自带 pointer-events-auto，从 none 的层里把指针事件接回来 */}
        {operable && rangeInitialized && (
          <div className="pointer-events-none absolute inset-0 z-30 overflow-visible">
            {handleRenderer("in", inRatio)}
            {handleRenderer("out", outRatio)}
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

        {/* 自动播放被拦截的恢复提示：点击轨道或方向键即可恢复 */}
        {operable && playbackBlocked && (
          <div className="pointer-events-none absolute inset-0 z-40 flex items-center justify-center">
            <span
              className="rounded-md px-3 py-1 text-xs text-white/85"
              style={{ background: "rgba(0,0,0,0.65)" }}
            >
              {t("clip.autoplayBlocked")}
            </span>
          </div>
        )}
      </div>

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

      <div className="w-px h-5 mx-1" style={{ background: "var(--canvas-border)" }} />

      {/* 确认：反色 ↑（与其它编辑工具栏一致）；转码/缓冲未就绪时整段禁用，
          避免可点击却静默无响应 */}
      <PrimaryActionButton onClick={handleConfirm} disabled={!rangeValid} />
    </div>
  );
}

export default ClipStripPanel;
