// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { StrictMode, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";
import VideoNode from "@/features/canvas/nodes/VideoNode";
import { playVideo, swapVideoSource } from "@/features/canvas/shared/video-playback-registry";
import { useCanvasStore } from "@/features/canvas/stores/canvas-store";
import type { VideoNodeData } from "@/features/canvas/types";
import { EventNames } from "@/lib/constants";

const { captureFrameApi, createNodeFromUrl, playbackError, imageResult, posterRequests } = vi.hoisted(() => ({
  captureFrameApi: vi.fn(),
  createNodeFromUrl: vi.fn(),
  playbackError: vi.fn(),
  imageResult: { current: { status: "ready", url: "/api/files/poster.webp" } as { status: string; url?: string } },
  posterRequests: [] as string[],
}));
vi.mock("react-i18next", async (original) => ({ ...await original<typeof import("react-i18next")>(), useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/components/ui/use-app-feedback", () => ({ useAppFeedback: () => ({ notification: { error: playbackError, warning: vi.fn() } }) }));
vi.mock("@/features/assets/store", () => ({ useAssetsStore: (selector: (state: unknown) => unknown) => selector({ addAsset: vi.fn() }) }));
vi.mock("@/features/canvas/upload", () => ({ useNodeUpload: () => vi.fn(), createNodeFromUrl, createVideoNodeFromUrl: vi.fn(), createAudioNodeFromUrl: vi.fn(), DERIVED_BASE_GAP_Y: 20 }));
vi.mock("@/features/canvas/api/file-api", async (original) => ({ ...await original<typeof import("@/features/canvas/api/file-api")>(), captureFrame: captureFrameApi }));
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
vi.mock("@/features/canvas/editing/VideoCropPanel", () => ({ default: function MockVideoCropPanel({ captureFrame }: { captureFrame: () => unknown }) {
  const [frame] = useState(captureFrame);
  return <div data-testid="crop">{frame ? "frame" : "empty"}</div>;
} }));

const data: VideoNodeData = { label: "video", src: "/api/files/test.mp4", naturalWidth: 1280, naturalHeight: 720, source: "derived", hasAudio: false };
function NodeView() {
  const nodeData = useCanvasStore((state) => state.nodes[0].data) as VideoNodeData;
  const props = { id: "video", data: nodeData, selected: false, dragging: false, type: "video-node", isConnectable: true, positionAbsoluteX: 0, positionAbsoluteY: 0, zIndex: 0 } as unknown as Parameters<typeof VideoNode>[0];
  return <VideoNode {...props} />;
}
function Scene() {
  // CanvasImage 失败态含 Tooltip（重试），需要 Provider（应用内由全局布局提供）
  return <TooltipProvider><NodeView /></TooltipProvider>;
}
async function flush() { await act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); }); }
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
  captureFrameApi.mockResolvedValue({ ok: true, json: async () => ({ data: { url: "/frame.jpg", time: 32.9, width: 1280, height: 720 } }) });
});
afterEach(() => { cleanup(); useCanvasStore.setState(useCanvasStore.getInitialState(), true); vi.restoreAllMocks(); vi.clearAllMocks(); vi.useRealTimers(); });

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
    await flush();
  }

  it("静止态渲染海报，不持有视频元素也没有播放按钮", async () => {
    const view = render(<Scene />);
    await flush();
    expect(view.container.querySelector("video")).toBeNull();
    const poster = view.container.querySelector("img")!;
    expect(poster).toHaveAttribute("src", "/api/files/poster.webp");
    expect(posterRequests).toContain("/api/files/test.mp4?w=480");
    expect(screen.queryByRole("button", { name: "play" })).toBeNull();
  });

  it("悬停 300ms 起播（带声尝试），离开节点即卸载回海报", async () => {
    vi.useFakeTimers();
    const view = render(<Scene />);
    await flush();
    await startHoverPlay(view);
    const video = view.container.querySelector("video")!;
    expect(video).toHaveAttribute("src", data.src);
    expect(video.preload).toBe("auto");
    expect(video.muted).toBe(false);
    expect(video.play).toHaveBeenCalledOnce();
    fireEvent.play(video);
    expect(screen.getByRole("button", { name: "pause" })).toBeInTheDocument();
    leaveBody(view);
    await flush();
    expect(view.container.querySelector("video")).toBeNull();
    expect(view.container.querySelector("img")).toHaveAttribute("src", "/api/files/poster.webp");
    expect(posterRequests).toContain("/api/files/test.mp4?w=480");
    vi.useRealTimers();
  });

  it("带声播放被自动播放策略拦截时静音降级继续播放", async () => {
    vi.useFakeTimers();
    const view = render(<Scene />);
    await flush();
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
    await flush();
    vi.spyOn(HTMLMediaElement.prototype, "play").mockRejectedValue(new DOMException("Unsupported", "NotSupportedError"));
    await startHoverPlay(view);
    expect(view.container.querySelector("video")).toBeNull();
    expect(view.container.querySelector("img")).toHaveAttribute("src", "/api/files/poster.webp");
    expect(posterRequests).toContain("/api/files/test.mp4?w=480");
    expect(playbackError).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("加载失败重试重新武装 hover 自动播放", async () => {
    vi.useFakeTimers();
    const view = render(<Scene />);
    await flush();
    await startHoverPlay(view);
    const failed = view.container.querySelector("video")!;
    fireEvent.error(failed);
    await flush();
    expect(screen.getByRole("alert")).toHaveTextContent("media.loadFailed");
    const playSpy = vi.mocked(HTMLMediaElement.prototype.play);
    playSpy.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "media.retry" }));
    await flush();
    const retried = view.container.querySelector("video")!;
    expect(retried).not.toBe(failed);
    expect(retried.play).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it("画布拖拽开始立即停止 hover 播放", async () => {
    vi.useFakeTimers();
    const view = render(<Scene />);
    await flush();
    await startHoverPlay(view);
    expect(view.container.querySelector("video")).not.toBeNull();
    act(() => useCanvasStore.setState({ interaction: { mode: "dragging-nodes" } as ReturnType<typeof useCanvasStore.getState>["interaction"] }));
    await flush();
    expect(view.container.querySelector("video")).toBeNull();
    vi.useRealTimers();
  });

  it("海报加载失败（404）显示占位而非破图", async () => {
    const view = render(<Scene />);
    await flush();
    imageResult.current = { status: "failed" };
    // VideoNode 是 memo 组件：换新 data 对象强制重渲染
    setNodeData({});
    await flush();
    expect(view.container.querySelector("img")).toBeNull();
    expect(view.container.querySelector('[data-image-status="failed"]')).not.toBeNull();
  });

  it("控件条接管的播放离开节点不打断，页面隐藏仍无条件卸载", async () => {
    vi.useFakeTimers();
    const view = render(<Scene />);
    await flush();
    await startHoverPlay(view);
    const video = view.container.querySelector("video")!;
    fireEvent.play(video);
    // 接管：点暂停（悬停中保持会话画面）再点播放
    fireEvent.click(screen.getByRole("button", { name: "pause" }));
    fireEvent.pause(video);
    await flush();
    expect(view.container.querySelector("video")).toBe(video);
    fireEvent.click(screen.getByRole("button", { name: "play" }));
    await flush();
    Object.defineProperty(video, "paused", { value: false, configurable: true });
    fireEvent.play(video);
    leaveBody(view);
    await flush();
    expect(view.container.querySelector("video")).toBe(video);
    // 页面隐藏：即便接管播放中也无条件卸载（隐藏期间不存在挂 src 的常驻缓冲）
    const prevHidden = document.hidden;
    const prevVisibility = document.visibilityState;
    Object.defineProperty(document, "hidden", { value: true, configurable: true });
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    Object.defineProperty(document, "hidden", { value: prevHidden, configurable: true });
    Object.defineProperty(document, "visibilityState", { value: prevVisibility, configurable: true });
    await flush();
    expect(view.container.querySelector("video")).toBeNull();
    vi.useRealTimers();
  });

  it("窗口失焦无条件卸载会话（含控件条接管播放）", async () => {
    vi.useFakeTimers();
    const view = render(<Scene />);
    await flush();
    await startHoverPlay(view);
    const video = view.container.querySelector("video")!;
    fireEvent.play(video);
    // 接管播放中（paused=false）
    Object.defineProperty(video, "paused", { value: false, configurable: true });
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    fireEvent.blur(window);
    await flush();
    expect(view.container.querySelector("video")).toBeNull();
    vi.useRealTimers();
  });

  it("面板驱动的循环预览不受节点 mouseleave 影响（面板会话不由 hover 逻辑结束）", async () => {
    const view = render(<Scene />);
    await flush();
    act(() => useCanvasStore.setState({ clipCaptureNodeId: "video" }));
    await flush();
    const video = view.container.querySelector("video")!;
    ready(video);
    // 面板经注册表起播循环预览：不经过控件条，hover 逻辑无从知晓
    Object.defineProperty(video, "paused", { value: false, configurable: true });
    act(() => { void playVideo("video"); });
    leaveBody(view);
    await flush();
    expect(view.container.querySelector("video")).toBe(video);
    expect(video.pause).not.toHaveBeenCalled();
  });

  it("退出截取面板后元素卸载回封面，控件播放状态作废，hover 恢复响应", async () => {
    vi.useFakeTimers();
    const view = render(<Scene />);
    await flush();
    act(() => useCanvasStore.setState({ clipCaptureNodeId: "video" }));
    await flush();
    const video = view.container.querySelector("video")!;
    ready(video);
    // 面板循环播放中：play 事件镜像置位
    Object.defineProperty(video, "paused", { value: false, configurable: true });
    fireEvent.play(video);
    // 面板关闭恢复源：load() 不触发 pause 事件，事件镜像会卡在播放态
    act(() => useCanvasStore.setState({ clipCaptureNodeId: null }));
    await flush();
    expect(view.container.querySelector("video")).toBeNull();
    expect(view.container.querySelector("img")).toHaveAttribute("src", "/api/files/poster.webp");
    expect(posterRequests).toContain("/api/files/test.mp4?w=480");
    await startHoverPlay(view);
    expect(view.container.querySelector("video")).not.toBeNull();
    vi.useRealTimers();
  });

  it("悬停中暂停保持会话画面，离开即卸载；重播从 0 秒开始（不恢复上次位置）", async () => {
    vi.useFakeTimers();
    const view = render(<Scene />);
    await flush();
    await startHoverPlay(view);
    const first = view.container.querySelector("video")!;
    first.currentTime = 17;
    fireEvent.pause(first);
    await flush();
    // 仍在悬停：会话保持（暂停画面），不闪回海报
    expect(view.container.querySelector("video")).toBe(first);
    leaveBody(view);
    await flush();
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
    await flush();
    await startHoverPlay(view);
    const video = view.container.querySelector("video")!;
    fireEvent.play(video);
    setNodeData({ src: "/replacement.mp4" });
    await flush();
    expect(view.container.querySelector("video")).toBeNull();
    vi.useRealTimers();
  });

  it("上传中预览直接挂 blob 源，完成后回到海报（StrictMode 重挂不崩）", async () => {
    setNodeData({ upload: { uploading: true, previewUrl: "blob:upload", version: 1 } as VideoNodeData["upload"] });
    const view = render(<StrictMode><Scene /></StrictMode>);
    await flush();
    const preview = view.container.querySelector("video")!;
    expect(preview).toHaveAttribute("src", "blob:upload");
    setNodeData({});
    await flush();
    expect(view.container.querySelector("video")).toBeNull();
    expect(view.container.querySelector("img")).toHaveAttribute("src", "/api/files/poster.webp");
    expect(posterRequests).toContain("/api/files/test.mp4?w=480");
  });
});

