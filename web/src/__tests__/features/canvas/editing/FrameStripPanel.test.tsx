// @vitest-environment jsdom
/**
 * 帧序列面板的 window 指针会话收尾。
 *
 * 回归点：窗口失焦后浏览器可能不再派发 pointerup，只注册指针事件的拖动会话
 * 会残留——未按键的移动继续搓擦播放头，节点时间跟随也被一直挂起。失焦必须按
 * 取消收尾：摘监听、清拖动守卫，不补提交最后一帧。
 */
import { cleanup, render } from "@testing-library/react";
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
import FrameStripPanel from "@/features/canvas/editing/FrameStripPanel";

const mocks = vi.hoisted(() => ({
  seekVideo: vi.fn(),
  pauseVideo: vi.fn(),
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
vi.mock("@/features/canvas/shared/video-playback-registry", () => ({
  getVideoPlaybackTime: vi.fn(() => 0),
  pauseVideo: mocks.pauseVideo,
  seekVideo: mocks.seekVideo,
}));

const STORAGE_KEY = makeStorageKey("frame", ".mp4");

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

function renderPanel() {
  return render(<FrameStripPanel nodeId="n1" videoRef={STORAGE_KEY} onClose={vi.fn()} />);
}

describe("帧序列面板失焦收尾", () => {
  it("拖动播放头时窗口失焦：摘掉会话，残留移动不再 seek，随后可重新拖动", () => {
    const { container } = renderPanel();
    // 初始化会按打开时的播放位置写一次播放头并 seek
    flush();
    vi.clearAllMocks();

    const track = container.querySelector<HTMLElement>('[class*="cursor-ew-resize"]')!;
    stubElementRect(track);

    firePointerDown(track, { clientX: 100 });
    flush();
    expect(mocks.seekVideo).toHaveBeenLastCalledWith("n1", 1);

    vi.clearAllMocks();
    fireWindowBlur();
    fireWindowPointerMove(900);
    flush();
    // 失焦后未按键的移动不得继续搓擦播放头
    expect(mocks.seekVideo).not.toHaveBeenCalled();

    // 拖动守卫已清除：回到窗口后能正常开始新的拖动
    firePointerDown(track, { clientX: 300 });
    flush();
    expect(mocks.seekVideo).toHaveBeenLastCalledWith("n1", 3);
  });

  it("失焦时取消尚未执行的 rAF seek：取消后不得再按最后移动位置定位", () => {
    const { container } = renderPanel();
    flush();
    vi.clearAllMocks();

    const track = container.querySelector<HTMLElement>('[class*="cursor-ew-resize"]')!;
    stubElementRect(track);

    // 最后一次移动已写入 ratio，但 rAF 尚未执行——此时失焦
    firePointerDown(track, { clientX: 100 });
    fireWindowBlur();
    flush();
    expect(mocks.seekVideo).not.toHaveBeenCalled();
  });

  it("多指并发只建立一个会话：第二根指针不驱动播放头，也不覆盖首指针收尾", () => {
    const { container } = renderPanel();
    flush();
    vi.clearAllMocks();

    const track = container.querySelector<HTMLElement>('[class*="cursor-ew-resize"]')!;
    stubElementRect(track);

    firePointerDown(track, { clientX: 100, pointerId: 1 });
    flush();
    expect(mocks.seekVideo).toHaveBeenLastCalledWith("n1", 1);

    vi.clearAllMocks();
    // 第二根指针按下：已有会话时不得建立第二套监听或改写播放头
    firePointerDown(track, { clientX: 900, pointerId: 2 });
    flush();
    expect(mocks.seekVideo).not.toHaveBeenCalled();

    fireWindowPointerMove(900, 2);
    flush();
    expect(mocks.seekVideo).not.toHaveBeenCalled();

    // 首指针仍驱动当前会话
    fireWindowPointerMove(500, 1);
    flush();
    expect(mocks.seekVideo).toHaveBeenLastCalledWith("n1", 5);

    // 其他指针的 pointerup 不得结束会话
    fireWindowPointerUp(500, 2);
    fireWindowPointerMove(700, 1);
    flush();
    expect(mocks.seekVideo).toHaveBeenLastCalledWith("n1", 7);

    // 首指针松手后会话才结束
    fireWindowPointerUp(700, 1);
    vi.clearAllMocks();
    fireWindowPointerMove(800, 1);
    flush();
    expect(mocks.seekVideo).not.toHaveBeenCalled();
  });

  it("正常松手不取消最后一次挂起的 seek", () => {
    const { container } = renderPanel();
    flush();
    vi.clearAllMocks();

    const track = container.querySelector<HTMLElement>('[class*="cursor-ew-resize"]')!;
    stubElementRect(track);

    firePointerDown(track, { clientX: 100 });
    fireWindowPointerUp(100);
    flush();
    expect(mocks.seekVideo).toHaveBeenLastCalledWith("n1", 1);
  });

  it("只接受主指针左键：右键与额外手指不建立拖拽会话", () => {
    const { container } = renderPanel();
    flush();
    vi.clearAllMocks();

    const track = container.querySelector<HTMLElement>('[class*="cursor-ew-resize"]')!;
    stubElementRect(track);

    const rightClick = firePointerDown(track, { clientX: 100, button: 2 });
    expect(rightClick.defaultPrevented).toBe(false);
    fireWindowPointerMove(900);
    flush();
    expect(mocks.seekVideo).not.toHaveBeenCalled();

    const extraFinger = firePointerDown(track, { clientX: 100, isPrimary: false });
    expect(extraFinger.defaultPrevented).toBe(false);
    fireWindowPointerMove(900);
    flush();
    expect(mocks.seekVideo).not.toHaveBeenCalled();

    // 主指针左键仍正常起拖，并继续拦截面板内事件
    const primary = firePointerDown(track, { clientX: 300 });
    expect(primary.defaultPrevented).toBe(true);
    flush();
    expect(mocks.seekVideo).toHaveBeenLastCalledWith("n1", 3);
  });
});
