// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { makeStorageKey } from "@/__tests__/test-utils/storage-fixtures";
import AudioClipStripPanel from "@/features/canvas/editing/AudioClipStripPanel";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
}));

vi.mock("wavesurfer.js", () => ({
  default: {
    create: mocks.create.mockImplementation(() => ({
      on: vi.fn(),
      destroy: vi.fn(),
      getCurrentTime: vi.fn(() => 0),
      getDuration: vi.fn(() => 0),
      isPlaying: vi.fn(() => false),
      setTime: vi.fn(),
      play: vi.fn(),
      pause: vi.fn(),
    })),
  },
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: "zh" } }),
}));
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
  default: () => false,
}));

afterEach(() => {
  cleanup();
  mocks.create.mockClear();
});

const STORAGE_KEY = makeStorageKey("a", ".mp3");

/** 默认引用值取生产值域（存储 key）；外部 URL 用例显式传入 */
function renderPanel(audioRef = STORAGE_KEY) {
  return render(<AudioClipStripPanel nodeId="n1" audioRef={audioRef} onClose={vi.fn()} />);
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
    const { container, getByText } = renderPanel();

    expect(getByText("clip.loading")).toBeTruthy();
    const wrapper = container.querySelector('[class*="overflow-hidden"]');
    expect(wrapper!.className).toContain("pointer-events-none");
  });
});

describe("音频引用值派生契约", () => {
  // 回归：持久化 src 是存储 key，wavesurfer 按 URL 直接请求——未派生时浏览器
  // 会相对 /canvas/{id} 解析成 /canvas/{id}/{key} 并 404（音频加载失败）
  it("存储 key 派生为托管文件 URL 后再交给 wavesurfer", () => {
    renderPanel();

    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ url: `/api/files/${STORAGE_KEY}` }));
  });

  it("外部 URL 原样交给 wavesurfer，不派生托管路径", () => {
    renderPanel("https://cdn.example.com/a.mp3");

    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({ url: "https://cdn.example.com/a.mp3" }),
    );
  });
});
