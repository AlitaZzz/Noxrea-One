/**
 * 视频帧序列缩略图抽取。
 *
 * 用隐藏 video + canvas 串行 seek 抽帧，生成整条轨道的缩略图 dataURL：
 * 帧数由视频时长决定（每格约 0.5 秒）并以最小帧宽兜底，抽到一帧就回填一次，
 * 用户看到的是缩略图逐张填充而不是空白等待。
 *
 * 缩略图只用于粗略定位——播放头位置由指针坐标连续计算，不吸附到格中心；
 * 真正出图由后端 ffmpeg 精确 seek 完成（见 VideoNode 的 captureFrame）。
 * 因此单帧失败（seek 超时、canvas 跨域污染）只降级为占位块，不阻断后续操作。
 */
"use client";

import { useEffect, useState } from "react";

/** 轨道宽（px）——与 FrameStripPanel 的 w-250 对齐，即 250 × 0.25rem = 1000px */
export const FRAME_TRACK_WIDTH = 1000;
/** 单帧采样宽（px）：仅为显示服务，远小于原分辨率以节省内存 */
const THUMB_WIDTH = 160;
/** 目标粒度：每格约 0.5 秒，让不同时长视频的选帧手感一致 */
const TARGET_SEC_PER_FRAME = 0.5;
/**
 * 帧数上下限。上限 20 同时兜住两件事：帧宽不低于 50px（再窄缩略图认不出画面），
 * 抽帧耗时控制在 2 秒左右；下限 8 避免短视频只剩稀疏几格。
 */
const MIN_FRAMES = 8;
const MAX_FRAMES = 20;
/** 元数据加载 / 单次 seek 超时（ms）：损坏视频可能永久挂起 */
const META_TIMEOUT = 10_000;
const SEEK_TIMEOUT = 3_000;

export type FrameStripStatus = "loading" | "extracting" | "ready" | "error";

export interface FrameStripState {
  /** 缩略图 dataURL 列表；未抽到的位置为 null（渲染占位块） */
  frames: (string | null)[];
  /** 单帧显示宽度（px），由视频宽高比推算并铺满轨道 */
  frameWidth: number;
  /** 视频时长（s）；不可用时为 0 */
  duration: number;
  /** 已成功抽出的帧数，用于进度提示 */
  extracted: number;
  /** loading=加载元数据；extracting=抽帧中；ready=全部完成；error=时长不可用 */
  status: FrameStripStatus;
}

const INITIAL: FrameStripState = {
  frames: [],
  frameWidth: FRAME_TRACK_WIDTH / MIN_FRAMES,
  duration: 0,
  extracted: 0,
  status: "loading",
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** 等待 video 的单个事件，带超时与 error 兜底 */
function waitEvent(
  video: HTMLVideoElement,
  event: "loadedmetadata" | "seeked",
  timeout: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      video.removeEventListener(event, onDone);
      video.removeEventListener("error", onFail);
    };
    const onDone = () => { cleanup(); resolve(); };
    const onFail = () => { cleanup(); reject(new Error(`video ${event} failed`)); };
    const timer = setTimeout(() => { cleanup(); reject(new Error(`video ${event} timeout`)); }, timeout);
    video.addEventListener(event, onDone);
    video.addEventListener("error", onFail);
  });
}

/** seek 到指定时间；目标时间与当前一致时不会触发 seeked，直接返回 */
async function seekTo(video: HTMLVideoElement, time: number): Promise<void> {
  if (Math.abs(video.currentTime - time) < 1e-3) return;
  const pending = waitEvent(video, "seeked", SEEK_TIMEOUT);
  video.currentTime = time;
  await pending;
}

/**
 * 按给定 src 抽取整条轨道的缩略图。
 * 组件卸载或 src 变化时会中断未完成的抽帧并释放 video 资源。
 */
export function useFrameThumbnails(src: string): FrameStripState {
  const [state, setState] = useState<FrameStripState>(INITIAL);

  useEffect(() => {
    if (!src) return;
    let cancelled = false;

    const video = document.createElement("video");
    video.preload = "auto";
    video.muted = true;
    video.playsInline = true;
    // 跨域资源需显式声明才能拿到未污染的 canvas；同源时不设置，避免多余 CORS 约束
    if (/^https?:\/\//i.test(src) && !src.startsWith(window.location.origin)) {
      video.crossOrigin = "anonymous";
    }
    // 不用 display:none：部分浏览器会跳过解码，改为移出视口的不可见元素
    video.style.cssText = "position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0;pointer-events:none;";
    document.body.appendChild(video);
    video.src = src;

    const canvas = document.createElement("canvas");

    void (async () => {
      try {
        await waitEvent(video, "loadedmetadata", META_TIMEOUT);
        const duration = video.duration;
        if (cancelled) return;
        // 部分 webm 的 duration 为 Infinity/NaN，无法做时间映射，只能放弃预览
        if (!Number.isFinite(duration) || duration <= 0) {
          setState({ ...INITIAL, status: "error" });
          return;
        }

        const aspect = video.videoWidth && video.videoHeight
          ? video.videoWidth / video.videoHeight
          : 16 / 9;
        // 密度由时长决定（每格约 TARGET_SEC_PER_FRAME 秒）后钳到上下限：
        // 10 秒内的视频能拿到 0.5 秒粒度，更长的视频固定 20 格、粒度随之变粗
        const count = clamp(Math.ceil(duration / TARGET_SEC_PER_FRAME), MIN_FRAMES, MAX_FRAMES);
        const frameWidth = FRAME_TRACK_WIDTH / count;

        // 缩略图按轨道比例缩放：竖屏高、横屏矮，避免 object-contain 拉伸
        canvas.width = THUMB_WIDTH;
        canvas.height = Math.max(1, Math.round(THUMB_WIDTH / aspect));

        const frames: (string | null)[] = new Array(count).fill(null);
        setState({ frames, frameWidth, duration, extracted: 0, status: "extracting" });

        const ctx = canvas.getContext("2d");
        for (let i = 0; i < count; i++) {
          if (cancelled || !ctx) return;
          // 取每格中点，避免抽到两格边界的重复画面
          const time = ((i + 0.5) / count) * duration;
          let url: string | null = null;
          try {
            await seekTo(video, time);
            if (cancelled) return;
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            url = canvas.toDataURL("image/jpeg", 0.7);
          } catch {
            // seek 超时或 canvas 被跨域污染：保留占位块，继续抽下一帧
            url = null;
          }
          if (cancelled) return;
          frames[i] = url;
          const extracted = frames.reduce((n, f) => (f ? n + 1 : n), 0);
          setState({
            frames: [...frames],
            frameWidth,
            duration,
            extracted,
            status: i === count - 1 ? "ready" : "extracting",
          });
        }
      } catch {
        if (!cancelled) setState({ ...INITIAL, status: "error" });
      }
    })();

    return () => {
      cancelled = true;
      // 必须清空 src 并 load()：否则解码器仍持有文件句柄，Windows 上会锁住视频文件
      video.removeAttribute("src");
      video.load();
      video.remove();
    };
  }, [src]);

  return state;
}
