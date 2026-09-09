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
  /** 视频时长（s） */
  duration: number;
  /** 真实帧率，拿不到时为 null */
  fps: number | null;
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
export async function detachAudio(videoKey: string): Promise<Response> {
  return apiRaw("/api/files/detach-audio", {
    method: "POST",
    body: JSON.stringify({ video_key: videoKey }),
  });
}
