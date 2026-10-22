/**
 * 帧序列雪碧图加载。
 *
 * 整条轨道的缩略图由服务端一次解码拼成雪碧图（见 createFrameSprite），前端只负责
 * 加载并按格切片显示。这里不再用「隐藏 video + canvas 逐个时间点 seek 抽帧」：
 * 那样串行 seek 既慢，又受浏览器解码行为影响（seek 超时、canvas 跨域污染），
 * 而服务端一次解码就能拿到同样甚至更规整的结果。
 *
 * 单格高度不写在响应里，而是从图片自身尺寸读：它取决于源视频宽高比，
 * 读 naturalHeight 就是最准的值，省去前后端各算一遍宽高比的同步成本。
 */
"use client";

import { storageKeyOf } from "@noxrea/shared/url";
import { useCallback, useEffect, useState } from "react";

import { fetchFrameSprite, type FrameSpriteInfo, type MediaRequestError, readMediaError } from "@/features/canvas/api/file-api";
import { fileRefUrl } from "@/lib/file-url";

/** 轨道内容区宽度（px，不含左右 12px 边距）——格子总宽与之严格相等，
    轨道容器宽度必须是它 + 24px（用 px 而非 rem，避免两边坐标系漂移） */
export const FRAME_TRACK_WIDTH = 1000;
/** 轨道高（px）——与 FrameStripPanel 的 h-14 对齐，用于把单格等比缩放进轨道 */
export const FRAME_TRACK_HEIGHT = 56;
/** 元数据读取超时（ms）：损坏视频可能永久挂起 */
const META_TIMEOUT = 10_000;

export type FrameStripStatus = "loading" | "ready" | "error";

export interface FrameSpriteState {
  /** 雪碧图地址；走兜底路径（无缩略图）时为 null */
  url: string | null;
  /** 雪碧图总宽（px）：背景缩放后的整体宽度由它推算 */
  spriteWidth: number;
  /** 单格原始宽高（px） */
  cellWidth: number;
  cellHeight: number;
  /** 实际格数；为 0 表示没有缩略图，只保留可定位的轨道 */
  count: number;
  /** 单格显示宽度（px） */
  frameWidth: number;
  /** 视频时长（s） */
  duration: number;
  /** 真实帧率，供一帧步进使用；拿不到时为 null */
  fps: number | null;
  /** duration 的来源：sprite = 服务端按可解码内容计算（可信）；
      fallback = 浏览器读原视频容器标称值（截断视频会虚报，调用方需自行核验） */
  durationSource: "sprite" | "fallback" | null;
  /** 源文件被截断：duration 是实际可解码时长，declaredDuration 是容器标称值 */
  truncated: boolean;
  declaredDuration: number | null;
  status: FrameStripStatus;
  /** 服务端失败原因（限流 / 繁忙 / 生成失败）：轨道保留兜底能力，面板据此提示并重试 */
  error: MediaRequestError | null;
}

const INITIAL: FrameSpriteState = {
  url: null,
  spriteWidth: 0,
  cellWidth: 0,
  cellHeight: 0,
  count: 0,
  frameWidth: 0,
  duration: 0,
  fps: null,
  durationSource: null,
  truncated: false,
  declaredDuration: null,
  status: "loading",
  error: null,
};

/**
 * 雪碧图不可用时的兜底：用 video 元素只读元数据拿时长。
 *
 * 与逐帧 seek 抽帧不同，这里只等 loadedmetadata，解码器几乎不做功，因此也不会
 * 遇到 seek 超时或 canvas 跨域污染。拿到时长后面板仍可拖动定位与截取（成片抽帧
 * 走后端精确 seek），只是轨道上没有缩略图。
 */
function probeDuration(src: string): Promise<number | null> {
  return new Promise((resolve) => {
    const video = document.createElement("video");
    video.preload = "metadata";
    video.muted = true;
    video.playsInline = true;
    video.style.cssText = "position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0;pointer-events:none;";
    document.body.appendChild(video);

    let settled = false;
    const done = (value: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // 必须清空 src 再 load()：否则解码器仍持有文件句柄，Windows 上会锁住视频文件
      video.removeAttribute("src");
      video.load();
      video.remove();
      resolve(value);
    };
    // 声明在 done 之后、只在它内部使用：真正调用时早已初始化，不存在 TDZ 问题
    const timer = setTimeout(() => done(null), META_TIMEOUT);
    video.addEventListener("loadedmetadata", () => {
      const d = video.duration;
      // 部分 webm 的 duration 为 Infinity/NaN，无法做时间映射
      done(Number.isFinite(d) && d > 0 ? d : null);
    });
    video.addEventListener("error", () => done(null));
    video.src = src;
  });
}

