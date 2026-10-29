// @vitest-environment jsdom
/**
 * 音频截取面板（specs/canvas-audio-peaks-cache.md 规则 5.2 / 5.4）。
 *
 * 面板与节点同样解耦：波形实例只用 `{ media, peaks, duration }` 创建、永不传
 * `url`；峰值按逻辑引用值取；峰值不可用时面板不可操作。
 */
import { cleanup, render } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  LOADING_PEAKS,
  READY_PEAKS,
  spyOnCreatedMedia,
  stubMediaElementMethods,
  TEST_PEAKS,
} from "@/__tests__/test-utils/audio-fixtures";
import { mutableFileAccessState } from "@/__tests__/test-utils/file-access-mock";
import { makeStorageKey } from "@/__tests__/test-utils/storage-fixtures";
import AudioClipStripPanel from "@/features/canvas/editing/AudioClipStripPanel";
import { getAudioPlaybackTime } from "@/features/canvas/shared/audio-playback-registry";
import { fileRefUrl } from "@/lib/file-url";

// 访问状态可注入：地址轮换、解析失败与重挂都是面板契约的一部分
const { accessHook } = vi.hoisted(() => ({ accessHook: vi.fn() }));
vi.mock("@/lib/use-file-access-url", () => ({ useFileAccessUrl: accessHook }));
const mocks = vi.hoisted(() => {
  const player = { destroy: vi.fn() };
  // 泛型而不是具名参数：断言要读创建参数（media / peaks / duration），
  // 具名未用参数会触发 no-unused-vars
  const create = vi.fn<(options?: Record<string, unknown>) => typeof player>();
  return {
    create,
    player,
    peaks: vi.fn(),
    resume: vi.fn(),
    resumeIfBlocked: vi.fn(),
  };
});

vi.mock("wavesurfer.js", () => ({ default: { create: mocks.create } }));
vi.mock("@/lib/audio-peaks/use-audio-peaks", () => ({ useAudioPeaks: mocks.peaks }));
vi.mock("react-i18next", () => import("@/__tests__/test-utils/react-i18next-mock"));
vi.mock("@/features/canvas/stores/canvas-store", () => ({
  useCanvasStore: { getState: () => ({}) },
}));
vi.mock("@/features/canvas/shared/audio-playback-registry", () => ({
  getAudioPlaybackTime: vi.fn(() => 0),
  pauseAudio: vi.fn(),
}));
vi.mock("@/features/canvas/shared/node-action", () => ({
  dispatchNodeAction: vi.fn(),
}));
vi.mock("@/features/canvas/hooks/use-frame-sprite", () => ({
  FRAME_TRACK_WIDTH: 1000,
}));
vi.mock("@/features/canvas/editing/use-playback-blocked", () => ({
  default: () => ({
    playbackBlocked: false,
    resume: mocks.resume,
    resumeIfBlocked: mocks.resumeIfBlocked,
  }),
}));

const STORAGE_KEY = makeStorageKey("a", ".mp3");

/** 面板命令式创建的播放元素（不进入 DOM，只能从 createElement 捕获） */
let media: HTMLAudioElement | null = null;
/** 本次挂载创建过的全部元素：StrictMode 双挂载会重建，最后一个才是活元素 */
let createdMedia: HTMLAudioElement[] = [];
const access = mutableFileAccessState(fileRefUrl(STORAGE_KEY));