describe("VideoNode 编辑会话", () => {
  it("裁剪面板等待首帧就绪，失败可重试恢复", async () => {
    const view = render(<Scene />);
    await flush();
    act(() => useCanvasStore.setState({ croppingNodeId: "video" }));
    await flush();
    expect(screen.getByRole("status")).toHaveTextContent("media.loading");
    const broken = view.container.querySelector("video")!;
    fireEvent.error(broken);
    await flush();
    expect(screen.getByRole("alert")).toHaveTextContent("media.loadFailed");
    fireEvent.click(screen.getByRole("button", { name: "media.retry" }));
    await flush();
    const retried = view.container.querySelector("video")!;
    expect(retried).not.toBe(broken);
    ready(retried);
    await flush();
    expect(screen.getByTestId("crop")).toHaveTextContent("frame");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("选帧面板打开即挂载会话，代理换源与恢复不丢播放位置", async () => {
    const view = render(<Scene />);
    await flush();
    act(() => useCanvasStore.setState({ frameCaptureNodeId: "video" }));
    await flush();
    const video = view.container.querySelector("video")!;
    expect(video).toHaveAttribute("src", data.src);
    // 面板打开不自动播放（无播放意图）
    expect(video.play).not.toHaveBeenCalled();
    ready(video);
    let restore!: () => void;
    act(() => { restore = swapVideoSource("video", "/proxy.mp4"); });
    video.currentTime = 9;
    expect(video).toHaveAttribute("src", "/proxy.mp4");
    act(() => restore());
    ready(video, 1);
    await flush();
    expect(video).toHaveAttribute("src", data.src);
    expect(video.currentTime).toBe(9);
  });

  it("抽帧是服务端操作，静止态没有视频元素也能完成", async () => {
    render(<Scene />);
    await flush();
    act(() => window.dispatchEvent(new CustomEvent(EventNames.CANVAS_NODE_ACTION, { detail: { nodeId: "video", action: "capture-frame", selection: { kind: "last" } } })));
    await flush();
    expect(captureFrameApi).toHaveBeenCalledWith("test.mp4", { kind: "last" }, expect.any(AbortSignal));
    expect(createNodeFromUrl).toHaveBeenCalledWith("video", "/frame.jpg", 1280, 720, expect.any(String), expect.anything(), { source: "derived" }, undefined, expect.any(String));
  });

  it("换源替换中止进行中的抽帧请求", async () => {
    let resolveCapture!: (response: unknown) => void;
    captureFrameApi.mockImplementation(() => new Promise((resolve) => { resolveCapture = resolve; }));
    render(<Scene />);
    await flush();
    act(() => window.dispatchEvent(new CustomEvent(EventNames.CANVAS_NODE_ACTION, { detail: { nodeId: "video", action: "capture-frame", selection: { kind: "last" } } })));
    await flush();
    setNodeData({ src: "/replacement.mp4" });
    await flush();
    const signal = captureFrameApi.mock.calls[0][2] as AbortSignal | undefined;
    expect(signal?.aborted).toBe(true);
    setNodeData({});
    await flush();
    await act(async () => resolveCapture({ ok: true, json: async () => ({ data: { url: "/frame.jpg", time: 32.9, width: 1280, height: 720 } }) }));
    expect(createNodeFromUrl).not.toHaveBeenCalled();
  });
});
