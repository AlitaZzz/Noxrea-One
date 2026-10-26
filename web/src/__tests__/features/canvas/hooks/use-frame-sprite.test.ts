// @vitest-environment jsdom
/**
 * 帧序列雪碧图加载（specs/storage-signed-direct-delivery.md 规则 3.5）：
 * 服务端返回的是逻辑托管 URL，暴露给轨道背景的必须是访问解析后的最终地址
 * （S3 为签名直连，字节不回流应用）。回归：曾把 `info.url` 直接透出，
 * 轨道的 background-image 因此请求应用路径，S3 部署下取不到字节。
 */
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { jsonResponse, makeStorageKey } from "@/__tests__/test-utils/storage-fixtures";

const { fetchFrameSprite, readMediaError, resolveMediaUrlString } = vi.hoisted(() => ({
  fetchFrameSprite: vi.fn(),
  readMediaError: vi.fn(),
  resolveMediaUrlString: vi.fn((url: string) => Promise.resolve(url)),
}));

vi.mock("@/features/canvas/api/file-api", () => ({ fetchFrameSprite, readMediaError }));
vi.mock("@/lib/file-access", () => ({ resolveMediaUrlString }));

import { useFrameSprite } from "@/features/canvas/hooks/use-frame-sprite";

const KEY = makeStorageKey("sprite", ".mp4");
const LOGICAL = "/api/files/_sprite/1/ab/x_c8v1.webp";
const SIGNED = "https://bucket.example/_sprite/x_c8v1.webp?X-Amz-Signature=abc";

/** 服务端响应：格数由雪碧图像素宽度反推，这里给一个能被 loadSpriteSize 读到的尺寸 */
const SPRITE_INFO = {
  url: LOGICAL,
  count: 8,
  cell_width: 100,
  duration: 12,
  fps: 24,
};

/** jsdom 不解码图片：拦截 Image 的 src，按目标地址回填尺寸 */
class SizedImage {
  naturalWidth = 800;
  naturalHeight = 56;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private _src = "";
  get src() { return this._src; }
  set src(value: string) {
    this._src = value;
    queueMicrotask(() => this.onload?.());
  }
}

describe("useFrameSprite 雪碧图地址", () => {
  beforeEach(() => {
    fetchFrameSprite.mockReset();
    readMediaError.mockReset();
    resolveMediaUrlString.mockReset();
    resolveMediaUrlString.mockImplementation((url: string) => Promise.resolve(url));
    vi.stubGlobal("Image", SizedImage);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("轨道拿到的是访问解析后的最终地址，不是响应里的逻辑 URL", async () => {
    fetchFrameSprite.mockResolvedValue(jsonResponse({ data: SPRITE_INFO }));
    resolveMediaUrlString.mockResolvedValue(SIGNED);

    const { result } = renderHook(() => useFrameSprite(KEY));

    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(resolveMediaUrlString).toHaveBeenCalledWith(LOGICAL);
    expect(result.current.url).toBe(SIGNED);
    expect(result.current.count).toBe(8);
  });

  it("雪碧图地址解析失败 → 退化为无缩略图但可定位的轨道（不暴露逻辑 URL）", async () => {
    fetchFrameSprite.mockResolvedValue(jsonResponse({ data: SPRITE_INFO }));
    resolveMediaUrlString.mockRejectedValue(new Error("signing unavailable"));

    const { result } = renderHook(() => useFrameSprite(KEY));

    // 兜底路径会去读原视频时长；jsdom 的 video 永远不触发 loadedmetadata，
    // 这里只断言缩略图侧的结果：url 为 null、count 为 0
    await waitFor(() => expect(resolveMediaUrlString).toHaveBeenCalledWith(LOGICAL));
    await waitFor(() => expect(result.current.url).toBeNull());
    expect(result.current.count).toBe(0);
  });

  it("解析失败时带出错误原因，面板因此提供提示与手动重试", async () => {
    vi.useFakeTimers();
    try {
      fetchFrameSprite.mockResolvedValue(jsonResponse({ data: SPRITE_INFO }));
      resolveMediaUrlString.mockRejectedValue(new Error("signing unavailable"));

      const { result } = renderHook(() => useFrameSprite(KEY));

      // 兜底时长探测有 10s 上限；推进到超时后状态才结算
      await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
      expect(result.current.status).toBe("error");
      expect(result.current.error).toMatchObject({ code: "network_error" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("地址解析成功但图片加载失败时同样带出原因，不静默退化", async () => {
    class BrokenImage {
      naturalWidth = 0;
      naturalHeight = 0;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_value: string) {
        queueMicrotask(() => this.onerror?.());
      }
    }
    vi.stubGlobal("Image", BrokenImage);
    fetchFrameSprite.mockResolvedValue(jsonResponse({ data: SPRITE_INFO }));
    // 雪碧图地址解析成功、图片加载失败；原视频地址解析失败让兜底立即结算（不触发 video 探测）
    resolveMediaUrlString.mockImplementation((url: string) =>
      url === LOGICAL ? Promise.resolve(SIGNED) : Promise.reject(new Error("video unavailable")));

    const { result } = renderHook(() => useFrameSprite(KEY));

    await waitFor(() =>
      expect(result.current.error).toMatchObject({ code: "network_error" }),
    );
  });
});
