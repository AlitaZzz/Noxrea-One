/**
 * 文件（Files）相关 API 封装：抽帧、音视频分离等媒体处理接口。
 */
import { apiRaw } from "@/lib/api/client";

/** 从视频指定时间抽帧，返回原始 Response（调用方解析 data.url）。 */
export async function captureFrame(videoKey: string, time: number): Promise<Response> {
  return apiRaw("/api/files/capture-frame", {
    method: "POST",
    body: JSON.stringify({ video_key: videoKey, time }),
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
 * 获取（必要时生成）全 I 帧代理视频，用于帧序列抽帧加速。
 * 代理让每次 seek 只解一帧，抽满一整条轨道快数倍；失败时调用方回退原视频即可。
 */
export async function fetchVideoProxy(videoKey: string): Promise<Response> {
  return apiRaw("/api/files/video-proxy", {
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
export async function detachAudio(videoKey: string): Promise<Response> {
  return apiRaw("/api/files/detach-audio", {
    method: "POST",
    body: JSON.stringify({ video_key: videoKey }),
  });
}
