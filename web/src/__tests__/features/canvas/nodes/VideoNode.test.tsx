// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { type InternalNode, type Node, type NodeProps, ReactFlowProvider, useStoreApi } from "@xyflow/react";
import { type ReactNode, StrictMode, useLayoutEffect, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import VideoNode from "@/features/canvas/nodes/VideoNode";
import CanvasMediaLoadingProvider from "@/features/canvas/shared/CanvasMediaLoadingProvider";
import { swapVideoSource } from "@/features/canvas/shared/video-playback-registry";
import { useCanvasStore } from "@/features/canvas/stores/canvas-store";
import type { VideoNode as VideoNodeType, VideoNodeData } from "@/features/canvas/types";
import { EventNames } from "@/lib/constants";

const { captureFrameApi, createNodeFromUrl, playbackError } = vi.hoisted(() => ({ captureFrameApi: vi.fn(), createNodeFromUrl: vi.fn(), playbackError: vi.fn() }));
vi.mock("react-i18next", async (original) => ({ ...await original<typeof import("react-i18next")>(), useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/components/ui/use-app-feedback", () => ({ useAppFeedback: () => ({ notification: { error: playbackError, warning: vi.fn() } }) }));
vi.mock("@/features/assets/store", () => ({ useAssetsStore: (selector: (state: unknown) => unknown) => selector({ addAsset: vi.fn() }) }));
vi.mock("@/features/canvas/upload", () => ({ useNodeUpload: () => vi.fn(), createNodeFromUrl, createVideoNodeFromUrl: vi.fn(), createAudioNodeFromUrl: vi.fn(), DERIVED_BASE_GAP_Y: 20 }));
vi.mock("@/features/canvas/api/file-api", async (original) => ({ ...await original<typeof import("@/features/canvas/api/file-api")>(), captureFrame: captureFrameApi }));
vi.mock("@/features/canvas/nodes/NodeTitle", () => ({ default: () => null }));
vi.mock("@/features/canvas/nodes/BusyOverlay", () => ({ default: () => null }));
vi.mock("@/features/canvas/controls/ConnectionSideRail", () => ({ default: () => null }));
vi.mock("@/features/canvas/shared/MediaPreviewOverlay", () => ({ default: () => null }));
vi.mock("@/features/canvas/editing/VideoCropPanel", () => ({ default: function MockVideoCropPanel({ captureFrame }: { captureFrame: () => unknown }) {
  const [frame] = useState(captureFrame);
  return <div data-testid="crop">{frame ? "frame" : "empty"}</div>;
} }));

let flowStore: ReturnType<typeof useStoreApi>;
const data: VideoNodeData = { label: "video", src: "/api/files/test.mp4", naturalWidth: 1280, naturalHeight: 720, source: "derived", hasAudio: false };
function StoreBridge({ children, x }: { children: ReactNode; x: number }) {
  const api = useStoreApi();
  useLayoutEffect(() => {
    flowStore = api;
    const userNode: Node = { id: "video", position: { x, y: 0 }, data: {}, measured: { width: 400, height: 328 } };
    const internal: InternalNode = { ...userNode, measured: { width: 400, height: 328 }, internals: { positionAbsolute: { x, y: 0 }, z: 0, userNode } };
    api.setState({ width: 800, height: 600, transform: [0, 0, 1], nodeLookup: new Map([["video", internal]]) });
  }, [api, x]);
  return children;
}
function NodeView() {
  const nodeData = useCanvasStore((state) => state.nodes[0].data) as VideoNodeData;
  const props = { id: "video", data: nodeData, selected: false, dragging: false, type: "video-node", isConnectable: true, positionAbsoluteX: 0, positionAbsoluteY: 0, zIndex: 0 } as NodeProps<VideoNodeType>;
  return <VideoNode {...props} />;
}
function Scene({ x = 5000, project = "first" }: { x?: number; project?: string }) {
  return <ReactFlowProvider><StoreBridge x={x}><CanvasMediaLoadingProvider key={project}><NodeView /></CanvasMediaLoadingProvider></StoreBridge></ReactFlowProvider>;
}
async function flush() { await act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); }); }
function ready(video: HTMLVideoElement, state = 2) {
  Object.defineProperties(video, {
    readyState: { value: state, configurable: true }, duration: { value: 33, configurable: true },
    videoWidth: { value: 1280, configurable: true }, videoHeight: { value: 720, configurable: true },
  });
  fireEvent(video, new Event(state >= 2 ? "loadeddata" : "loadedmetadata"));
}
beforeEach(() => {
  useCanvasStore.setState({ ...useCanvasStore.getInitialState(), nodes: [{ id: "video", type: "video-node", position: { x: 5000, y: 0 }, data: { ...data } }] });
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(function (this: HTMLMediaElement) {
    Object.defineProperties(this, {
      readyState: { value: 0, configurable: true }, duration: { value: NaN, configurable: true },
      videoWidth: { value: 0, configurable: true }, videoHeight: { value: 0, configurable: true },
    });
    this.dispatchEvent(new Event("loadstart"));
  });
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage: vi.fn() } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/jpeg;base64,frame");
  captureFrameApi.mockResolvedValue({ ok: true, json: async () => ({ data: { url: "/frame.jpg", time: 32.9, width: 1280, height: 720 } }) });
});
afterEach(() => { cleanup(); useCanvasStore.setState(useCanvasStore.getInitialState(), true); vi.restoreAllMocks(); vi.clearAllMocks(); vi.useRealTimers(); });