/** 预加载雪碧图并读出真实像素尺寸；加载失败返回 null */
function loadSpriteSize(url: string): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () =>
      resolve(
        img.naturalWidth > 0 && img.naturalHeight > 0
          ? { width: img.naturalWidth, height: img.naturalHeight }
          : null,
      );
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

/**
 * 按给定视频地址加载帧序列雪碧图。
 * 组件卸载或地址变化时会中止未完成的加载；失败时轨道退化为「无缩略图但可定位」，
 * 同时带出失败原因与 retry——面板据此提示并由用户手动重试（不做自动重试）。
 */
export function useFrameSprite(videoRef: string | null): FrameSpriteState & { retry: () => void } {
  // 结果连同它所属的视频地址一起存：地址切换后旧结果即失效，靠这个标记区分，
  // 不必在 effect 里同步 setState 重置（那会引发级联渲染）
  const [entry, setEntry] = useState<{ src: string; sprite: FrameSpriteState }>({
    src: "",
    sprite: INITIAL,
  });
  // 手动重试的触发计数：入参不变时也要重新发起请求
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((a) => a + 1), []);

  useEffect(() => {
    if (!videoRef) return;
    const controller = new AbortController();
    let cancelled = false;
    const apply = (sprite: FrameSpriteState) => {
      if (cancelled) return;
      setEntry({ src: videoRef, sprite });
    };

    void (async () => {
      // 只有存储 key 引用才能请求服务端生成雪碧图；
      // 本地预览地址（blob 等）与外部 URL 没有对应键，直接走兜底读时长
      const videoKey = storageKeyOf(videoRef);
      let fetchError: MediaRequestError | null = null;

      if (videoKey) {
        const info = await fetchFrameSprite(videoKey, controller.signal)
          .then(async (res) => {
            if (!res.ok) {
              fetchError = await readMediaError(res);
              return null;
            }
            const json = (await res.json()) as { data?: FrameSpriteInfo };
            return json.data ?? null;
          })
          .catch(() => {
            // 请求失败只有两种：本组件中止（忽略），或真实网络失败（带原因走兜底与重试）
            if (controller.signal.aborted) return null;
            fetchError = { code: "network_error", retryAfterSeconds: null, receivedAt: Date.now() };
            return null;
          });
        if (cancelled) return;

        if (info?.url) {
          const size = await loadSpriteSize(info.url);
          if (cancelled) return;
          if (size) {
            // 格数以图片实际宽度为准，避免前后端各算一遍而不同步
            const count = Math.max(1, Math.round(size.width / info.cell_width));
            apply({
              url: info.url,
              spriteWidth: size.width,
              cellWidth: info.cell_width,
              cellHeight: size.height,
              count,
              frameWidth: FRAME_TRACK_WIDTH / count,
              duration: info.duration,
              fps: info.fps ?? null,
              durationSource: "sprite",
              truncated: info.truncated ?? false,
              declaredDuration: info.declared_duration ?? null,
              status: "ready",
              error: null,
            });
            return;
          }
        }
      }

      // 兜底：拿不到雪碧图也要拿到时长，否则播放头无从定位、面板等同于不可用。
      // 注意来源标记为 fallback：浏览器读的是容器标称值，截断视频会虚报，
      // 调用方（片段截取面板）需改用代理元素的真实时长做时间轴；
      // 服务端失败原因（fetchError）随状态带出，面板据此提示并重试
      const duration = await probeDuration(fileRefUrl(videoRef));
      apply(
        duration
          ? { ...INITIAL, duration, durationSource: "fallback", status: "ready", error: fetchError }
          : { ...INITIAL, status: "error", error: fetchError },
      );
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [videoRef, attempt]);

  // 地址已切换但新结果还没回来时返回初始态，避免短暂沿用上一条视频的缩略图
  return entry.src === videoRef ? { ...entry.sprite, retry } : { ...INITIAL, retry };
}
