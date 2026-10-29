// @vitest-environment jsdom
/**
 * 音频波形节点（specs/canvas-audio-peaks-cache.md 规则 4 / 5）。
 *
 * 波形与播放解耦的核心契约在这里锁定：
 * - 实例只用 `{ media, peaks, duration }` 创建，永不传 `url` / `fetchParams`；
 * - 签名地址轮换只改媒体元素地址，不重建实例、不重新解码；
 * - 重挂令牌只让媒体元素重新加载；
 * - 波形不可用不影响播放元素与注册表。
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  LOADING_PEAKS,
  READY_PEAKS,
  spyOnCreatedMedia,
  stubMediaElementMethods,
  TEST_PEAKS,
} from "@/__tests__/test-utils/audio-fixtures";
import { mutableFileAccessState } from "@/__tests__/test-utils/file-access-mock";
import AudioWaveform from "@/features/canvas/nodes/AudioWaveform";
import type { AudioPlaybackHandle } from "@/features/canvas/shared/audio-playback-registry";

const { create, player } = vi.hoisted(() => {
  const player = { setOptions: vi.fn(), destroy: vi.fn() };
  return { create: vi.fn(), player };
});

const { accessHook, peaksHook } = vi.hoisted(() => ({
  accessHook: vi.fn(),
  peaksHook: vi.fn(),
}));

const { registerAudioPlayer } = vi.hoisted(() => ({
  registerAudioPlayer: vi.fn<(nodeId: string, handle: AudioPlaybackHandle) => () => void>(() => vi.fn()),
}));

vi.mock("wavesurfer.js", () => ({ default: { create } }));
vi.mock("@/lib/use-file-access-url", () => ({ useFileAccessUrl: accessHook }));
vi.mock("@/lib/audio-peaks/use-audio-peaks", () => ({ useAudioPeaks: peaksHook }));
vi.mock("@/features/canvas/shared/audio-playback-registry", () => ({ registerAudioPlayer }));

/** 组件命令式创建的播放元素（不进入 DOM，只能从 createElement 捕获） */
let media: HTMLAudioElement | null = null;

const access = mutableFileAccessState("/audio.mp3");

beforeEach(() => {
  create.mockImplementation(() => player);
  media = null;
  access.reset();
  accessHook.mockImplementation(() => access.current);
  peaksHook.mockReturnValue(READY_PEAKS);

  spyOnCreatedMedia((element) => {
    media = element;
  });
  stubMediaElementMethods();
});

