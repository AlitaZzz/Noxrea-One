/**
 * 文件（Files）相关 API 封装：上传约束、抽帧、音视频分离等媒体处理接口。
 */
import type { FrameSelection } from "@noxrea/shared";
import { type CropRectPx } from "@noxrea/shared/crop-rect";
import type { TFunction } from "i18next";

import { notifyActionFailed } from "@/features/canvas/shared/notify";
import { apiRaw } from "@/lib/api/client";
import type { NotificationApi } from "@/lib/feedback";

/** 抽帧服务端响应：持久化 key、渲染 URL、尺寸和抽帧时间。 */
export interface CapturedFrameInfo {
  frame_key: string;
  url: string;
  time: number;
  width: number;
  height: number;
}

/** 抽帧产物的持久化投影：存储 key + 派生节点所需尺寸 / 时间（不含渲染 URL）。 */
export interface CapturedFrameRef {
  key: string;
  time: number;
  width: number;
  height: number;
}

export async function captureFrame(
  videoKey: string,
  selection: FrameSelection,
  signal?: AbortSignal,
): Promise<Response> {
  return apiRaw("/api/files/capture-frame", {
    method: "POST",
    body: JSON.stringify({ video_key: videoKey, selection }),
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
export async function fetchVideoProxy(videoKey: string, signal?: AbortSignal): Promise<Response> {
  return apiRaw("/api/files/video-proxy", {
    method: "POST",
    body: JSON.stringify({ video_key: videoKey }),
    signal,
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
export async function fetchFrameSprite(videoKey: string, signal?: AbortSignal): Promise<Response> {
  return apiRaw("/api/files/frame-sprite", {
    method: "POST",
    body: JSON.stringify({ video_key: videoKey }),
    signal,
  });
}

/** 媒体请求的可重试失败：限流（common.rate_limited）、个人名额（media.user_busy）、
    全站繁忙（media.busy）与各路由失败码都走同一个形状 */
export interface MediaRequestError {
  /** 服务端错误码（error.<code> 本地化） */
  code: string;
  /** Retry-After 提示的可重试秒数；响应未带时为 null（仍可手动重试，不倒计时） */
  retryAfterSeconds: number | null;
  /** 失败到达时刻（epoch ms）：Retry-After 倒计时以此为基准，组件渲染期不读时钟 */
  receivedAt: number;
}

/** 读取 Retry-After（秒）；缺失或非法时为 null */
function retryAfterOf(res: Response): number | null {
  const seconds = Number(res.headers.get("Retry-After"));
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

/** 从失败响应中读出错误码与 Retry-After：429 / 503 / 路由失败码共用 */
export async function readMediaError(res: Response): Promise<MediaRequestError> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  return {
    code: body?.error ?? "common.internal_error",
    retryAfterSeconds: retryAfterOf(res),
    receivedAt: Date.now(),
  };
}

/** 编辑动作 serverTask 的响应信封上下文（readEditEnvelope / readEditResultKey 共用） */
export interface EditEnvelopeContext {
  notification: NotificationApi;
  t: TFunction;
  /** 失败文案的兜底 key */
  errorKey: string;
  /** 通知去重的节点 id */
  nodeId: string;
  /** 特定错误码的节点侧联动（如分离音轨确认无音轨后禁用入口）；无错误码时收到 undefined */
  onErrorCode?: (code: string | undefined) => void;
}

/**
 * 编辑动作 serverTask 的统一响应信封解析：{ data, error } 形状由各编辑路由约定。
 * 响应返回后先复核中止信号（取消与响应收尾竞态时不弹虚假失败通知），失败经
 * notifyActionFailed 按 error.<code> 本地化（fallbackKey 回落 + Retry-After 附注
 * + 按节点去重）并返回 undefined——服务端兜底失败不抛（useMediaEditTask 契约）。
 */
async function readEditEnvelope<T>(
  res: Response,
  signal: AbortSignal,
  ctx: EditEnvelopeContext,
): Promise<T | undefined> {
  // 错误响应体可能非 JSON：防御解析，成功 / 失败共用
  const json = (await res.json().catch(() => null)) as { data?: T; error?: string } | null;
  if (signal.aborted) return undefined;
  // 「缺失」以 undefined 判定而非 falsy：泛型 T 为原始值时 0 / "" 是合法载荷
  if (!res.ok || json?.data === undefined) {
    const code = json?.error;
    notifyActionFailed(ctx.notification, ctx.t, code, ctx.errorKey, ctx.nodeId, retryAfterOf(res));
    ctx.onErrorCode?.(code);
    return undefined;
  }
  return json.data;
}

/**
 * 信封成功但缺持久化 key：属响应契约破坏（服务端正常路径不可能出现），
 * 与抽帧「200 但载荷缺字段」同一处理——按失败提示，不静默产出空值。
 */
function rejectMissingKey(res: Response, ctx: EditEnvelopeContext): undefined {
  // 与信封失败路径同一联动契约：无错误码时 onErrorCode 收到 undefined
  notifyActionFailed(ctx.notification, ctx.t, undefined, ctx.errorKey, ctx.nodeId, retryAfterOf(res));
  ctx.onErrorCode?.(undefined);
  return undefined;
}

/**
 * 编辑信封的持久化字段基座：成功信封缺少持久化 key 属响应契约破坏。
 * 单产物 / 双产物 / 抽帧的差异只在必填字段判定，失败提示与联动契约共用。
 */
async function readPersistedEnvelope<T>(
  res: Response,
  signal: AbortSignal,
  ctx: EditEnvelopeContext,
  hasPersistedKey: (data: T) => boolean,
): Promise<T | undefined> {
  const data = await readEditEnvelope<T>(res, signal, ctx);
  // 只有 undefined 表示已中止或已按 ctx 提示失败（不得重复提示）；
  // 与信封层的「缺失 = undefined」判定同一条规则，不对载荷做 falsy 归一
  if (data === undefined) return undefined;
  return hasPersistedKey(data) ? data : rejectMissingKey(res, ctx);
}

/**
 * 编辑产物的持久化值投影：单产物响应只取 `data.key`。
 *
 * 派生节点的 data.src 持久化值域是存储 key；响应里的 `url` 是渲染期派生物，
 * 不得写入节点（specs/storage-reference-key-unification.md）。单产物编辑动作
 * （音频截取/变速、视频截取/裁剪）统一经此投影，禁止各自再按 url 消费。
 */
export async function readEditResultKey(
  res: Response,
  signal: AbortSignal,
  ctx: EditEnvelopeContext,
): Promise<string | undefined> {
  const data = await readPersistedEnvelope<{ key?: string }>(
    res,
    signal,
    ctx,
    (data) => !!data.key,
  );
  return data?.key;
}

/** 音轨分离结果：独立音轨 + 静音视频 */
export interface DetachAudioResult {
  /** 音轨产物。format 为 copy 时是原编码无损拷贝，wav 为不兼容时的回退重编码 */
  audio: DetachedMedia & { format: "copy" | "wav" };
  /** 去掉音轨后的视频（视频流原样拷贝，未重新编码） */
  video: DetachedMedia;
}

/**
 * 分离音轨双产物的持久化值投影：`audio.key` 与 `video.key` 都进入节点
 * data.src，缺一即响应契约破坏，与 readEditResultKey 同一失败提示与联动契约。
 * 客户端管线的产物类型在编译期保证 key 非空，此投影只守服务端兜底信封。
 */
export async function readDetachAudioResult(
  res: Response,
  signal: AbortSignal,
  ctx: EditEnvelopeContext,
): Promise<DetachAudioResult | undefined> {
  return readPersistedEnvelope<DetachAudioResult>(
    res,
    signal,
    ctx,
    (data) => !!data.audio?.key && !!data.video?.key,
  );
}

/**
 * 抽帧响应投影：只暴露持久化 key 与展示所需的尺寸 / 时间。
 * `frame_key` 是写入派生图片节点的存储 key；响应中的 `url` 是渲染期派生物，
 * 不进入投影，调用方无从误写节点。缺 `frame_key` 属响应契约破坏。
 */
export async function readCapturedFrame(
  res: Response,
  signal: AbortSignal,
  ctx: EditEnvelopeContext,
): Promise<CapturedFrameRef | undefined> {
  const frame = await readPersistedEnvelope<CapturedFrameInfo>(
    res,
    signal,
    ctx,
    (data) => !!data.frame_key,
  );
  if (!frame) return undefined;
  return { key: frame.frame_key, time: frame.time, width: frame.width, height: frame.height };
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

/**
 * 裁剪视频画面区域（重编码整段视频），返回原始 Response。
 * 同步长请求，调用方需自行给出忙反馈；失败时按 `error.<code>` 读取本地化错误。
 * 源像素矩形契约类型 CropRectPx 直接从 @noxrea/shared/crop-rect 导入（单一来源）。
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
