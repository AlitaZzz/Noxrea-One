/**
 * 文件（Files）相关 API 封装：抽帧等媒体处理接口。
 */
import { apiRaw } from "./client";

/** 从视频指定时间抽帧，返回原始 Response（调用方解析 data.url）。 */
export async function captureFrame(videoKey: string, time: number): Promise<Response> {
  return apiRaw("/api/files/capture-frame", {
    method: "POST",
    body: JSON.stringify({ video_key: videoKey, time }),
  });
}
