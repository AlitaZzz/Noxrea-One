// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";

import { flushMicrotasks, nodeViewProps } from "@/__tests__/test-utils/canvas-node";
import {
  detachedMedia,
  editResultResponse,
  jsonResponse,
  makeStorageKey,
} from "@/__tests__/test-utils/storage-fixtures";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ClientUnsupportedError } from "@/features/canvas/editing/client-media/client-video";
import VideoNode from "@/features/canvas/nodes/VideoNode";
import { playVideo, swapVideoSource } from "@/features/canvas/shared/video-playback-registry";
import { useCanvasStore } from "@/features/canvas/stores/canvas-store";
import type { VideoNodeData } from "@/features/canvas/types";
import { EventNames } from "@/lib/constants";

const {
  captureFrameApi, createImageNodeFromRef, createVideoNodeFromRef, createAudioNodeFromRef,
  serverExtractClip, tryClipOnClient, serverCropVideo, tryCropOnClient,
  serverDetachAudio, tryDetachAudioOnClient, playbackError, imageResult, posterRequests,
} = vi.hoisted(() => ({
  captureFrameApi: vi.fn(),
  createImageNodeFromRef: vi.fn(),
  createVideoNodeFromRef: vi.fn(),
  createAudioNodeFromRef: vi.fn(),
  serverExtractClip: vi.fn(),
  tryClipOnClient: vi.fn(),
  serverCropVideo: vi.fn(),
  tryCropOnClient: vi.fn(),
  serverDetachAudio: vi.fn(),
  tryDetachAudioOnClient: vi.fn(),
  playbackError: vi.fn(),
  imageResult: { current: { status: "ready", url: "/api/files/poster.webp" } as { status: string; url?: string } },
  posterRequests: [] as string[],
}));
vi.mock("react-i18next", async (original) => ({ ...await original<typeof import("react-i18next")>(), useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/components/ui/use-app-feedback", () => ({ useAppFeedback: () => ({ notification: { error: playbackError, warning: vi.fn() } }) }));
vi.mock("@/features/assets/store", () => ({ useAssetsStore: (selector: (state: unknown) => unknown) => selector({ addAsset: vi.fn() }) }));
vi.mock("@/features/canvas/upload", () => ({
  useNodeUpload: () => vi.fn(),
  createImageNodeFromRef,
  createVideoNodeFromRef,
  createAudioNodeFromRef,
  DERIVED_BASE_GAP_Y: 20,
}));
vi.mock("@/features/canvas/api/file-api", async (original) => ({
  ...await original<typeof import("@/features/canvas/api/file-api")>(),
  captureFrame: captureFrameApi,
  extractClip: serverExtractClip,
  cropVideo: serverCropVideo,
  detachAudio: serverDetachAudio,
}));
vi.mock("@/features/canvas/editing/client-media/client-video", async (original) => ({
  ...await original<typeof import("@/features/canvas/editing/client-media/client-video")>(),
  tryClipOnClient,
  tryCropOnClient,
  tryDetachAudioOnClient,
}));
// 海报加载状态可按用例切换：锁定静止态海报 URL 与 404 失败占位。
// 调度器 mock 捕获 VideoNode 传入的原始海报 URL（posterRequests），
// 渲染层 img 直接挂同一 HTTP URL（与「结果即原 URL、字节走 HTTP 缓存」契约一致）
vi.mock("@/features/canvas/hooks/use-canvas-image", () => ({
  useCanvasImage: (_nodeId: string, src: string) => {
    posterRequests.push(src);
    return { result: imageResult.current as { status: "ready" | "failed" | "pending" }, retry: vi.fn() };
  },
}));
vi.mock("@/features/canvas/nodes/NodeTitle", () => ({ default: () => null }));
vi.mock("@/features/canvas/nodes/BusyOverlay", () => ({ default: () => null }));
vi.mock("@/features/canvas/controls/ConnectionSideRail", () => ({ default: () => null }));
vi.mock("@/features/canvas/shared/MediaPreviewOverlay", () => ({ default: () => null }));
vi.mock("@/features/canvas/editing/VideoCropPanel", () => ({ default: function MockVideoCropPanel({ videoSize }: { videoSize?: { w: number; h: number } }) {
  return <div data-testid="crop">{videoSize ? `${videoSize.w}×${videoSize.h}` : "–"}</div>;
} }));

/** 源节点持久化值：存储 key（生产值域），渲染 URL 由组件派生 */
const SOURCE_KEY = makeStorageKey("source-video", ".mp4");
const SOURCE_URL = `/api/files/${SOURCE_KEY}`;
/** 换源测试的替代源（同为存储 key） */
const REPLACEMENT_KEY = makeStorageKey("replacement-video", ".mp4");
const data: VideoNodeData = { label: "video", src: SOURCE_KEY, naturalWidth: 1280, naturalHeight: 720, source: "derived", hasAudio: false };
/** 抽帧产物持久化值域：服务端存储 key（不是展示 URL） */
const FRAME_KEY = makeStorageKey("a", ".jpg");
/** 视频截取产物持久化值域：服务端存储 key */
const CLIP_KEY = makeStorageKey("b", ".mp4");
/** 视频裁剪产物持久化值域：服务端存储 key */
const CROP_KEY = makeStorageKey("c", ".mp4");
/** 分离音轨的静音视频产物持久化值域：服务端存储 key */
const DETACH_VIDEO_KEY = makeStorageKey("d", ".mp4");
/** 分离音轨的音频产物持久化值域：服务端存储 key */
const DETACH_AUDIO_KEY = makeStorageKey("e", ".m4a");
/** 派生视频节点的统一创建契约：源 id、持久化 key、尺寸、构建后同批写入 */
function expectDerivedVideoNode(key: string, width = 1280, height = 720) {
  expect(createVideoNodeFromRef).toHaveBeenCalledWith(
    "video",
    key,
    width,
    height,
    expect.any(String),
    expect.anything(),
    { source: "derived" },
    undefined,
    undefined,
    { write: false },
  );
}
/** 派生音频节点的统一创建契约（与视频节点同一形状，仅供分离音轨使用） */
function expectDerivedAudioNode(key: string, position: { x: number; y: number }) {
  expect(createAudioNodeFromRef).toHaveBeenCalledWith(
    "video",
    key,
    expect.any(String),
    expect.anything(),
    { source: "derived" },
    position,
    undefined,
    { write: false },
  );
}
/** 为派生工厂提供占位节点：测试只关心写入路径，不关心节点内容 */
function stubNode(
  factory: Mock,
  id: string,
  position: { x: number; y: number },
  style: Record<string, unknown> = {},
) {
  factory.mockReturnValueOnce({ id, position, style });
}
function NodeView() {
  const nodeData = useCanvasStore((state) => state.nodes[0].data) as VideoNodeData;
  return <VideoNode {...nodeViewProps<typeof VideoNode>("video", "video-node", nodeData)} />;
}
function Scene() {
  // CanvasImage 失败态含 Tooltip（重试），需要 Provider（应用内由全局布局提供）
  return <TooltipProvider><NodeView /></TooltipProvider>;
}
function ready(video: HTMLVideoElement, state = 2) {
  Object.defineProperties(video, {
    readyState: { value: state, configurable: true }, duration: { value: 33, configurable: true },
    videoWidth: { value: 1280, configurable: true }, videoHeight: { value: 720, configurable: true },
  });
  fireEvent(video, new Event(state >= 2 ? "loadeddata" : "loadedmetadata"));
}
function setNodeData(overrides: Partial<VideoNodeData>) {
  act(() => useCanvasStore.setState({ nodes: [{ id: "video", type: "video-node", position: { x: 5000, y: 0 }, data: { ...data, ...overrides } }] }));
}
beforeEach(() => {
  useCanvasStore.setState({ ...useCanvasStore.getInitialState(), nodes: [{ id: "video", type: "video-node", position: { x: 5000, y: 0 }, data: { ...data } }] });
  imageResult.current = { status: "ready", url: "/api/files/poster.webp" };
  posterRequests.length = 0;
  window.matchMedia = window.matchMedia ?? (() => ({ matches: false, media: "", addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(), onchange: null }));
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage: vi.fn() } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/jpeg;base64,frame");
  captureFrameApi.mockResolvedValue(jsonResponse({ data: { frame_key: FRAME_KEY, url: "/frame.jpg", time: 32.9, width: 1280, height: 720 } }));
});
afterEach(() => { cleanup(); useCanvasStore.setState(useCanvasStore.getInitialState(), true); vi.restoreAllMocks(); vi.resetAllMocks(); vi.useRealTimers(); });

describe("VideoNode poster-first", () => {
  function hoverBody(view: ReturnType<typeof render>) {
    fireEvent.mouseEnter(view.container.querySelector(".node-body")!);
  }
  function leaveBody(view: ReturnType<typeof render>) {
    fireEvent.mouseLeave(view.container.querySelector(".node-body")!);
  }
  async function startHoverPlay(view: ReturnType<typeof render>) {
    hoverBody(view);
    await act(async () => vi.advanceTimersByTimeAsync(300));
    await flushMicrotasks();
  }

  it("静止态渲染海报，不持有视频元素也没有播放按钮", async () => {
    const view = render(<Scene />);
    await flushMicrotasks();
    expect(view.container.querySelector("video")).toBeNull();
    const poster = view.container.querySelector("img")!;
    expect(poster).toHaveAttribute("src", "/api/files/poster.webp");
    expect(posterRequests).toContain(`${SOURCE_URL}?w=1280`);
    expect(screen.queryByRole("button", { name: "play" })).toBeNull();
  });

  it("悬停 300ms 起播（带声尝试），离开节点即卸载回海报", async () => {
    vi.useFakeTimers();
    const view = render(<Scene />);
    await flushMicrotasks();
    await startHoverPlay(view);
    const video = view.container.querySelector("video")!;
    expect(video).toHaveAttribute("src", SOURCE_URL);
    expect(video.preload).toBe("auto");
    expect(video.muted).toBe(false);
    expect(video.play).toHaveBeenCalledOnce();
    fireEvent.play(video);
    expect(screen.getByRole("button", { name: "pause" })).toBeInTheDocument();
    leaveBody(view);
    await flushMicrotasks();
    expect(view.container.querySelector("video")).toBeNull();
    expect(view.container.querySelector("img")).toHaveAttribute("src", "/api/files/poster.webp");
    expect(posterRequests).toContain(`${SOURCE_URL}?w=1280`);
    vi.useRealTimers();
  });

  it("带声播放被自动播放策略拦截时静音降级继续播放", async () => {
    vi.useFakeTimers();
    const view = render(<Scene />);
    await flushMicrotasks();
    vi.spyOn(HTMLMediaElement.prototype, "play")
      .mockRejectedValueOnce(new DOMException("blocked", "NotAllowedError"))
      .mockResolvedValue();
    await startHoverPlay(view);
    const video = view.container.querySelector("video")!;
    expect(video.play).toHaveBeenCalledTimes(2);
    expect(video.muted).toBe(true);
    vi.useRealTimers();
  });

  it("起播失败（解码不支持）静默回到海报，不弹错误通知", async () => {
    vi.useFakeTimers();
    const view = render(<Scene />);
    await flushMicrotasks();
    vi.spyOn(HTMLMediaElement.prototype, "play").mockRejectedValue(new DOMException("Unsupported", "NotSupportedError"));
    await startHoverPlay(view);
    expect(view.container.querySelector("video")).toBeNull();
    expect(view.container.querySelector("img")).toHaveAttribute("src", "/api/files/poster.webp");
    expect(posterRequests).toContain(`${SOURCE_URL}?w=1280`);
    expect(playbackError).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("加载失败重试重新武装 hover 自动播放", async () => {
    vi.useFakeTimers();
    const view = render(<Scene />);
    await flushMicrotasks();
    await startHoverPlay(view);
    const failed = view.container.querySelector("video")!;
    fireEvent.error(failed);
    await flushMicrotasks();
    expect(screen.getByRole("alert")).toHaveTextContent("media.loadFailed");
    // 非裁剪态的失败浮层只有重试：「取消」仅属于裁剪态（退出 croppingNodeId）
    expect(screen.queryByRole("button", { name: "common.cancel" })).toBeNull();
    const playSpy = vi.mocked(HTMLMediaElement.prototype.play);
    playSpy.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "media.retry" }));
    await flushMicrotasks();
    const retried = view.container.querySelector("video")!;
    expect(retried).not.toBe(failed);
    expect(retried.play).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it("画布拖拽开始立即停止 hover 播放", async () => {
    vi.useFakeTimers();
    const view = render(<Scene />);
    await flushMicrotasks();
    await startHoverPlay(view);
    expect(view.container.querySelector("video")).not.toBeNull();
    act(() => useCanvasStore.setState({ interaction: { mode: "dragging-nodes" } as ReturnType<typeof useCanvasStore.getState>["interaction"] }));
    await flushMicrotasks();
    expect(view.container.querySelector("video")).toBeNull();
    vi.useRealTimers();
  });

  it("海报加载失败（404）显示占位而非破图", async () => {
    const view = render(<Scene />);
    await flushMicrotasks();
    imageResult.current = { status: "failed" };
    // VideoNode 是 memo 组件：换新 data 对象强制重渲染
    setNodeData({});
    await flushMicrotasks();
    expect(view.container.querySelector("img")).toBeNull();
    expect(view.container.querySelector('[data-image-status="failed"]')).not.toBeNull();
  });

  it("控件条接管的播放离开节点不打断，页面隐藏仍无条件卸载", async () => {
    vi.useFakeTimers();
    const view = render(<Scene />);
    await flushMicrotasks();
    await startHoverPlay(view);
    const video = view.container.querySelector("video")!;
    fireEvent.play(video);
    // 接管：点暂停（悬停中保持会话画面）再点播放
    fireEvent.click(screen.getByRole("button", { name: "pause" }));
    fireEvent.pause(video);
    await flushMicrotasks();
    expect(view.container.querySelector("video")).toBe(video);
    fireEvent.click(screen.getByRole("button", { name: "play" }));
    await flushMicrotasks();
    Object.defineProperty(video, "paused", { value: false, configurable: true });
    fireEvent.play(video);
    leaveBody(view);
    await flushMicrotasks();
    expect(view.container.querySelector("video")).toBe(video);
    // 页面隐藏：即便接管播放中也无条件卸载（隐藏期间不存在挂 src 的常驻缓冲）
    const prevHidden = document.hidden;
    const prevVisibility = document.visibilityState;
    Object.defineProperty(document, "hidden", { value: true, configurable: true });
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    Object.defineProperty(document, "hidden", { value: prevHidden, configurable: true });
    Object.defineProperty(document, "visibilityState", { value: prevVisibility, configurable: true });
    await flushMicrotasks();
    expect(view.container.querySelector("video")).toBeNull();
    vi.useRealTimers();
  });

  it("窗口失焦无条件卸载会话（含控件条接管播放）", async () => {
    vi.useFakeTimers();
    const view = render(<Scene />);
    await flushMicrotasks();
    await startHoverPlay(view);
    const video = view.container.querySelector("video")!;
    fireEvent.play(video);
    // 接管播放中（paused=false）
    Object.defineProperty(video, "paused", { value: false, configurable: true });
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    fireEvent.blur(window);
    await flushMicrotasks();
    expect(view.container.querySelector("video")).toBeNull();
    vi.useRealTimers();
  });

  it("面板驱动的循环预览不受节点 mouseleave 影响（面板会话不由 hover 逻辑结束）", async () => {
    const view = render(<Scene />);
    await flushMicrotasks();
    act(() => useCanvasStore.setState({ clipCaptureNodeId: "video" }));
    await flushMicrotasks();
    const video = view.container.querySelector("video")!;
    ready(video);
    // 面板经注册表起播循环预览：不经过控件条，hover 逻辑无从知晓
    Object.defineProperty(video, "paused", { value: false, configurable: true });
    act(() => { void playVideo("video"); });
    leaveBody(view);
    await flushMicrotasks();
    expect(view.container.querySelector("video")).toBe(video);
    expect(video.pause).not.toHaveBeenCalled();
  });

  it("退出截取面板后元素卸载回封面，控件播放状态作废，hover 恢复响应", async () => {
    vi.useFakeTimers();
    const view = render(<Scene />);
    await flushMicrotasks();
    act(() => useCanvasStore.setState({ clipCaptureNodeId: "video" }));
    await flushMicrotasks();
    const video = view.container.querySelector("video")!;
    ready(video);
    // 面板循环播放中：play 事件镜像置位
    Object.defineProperty(video, "paused", { value: false, configurable: true });
    fireEvent.play(video);
    // 面板关闭恢复源：load() 不触发 pause 事件，事件镜像会卡在播放态
    act(() => useCanvasStore.setState({ clipCaptureNodeId: null }));
    await flushMicrotasks();
    expect(view.container.querySelector("video")).toBeNull();
    expect(view.container.querySelector("img")).toHaveAttribute("src", "/api/files/poster.webp");
    expect(posterRequests).toContain(`${SOURCE_URL}?w=1280`);
    await startHoverPlay(view);
    expect(view.container.querySelector("video")).not.toBeNull();
    vi.useRealTimers();
  });

  it("悬停中暂停保持会话画面，离开即卸载；重播从 0 秒开始（不恢复上次位置）", async () => {
    vi.useFakeTimers();
    const view = render(<Scene />);
    await flushMicrotasks();
    await startHoverPlay(view);
    const first = view.container.querySelector("video")!;
    first.currentTime = 17;
    fireEvent.pause(first);
    await flushMicrotasks();
    // 仍在悬停：会话保持（暂停画面），不闪回海报
    expect(view.container.querySelector("video")).toBe(first);
    leaveBody(view);
    await flushMicrotasks();
    expect(view.container.querySelector("video")).toBeNull();
    await startHoverPlay(view);
    const second = view.container.querySelector("video")!;
    expect(second).not.toBe(first);
    ready(second, 1);
    expect(second.currentTime).toBe(0);
    vi.useRealTimers();
  });

  it("换源替换丢弃进行中的会话", async () => {
    vi.useFakeTimers();
    const view = render(<Scene />);
    await flushMicrotasks();
    await startHoverPlay(view);
    const video = view.container.querySelector("video")!;
    fireEvent.play(video);
    setNodeData({ src: REPLACEMENT_KEY });
    await flushMicrotasks();
    expect(view.container.querySelector("video")).toBeNull();
    vi.useRealTimers();
  });

  it("上传中预览直接挂 blob 源，完成后回到海报（StrictMode 重挂不崩）", async () => {
    setNodeData({ upload: { uploading: true, previewUrl: "blob:upload", version: 1 } as VideoNodeData["upload"] });
    const view = render(<StrictMode><Scene /></StrictMode>);
    await flushMicrotasks();
    const preview = view.container.querySelector("video")!;
    expect(preview).toHaveAttribute("src", "blob:upload");
    setNodeData({});
    await flushMicrotasks();
    expect(view.container.querySelector("video")).toBeNull();
    expect(view.container.querySelector("img")).toHaveAttribute("src", "/api/files/poster.webp");
    expect(posterRequests).toContain(`${SOURCE_URL}?w=1280`);
  });
});

describe("VideoNode 编辑会话", () => {
  it("裁剪面板立即出现叠加在画面上，视频失败时让位给失败重试浮层", async () => {
    const view = render(<Scene />);
    await flushMicrotasks();
    act(() => useCanvasStore.setState({ croppingNodeId: "video" }));
    await flushMicrotasks();
    // 裁剪是空间操作：面板立即渲染，不等会话视频就绪，也没有黑幕加载层
    expect(screen.getByTestId("crop")).toHaveTextContent("1280×720");
    expect(screen.queryByRole("status")).toBeNull();
    const video = view.container.querySelector("video")!;
    expect(video).toHaveAttribute("src", SOURCE_URL);
    fireEvent.error(video);
    await flushMicrotasks();
    expect(screen.getByRole("alert")).toHaveTextContent("media.loadFailed");
    expect(screen.queryByTestId("crop")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "media.retry" }));
    await flushMicrotasks();
    const retried = view.container.querySelector("video")!;
    expect(retried).not.toBe(video);
    ready(retried);
    await flushMicrotasks();
    expect(screen.getByTestId("crop")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("裁剪中视频加载失败：失败浮层保留「取消」直接入口，点击退出裁剪态", async () => {
    const view = render(<Scene />);
    await flushMicrotasks();
    act(() => useCanvasStore.setState({ croppingNodeId: "video" }));
    await flushMicrotasks();
    fireEvent.error(view.container.querySelector("video")!);
    await flushMicrotasks();
    // 失败态下裁剪面板让位，面板自带的关闭键随之不可见：浮层上的「取消」是退出裁剪态的直接入口
    expect(screen.getByRole("alert")).toHaveTextContent("media.loadFailed");
    expect(screen.queryByTestId("crop")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "common.cancel" }));
    await flushMicrotasks();
    expect(useCanvasStore.getState().croppingNodeId).toBeNull();
  });

  it("选帧面板打开即挂载会话，代理换源与恢复不丢播放位置", async () => {
    const view = render(<Scene />);
    await flushMicrotasks();
    act(() => useCanvasStore.setState({ frameCaptureNodeId: "video" }));
    await flushMicrotasks();
    const video = view.container.querySelector("video")!;
    expect(video).toHaveAttribute("src", SOURCE_URL);
    // 面板打开不自动播放（无播放意图）
    expect(video.play).not.toHaveBeenCalled();
    ready(video);
    let restore!: () => void;
    act(() => { restore = swapVideoSource("video", "/proxy.mp4"); });
    video.currentTime = 9;
    expect(video).toHaveAttribute("src", "/proxy.mp4");
    act(() => restore());
    ready(video, 1);
    await flushMicrotasks();
    expect(video).toHaveAttribute("src", SOURCE_URL);
    expect(video.currentTime).toBe(9);
  });

  it("抽帧是服务端操作，静止态没有视频元素也能完成", async () => {
    render(<Scene />);
    await flushMicrotasks();
    act(() => window.dispatchEvent(new CustomEvent(EventNames.CANVAS_NODE_ACTION, { detail: { nodeId: "video", action: "capture-frame", selection: { kind: "last" } } })));
    await flushMicrotasks();
    expect(captureFrameApi).toHaveBeenCalledWith(SOURCE_KEY, { kind: "last" }, expect.any(AbortSignal));
    expect(createImageNodeFromRef).toHaveBeenCalledWith("video", FRAME_KEY, 1280, 720, expect.any(String), expect.anything(), { source: "derived" }, undefined, expect.any(String));
  });

  it("换源替换中止进行中的抽帧请求", async () => {
    let resolveCapture!: (response: unknown) => void;
    captureFrameApi.mockImplementation(() => new Promise((resolve) => { resolveCapture = resolve; }));
    render(<Scene />);
    await flushMicrotasks();
    act(() => window.dispatchEvent(new CustomEvent(EventNames.CANVAS_NODE_ACTION, { detail: { nodeId: "video", action: "capture-frame", selection: { kind: "last" } } })));
    await flushMicrotasks();
    setNodeData({ src: REPLACEMENT_KEY });
    await flushMicrotasks();
    const signal = captureFrameApi.mock.calls[0][2] as AbortSignal | undefined;
    expect(signal?.aborted).toBe(true);
    setNodeData({});
    await flushMicrotasks();
    await act(async () => resolveCapture(jsonResponse({ data: { frame_key: FRAME_KEY, url: "/frame.jpg", time: 32.9, width: 1280, height: 720 } })));
    expect(createImageNodeFromRef).not.toHaveBeenCalled();
  });

  it("抽帧成功响应缺 frame_key 属契约破坏：不创建节点并按失败提示", async () => {
    // 200 信封但持久化字段缺失：与信封失败同一提示契约，不静默丢弃任务
    captureFrameApi.mockResolvedValueOnce(
      jsonResponse({ data: { url: "/frame.jpg", time: 32.9, width: 1280, height: 720 } }),
    );
    render(<Scene />);
    await flushMicrotasks();
    act(() => window.dispatchEvent(new CustomEvent(EventNames.CANVAS_NODE_ACTION, { detail: { nodeId: "video", action: "capture-frame", selection: { kind: "last" } } })));
    await flushMicrotasks();
    expect(createImageNodeFromRef).not.toHaveBeenCalled();
    expect(playbackError).toHaveBeenCalled();
  });

  it("客户端管线截取产物写入存储 key，不写展示 URL", async () => {
    tryClipOnClient.mockResolvedValueOnce({ url: `/api/files/${CLIP_KEY}`, key: CLIP_KEY });
    stubNode(createVideoNodeFromRef, "clip-node", { x: 0, y: 0 });
    render(<Scene />);
    await flushMicrotasks();
    act(() => window.dispatchEvent(new CustomEvent(EventNames.CANVAS_NODE_ACTION, { detail: { nodeId: "video", action: "extract-clip", start: 0, end: 2 } })));
    await flushMicrotasks();
    expect(serverExtractClip).not.toHaveBeenCalled();
    expectDerivedVideoNode(CLIP_KEY);
  });

  it("客户端管线不支持时，服务端兜底的截取产物仍写入存储 key", async () => {
    tryClipOnClient.mockRejectedValueOnce(new ClientUnsupportedError("unsupported"));
    serverExtractClip.mockResolvedValueOnce(editResultResponse(CLIP_KEY));
    stubNode(createVideoNodeFromRef, "clip-node", { x: 0, y: 0 });
    render(<Scene />);
    await flushMicrotasks();
    act(() => window.dispatchEvent(new CustomEvent(EventNames.CANVAS_NODE_ACTION, { detail: { nodeId: "video", action: "extract-clip", start: 0, end: 2 } })));
    await flushMicrotasks();
    expect(serverExtractClip).toHaveBeenCalledWith(SOURCE_KEY, 0, 2, expect.any(AbortSignal));
    expectDerivedVideoNode(CLIP_KEY);
  });

  it("客户端管线裁剪产物写入存储 key，不写展示 URL", async () => {
    const rect = { x: 10, y: 20, width: 640, height: 360 };
    tryCropOnClient.mockResolvedValueOnce({ url: `/api/files/${CROP_KEY}`, key: CROP_KEY });
    stubNode(createVideoNodeFromRef, "crop-node", { x: 0, y: 0 });
    render(<Scene />);
    await flushMicrotasks();
    act(() => window.dispatchEvent(new CustomEvent(EventNames.CANVAS_NODE_ACTION, { detail: { nodeId: "video", action: "crop-video-apply", rect } })));
    await flushMicrotasks();
    expect(serverCropVideo).not.toHaveBeenCalled();
    expectDerivedVideoNode(CROP_KEY, rect.width, rect.height);
  });

  it("客户端管线不支持时，服务端兜底的裁剪产物仍写入存储 key", async () => {
    const rect = { x: 10, y: 20, width: 640, height: 360 };
    tryCropOnClient.mockRejectedValueOnce(new ClientUnsupportedError("unsupported"));
    serverCropVideo.mockResolvedValueOnce(editResultResponse(CROP_KEY));
    stubNode(createVideoNodeFromRef, "crop-node", { x: 0, y: 0 });
    render(<Scene />);
    await flushMicrotasks();
    act(() => window.dispatchEvent(new CustomEvent(EventNames.CANVAS_NODE_ACTION, { detail: { nodeId: "video", action: "crop-video-apply", rect } })));
    await flushMicrotasks();
    expect(serverCropVideo).toHaveBeenCalledWith(SOURCE_KEY, rect, expect.any(AbortSignal));
    expectDerivedVideoNode(CROP_KEY, rect.width, rect.height);
  });

  it("客户端管线分离音轨双产物写入存储 key，不写展示 URL", async () => {
    tryDetachAudioOnClient.mockResolvedValueOnce({
      video: detachedMedia(DETACH_VIDEO_KEY, "video/mp4", ".mp4"),
      audio: { ...detachedMedia(DETACH_AUDIO_KEY, "audio/mp4", ".m4a"), format: "copy" },
    });
    stubNode(createVideoNodeFromRef, "muted-node", { x: 5000, y: 0 }, { height: 200 });
    stubNode(createAudioNodeFromRef, "audio-node", { x: 5000, y: 220 });
    render(<Scene />);
    await flushMicrotasks();
    act(() => window.dispatchEvent(new CustomEvent(EventNames.CANVAS_NODE_ACTION, { detail: { nodeId: "video", action: "detach-audio" } })));
    await flushMicrotasks();
    expect(serverDetachAudio).not.toHaveBeenCalled();
    expectDerivedVideoNode(DETACH_VIDEO_KEY);
    expectDerivedAudioNode(DETACH_AUDIO_KEY, { x: 5000, y: 220 });
    expect(useCanvasStore.getState().nodes).toHaveLength(3);
  });

  it("客户端管线不支持时，服务端兜底的分离音轨双产物仍写入存储 key", async () => {
    tryDetachAudioOnClient.mockRejectedValueOnce(new ClientUnsupportedError("unsupported"));
    serverDetachAudio.mockResolvedValueOnce(jsonResponse({
      data: {
        video: detachedMedia(DETACH_VIDEO_KEY, "video/mp4", ".mp4"),
        audio: { ...detachedMedia(DETACH_AUDIO_KEY, "audio/mp4", ".m4a"), format: "copy" },
      },
    }));
    stubNode(createVideoNodeFromRef, "muted-node", { x: 5000, y: 0 }, { height: 200 });
    stubNode(createAudioNodeFromRef, "audio-node", { x: 5000, y: 220 });
    render(<Scene />);
    await flushMicrotasks();
    act(() => window.dispatchEvent(new CustomEvent(EventNames.CANVAS_NODE_ACTION, { detail: { nodeId: "video", action: "detach-audio" } })));
    await flushMicrotasks();
    expect(serverDetachAudio).toHaveBeenCalledWith(SOURCE_KEY, expect.any(AbortSignal));
    expectDerivedVideoNode(DETACH_VIDEO_KEY);
    // 音频节点排在静音视频正下方（间隙取 mock 的 DERIVED_BASE_GAP_Y = 20）
    expectDerivedAudioNode(DETACH_AUDIO_KEY, { x: 5000, y: 220 });
    expect(useCanvasStore.getState().nodes).toHaveLength(3);
  });

  it("服务端兜底成功但缺 audio.key 属契约破坏：不创建半成品节点", async () => {
    tryDetachAudioOnClient.mockRejectedValueOnce(new ClientUnsupportedError("unsupported"));
    // 200 信封但音频产物缺 key：不得把 undefined 当 src 创建节点
    serverDetachAudio.mockResolvedValueOnce(jsonResponse({
      data: { video: detachedMedia(DETACH_VIDEO_KEY, "video/mp4", ".mp4") },
    }));
    render(<Scene />);
    await flushMicrotasks();
    act(() => window.dispatchEvent(new CustomEvent(EventNames.CANVAS_NODE_ACTION, { detail: { nodeId: "video", action: "detach-audio" } })));
    await flushMicrotasks();
    expect(createVideoNodeFromRef).not.toHaveBeenCalled();
    expect(createAudioNodeFromRef).not.toHaveBeenCalled();
    expect(playbackError).toHaveBeenCalled();
    expect(useCanvasStore.getState().nodes).toHaveLength(1);
  });
});
