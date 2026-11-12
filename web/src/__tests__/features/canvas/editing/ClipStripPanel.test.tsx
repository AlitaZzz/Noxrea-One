// @vitest-environment jsdom
/**
 * 片段截取面板三个拖拽会话（轨道 / 手柄 / 整段亮带）的 window 收尾。
 *
 * 回归点：窗口失焦后浏览器可能不再派发 pointerup / pointercancel，只靠指针
 * 事件收尾会让会话残留——未按键的移动继续挪手柄，过期的 pointerup 还会按旧
 * 落点补提交。三类会话都必须把失焦当取消处理。
 */
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  firePointerDown,
  fireWindowBlur,
  fireWindowPointerMove,
  fireWindowPointerUp,
  stubElementRect,
} from "@/__tests__/test-utils/pointer-events";
import { stubRaf } from "@/__tests__/test-utils/raf";
import { makeStorageKey } from "@/__tests__/test-utils/storage-fixtures";
import ClipStripPanel from "@/features/canvas/editing/ClipStripPanel";

const mocks = vi.hoisted(() => ({
  seekVideo: vi.fn(),
  setVideoTime: vi.fn(),
  playVideo: vi.fn(() => Promise.resolve()),
  pauseVideo: vi.fn(),
  resume: vi.fn(),
  resumeIfBlocked: vi.fn(),
}));

vi.mock("react-i18next", () => import("@/__tests__/test-utils/react-i18next-mock"));
vi.mock("@/features/canvas/shared/node-action", () => ({ dispatchNodeAction: vi.fn() }));
vi.mock("@/features/canvas/hooks/use-frame-sprite", () => ({
  FRAME_TRACK_WIDTH: 1000,
  FRAME_TRACK_HEIGHT: 56,
  useFrameSprite: () => ({
    url: null,
    spriteWidth: 0,
    cellWidth: 0,
    cellHeight: 0,
    count: 0,
    frameWidth: 0,
    duration: 10,
    durationSource: "sprite",
    fps: 30,
    truncated: false,
    declaredDuration: null,
    status: "ready",
    error: null,
    retry: vi.fn(),
  }),
}));
vi.mock("@/features/canvas/hooks/use-proxy-playback", () => ({
  useProxyPlayback: () => ({
    status: "ready",
    url: null,
    duration: 10,
    error: null,
    playable: true,
    retry: vi.fn(),
  }),
}));
vi.mock("@/features/canvas/hooks/use-video-time-source", () => ({
  useVideoTimeSource: () => () => 0,
}));
vi.mock("@/lib/use-media-progress", () => ({ useMediaProgress: vi.fn() }));
vi.mock("@/features/canvas/editing/use-playback-blocked", () => ({
  default: () => ({
    playbackBlocked: false,
    resume: mocks.resume,
    resumeIfBlocked: mocks.resumeIfBlocked,
  }),
}));
vi.mock("@/features/canvas/shared/video-playback-registry", () => ({
  getVideoPlaybackTime: vi.fn(() => 0),
  isVideoPlaying: vi.fn(() => false),
  onVideoEnded: vi.fn(() => () => {}),
  pauseVideo: mocks.pauseVideo,
  playVideo: mocks.playVideo,
  seekVideo: mocks.seekVideo,
  setVideoTime: mocks.setVideoTime,
}));

const STORAGE_KEY = makeStorageKey("clip", ".mp4");

let flush: () => void;

beforeEach(() => {
  ({ flush } = stubRaf());
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

async function renderPanel() {
  const result = render(<ClipStripPanel nodeId="n1" videoRef={STORAGE_KEY} onClose={vi.fn()} />);
  // 初始化写入真实区间后双手柄才渲染（rangeInitialized）
  await waitFor(() => expect(result.container.querySelectorAll('[class*="w-3.5"]')).toHaveLength(2));
  const track = result.container.querySelector<HTMLElement>('[class*="cursor-ew-resize"]')!;
  stubElementRect(track);
  vi.clearAllMocks();
  return { ...result, track };
}

describe("片段截取面板失焦收尾", () => {
  it("轨道拖动：失焦后未按键的移动不再挪手柄，随后可重新拖动", async () => {
    const { container, track } = await renderPanel();

    firePointerDown(track, { clientX: 100 });
    flush();
    expect(mocks.seekVideo).toHaveBeenLastCalledWith("n1", 1);

    vi.clearAllMocks();
    fireWindowBlur();
    fireWindowPointerMove(900);
    fireWindowPointerUp(900);
    flush();
    expect(mocks.seekVideo).not.toHaveBeenCalled();
    expect(mocks.setVideoTime).not.toHaveBeenCalled();

    firePointerDown(track, { clientX: 300 });
    flush();
    expect(mocks.seekVideo).toHaveBeenLastCalledWith("n1", 3);
    expect(container.querySelectorAll('[class*="w-3.5"]')).toHaveLength(2);
  });

  it("手柄拖动：失焦按取消收尾，不按旧落点补提交，随后可重新抓取", async () => {
    const { container } = await renderPanel();
    const handles = container.querySelectorAll<HTMLElement>('[class*="w-3.5"]');

    firePointerDown(handles[0], { clientX: 100 });
    flush();
    expect(mocks.seekVideo).toHaveBeenLastCalledWith("n1", 1);

    vi.clearAllMocks();
    fireWindowBlur();
    fireWindowPointerMove(900);
    fireWindowPointerUp(900);
    flush();
    expect(mocks.seekVideo).not.toHaveBeenCalled();
    expect(mocks.setVideoTime).not.toHaveBeenCalled();

    // 选区手柄被钳在出点前（最小区间 0.5s），但预览 seek 按指针原始位置：
    // 钳制只约束手柄与选区，不把播放头强行拽进有效区间
    firePointerDown(handles[0], { clientX: 300 });
    flush();
    expect(mocks.seekVideo).toHaveBeenLastCalledWith("n1", 3);
  });

  it("整段亮带拖动：失焦后过期 pointerup 不再提交平移，随后可重新起拖", async () => {
    const { container } = await renderPanel();
    const band = container.querySelector<HTMLElement>('[class*="cursor-grab"]')!;

    firePointerDown(band, { clientX: 100 });
    flush();
    expect(mocks.seekVideo).toHaveBeenLastCalledWith("n1", 0);

    vi.clearAllMocks();
    fireWindowBlur();
    fireWindowPointerMove(500);
    fireWindowPointerUp(500);
    flush();
    expect(mocks.seekVideo).not.toHaveBeenCalled();
    expect(mocks.setVideoTime).not.toHaveBeenCalled();

    firePointerDown(band, { clientX: 200 });
    fireWindowPointerMove(300);
    fireWindowPointerUp(300);
    flush();
    const [seekNodeId, seekTime] = mocks.seekVideo.mock.lastCall!;
    expect(seekNodeId).toBe("n1");
    expect(seekTime).toBeCloseTo(1, 5);
  });
});
