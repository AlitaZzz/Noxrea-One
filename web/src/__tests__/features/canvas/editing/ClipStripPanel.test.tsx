// @vitest-environment jsdom
/**
 * 片段截取面板三个拖拽会话（轨道 / 手柄 / 整段亮带）的收尾与播放恢复。
 *
 * 失焦回归点：窗口失焦后浏览器可能不再派发 pointerup / pointercancel，只靠指针
 * 事件收尾会让会话残留——未按键的移动继续挪手柄，过期的 pointerup 还会按旧
 * 落点补提交。三类会话都必须把失焦当取消处理。
 *
 * 播放恢复回归点：播放中拖动任一手柄 / 轨道时暂停并预览指针帧；松手先取消
 * 挂起的 seek，再从选区入点续播（出点拖动不落在出点帧）。暂停中拖动则停在
 * 指针帧。
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
import { getVideoPlaybackTime, isVideoPlaying } from "@/features/canvas/shared/video-playback-registry";

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
  // 每个用例从「未播放、打开位置 0」起步；两项都由用例显式覆盖
  // （实现不随 clearAllMocks 重置）
  vi.mocked(isVideoPlaying).mockReturnValue(false);
  vi.mocked(getVideoPlaybackTime).mockReturnValue(0);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

async function renderPanel(initialPosition = 0) {
  vi.mocked(getVideoPlaybackTime).mockReturnValue(initialPosition);
  const result = render(<ClipStripPanel nodeId="n1" videoRef={STORAGE_KEY} onClose={vi.fn()} />);
  // 初始化写入真实区间后双手柄才渲染（rangeInitialized）
  await waitFor(() => expect(result.container.querySelectorAll('[class*="w-3.5"]')).toHaveLength(2));
  const track = result.container.querySelector<HTMLElement>('[class*="cursor-ew-resize"]')!;
  stubElementRect(track);
  vi.clearAllMocks();
  return { ...result, track };
}

describe("片段截取面板拖拽收尾与播放恢复", () => {
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

  it("只接受主指针左键：右键与额外手指不建立拖拽会话", async () => {
    const { container, track } = await renderPanel();
    const handles = container.querySelectorAll<HTMLElement>('[class*="w-3.5"]');
    const band = container.querySelector<HTMLElement>('[class*="cursor-grab"]')!;

    const rightClick = firePointerDown(track, { clientX: 100, button: 2 });
    expect(rightClick.defaultPrevented).toBe(false);
    fireWindowPointerMove(900);
    fireWindowPointerUp(900);
    flush();
    expect(mocks.seekVideo).not.toHaveBeenCalled();

    const extraFinger = firePointerDown(handles[0], { clientX: 100, isPrimary: false });
    expect(extraFinger.defaultPrevented).toBe(false);
    fireWindowPointerMove(900);
    fireWindowPointerUp(900);
    flush();
    expect(mocks.seekVideo).not.toHaveBeenCalled();

    const bandRightClick = firePointerDown(band, { clientX: 100, button: 2 });
    expect(bandRightClick.defaultPrevented).toBe(false);
    fireWindowPointerMove(900);
    fireWindowPointerUp(900);
    flush();
    expect(mocks.seekVideo).not.toHaveBeenCalled();

    // 主指针左键仍正常起拖，并继续拦截面板内事件
    const primary = firePointerDown(track, { clientX: 300 });
    expect(primary.defaultPrevented).toBe(true);
    flush();
    expect(mocks.seekVideo).toHaveBeenLastCalledWith("n1", 3);
  });

  it("播放中拖出点：拖动中暂停并预览出点帧，松手回到选区入点续播", async () => {
    // 从 5s 处打开：初始选区 [5s, 7s]，验证续播位置是选区入点而非硬编码 0
    const { container } = await renderPanel(5);
    const handles = container.querySelectorAll<HTMLElement>('[class*="w-3.5"]');
    vi.mocked(isVideoPlaying).mockReturnValue(true);

    firePointerDown(handles[1], { clientX: 800 });
    flush();
    // 出点在播放中同样跟手 seek：画面固定在拖动中的出点帧，而不是继续播放
    expect(mocks.seekVideo).toHaveBeenLastCalledWith("n1", 8);

    // 再拖一次但不 flush：松手时仍有挂起的 rAF seek，验证取消先于 resume
    vi.clearAllMocks();
    fireWindowPointerMove(700);
    fireWindowPointerUp(700);
    flush();
    // 松手不能从出点起播（循环 tick 会立刻折回），落到选区入点 5s；
    // 挂起的 7s 预览 seek 已被取消，不会在 resume 之后把播放在下一帧按停
    expect(mocks.seekVideo).not.toHaveBeenCalled();
    const [resumeNodeId, resumeTime] = mocks.setVideoTime.mock.lastCall!;
    expect(resumeNodeId).toBe("n1");
    expect(resumeTime).toBeCloseTo(5, 5);
    expect(mocks.setVideoTime).not.toHaveBeenCalledWith("n1", 0);
    expect(mocks.setVideoTime).not.toHaveBeenCalledWith("n1", 7);
    expect(mocks.setVideoTime).not.toHaveBeenCalledWith("n1", 8);
    expect(mocks.resume).toHaveBeenCalledTimes(1);
  });

  it("播放中拖入点越过钳制边界：松手从钳制后的选区入点续播", async () => {
    const { container } = await renderPanel(5);
    const handles = container.querySelectorAll<HTMLElement>('[class*="w-3.5"]');
    vi.mocked(isVideoPlaying).mockReturnValue(true);

    // 指针到 9s，但入点被钳在出点 7s 前 0.5s（6.5s）；拖动中仍按指针位置预览
    firePointerDown(handles[0], { clientX: 900 });
    flush();
    expect(mocks.seekVideo).toHaveBeenLastCalledWith("n1", 9);

    vi.clearAllMocks();
    fireWindowPointerUp(900);
    flush();
    const [resumeNodeId, resumeTime] = mocks.setVideoTime.mock.lastCall!;
    expect(resumeNodeId).toBe("n1");
    expect(resumeTime).toBeCloseTo(6.5, 5);
    expect(mocks.setVideoTime).not.toHaveBeenCalledWith("n1", 9);
    expect(mocks.resume).toHaveBeenCalledTimes(1);
  });

  it("播放中点击轨道靠出点一侧：拖动与松手都走同一套预览/续播语义", async () => {
    const { track } = await renderPanel(5);
    vi.mocked(isVideoPlaying).mockReturnValue(true);

    firePointerDown(track, { clientX: 800 });
    flush();
    expect(mocks.seekVideo).toHaveBeenLastCalledWith("n1", 8);

    vi.clearAllMocks();
    fireWindowPointerUp(800);
    flush();
    const [resumeNodeId, resumeTime] = mocks.setVideoTime.mock.lastCall!;
    expect(resumeNodeId).toBe("n1");
    expect(resumeTime).toBeCloseTo(5, 5);
    expect(mocks.setVideoTime).not.toHaveBeenCalledWith("n1", 8);
    expect(mocks.resume).toHaveBeenCalledTimes(1);
  });

  it("播放中拖出点失焦：取消挂起的 seek 并恢复循环", async () => {
    const { container } = await renderPanel(5);
    const handles = container.querySelectorAll<HTMLElement>('[class*="w-3.5"]');
    vi.mocked(isVideoPlaying).mockReturnValue(true);

    firePointerDown(handles[1], { clientX: 800 });
    flush();
    expect(mocks.seekVideo).toHaveBeenLastCalledWith("n1", 8);

    // 失焦前不 flush：留一次挂起的 rAF seek，验证 cancelDrag 先取消再恢复
    vi.clearAllMocks();
    fireWindowPointerMove(700);
    fireWindowBlur();
    fireWindowPointerMove(900);
    fireWindowPointerUp(900);
    flush();
    expect(mocks.seekVideo).not.toHaveBeenCalled();
    expect(mocks.setVideoTime).not.toHaveBeenCalled();
    expect(mocks.resume).toHaveBeenCalledTimes(1);
  });
});
