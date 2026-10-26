/**
 * 视频预览代理加载契约（specs/client-video-editing.md 轮二十三）：
 * 只对存储 key 发起请求；换源 / 重试时旧结果立即失效；失败可重试，
 * 消费方上报不可解码时进入无错误码的失败态。
 */
// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { jsonResponse, makeStorageKey } from "@/__tests__/test-utils/storage-fixtures";

const { fetchVideoProxy, readMediaError, resolveMediaUrlString } = vi.hoisted(() => ({
  fetchVideoProxy: vi.fn(),
  readMediaError: vi.fn(),
  // 默认恒等：未显式设定时解析层把逻辑 URL 原样返回（stream 语义）
  resolveMediaUrlString: vi.fn((url: string) => Promise.resolve(url)),
}));

vi.mock("@/features/canvas/api/file-api", () => ({ fetchVideoProxy, readMediaError }));
vi.mock("@/lib/file-access", () => ({ resolveMediaUrlString }));

import { useVideoProxy } from "@/features/canvas/hooks/use-video-proxy";

const KEY = makeStorageKey("proxy", ".mp4");
const NEXT_KEY = makeStorageKey("proxy-2", ".mp4");

describe("useVideoProxy", () => {
  beforeEach(() => {
    // reset 而非 clear：清掉 Once 队列，避免未消费的替身跨用例泄漏
    fetchVideoProxy.mockReset();
    readMediaError.mockReset();
    resolveMediaUrlString.mockReset();
    resolveMediaUrlString.mockImplementation((url: string) => Promise.resolve(url));
  });
  afterEach(cleanup);

  it("存储 key 引用发起代理请求，ready 时暴露 url 与时长", async () => {
    fetchVideoProxy.mockResolvedValue(
      jsonResponse({ data: { url: "http://test/proxy.mp4", duration: 12.5 } }),
    );
    const { result } = renderHook(() => useVideoProxy(KEY));
    expect(result.current.status).toBe("pending");

    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.url).toBe("http://test/proxy.mp4");
    expect(result.current.duration).toBe(12.5);
    expect(fetchVideoProxy).toHaveBeenCalledWith(KEY, expect.any(AbortSignal));
  });

  it("key 请求成功但缺 url 属契约破坏：failed 且无错误码", async () => {
    fetchVideoProxy.mockResolvedValue(jsonResponse({ data: { duration: 3 } }));
    const { result } = renderHook(() => useVideoProxy(KEY));

    await waitFor(() => expect(result.current.status).toBe("failed"));
    expect(result.current.error).toBeNull();
  });

  it("外部 URL 不发起只接受 key 的请求，直接定论为无代理", async () => {
    const { result } = renderHook(() => useVideoProxy("https://example.com/a.mp4"));

    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.url).toBeNull();
    expect(fetchVideoProxy).not.toHaveBeenCalled();
  });

  it("失败响应进入 failed 并携带错误码；retry 重新请求", async () => {
    fetchVideoProxy.mockResolvedValueOnce(new Response(null, { status: 429 }));
    readMediaError.mockResolvedValueOnce({ code: "media.busy", retryAfterSeconds: 3, receivedAt: 1 });
    const { result } = renderHook(() => useVideoProxy(KEY));

    await waitFor(() => expect(result.current.status).toBe("failed"));
    expect(result.current.error?.code).toBe("media.busy");

    fetchVideoProxy.mockResolvedValueOnce(jsonResponse({ data: { url: "http://test/proxy-2.mp4" } }));
    act(() => result.current.retry());
    expect(result.current.status).toBe("pending");

    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.url).toBe("http://test/proxy-2.mp4");
    expect(fetchVideoProxy).toHaveBeenCalledTimes(2);
  });

  it("代理地址经访问解析层换成最终地址后才暴露（S3 签名直连不在元素上使用逻辑 URL）", async () => {
    fetchVideoProxy.mockResolvedValue(
      jsonResponse({ data: { url: "/api/files/_proxy/1/ab/x_w480v3.mp4", duration: 8 } }),
    );
    resolveMediaUrlString.mockResolvedValue("https://bucket.example/x_w480v3.mp4?X-Amz-Signature=abc");

    const { result } = renderHook(() => useVideoProxy(KEY));

    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(resolveMediaUrlString).toHaveBeenCalledWith("/api/files/_proxy/1/ab/x_w480v3.mp4");
    expect(result.current.url).toBe("https://bucket.example/x_w480v3.mp4?X-Amz-Signature=abc");
  });

  it("代理地址解析失败（含一次重新描述）→ failed 可重试，不把逻辑 URL 交给元素", async () => {
    fetchVideoProxy.mockResolvedValue(jsonResponse({ data: { url: "/api/files/_proxy/1/ab/x_w480v3.mp4" } }));
    resolveMediaUrlString.mockRejectedValue(new Error("signing unavailable"));

    const { result } = renderHook(() => useVideoProxy(KEY));

    await waitFor(() => expect(result.current.status).toBe("failed"));
    expect(result.current.url).toBeNull();
    expect(result.current.error?.code).toBe("network_error");
  });

  it("换源后旧结果立即失效；markFailed 把已就绪代理标为失败", async () => {
    fetchVideoProxy.mockResolvedValueOnce(jsonResponse({ data: { url: "http://test/old.mp4" } }));
    const { result, rerender } = renderHook(({ src }) => useVideoProxy(src), {
      initialProps: { src: KEY },
    });
    await waitFor(() => expect(result.current.status).toBe("ready"));

    act(() => result.current.markFailed());
    expect(result.current.status).toBe("failed");
    // 解码失败不带错误码：重试同一份缓存产物不会成功
    expect(result.current.error).toBeNull();

    let resolveNext: (res: Response) => void = () => {};
    fetchVideoProxy.mockImplementationOnce(
      () => new Promise<Response>((resolve) => { resolveNext = resolve; }),
    );
    rerender({ src: NEXT_KEY });
    expect(result.current.status).toBe("pending");
    expect(result.current.url).toBeNull();

    await act(async () => {
      resolveNext(jsonResponse({ data: { url: "http://test/new.mp4" } }));
    });
    await waitFor(() => expect(result.current.url).toBe("http://test/new.mp4"));
  });
});