describe("VideoNode loading", () => {
  it("cancels the hover delay when loading fails before playback starts", async () => {
    vi.useFakeTimers();
    const view = render(<Scene x={0} />);
    await flush();
    const video = view.container.querySelector("video")!;
    fireEvent.mouseEnter(video.parentElement!);
    await act(async () => vi.advanceTimersByTimeAsync(100));
    fireEvent.error(video);
    await act(async () => vi.advanceTimersByTimeAsync(300));
    expect(video.play).not.toHaveBeenCalled();
  });

  it("pauses hover playback when a busy operation starts before leaving", async () => {
    vi.useFakeTimers();
    const view = render(<Scene x={0} />);
    await flush();
    const body = view.container.querySelector(".node-body")!;
    const video = view.container.querySelector("video")!;
    fireEvent.mouseEnter(body);
    await act(async () => vi.advanceTimersByTimeAsync(300));
    await flush();
    const pause = vi.mocked(video.pause);
    pause.mockClear();

    let resolveCapture!: (response: unknown) => void;
    captureFrameApi.mockImplementation(() => new Promise((resolve) => { resolveCapture = resolve; }));
    act(() => window.dispatchEvent(new CustomEvent(EventNames.CANVAS_NODE_ACTION, {
      detail: { nodeId: "video", action: "capture-frame", selection: { kind: "last" } },
    })));
    await flush();
    fireEvent.mouseLeave(body);

    expect(pause).toHaveBeenCalledOnce();
    act(() => resolveCapture({ ok: false, json: async () => ({}) }));
    await flush();
  });

  it.each(["failed", "stalled"])("does not start a pending hover play on a %s source", async (status) => {
    vi.useFakeTimers();
    const view = render(<Scene x={0} />);
    await flush();
    const video = view.container.querySelector("video")!;
    if (status === "failed") fireEvent.error(video);
    else await act(async () => vi.advanceTimersByTimeAsync(60_000));
    await flush();
    fireEvent.mouseEnter(video.parentElement!);
    await act(async () => vi.advanceTimersByTimeAsync(300));
    expect(video.play).not.toHaveBeenCalled();
    expect(video.load).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("shows crop loading, then failure with an explicit retry that can recover", async () => {
    const view = render(<Scene />);
    await flush();
    act(() => useCanvasStore.setState({ croppingNodeId: "video" }));
    await flush();
    expect(screen.getByRole("status")).toHaveTextContent("media.loading");
    const video = view.container.querySelector("video")!;
    fireEvent.error(video);
    await flush();
    expect(screen.getByRole("alert")).toHaveTextContent("media.loadFailed");
    fireEvent.click(screen.getByRole("button", { name: "media.retry" }));
    await flush();
    expect(video.load).toHaveBeenCalled();
    ready(video);
    await flush();
    expect(screen.getByTestId("crop")).toHaveTextContent("frame");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("restarts a failed source on an explicit play request", async () => {
    const view = render(<Scene x={0} />);
    await flush();
    const video = view.container.querySelector("video")!;
    fireEvent.error(video);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "play" }));
    await flush();
    expect(video.load).toHaveBeenCalledOnce();
    expect(video.preload).toBe("auto");
    ready(video);
    expect(screen.queryByRole("alert")).toBeNull();
  });
  it("loads metadata near the viewport, upgrades to a first frame when visible and retains the player on departure", async () => {
    const view = render(<Scene />);
    const video = view.container.querySelector("video")!;
    await flush();
    expect(video).not.toHaveAttribute("src");
    act(() => flowStore.setState({ transform: [-4100, 0, 1] }));
    await flush();
    expect(video).toHaveAttribute("src", data.src);
    expect(video.preload).toBe("metadata");
    ready(video, 1);
    act(() => flowStore.setState({ transform: [-5000, 0, 1] }));
    await flush();
    expect(video.preload).toBe("auto");
    ready(video);
    video.currentTime = 7;
    act(() => flowStore.setState({ transform: [0, 0, 1] }));
    await flush();
    expect(view.container.querySelector("video")).toBe(video);
    expect(video.currentTime).toBe(7);
    expect(video).toHaveAttribute("src", data.src);
    expect(video.load).not.toHaveBeenCalled();
    expect(video.pause).not.toHaveBeenCalled();
  });

  it("assigns a distant source synchronously before a user play request", async () => {
    const view = render(<Scene />);
    await flush();
    const video = view.container.querySelector("video")!;
    const play = vi.spyOn(video, "play").mockImplementation(async () => { expect(video).toHaveAttribute("src", data.src); });
    fireEvent.click(screen.getByRole("button", { name: "play" }));
    expect(play).toHaveBeenCalledOnce();
    fireEvent.play(video);
    fireEvent.mouseLeave(video.closest(".node-body")!);
    act(() => flowStore.setState({ transform: [10000, 0, 1] }));
    await flush();
    expect(video.pause).not.toHaveBeenCalled();
    expect(video).toHaveAttribute("src", data.src);
  });

  it("prioritizes a distant editor and preserves proxy source and selection time across panning", async () => {
    const view = render(<Scene />);
    await flush();
    act(() => useCanvasStore.setState({ frameCaptureNodeId: "video" }));
    await flush();
    const video = view.container.querySelector("video")!;
    expect(video).toHaveAttribute("src", data.src);
    ready(video);
    let restore!: () => void;
    act(() => { restore = swapVideoSource("video", "/proxy.mp4"); });
    fireEvent.loadStart(video);
    video.currentTime = 9;
    act(() => flowStore.setState({ transform: [20000, 0, 1] }));
    await flush();
    expect(video).toHaveAttribute("src", "/proxy.mp4");
    expect(video.currentTime).toBe(9);
    expect(view.container.querySelector("video")).toBe(video);
    act(() => restore());
    ready(video, 1);
    await flush();
    expect(video).toHaveAttribute("src", data.src);
    expect(video.currentTime).toBe(9);
  });

  it("waits for the first frame before mounting a crop panel that captures once", async () => {
    const view = render(<Scene />);
    await flush();
    act(() => useCanvasStore.setState({ croppingNodeId: "video" }));
    await flush();
    expect(screen.queryByTestId("crop")).toBeNull();
    ready(view.container.querySelector("video")!);
    await flush();
    expect(screen.getByTestId("crop")).toHaveTextContent("frame");
  });

  it("captures an unloaded video's last frame on the server without local decoding", async () => {
    render(<Scene />);
    await flush();
    act(() => window.dispatchEvent(new CustomEvent(EventNames.CANVAS_NODE_ACTION, { detail: { nodeId: "video", action: "capture-frame", selection: { kind: "last" } } })));
    await flush();
    expect(captureFrameApi).toHaveBeenCalledWith("test.mp4", { kind: "last" }, expect.any(AbortSignal));
    expect(createNodeFromUrl).toHaveBeenCalledWith("video", "/frame.jpg", 1280, 720, expect.any(String), expect.anything(), { source: "derived" }, undefined, expect.any(String));
  });

  it("captures a selected time while the original source is reloading after proxy restoration", async () => {
    const view = render(<Scene x={0} />);
    await flush();
    const video = view.container.querySelector("video")!;
    ready(video);
    let restore!: () => void;
    act(() => { restore = swapVideoSource("video", "/proxy.mp4"); });
    ready(video);
    act(() => restore());
    expect(video.readyState).toBe(0);
    expect(Number.isNaN(video.duration)).toBe(true);
    captureFrameApi.mockResolvedValue({ ok: true, json: async () => ({ data: { url: "/frame.jpg", time: 5, width: 1920, height: 1080 } }) });
    act(() => window.dispatchEvent(new CustomEvent(EventNames.CANVAS_NODE_ACTION, { detail: { nodeId: "video", action: "capture-frame", selection: { kind: "time", seconds: 5 } } })));
    await flush();
    expect(captureFrameApi).toHaveBeenCalledWith("test.mp4", { kind: "time", seconds: 5 }, expect.any(AbortSignal));
    expect(createNodeFromUrl).toHaveBeenCalledWith("video", "/frame.jpg", 1920, 1080, "video #5s", expect.anything(), { source: "derived" }, undefined, "video #5s");
  });

  it("captures a selected time even when the browser rejects the original encoding", async () => {
    const view = render(<Scene x={0} />);
    await flush();
    fireEvent.error(view.container.querySelector("video")!);
    act(() => window.dispatchEvent(new CustomEvent(EventNames.CANVAS_NODE_ACTION, { detail: { nodeId: "video", action: "capture-frame", selection: { kind: "time", seconds: 5 } } })));
    await flush();
    expect(captureFrameApi).toHaveBeenCalledWith("test.mp4", { kind: "time", seconds: 5 }, expect.any(AbortSignal));
    expect(createNodeFromUrl).toHaveBeenCalledOnce();
  });

  it("opens crop after a timed-out video subsequently loads its first frame", async () => {
    vi.useFakeTimers();
    const view = render(<Scene x={0} />);
    await flush();
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    ready(view.container.querySelector("video")!);
    act(() => useCanvasStore.setState({ croppingNodeId: "video" }));
    await flush();
    expect(screen.getByTestId("crop")).toHaveTextContent("frame");
    vi.useRealTimers();
  });

  it("cancels pending hover playback without a late autoplay retry", async () => {
    vi.useFakeTimers();
    const view = render(<Scene />);
    await flush();
    const video = view.container.querySelector("video")!;
    let rejectPlay!: (error: Error) => void;
    const play = vi.spyOn(video, "play").mockImplementation(() => new Promise<void>((_resolve, reject) => { rejectPlay = reject; }));
    fireEvent.mouseEnter(video.closest(".node-body")!);
    await act(async () => vi.advanceTimersByTimeAsync(300));
    expect(play).toHaveBeenCalledOnce();
    expect(video.preload).toBe("auto");
    fireEvent.mouseLeave(video.closest(".node-body")!);
    expect(video.preload).toBe("none");
    await act(async () => { rejectPlay(new DOMException("Cancelled", "AbortError")); });
    expect(play).toHaveBeenCalledOnce();
    expect(video.pause).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it.each(["AbortError", "NotSupportedError", "NotAllowedError"])("releases hover loading after %s playback failure", async (name) => {
    vi.useFakeTimers();
    const view = render(<Scene />);
    await flush();
    const video = view.container.querySelector("video")!;
    vi.spyOn(video, "play").mockRejectedValue(new DOMException("Playback failed", name));
    fireEvent.mouseEnter(video.closest(".node-body")!);
    await act(async () => vi.advanceTimersByTimeAsync(300));
    await flush();
    expect(video.preload).toBe("none");
  });

  it("releases pending hover loading when a drag starts", async () => {
    vi.useFakeTimers();
    const view = render(<Scene />);
    await flush();
    const video = view.container.querySelector("video")!;
    vi.spyOn(video, "play").mockImplementation(() => new Promise<void>(() => {}));
    fireEvent.mouseEnter(video.closest(".node-body")!);
    await act(async () => vi.advanceTimersByTimeAsync(300));
    act(() => useCanvasStore.setState({ interaction: { mode: "dragging-nodes" } as ReturnType<typeof useCanvasStore.getState>["interaction"] }));
    await flush();
    expect(video.preload).toBe("none");
  });

  it("releases user-play loading after playback failure", async () => {
    const view = render(<Scene />);
    await flush();
    const video = view.container.querySelector("video")!;
    vi.spyOn(video, "play").mockRejectedValue(new DOMException("Unsupported", "NotSupportedError"));
    fireEvent.click(screen.getByRole("button", { name: "play" }));
    await flush();
    expect(video.preload).toBe("none");
    expect(screen.getByRole("button", { name: "play" })).toBeInTheDocument();
    expect(playbackError).toHaveBeenCalledWith(expect.objectContaining({ title: "media.playFailed" }));
  });

  it("offers retry and cancellation when crop preparation times out", async () => {
    vi.useFakeTimers();
    const view = render(<Scene />);
    await flush();
    act(() => useCanvasStore.setState({ croppingNodeId: "video" }));
    await flush();
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(screen.getByRole("alert")).toHaveTextContent("media.loadTimedOut");
    fireEvent.click(screen.getByRole("button", { name: "media.retry" }));
    await flush();
    expect(view.container.querySelector("video")!.load).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "common.cancel" }));
    expect(useCanvasStore.getState().croppingNodeId).toBeNull();
  });

  it("drops the previous source's playing demand on replacement", async () => {
    const view = render(<Scene />);
    await flush();
    const video = view.container.querySelector("video")!;
    fireEvent.click(screen.getByRole("button", { name: "play" }));
    await flush();
    fireEvent.play(video);
    act(() => useCanvasStore.setState({ nodes: [{ id: "video", type: "video-node", position: { x: 5000, y: 0 }, data: { ...data, src: "/replacement.mp4" } }] }));
    await flush();
    expect(video).not.toHaveAttribute("src");
    expect(screen.getByRole("button", { name: "play" })).toBeInTheDocument();
  });

  it("ignores user-play completion after the player was paused", async () => {
    const view = render(<Scene />);
    await flush();
    const video = view.container.querySelector("video")!;
    let resolvePlay!: () => void;
    vi.spyOn(video, "play").mockImplementation(() => new Promise<void>((resolve) => { resolvePlay = resolve; }));
    fireEvent.click(screen.getByRole("button", { name: "play" }));
    fireEvent.pause(video);
    await act(async () => resolvePlay());
    await flush();
    expect(video.preload).toBe("none");
    expect(screen.getByRole("button", { name: "play" })).toBeInTheDocument();
  });

  it("keeps user-play request ownership when the pointer leaves during loading", async () => {
    const view = render(<Scene />);
    await flush();
    const video = view.container.querySelector("video")!;
    let rejectPlay!: (error: Error) => void;
    vi.spyOn(video, "play").mockImplementation(() => new Promise<void>((_resolve, reject) => { rejectPlay = reject; }));
    fireEvent.click(screen.getByRole("button", { name: "play" }));
    fireEvent.play(video);
    fireEvent.mouseLeave(video.closest(".node-body")!);
    await act(async () => rejectPlay(new DOMException("Unsupported", "NotSupportedError")));
    await flush();
    expect(video.preload).toBe("none");
    expect(screen.getByRole("button", { name: "play" })).toBeInTheDocument();
  });

  it("cancels pending capture after its source is replaced", async () => {
    let resolveCapture!: (response: unknown) => void;
    captureFrameApi.mockImplementation(() => new Promise((resolve) => { resolveCapture = resolve; }));
    render(<Scene />);
    await flush();
    act(() => window.dispatchEvent(new CustomEvent(EventNames.CANVAS_NODE_ACTION, { detail: { nodeId: "video", action: "capture-frame", selection: { kind: "last" } } })));
    await flush();
    act(() => useCanvasStore.setState({ nodes: [{ id: "video", type: "video-node", position: { x: 5000, y: 0 }, data: { ...data, src: "/replacement.mp4" } }] }));
    await flush();
    const signal = captureFrameApi.mock.calls[0][2] as AbortSignal | undefined;
    expect(signal?.aborted).toBe(true);
    act(() => useCanvasStore.setState({ nodes: [{ id: "video", type: "video-node", position: { x: 5000, y: 0 }, data: { ...data } }] }));
    await flush();
    await act(async () => resolveCapture({ ok: true, json: async () => ({ data: { url: "/frame.jpg", time: 32.9, width: 1280, height: 720 } }) }));
    expect(createNodeFromUrl).not.toHaveBeenCalled();
  });

  it("cancels pending hover playback when the same player receives a replacement source", async () => {
    vi.useFakeTimers();
    const view = render(<Scene />);
    await flush();
    const video = view.container.querySelector("video")!;
    let rejectPlay!: (error: Error) => void;
    const play = vi.spyOn(video, "play").mockImplementation(() => new Promise<void>((_resolve, reject) => { rejectPlay = reject; }));
    fireEvent.mouseEnter(video.closest(".node-body")!);
    await act(async () => vi.advanceTimersByTimeAsync(300));
    act(() => useCanvasStore.setState({ nodes: [{ id: "video", type: "video-node", position: { x: 5000, y: 0 }, data: { ...data, src: "/replacement.mp4" } }] }));
    await flush();
    await act(async () => rejectPlay(new DOMException("Late autoplay rejection", "NotAllowedError")));
    expect(play).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it("does not carry a loaded source into a distant replacement or a different project", async () => {
    const view = render(<Scene x={0} />);
    await flush();
    const original = view.container.querySelector("video")!;
    ready(original);
    act(() => flowStore.setState({ transform: [10000, 0, 1] }));
    act(() => useCanvasStore.setState({ nodes: [{ id: "video", type: "video-node", position: { x: 5000, y: 0 }, data: { ...data, src: "/new.mp4" } }] }));
    await flush();
    expect(original).not.toHaveAttribute("src");
    view.rerender(<Scene project="second" />);
    await flush();
    expect(view.container.querySelector("video")).not.toBe(original);
    expect(view.container.querySelector("video")).not.toHaveAttribute("src");
  });

  it("schedules upload preview sources and registers the final player after the branch switches", async () => {
    act(() => useCanvasStore.setState({ nodes: [{ id: "video", type: "video-node", position: { x: 5000, y: 0 }, data: { ...data, upload: { uploading: true, previewUrl: "blob:upload", version: 1 } } }] }));
    const view = render(<StrictMode><Scene /></StrictMode>);
    await flush();
    expect(view.container.querySelector("video")).not.toHaveAttribute("src");
    act(() => flowStore.setState({ transform: [-5000, 0, 1] }));
    await flush();
    const preview = view.container.querySelector("video")!;
    expect(preview).toHaveAttribute("src", "blob:upload");
    act(() => useCanvasStore.setState({ nodes: [{ id: "video", type: "video-node", position: { x: 5000, y: 0 }, data: { ...data } }] }));
    await flush();
    expect(preview).not.toHaveAttribute("src", "blob:upload");
    const video = view.container.querySelector("video")!;
    expect(video).toHaveAttribute("src", data.src);
    let restore!: () => void;
    act(() => { restore = swapVideoSource("video", "/proxy.mp4"); });
    expect(video).toHaveAttribute("src", "/proxy.mp4");
    act(() => restore());
  });
});
