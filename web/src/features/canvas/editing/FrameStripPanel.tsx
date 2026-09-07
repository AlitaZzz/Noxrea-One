/**
 * 视频帧序列面板。
 *
 * 打开时抽取整条轨道的缩略图，用户拖动播放头（或点击某一格）定位到目标帧，
 * 点「截取」才真正抽帧——时间通过 canvas:node-action 事件交给 VideoNode，
 * 复用既有的后端抽帧与派生节点创建链路。
 *
 * 挂载位置由 InfiniteCanvas 用 RfNodeToolbar(Position.Bottom) 决定：
 * 浮在节点下方居中，且不随画布缩放，轨道尺寸始终稳定。
 */
"use client";

import { CheckOutlined, CloseOutlined } from "@ant-design/icons";
import { Button, Tooltip } from "antd";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { fetchVideoProxy } from "@/features/canvas/api/file-api";
import { useFrameThumbnails } from "@/features/canvas/hooks/use-frame-thumbnails";
import { getVideoPlaybackTime, isVideoPlaying, pauseVideo, seekVideo, swapVideoSource } from "@/features/canvas/shared/video-playback-registry";
import { EventNames } from "@/lib/constants";
import { formatTime } from "@/lib/utils/format";

/** 播放头所在层左右各留 12px（与 inset-x-3 对齐），按内区换算才能跟手 */
const PLAYHEAD_INSET = 12;
/** 等待代理视频的上限：720p 全 I 帧首次转码通常 1–3 秒，超时就先用原视频 */
const PROXY_WAIT_MS = 3_000;
/** 拿不到真实帧率时的回退步进（秒）：小于常见帧率的一帧，保证不会跳过帧 */
const FALLBACK_FRAME_STEP = 1 / 50;

interface FrameStripPanelProps {
  nodeId: string;
  videoSrc: string;
  onClose: () => void;
}

