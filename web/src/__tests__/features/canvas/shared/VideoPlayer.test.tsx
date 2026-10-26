// @vitest-environment jsdom
/**
 * VideoPlayer 自动播放与重挂状态同步（specs/storage-signed-direct-delivery.md 规则 3.6 的消费点）：
 * 访问地址异步解析——地址未就绪时元素没有源，不能尝试 play()，更不能把
 * NotSupportedError 当成自动播放被策略拦截去静音；只有 NotAllowedError 才降级。
 * 重描述成功后元素按 reloadToken 重挂，音量偏好、播放态与进度必须跟着复位到新元素。
 */
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  state: {
    url: undefined as string | undefined,
    retrySigned: vi.fn(() => Promise.resolve(null as string | null)),
    reloadToken: 0,
  },
}));

vi.mock("@/lib/use-file-access-url", () => ({
  useFileAccessUrl: () => ({
    url: mocks.state.url,
    delivery: mocks.state.url ? "signed" : undefined,
    failed: false,
    refresh: async () => mocks.state.url,
    retrySigned: mocks.state.retrySigned,
    reloadToken: mocks.state.reloadToken,
  }),
}));

import VideoPlayer from "@/features/canvas/shared/VideoPlayer";

let playImpl: () => Promise<void>;
let playSpy: ReturnType<typeof vi.spyOn>;

async function flush(): Promise<void> {
  await act(async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); });
}

beforeEach(() => {
  mocks.state.url = undefined;
  mocks.state.reloadToken = 0;
  mocks.state.retrySigned.mockClear();
  playImpl = () => Promise.resolve();
  playSpy = vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() => playImpl());
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("VideoPlayer 重挂状态同步（key=reloadToken）", () => {
  it("重挂后把音量偏好回写到新元素（DOM 音量不会被浏览器默认值覆盖）", async () => {
    mocks.state.url = "https://signed/a.mp4";
    const { container, rerender } = render(<VideoPlayer src="key.mp4" defaultVolume={0.3} />);
    await flush();

    mocks.state.reloadToken = 1;
    rerender(<VideoPlayer src="key.mp4" defaultVolume={0.3} />);
    await flush();

    const video = container.querySelector("video")!;
    expect(video.volume).toBeCloseTo(0.3);
  });

  it("重挂后播放态与进度复位到新元素的状态，不保留旧元素镜像", async () => {
    mocks.state.url = "https://signed/a.mp4";
    const { container, rerender } = render(<VideoPlayer src="key.mp4" autoPlay={false} />);
    await flush();
    const first = container.querySelector("video")!;

    // 旧元素上发生的播放/进度事件（新元素不会继承）
    await act(async () => {
      first.dispatchEvent(new Event("play"));
      Object.defineProperty(first, "currentTime", { value: 12, configurable: true });
      first.dispatchEvent(new Event("timeupdate"));
    });

    mocks.state.reloadToken = 1;
    rerender(<VideoPlayer src="key.mp4" autoPlay={false} />);
    await flush();

    const second = container.querySelector("video")!;
    expect(second).not.toBe(first);
    // 新元素暂停在 0：图标必须是「播放」而不是旧元素的「暂停」
    expect(container.querySelector('[aria-label="play"]')).toBeTruthy();
    expect(container.querySelector('[aria-label="pause"]')).toBeNull();
  });
});

describe("VideoPlayer 自动播放", () => {
  it("地址未就绪不尝试播放；就绪后有声音播放", async () => {
    const { container, rerender } = render(<VideoPlayer src="key.mp4" />);
    await flush();
    expect(playSpy).not.toHaveBeenCalled();

    mocks.state.url = "https://signed/a.mp4";
    rerender(<VideoPlayer src="key.mp4" />);
    await flush();

    expect(playSpy).toHaveBeenCalledTimes(1);
    const video = container.querySelector("video")!;
    expect(video.muted).toBe(false);
  });

  it("自动播放被策略拒绝（NotAllowedError）才降级静音", async () => {
    mocks.state.url = "https://signed/a.mp4";
    playImpl = () => Promise.reject(new DOMException("blocked", "NotAllowedError"));

    const { container } = render(<VideoPlayer src="key.mp4" />);
    await flush();

    expect(container.querySelector("video")!.muted).toBe(true);
  });

  it("非策略错误（如 NotSupportedError）不降级静音，避免把加载失败误判为自动播放拦截", async () => {
    mocks.state.url = "https://signed/a.mp4";
    playImpl = () => Promise.reject(new DOMException("no source", "NotSupportedError"));

    const { container } = render(<VideoPlayer src="key.mp4" />);
    await flush();

    expect(container.querySelector("video")!.muted).toBe(false);
  });
});
