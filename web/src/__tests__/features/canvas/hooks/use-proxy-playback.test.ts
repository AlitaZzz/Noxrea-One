/**
 * 代理播放就绪度（specs/client-video-editing.md）：
 * ready 只代表产物可下载，换入节点播放器并 canplay 后才解锁 scrub；
 * 浏览器解不出来时上报失败并撤回换源；同一地址重试成功要重新换源。
 */
// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { jsonResponse, makeStorageKey } from "@/__tests__/test-utils/storage-fixtures";

const mocks = vi.hoisted(() => ({
  fetchVideoProxy: vi.fn(),
  readMediaError: vi.fn(),
  networkError: vi.fn(() => ({ code: "network_error", retryAfterSeconds: null, receivedAt: Date.now() })),
  // 默认恒等：解析层把逻辑 URL 原样返回
  resolveMediaUrlString: vi.fn((url: string) => Promise.resolve(url)),
  swapVideoSource: vi.fn(),
  isVideoPlaying: vi.fn(() => false),
}));

vi.mock("@/features/canvas/api/file-api", () => ({
  fetchVideoProxy: mocks.fetchVideoProxy,
  readMediaError: mocks.readMediaError,
  networkError: mocks.networkError,
}));
vi.mock("@/lib/file-access", () => ({ resolveMediaUrlString: mocks.resolveMediaUrlString }));
vi.mock("@/features/canvas/shared/video-playback-registry", () => ({
  swapVideoSource: mocks.swapVideoSource,
  isVideoPlaying: mocks.isVideoPlaying,
}));

import { useProxyPlayback } from "@/features/canvas/hooks/use-proxy-playback";

const NODE = "node-1";
const KEY = makeStorageKey("proxy", ".mp4");
const NEXT_KEY = makeStorageKey("proxy-2", ".mp4");

interface SwapOptions {
  resume?: boolean;
  onReady?: (ok: boolean) => void;
}
interface Swap {
  url: string;
  options: SwapOptions;
  cleanup: ReturnType<typeof vi.fn>;
}

let swaps: Swap[] = [];

describe("useProxyPlayback", () => {
  beforeEach(() => {
    // reset 而非 clear：清掉 Once 队列，避免未消费的替身跨用例泄漏
    mocks.fetchVideoProxy.mockReset();
    mocks.readMediaError.mockReset();
    mocks.isVideoPlaying.mockReset();
    mocks.isVideoPlaying.mockReturnValue(false);
    mocks.swapVideoSource.mockReset();
    swaps = [];
    mocks.swapVideoSource.mockImplementation((_nodeId: string, url: string, options: SwapOptions) => {
      const entry: Swap = { url, options, cleanup: vi.fn() };
      swaps.push(entry);
      return entry.cleanup;
    });
  });
  afterEach(cleanup);

  it("代理可下载后换入节点播放器；canplay 前不可播放，canplay 后才解锁", async () => {
    mocks.fetchVideoProxy.mockResolvedValue(
      jsonResponse({ data: { url: "http://test/proxy.mp4", duration: 12.5 } }),
    );
    const { result } = renderHook(() => useProxyPlayback(NODE, KEY));
    expect(result.current.status).toBe("pending");
    expect(result.current.playable).toBe(false);

    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(mocks.swapVideoSource).toHaveBeenCalledWith(
      NODE,
      "http://test/proxy.mp4",
      expect.any(Object),
    );
    expect(swaps).toHaveLength(1);
    expect(result.current.duration).toBe(12.5);
    // URL 就绪只代表产物可下载：浏览器未 canplay 前仍不可播放
    expect(result.current.playable).toBe(false);

    act(() => swaps[0].options.onReady?.(true));
    expect(result.current.playable).toBe(true);
  });

  it("换源发生在播放中途时续播，暂停中的换源保持暂停", async () => {
    mocks.isVideoPlaying.mockReturnValue(true);
    mocks.fetchVideoProxy.mockResolvedValue(jsonResponse({ data: { url: "http://test/proxy.mp4" } }));

    const { result } = renderHook(() => useProxyPlayback(NODE, KEY));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    expect(swaps).toHaveLength(1);
    expect(swaps[0].options.resume).toBe(true);
  });

  it("浏览器解不出代理：按失败上报并撤回换源，面板保持禁用", async () => {
    mocks.fetchVideoProxy.mockResolvedValue(jsonResponse({ data: { url: "http://test/proxy.mp4" } }));
    const { result } = renderHook(() => useProxyPlayback(NODE, KEY));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    act(() => swaps[0].options.onReady?.(false));

    // 解码失败不带错误码：重试同一份缓存产物不会成功
    expect(result.current.status).toBe("failed");
    expect(result.current.error).toBeNull();
    expect(result.current.playable).toBe(false);
    // 失败后 effect 清理把节点播放器换回原视频，且不得再换入同一条代理
    expect(swaps[0].cleanup).toHaveBeenCalled();
    expect(swaps).toHaveLength(1);
  });

  it("同一地址重试成功后重新换源并解除失败", async () => {
    // 每次请求给一份新的 Response：响应体只能读一次，复用会把重试误判成网络失败
    mocks.fetchVideoProxy.mockImplementation(() =>
      Promise.resolve(jsonResponse({ data: { url: "http://test/proxy.mp4" } })),
    );
    const { result } = renderHook(() => useProxyPlayback(NODE, KEY));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    act(() => swaps[0].options.onReady?.(false));
    expect(result.current.status).toBe("failed");

    act(() => result.current.retry());
    expect(result.current.status).toBe("pending");
    await waitFor(() => expect(result.current.status).toBe("ready"));

    // 重试拿回同一地址：只看 URL 变化会漏掉这次换源，播放器仍停在原视频
    expect(swaps).toHaveLength(2);
    expect(swaps[1].url).toBe("http://test/proxy.mp4");

    act(() => swaps[1].options.onReady?.(true));
    expect(result.current.playable).toBe(true);
  });

  it("换视频源后旧地址的缓冲状态失效，新地址 canplay 后才重新可播放", async () => {
    mocks.fetchVideoProxy.mockResolvedValueOnce(
      jsonResponse({ data: { url: "http://test/old.mp4" } }),
    );
    const { result, rerender } = renderHook(({ src }) => useProxyPlayback(NODE, src), {
      initialProps: { src: KEY },
    });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    act(() => swaps[0].options.onReady?.(true));
    expect(result.current.playable).toBe(true);

    mocks.fetchVideoProxy.mockResolvedValueOnce(
      jsonResponse({ data: { url: "http://test/new.mp4" } }),
    );
    rerender({ src: NEXT_KEY });
    expect(result.current.status).toBe("pending");
    expect(result.current.playable).toBe(false);
    expect(swaps[0].cleanup).toHaveBeenCalled();

    await waitFor(() => expect(result.current.url).toBe("http://test/new.mp4"));
    expect(swaps).toHaveLength(2);
    expect(result.current.playable).toBe(false);

    act(() => swaps[1].options.onReady?.(true));
    expect(result.current.playable).toBe(true);
  });
});