afterEach(() => {
  cleanup();
  document.documentElement.classList.remove("dark", "light");
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

/** 媒体元数据到达：jsdom 不解析媒体，给播放元素一个时长再派发 loadedmetadata */
function admitMetadata(duration: number) {
  Object.defineProperty(media!, "duration", { configurable: true, value: duration });
  act(() => {
    media!.dispatchEvent(new Event("loadedmetadata"));
  });
}

describe("AudioWaveform 实例创建契约（规则 4.1）", () => {
  it("只用 media / peaks / duration 创建实例，不传 url 或 fetchParams", () => {
    render(<AudioWaveform audioRef="/audio.mp3" duration={19} />);

    expect(create).toHaveBeenCalledTimes(1);
    const options = create.mock.calls[0][0] as Record<string, unknown>;
    expect(options.media).toBe(media);
    expect(options.duration).toBe(19);
    expect(options).not.toHaveProperty("url");
    expect(options).not.toHaveProperty("fetchParams");

    const peaks = options.peaks as Float32Array[];
    expect(peaks).toHaveLength(2);
    // 与缓存数组逐值相等（Float32 精度，按 Float32Array 比较而不是十进制字面量）
    expect(Array.from(peaks[0])).toEqual(Array.from(TEST_PEAKS.channels[0]));
    expect(Array.from(peaks[1])).toEqual(Array.from(TEST_PEAKS.channels[1]));
    // 传副本：wavesurfer 的 createBuffer 会就地 normalize，缓存数组视为不可变（规则 2.4）
    expect(peaks[0]).not.toBe(TEST_PEAKS.channels[0]);
  });

  it("峰值未就绪时不创建实例（否则会走全量下载路径）", () => {
    peaksHook.mockReturnValue(LOADING_PEAKS);
    render(<AudioWaveform audioRef="/audio.mp3" duration={19} />);

    expect(create).not.toHaveBeenCalled();
    // 已存时长只用于底部显示，不构成「时长已知」：播放按钮保持禁用
    expect(screen.getByText("00:00 / 00:19")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Play" })).toBeDisabled();
  });

  it("媒体元数据到达后即可播，底部时间改用已知时长（规则 5.3）", () => {
    peaksHook.mockReturnValue(LOADING_PEAKS);
    render(<AudioWaveform audioRef="/audio.mp3" duration={19} />);

    admitMetadata(21);

    expect(screen.getByRole("button", { name: "Play" })).not.toBeDisabled();
    expect(screen.getByText("00:00 / 00:21")).toBeTruthy();
  });

  it("签名地址轮换只改媒体元素地址：不重建实例、不重新解码", () => {
    const { rerender } = render(<AudioWaveform audioRef="/audio.mp3" duration={19} />);
    expect(media?.getAttribute("src")).toBe("/audio.mp3");

    access.set({ url: "https://signed.example/audio.mp3?sig=2" });
    rerender(<AudioWaveform audioRef="/audio.mp3" duration={19} />);

    expect(media?.getAttribute("src")).toBe("https://signed.example/audio.mp3?sig=2");
    expect(create).toHaveBeenCalledTimes(1);
    // 峰值按逻辑引用值取，签名地址变化不构成新的解码请求
    for (const [value] of peaksHook.mock.calls) expect(value).toBe("/audio.mp3");
  });

  it("地址未解析出来时播放按钮不可用（元素没有 src，play() 只会失败）", () => {
    access.set({ url: undefined });
    render(<AudioWaveform audioRef="/audio.mp3" duration={19} />);

    expect(screen.getByRole("button", { name: "Play" })).toBeDisabled();
  });

  it("重挂令牌只触发媒体元素重新加载，地址不变时不重建实例", () => {
    const { rerender } = render(<AudioWaveform audioRef="/audio.mp3" duration={19} />);
    const load = vi.mocked(HTMLMediaElement.prototype.load);
    expect(load).not.toHaveBeenCalled();

    access.set({ reloadToken: 1 });
    rerender(<AudioWaveform audioRef="/audio.mp3" duration={19} />);

    expect(load).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(1);
  });
});

describe("AudioWaveform 时长回填（规则 4.6 / 5.3）", () => {
  it("peaks 未落定时不抢先上报媒体时长，落定后每源只上报一次", () => {
    peaksHook.mockReturnValue(LOADING_PEAKS);
    const onReady = vi.fn();
    const { rerender } = render(<AudioWaveform audioRef="/audio.mp3" duration={0} onReady={onReady} />);

    admitMetadata(21);
    expect(onReady).not.toHaveBeenCalled();

    peaksHook.mockReturnValue(READY_PEAKS);
    rerender(<AudioWaveform audioRef="/audio.mp3" duration={0} onReady={onReady} />);

    expect(onReady).toHaveBeenCalledTimes(1);
    expect(onReady).toHaveBeenCalledWith(TEST_PEAKS.duration);

    act(() => {
      media!.dispatchEvent(new Event("loadedmetadata"));
    });
    expect(onReady).toHaveBeenCalledTimes(1);
  });

  it("时长与 prop 已一致时仍上报：等值抑制是消费方的写入决策，不是组件契约", () => {
    const onReady = vi.fn();
    render(<AudioWaveform audioRef="/audio.mp3" duration={TEST_PEAKS.duration} onReady={onReady} />);

    expect(onReady).toHaveBeenCalledTimes(1);
    expect(onReady).toHaveBeenCalledWith(TEST_PEAKS.duration);
  });

  it("同一实例换源后重新上报一次", () => {
    const onReady = vi.fn();
    const { rerender } = render(<AudioWaveform audioRef="/first.mp3" duration={0} onReady={onReady} />);
    expect(onReady).toHaveBeenCalledTimes(1);

    rerender(<AudioWaveform audioRef="/second.mp3" duration={0} onReady={onReady} />);
    expect(onReady).toHaveBeenCalledTimes(2);
  });

  it("peaks 不可用时以媒体元数据时长上报一次", () => {
    peaksHook.mockReturnValue({ peaks: null, duration: null, status: "unavailable" });
    const onReady = vi.fn();
    render(<AudioWaveform audioRef="/audio.mp3" duration={0} onReady={onReady} />);

    admitMetadata(21);

    expect(onReady).toHaveBeenCalledTimes(1);
    expect(onReady).toHaveBeenCalledWith(21);
  });
});

describe("AudioWaveform theme rendering", () => {
  it("redraws the waveform from its computed foreground without replacing the player", async () => {
    vi.spyOn(window, "getComputedStyle").mockImplementation(() => ({
      color: document.documentElement.classList.contains("dark") ? "rgb(250, 250, 250)" : "rgb(23, 23, 23)",
    }) as CSSStyleDeclaration);

    const { unmount } = render(<AudioWaveform audioRef="/audio.mp3" duration={19} />);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ waveColor: "rgb(23, 23, 23)" }));
    expect(screen.getByText("00:00 / 00:19")).toHaveClass("opacity-70");

    await act(async () => { document.documentElement.classList.add("dark"); });
    expect(player.setOptions).toHaveBeenLastCalledWith({ waveColor: "rgb(250, 250, 250)" });
    await act(async () => { document.documentElement.classList.remove("dark"); });
    expect(player.setOptions).toHaveBeenLastCalledWith({ waveColor: "rgb(23, 23, 23)" });
    expect(create).toHaveBeenCalledTimes(1);
    expect(player.destroy).not.toHaveBeenCalled();

    unmount();
    expect(player.destroy).toHaveBeenCalledTimes(1);
    const redraws = player.setOptions.mock.calls.length;
    await act(async () => { document.documentElement.classList.add("dark"); });
    expect(player.setOptions).toHaveBeenCalledTimes(redraws);
  });

  it("does not redraw when a root class changes without changing the foreground", async () => {
    vi.spyOn(window, "getComputedStyle").mockReturnValue({ color: "rgb(23, 23, 23)" } as CSSStyleDeclaration);
    render(<AudioWaveform audioRef="/audio.mp3" />);
    await act(async () => { document.documentElement.classList.add("light"); });
    expect(player.setOptions).not.toHaveBeenCalled();
  });

  it("keeps the parent's white foreground on a fixed dark preview in either theme", async () => {
    document.documentElement.classList.add("light");
    render(
      <div style={{ backgroundColor: "black", color: "white" }}>
        <AudioWaveform audioRef="/audio.mp3" duration={19} />
      </div>,
    );
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ waveColor: "rgb(255, 255, 255)" }));
    expect(getComputedStyle(screen.getByText("00:00 / 00:19")).color).toBe("rgb(255, 255, 255)");
    await act(async () => {
      document.documentElement.classList.replace("light", "dark");
    });
    expect(player.setOptions).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledTimes(1);
  });
});