beforeEach(() => {
  media = null;
  createdMedia = [];
  access.reset();
  accessHook.mockImplementation(() => access.current);
  mocks.create.mockImplementation(() => mocks.player);
  mocks.peaks.mockReturnValue(READY_PEAKS);

  spyOnCreatedMedia((element) => {
    // jsdom 不推进播放时间：给每个元素一个可写 currentTime，初始化写入才可断言
    Object.defineProperty(element, "currentTime", {
      configurable: true,
      writable: true,
      value: 0,
    });
    createdMedia.push(element);
    media = element;
  });
  stubMediaElementMethods();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

/** 默认引用值取生产值域（存储 key）；外部 URL 用例显式传入 */
function renderPanel(audioRef = STORAGE_KEY) {
  return render(<AudioClipStripPanel nodeId="n1" audioRef={audioRef} onClose={vi.fn()} />);
}

/** 每次取峰值都以逻辑引用值为参数：不先派生成地址，也不因签名轮换换源 */
function expectPeaksRequestedWith(source: string) {
  for (const [value] of mocks.peaks.mock.calls) expect(value).toBe(source);
}

describe("音频截取条带层级契约", () => {
  it("轨道容器不再自带背景与圆角，背景统一切进裁剪层", () => {
    const { container } = renderPanel();

    const track = container.querySelector('[class*="cursor-ew-resize"]') as HTMLElement;
    expect(track.className).not.toContain("bg-black");
    expect(track.className).not.toContain("rounded-");
    expect(track.className).toContain("overflow-visible");

    // 按类名组合定位裁剪层，不依赖「恰好是轨道第一个子 div」的位置约定
    const wrapper = track.querySelector('[class*="overflow-hidden"][class*="pointer-events-none"]');
    expect(wrapper).toBeTruthy();
    expect(wrapper!.className).toContain("overflow-hidden");
    expect(wrapper!.className).toContain("pointer-events-none");
    expect(wrapper!.className).toContain("rounded-lg");
    expect(wrapper!.querySelector(":scope > .bg-black")).toBeTruthy();
  });

  it("状态提示在未就绪时渲染，裁剪层不拦截轨道点击（pointer-events-none）", () => {
    mocks.peaks.mockReturnValue(LOADING_PEAKS);
    const { container, getByText } = renderPanel();

    expect(getByText("clip.loading")).toBeTruthy();
    const wrapper = container.querySelector('[class*="overflow-hidden"]');
    expect(wrapper!.className).toContain("pointer-events-none");
  });

  it("访问地址描述失败时给出失败态与重试入口，而不是永远停在加载中", () => {
    access.set({ failed: true });
    const { getByText, getByRole, queryByText } = renderPanel();

    expect(getByText("media.previewLoadFailed")).toBeTruthy();
    expect(getByRole("button", { name: "media.retry" })).toBeTruthy();
    expect(queryByText("clip.loading")).toBeNull();
  });

  it("峰值不可用时给出波形不可用提示（不是音频加载失败），且面板不可操作", () => {
    mocks.peaks.mockReturnValue({ peaks: null, duration: 19, status: "unavailable" });
    const { getByText, queryByText } = renderPanel();

    // 峰值不可用只影响波形与截取，播放路径独立（规则 4.6 / 5.4）：文案不得声称音频加载失败
    expect(getByText("clip.peaksUnavailable")).toBeTruthy();
    expect(queryByText("clip.unavailable")).toBeNull();
    expect(queryByText("clip.loading")).toBeNull();
    // 不可操作：选区叠层不渲染（选区依赖 peaks 时长）
    expect(queryByText("19.00s")).toBeNull();
  });
});

describe("访问地址未就绪（规则 4.3）", () => {
  it("不初始化选区、不发起 play：此时 seek 会被随后的加载清零，play 也只会失败", () => {
    access.set({ url: undefined });
    const { getByText, queryByText } = renderPanel();

    // 保持加载提示，选区叠层不渲染（选区时长标签是 operable 的直接证据）
    expect(getByText("clip.loading")).toBeTruthy();
    expect(queryByText("19.00s")).toBeNull();
    expect(media?.hasAttribute("src")).toBe(false);
    // 播放经 usePlaybackBlocked 的 resume 发出；该 hook 在本文件被整体 mock，
    // 原型 play 永远不会被面板触达——只有断言 resume 未被请求才可证伪
    expect(mocks.resume).not.toHaveBeenCalled();
  });
});

describe("波形实例创建契约（规则 5.2）", () => {
  it("只用 media / peaks / duration 创建实例，不传 url 或 fetchParams", () => {
    renderPanel();

    expect(mocks.create).toHaveBeenCalledTimes(1);
    const options = mocks.create.mock.calls[0][0]!;
    expect(options.media).toBe(media);
    expect(options.duration).toBe(TEST_PEAKS.duration);
    expect(options).not.toHaveProperty("url");
    expect(options).not.toHaveProperty("fetchParams");
    // 面板轨道是黑底：固定白色波形，不跟随根主题重绘
    expect(options.waveColor).toBe("#ffffff");
    expect(options.barWidth).toBe(3);
    expect(options.barGap).toBe(2);

    const peaks = options.peaks as Float32Array[];
    expect(peaks).toHaveLength(2);
    // 传副本：wavesurfer 的 createBuffer 会就地 normalize，缓存数组视为不可变（规则 2.4）
    expect(peaks[0]).not.toBe(TEST_PEAKS.channels[0]);
    expect(Array.from(peaks[0])).toEqual(Array.from(TEST_PEAKS.channels[0]));
  });

  it("峰值按逻辑引用值取，存储 key 不先派生成托管 URL", () => {
    renderPanel();

    expectPeaksRequestedWith(STORAGE_KEY);
  });

  it("外部 URL 同样按逻辑引用值取峰值", () => {
    renderPanel("https://cdn.example.com/a.mp3");

    expectPeaksRequestedWith("https://cdn.example.com/a.mp3");
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ media }));
  });

  it("峰值未就绪时不创建实例（否则会走全量下载路径）", () => {
    mocks.peaks.mockReturnValue(LOADING_PEAKS);
    renderPanel();

    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("签名地址轮换只改媒体元素地址：不重建实例、不重新解码", () => {
    const { rerender } = renderPanel();
    expect(media?.getAttribute("src")).toBe(fileRefUrl(STORAGE_KEY));

    access.set({ url: "https://signed.example/a.mp3?sig=2" });
    rerender(<AudioClipStripPanel nodeId="n1" audioRef={STORAGE_KEY} onClose={vi.fn()} />);

    expect(media?.getAttribute("src")).toBe("https://signed.example/a.mp3?sig=2");
    expect(mocks.create).toHaveBeenCalledTimes(1);
    // 峰值按逻辑引用值取，签名地址变化不构成新的解码请求
    expectPeaksRequestedWith(STORAGE_KEY);
  });

  it("重挂令牌只触发媒体元素重新加载，地址不变时不重建实例", () => {
    const { rerender } = renderPanel();
    const load = vi.mocked(HTMLMediaElement.prototype.load);
    expect(load).not.toHaveBeenCalled();

    access.set({ reloadToken: 1 });
    rerender(<AudioClipStripPanel nodeId="n1" audioRef={STORAGE_KEY} onClose={vi.fn()} />);

    expect(load).toHaveBeenCalledTimes(1);
    expect(mocks.create).toHaveBeenCalledTimes(1);
  });
});

describe("StrictMode 双挂载（开发态元素重建）", () => {
  afterEach(() => {
    vi.mocked(getAudioPlaybackTime).mockReturnValue(0);
  });

  it("重建后的活元素仍被初始化：起点写入与自动试听不能只落在被丢弃的元素上", () => {
    // 起点取非 0：默认 0 无法区分「初始化过」与「currentTime 从没写过」
    vi.mocked(getAudioPlaybackTime).mockReturnValue(4);

    render(
      <StrictMode>
        <AudioClipStripPanel nodeId="n1" audioRef={STORAGE_KEY} onClose={vi.fn()} />
      </StrictMode>,
    );

    // 严格模式挂载→卸载→重挂：元素归 useAudioElement 的 effect 所有，第一个已被清理丢弃
    expect(createdMedia).toHaveLength(2);
    const live = createdMedia[1];
    expect(media).toBe(live);
    expect(createdMedia[0].currentTime).toBeCloseTo(4, 5);
    // 回归点：修复前一次性语义只按逻辑源记账，活元素停在 0、也不自动试听
    expect(live.currentTime).toBeCloseTo(4, 5);
    // 每个元素各初始化一次：只初始化被丢弃的第一个等于没有初始化
    expect(mocks.resume).toHaveBeenCalledTimes(2);
  });
});