function FrameStripPanel({ nodeId, videoSrc, onClose }: FrameStripPanelProps) {
  const { t } = useTranslation();
  // 抽帧源：优先全 I 帧代理（seek 只解一帧，抽满整条轨道快数倍），拿不到就退回原视频
  const [thumbSrc, setThumbSrc] = useState<string | null>(null);
  // 代理地址单独留存：它同时也是拖动时节点播放器的临时播放源
  const [proxyUrl, setProxyUrl] = useState<string | null>(null);
  // 真实帧率：供 ←/→ 一帧步进使用，拿不到时回退固定步进
  const [fps, setFps] = useState<number | null>(null);
  const { frames, frameWidth, duration, extracted, status } = useFrameThumbnails(thumbSrc);
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

  // 取代理视频：全 I 帧让每次 seek 只解一帧，抽满一整条轨道快数倍。
  // 首次需要转码，超过上限就先用原视频；转完会落在服务端缓存，下次打开直接命中。
  useEffect(() => {
    let cancelled = false;
    const videoKey = videoSrc.replace(/^\/api\/files\//, "").split("?")[0];
    const timeout = new Promise<null>((resolve) => {
      setTimeout(() => resolve(null), PROXY_WAIT_MS);
    });
    // 拿不到源键（例如本地预览地址）时直接用原视频，不再请求代理
    const request = videoKey
      ? fetchVideoProxy(videoKey)
          .then(async (res) => {
            if (!res.ok) return null;
            const json = (await res.json()) as { data?: { url?: string; fps?: number | null } };
            return { url: json.data?.url ?? null, fps: json.data?.fps ?? null };
          })
          .catch(() => null)
      : Promise.resolve(null);
    void Promise.race([request, timeout]).then((data) => {
      if (cancelled) return;
      const url = data?.url ?? null;
      setProxyUrl(url);
      setFps(data?.fps ?? null);
      setThumbSrc(url || videoSrc);
    });
    return () => {
      cancelled = true;
    };
  }, [videoSrc]);

  // 选帧期间暂停节点播放，避免 hover 播放干扰视觉判断
  useEffect(() => {
    pauseVideo(nodeId);
  }, [nodeId]);

  // 选帧期间把节点播放器切到全 I 帧代理：任意时间点只解一帧，seek 毫秒级完成，
  // 拖动时画面既能连续更新又能与播放头对齐；关闭面板自动恢复原视频并停在所选帧
  useEffect(() => {
    if (!proxyUrl) return;
    return swapVideoSource(nodeId, proxyUrl);
  }, [nodeId, proxyUrl]);

  // 时长就绪后把播放头放到打开时的播放位置（首帧渲染时 duration 仍为 0）
  useEffect(() => {
    if (initializedRef.current || duration <= 0) return;
    initializedRef.current = true;
    setRatioByUser(clamp01((initialTimeRef.current ?? 0) / duration));
  }, [duration, setRatioByUser]);

  // Esc 关闭：与点击画布空白（取消选中后面板自动卸载）形成一致的退出路径
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  // ← / → 按一帧步进：轨道像素密度不足以选中长视频的每一帧，用键盘补齐精度
  useEffect(() => {
    if (duration <= 0) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      // 面板打开时可能有输入框持有焦点，方向键要留给它们
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      e.preventDefault();
      const step = fps && fps > 0 ? 1 / fps : FALLBACK_FRAME_STEP;
      userDrivenRef.current = true;
      setRatio((r) => clamp01(r + (e.key === "ArrowRight" ? step : -step) / duration));
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [duration, fps]);

  const ratioFromClientX = useCallback((clientX: number) => {
    const el = trackRef.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    const inner = rect.width - PLAYHEAD_INSET * 2;
    if (inner <= 0) return null;
    return clamp01((clientX - rect.left - PLAYHEAD_INSET) / inner);
  }, []);

  const handleTrackDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const next = ratioFromClientX(e.clientX);
      if (next !== null) setRatioByUser(next);
      const onMove = (ev: PointerEvent) => {
        ev.preventDefault();
        const r = ratioFromClientX(ev.clientX);
        if (r !== null) setRatioByUser(r);
      };
      const cleanup = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        dragCleanupRef.current = null;
      };
      const onUp = () => cleanup();
      dragCleanupRef.current = cleanup;
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [ratioFromClientX, setRatioByUser],
  );

  const frameCount = frames.length;
  const ready = frameCount > 0 && duration > 0;
  const currentTime = ready ? ratio * duration : 0;

  // 节点播放时播放头跟随：复用节点控件栏的播放按钮，边听边看；
  // 暂停后播放头即停在当前帧，再用 ←/→ 微调
  useEffect(() => {
    if (!ready || duration <= 0) return;
    let raf = 0;
    const tick = () => {
      // 只在播放中跟随：拖动或步进时视频是暂停的，此时跟随会用滞后的位置覆盖用户操作
      if (isVideoPlaying(nodeId)) {
        setRatio(clamp01(getVideoPlaybackTime(nodeId) / duration));
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [ready, duration, nodeId]);

  // 拖动播放头时同步 seek 节点播放器，形成 scrubbing 预览；
  // rAF 节流保证一帧最多 seek 一次，避免高频 seek 拖垮解码
  useEffect(() => {
    // 跟随播放引起的 ratio 变化不需要 seek——那会触发 seekVideo 里的 pause，把播放打断
    if (!ready || !userDrivenRef.current) return;
    userDrivenRef.current = false;
    const raf = requestAnimationFrame(() => seekVideo(nodeId, ratio * duration));
    return () => cancelAnimationFrame(raf);
  }, [ready, nodeId, ratio, duration]);

  const handleCapture = useCallback(() => {
    if (!ready) return;
    // 末帧留 0.05s 余量：贴着 duration 抽帧可能落到视频结尾之外
    const time = Math.max(0, Math.min(currentTime, duration - 0.05));
    window.dispatchEvent(
      new CustomEvent(EventNames.CANVAS_NODE_ACTION, {
        detail: { nodeId, action: "capture-frame", time },
      }),
    );
    onClose();
  }, [ready, currentTime, duration, nodeId, onClose]);

  // 整块面板不透明：轨道与右侧操作区共用黑色背板，避免按钮直接透出画布内容
  return (
    <div className="canvas-toolbar nodrag nopan nowheel pointer-events-auto flex items-center gap-3 rounded-2xl p-2">
      <div
        ref={trackRef}
        className="relative h-14 w-250 cursor-ew-resize overflow-visible"
        onPointerDown={handleTrackDown}
      >
        <div className="flex size-full overflow-hidden rounded-xl bg-black">
          {ready ? (
            frames.map((src, i) => (
              // 帧格只做展示，不挂钩点击定位：定位统一交给轨道的指针事件。
              // 若在这里定位，松手时浏览器补发的 click 会把播放头吸附回格中心，
              // 表现为「松手后位置跳一下」（格数少时尤其像吸到整数秒）
              <div
                key={i}
                className="relative h-full shrink-0 overflow-hidden"
                style={{ width: frameWidth, marginLeft: i === 0 ? 0 : -1 }}
              >
                {src ? (
                  <img
                    alt=""
                    draggable={false}
                    src={src}
                    className="size-full select-none bg-black object-contain object-center"
                  />
                ) : (
                  <span className="block size-full bg-white/10" />
                )}
              </div>
            ))
          ) : (
            <div className="flex size-full items-center justify-center px-4 text-xs text-white/60">
              {status === "error" ? t("capture.unavailable") : t("capture.loading")}
            </div>
          )}
        </div>

        {/* 抽帧进度：贴轨道上方，避免遮挡缩略图 */}
        {status === "extracting" && frameCount > 0 && (
          <div className="pointer-events-none absolute -top-5 right-0 z-20 text-xs tabular-nums text-[var(--canvas-text-dim)]">
            {t("capture.extracting", { done: extracted, total: frameCount })}
          </div>
        )}

        {/* 播放头：白色圆点 + 竖线，与轨道内侧留 12px 边距 */}
        {ready && (
          <div className="pointer-events-none absolute inset-0 z-20 overflow-visible">
            <div className="absolute inset-x-3 inset-y-0 overflow-visible">
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
          </div>
        )}
      </div>

      <span className="text-sm tabular-nums text-[var(--canvas-text)]">{formatTime(currentTime)}</span>

      <div className="w-px h-5 mx-1" style={{ background: "var(--canvas-border)" }} />

      {/* 取消 / 确认：与裁剪、标注编辑条使用同一套图标语义（X 取消、✓ 确认） */}
      <Tooltip title={t("common.cancel")}>
        <Button type="text" size="middle" style={{ padding: 8 }} icon={<CloseOutlined />} onClick={onClose} />
      </Tooltip>
      <Tooltip title={t("capture.confirm")}>
        <Button
          type="text"
          size="middle"
          style={{ padding: 8, color: ready ? "#1D9E75" : undefined }}
          icon={<CheckOutlined />}
          disabled={!ready}
          onClick={handleCapture}
        />
      </Tooltip>
    </div>
  );
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

export default FrameStripPanel;
