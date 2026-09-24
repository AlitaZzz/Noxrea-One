/**
 * 文件（Files）相关 API 封装：上传约束、抽帧、音视频分离等媒体处理接口。
 */
import { api, apiRaw } from "@/lib/api/client";

/** 服务端上传约束：体积上限与格式白名单的唯一事实来源 */
export interface UploadLimits {
  maxSizeMb: number;
  formats: { image: string[]; video: string[]; audio: string[] };
}

/** 拉取上传约束，供上传 UI 展示格式/体积说明（避免前端硬编码与服务端漂移） */
export function fetchUploadLimits(signal?: AbortSignal): Promise<UploadLimits> {
  return api<UploadLimits>("/api/files/upload-limits", { signal });
}

/** 从 `/api/files/<key>` 形式的 URL 提取存储键（去掉查询串）。
    后端媒体接口的统一入参格式，抽帧/代理/雪碧图/截取等调用方共用 */
export function toFileKey(url: string): string {
  return url.replace(/^\/api\/files\//, "").split("?")[0];
}

/** 从视频指定时间抽帧，返回原始 Response（调用方解析 data.url）。 */
export async function captureFrame(
  videoKey: string,
  time: number,
  signal?: AbortSignal,
): Promise<Response> {
  return apiRaw("/api/files/capture-frame", {
    method: "POST",
    body: JSON.stringify({ video_key: videoKey, time }),
    signal,
  });
}

/** 分离产物的落库信息 */
export interface DetachedMedia {
  key: string;
  url: string;
  mime: string;
  ext: string;
  size: number;
}

/**
 * 获取（必要时生成）预览代理视频，用于拖动播放头时的 scrub 预览。
 * 代理是低分辨率短 GOP 副本，seek 最多解码 1 秒画面；失败时调用方回退原视频即可。
 */
export async function fetchVideoProxy(videoKey: string): Promise<Response> {
  return apiRaw("/api/files/video-proxy", {
    method: "POST",
    body: JSON.stringify({ video_key: videoKey }),
  });
}

/** 帧序列雪碧图：整条轨道的缩略图拼成的一张静态图 */
export interface FrameSpriteInfo {
  url: string;
  /** 采样格数 */
  count: number;
  /** 单格宽度（px） */
  cell_width: number;
  /** 视频时长（s）；截断文件时是实际可解码时长，不是容器声明值 */
  duration: number;
  /** 真实帧率，拿不到时为 null */
  fps: number | null;
  /** 源文件被截断（容器声明时长 > 实际数据）：轨道已收敛到可解码范围 */
  truncated?: boolean;
  /** 截断文件的容器声明时长（s），供面板展示标称值 */
  declared_duration?: number | null;
}

/**
 * 获取（必要时生成）帧序列雪碧图。
 * 服务端一次解码后等间隔采样并拼成一张图，前端按格取图渲染整条轨道；
 * 失败时调用方退化为「无缩略图但可定位」的轨道即可。
 */
export async function fetchFrameSprite(videoKey: string): Promise<Response> {
  return apiRaw("/api/files/frame-sprite", {
    method: "POST",
    body: JSON.stringify({ video_key: videoKey }),
  });
}

/** 音轨分离结果：独立音轨 + 静音视频 */
export interface DetachAudioResult {
  /** 音轨产物。format 为 copy 时是原编码无损拷贝，wav 为不兼容时的回退重编码 */
  audio: DetachedMedia & { format: "copy" | "wav" };
  /** 去掉音轨后的视频（视频流原样拷贝，未重新编码） */
  video: DetachedMedia;
}

/**
 * 从视频中分离音轨，返回原始 Response。
 * 同时产出独立音轨与静音视频两个文件；视频无音轨时后端返回 422。
 */
export async function detachAudio(videoKey: string, signal?: AbortSignal): Promise<Response> {
  return apiRaw("/api/files/detach-audio", {
    method: "POST",
    body: JSON.stringify({ video_key: videoKey }),
    signal,
  });
}

/** 片段截取结果 */
export interface ExtractedClipInfo {
  key: string;
  url: string;
  size: number;
  ext: string;
  mime: string;
}

/**
 * 截取视频片段（帧精确重编码），返回原始 Response。
 * 同步长请求（重编码可能持续数十秒），调用方需自行给出忙反馈；
 * 失败时按 `error.<code>` 读取本地化错误。
 */
export async function extractClip(
  videoKey: string,
  start: number,
  end: number,
  signal?: AbortSignal,
): Promise<Response> {
  return apiRaw("/api/files/extract-clip", {
    method: "POST",
    body: JSON.stringify({ video_key: videoKey, start, end }),
    signal,
  });
}

/**
 * 截取音频片段（音频流 copy，不重编码），返回原始 Response。
 * 同步请求（copy 秒级完成），调用方需自行给出忙反馈；
 * 失败时按 `error.<code>` 读取本地化错误。
 */
export async function extractAudioClip(
  audioKey: string,
  start: number,
  end: number,
  signal?: AbortSignal,
): Promise<Response> {
  return apiRaw("/api/files/extract-audio-clip", {
    method: "POST",
    body: JSON.stringify({ audio_key: audioKey, start, end }),
    signal,
  });
}

/**
 * 音频变速（ffmpeg atempo 重编码为 m4a，保留音调），返回原始 Response。
 * 同步请求（重编码可能持续数秒到数十秒），调用方需自行给出忙反馈；
 * 失败时按 `error.<code>` 读取本地化错误。
 */
export async function applyAudioSpeed(
  audioKey: string,
  speed: number,
  signal?: AbortSignal,
): Promise<Response> {
  return apiRaw("/api/files/apply-audio-speed", {
    method: "POST",
    body: JSON.stringify({ audio_key: audioKey, speed }),
    signal,
  });
}

/** 视频画面裁剪的源像素矩形（服务端会再次做偶数钳位与边界校验） */
export interface CropRectPx {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 裁剪视频画面区域（重编码整段视频），返回原始 Response。
 * 同步长请求，调用方需自行给出忙反馈；失败时按 `error.<code>` 读取本地化错误。
 */
export async function cropVideo(
  videoKey: string,
  rect: CropRectPx,
  signal?: AbortSignal,
): Promise<Response> {
  return apiRaw("/api/files/crop-video", {
    method: "POST",
    body: JSON.stringify({ video_key: videoKey, ...rect }),
    signal,
  });
}
