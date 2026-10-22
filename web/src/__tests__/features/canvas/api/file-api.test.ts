/**
 * 编辑响应投影的持久化契约：单产物编辑只消费 `data.key`，分离音轨消费
 * `audio.key` / `video.key` 且缺一即失败。
 *
 * 派生节点 data.src 的持久化值域是存储 key，响应中的 `url` 是渲染期派生
 * （specs/storage-reference-key-unification.md）；投影层是五条编辑路径
 * （音频截取/变速、视频截取/裁剪、分离音轨）的唯一分叉点，回归必须锁在这里。
 */
import type { TFunction } from "i18next";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  detachedMedia,
  editResultResponse,
  errorResponse,
  jsonResponse,
  makeStorageKey,
} from "@/__tests__/test-utils/storage-fixtures";

const { notifyActionFailed } = vi.hoisted(() => ({ notifyActionFailed: vi.fn() }));

vi.mock("@/lib/api/client", () => ({ apiRaw: vi.fn(), BASE: "http://test", getTokenHeader: () => ({}) }));
vi.mock("@/features/canvas/shared/notify", () => ({ notifyActionFailed }));

import type { EditEnvelopeContext } from "@/features/canvas/api/file-api";
import {
  readCapturedFrame,
  readDetachAudioResult,
  readEditResultKey,
} from "@/features/canvas/api/file-api";

const KEY = makeStorageKey("b", ".m4a");
const AUDIO_KEY = makeStorageKey("detach-audio", ".m4a");
const VIDEO_KEY = makeStorageKey("detach-video", ".mp4");

/**
 * 完整实现的信封上下文：errorKey 必须与各调用点的兜底 key 一致
 * （VideoNode / AudioNode 的五个编辑路径），否则断言锁定的是测试自己的假设。
 */
function makeCtx(overrides: Partial<EditEnvelopeContext> = {}): EditEnvelopeContext {
  return {
    notification: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
    // t 的完整重载集无法在测试里逐条实现；只用到「key → key」这一形态
    t: ((key: string) => key) as unknown as TFunction,
    errorKey: "error.clip.extract_failed",
    nodeId: "node-1",
    onErrorCode: vi.fn(),
    ...overrides,
  };
}

/** 分离音轨响应：两个产物都带 key 与展示 url（url 仅供渲染） */
function detachResponse(omit?: "audio" | "video") {
  return jsonResponse({
    data: {
      audio:
        omit === "audio"
          ? undefined
          : { ...detachedMedia(AUDIO_KEY, "audio/mp4", ".m4a"), format: "copy" },
      video: omit === "video" ? undefined : detachedMedia(VIDEO_KEY, "video/mp4", ".mp4"),
    },
  });
}

describe("readEditResultKey", () => {
  let ctx: EditEnvelopeContext;
  beforeEach(() => {
    vi.clearAllMocks();
    ctx = makeCtx();
  });

  it("只取 data.key，忽略同响应中的展示 url", async () => {
    const key = await readEditResultKey(editResultResponse(KEY), new AbortController().signal, ctx);
    expect(key).toBe(KEY);
  });

  it("成功响应缺 key 属契约破坏：返回 undefined 并按失败提示", async () => {
    const key = await readEditResultKey(
      jsonResponse({ data: { url: `/api/files/${KEY}`, size: 1 } }),
      new AbortController().signal,
      ctx,
    );
    expect(key).toBeUndefined();
    expect(notifyActionFailed).toHaveBeenCalledWith(
      ctx.notification,
      ctx.t,
      undefined,
      "error.clip.extract_failed",
      "node-1",
      null,
    );
    // 与信封失败路径同一联动契约：无错误码时收到 undefined
    expect(ctx.onErrorCode).toHaveBeenCalledWith(undefined);
  });

  it("失败响应返回 undefined，并按 errorKey 通知", async () => {
    const key = await readEditResultKey(
      errorResponse("common.invalid_request"),
      new AbortController().signal,
      ctx,
    );
    expect(key).toBeUndefined();
    expect(notifyActionFailed).toHaveBeenCalledWith(
      ctx.notification,
      ctx.t,
      "common.invalid_request",
      "error.clip.extract_failed",
      "node-1",
      null,
    );
  });

  it("请求已中止时丢弃收尾响应且不提示", async () => {
    const controller = new AbortController();
    controller.abort();
    const key = await readEditResultKey(editResultResponse(KEY), controller.signal, ctx);
    expect(key).toBeUndefined();
    expect(notifyActionFailed).not.toHaveBeenCalled();
  });
});

describe("readCapturedFrame", () => {
  let ctx: EditEnvelopeContext;
  beforeEach(() => {
    vi.clearAllMocks();
    // 与 VideoNode 抽帧调用点的兜底 key 一致
    ctx = makeCtx({ errorKey: "error.capture_frame.capture_failed" });
  });

  it("投影只含 key / 时间 / 尺寸，展示 url 不暴露给调用方", async () => {
    const frame = await readCapturedFrame(
      jsonResponse({
        data: {
          frame_key: KEY,
          url: `/api/files/${KEY}`,
          time: 32.9,
          width: 1280,
          height: 720,
        },
      }),
      new AbortController().signal,
      ctx,
    );
    expect(frame).toEqual({ key: KEY, time: 32.9, width: 1280, height: 720 });
    expect(frame).not.toHaveProperty("url");
  });

  it("成功响应缺 frame_key 属契约破坏：返回 undefined 并按失败提示", async () => {
    const frame = await readCapturedFrame(
      jsonResponse({
        data: { url: `/api/files/${KEY}`, time: 32.9, width: 1280, height: 720 },
      }),
      new AbortController().signal,
      ctx,
    );
    expect(frame).toBeUndefined();
    expect(notifyActionFailed).toHaveBeenCalledWith(
      ctx.notification,
      ctx.t,
      undefined,
      "error.capture_frame.capture_failed",
      "node-1",
      null,
    );
    expect(ctx.onErrorCode).toHaveBeenCalledWith(undefined);
  });
});

describe("readDetachAudioResult", () => {
  let ctx: EditEnvelopeContext;
  beforeEach(() => {
    vi.clearAllMocks();
    // 与 VideoNode 分离音轨调用点的兜底 key 一致
    ctx = makeCtx({ errorKey: "detach.failed" });
  });

  it("双产物各自消费 key，忽略展示 url", async () => {
    const result = await readDetachAudioResult(
      detachResponse(),
      new AbortController().signal,
      ctx,
    );
    expect(result?.audio.key).toBe(AUDIO_KEY);
    expect(result?.video.key).toBe(VIDEO_KEY);
  });

  it.each(["audio", "video"] as const)("成功响应缺 %s.key 属契约破坏：不返回半成品", async (missing) => {
    const result = await readDetachAudioResult(
      detachResponse(missing),
      new AbortController().signal,
      ctx,
    );
    expect(result).toBeUndefined();
    expect(notifyActionFailed).toHaveBeenCalledWith(
      ctx.notification,
      ctx.t,
      undefined,
      "detach.failed",
      "node-1",
      null,
    );
    expect(ctx.onErrorCode).toHaveBeenCalledWith(undefined);
  });
});