describe("AudioWaveform 波形不可用不影响播放（规则 4.5 / 5.2）", () => {
  it("peaks 不可用时仍可播放，且照常注册播放句柄", () => {
    peaksHook.mockReturnValue({ peaks: null, duration: null, status: "unavailable" });
    render(<AudioWaveform audioRef="/audio.mp3" nodeId="node-1" duration={19} />);

    admitMetadata(21);

    const play = screen.getByRole("button", { name: "Play" });
    expect(play).not.toBeDisabled();
    fireEvent.click(play);
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1);

    // 句柄由播放元素支撑：不依赖波形实例，截取面板据此读位置 / 暂停
    expect(registerAudioPlayer).toHaveBeenCalledWith(
      "node-1",
      expect.objectContaining({ getCurrentTime: expect.any(Function), pause: expect.any(Function) }),
    );
    const handle = registerAudioPlayer.mock.calls[0][1];
    expect(handle.getCurrentTime()).toBe(0);
    handle.pause();
    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled();
  });
});

describe("AudioWaveform 访问地址失败态", () => {
  it("播放元素加载失败时重新描述一次签名地址", async () => {
    access.set({ delivery: "signed" });
    render(<AudioWaveform audioRef="/audio.mp3" />);

    await act(async () => {
      media?.dispatchEvent(new Event("error"));
    });
    expect(access.current.retrySigned).toHaveBeenCalledTimes(1);
    expect(screen.getByText("音频加载失败")).toBeTruthy();
  });

  it("描述本身失败时提供手动重试入口，不再空转 retrySigned", () => {
    const refresh = vi.fn(async () => undefined);
    const retrySigned = vi.fn(async () => null);
    access.set({ url: undefined, failed: true, refresh, retrySigned });
    render(<AudioWaveform audioRef="/audio.mp3" />);

    expect(screen.getByText("音频加载失败")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(retrySigned).not.toHaveBeenCalled();
  });
});
