// @vitest-environment jsdom
/**
 * 音频节点编辑动作的持久化契约回归测试。
 *
 * 缺陷背景：音频截取 / 变速的编辑响应同时携带 key 与 url，节点曾把展示 URL
 * （`/api/files/...`）写入派生节点的 data.src。持久化值域必须是存储 key——
 * 引用账本只识别 key，且该 URL 作为生成参考会被服务端 file-ref 校验拒绝。
 * 客户端管线与服务端兜底两条路径都必须只消费 key。
 */
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { flushMicrotasks, nodeViewProps } from "@/__tests__/test-utils/canvas-node";
import { editResultResponse, makeStorageKey } from "@/__tests__/test-utils/storage-fixtures";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ClientUnsupportedError } from "@/features/canvas/editing/client-media/client-video";
import AudioNode from "@/features/canvas/nodes/AudioNode";
import { useCanvasStore } from "@/features/canvas/stores/canvas-store";
import type { AudioNodeData } from "@/features/canvas/types";
import { saveManager } from "@/features/project/save-manager";
import { EventNames } from "@/lib/constants";

const {
  createAudioNodeFromRef, extractAudioClip, serverExtractAudioClip,
  applyAudioSpeed, serverApplyAudioSpeed,
} = vi.hoisted(() => ({
  createAudioNodeFromRef: vi.fn(),
  extractAudioClip: vi.fn(),
  serverExtractAudioClip: vi.fn(),
  applyAudioSpeed: vi.fn(),
  serverApplyAudioSpeed: vi.fn(),
}));

vi.mock("next/dynamic", () => ({ default: () => () => null }));
vi.mock("react-i18next", async (original) => ({
  ...await original<typeof import("react-i18next")>(),
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/components/ui/use-app-feedback", () => ({
  useAppFeedback: () => ({ notification: { error: vi.fn(), warning: vi.fn() } }),
}));
vi.mock("@/features/canvas/upload", () => ({
  useNodeUpload: () => vi.fn(),
  createAudioNodeFromRef,
}));
vi.mock("@/features/canvas/editing/client-media/client-video", async (original) => ({
  ...await original<typeof import("@/features/canvas/editing/client-media/client-video")>(),
  tryExtractAudioClipOnClient: extractAudioClip,
  tryApplyAudioSpeedOnClient: applyAudioSpeed,
}));
vi.mock("@/features/canvas/api/file-api", async (original) => ({
  ...await original<typeof import("@/features/canvas/api/file-api")>(),
  extractAudioClip: serverExtractAudioClip,
  applyAudioSpeed: serverApplyAudioSpeed,
}));
vi.mock("@/features/canvas/nodes/NodeTitle", () => ({ default: () => null }));
vi.mock("@/features/canvas/nodes/BusyOverlay", () => ({ default: () => null }));
vi.mock("@/features/canvas/controls/ConnectionSideRail", () => ({ default: () => null }));

/** 源节点引用值：存储 key（持久化值域） */
const SOURCE_KEY = makeStorageKey("a", ".mp3");
/** 客户端管线产物 */
const CLIENT_KEY = makeStorageKey("b", ".mp3");
/** 服务端兜底产物 */
const SERVER_KEY = makeStorageKey("c", ".mp3");
/** 变速客户端管线产物 */
const CLIENT_SPEED_KEY = makeStorageKey("d", ".m4a");
/** 变速服务端兜底产物 */
const SPEED_KEY = makeStorageKey("e", ".m4a");
const data: AudioNodeData = { label: "audio", src: SOURCE_KEY, duration: 12 };

function NodeView() {
  const nodeData = useCanvasStore((state) => state.nodes[0].data) as AudioNodeData;
  return <AudioNode {...nodeViewProps<typeof AudioNode>("audio", "audio-node", nodeData)} />;
}

/** 挂载节点并冲掉首帧渲染链上的微任务 */
async function openNode(): Promise<void> {
  render(<TooltipProvider><NodeView /></TooltipProvider>);
  await flushMicrotasks();
}

function dispatchClip(): void {
  act(() => window.dispatchEvent(new CustomEvent(EventNames.CANVAS_NODE_ACTION, {
    detail: { nodeId: "audio", action: "extract-audio-clip", start: 0, end: 11 },
  })));
}

function dispatchSpeed(speed: number): void {
  act(() => window.dispatchEvent(new CustomEvent(EventNames.CANVAS_NODE_ACTION, {
    detail: { nodeId: "audio", action: "apply-audio-speed", speed },
  })));
}

beforeEach(() => {
  useCanvasStore.setState({
    ...useCanvasStore.getInitialState(),
    nodes: [{ id: "audio", type: "audio-node", position: { x: 0, y: 0 }, data: { ...data } }],
  });
  extractAudioClip.mockResolvedValue({ url: `/api/files/${CLIENT_KEY}`, key: CLIENT_KEY });
});
afterEach(() => {
  cleanup();
  saveManager.resetForProjectSwitch();
  useCanvasStore.setState(useCanvasStore.getInitialState(), true);
  // reset 而非 clear：清掉未消费的 Once 队列与实现，避免跨用例泄漏
  vi.resetAllMocks();
});

describe("AudioNode 编辑产物", () => {
  it("音频截取（客户端管线）派生节点写入存储 key，不写展示 URL", async () => {
    await openNode();
    dispatchClip();
    await flushMicrotasks();
    expect(extractAudioClip).toHaveBeenCalledWith(SOURCE_KEY, { start: 0, end: 11 }, expect.anything());
    expect(createAudioNodeFromRef).toHaveBeenCalledWith(
      "audio",
      CLIENT_KEY,
      expect.any(String),
      expect.anything(),
      { source: "derived" },
    );
  });

  it("音频截取（服务端兜底）派生节点写入存储 key，不写展示 URL", async () => {
    extractAudioClip.mockRejectedValueOnce(new ClientUnsupportedError("unsupported"));
    serverExtractAudioClip.mockResolvedValueOnce(editResultResponse(SERVER_KEY));
    await openNode();
    dispatchClip();
    await flushMicrotasks();
    expect(serverExtractAudioClip).toHaveBeenCalledWith(SOURCE_KEY, 0, 11, expect.any(AbortSignal));
    expect(createAudioNodeFromRef).toHaveBeenCalledWith(
      "audio",
      SERVER_KEY,
      expect.any(String),
      expect.anything(),
      { source: "derived" },
    );
  });

  it("音频变速（客户端管线）派生节点写入存储 key，不写展示 URL", async () => {
    applyAudioSpeed.mockResolvedValueOnce({
      url: `/api/files/${CLIENT_SPEED_KEY}`,
      key: CLIENT_SPEED_KEY,
    });
    await openNode();
    dispatchSpeed(1.5);
    await flushMicrotasks();
    expect(applyAudioSpeed).toHaveBeenCalledWith(SOURCE_KEY, 1.5, expect.anything());
    expect(serverApplyAudioSpeed).not.toHaveBeenCalled();
    expect(createAudioNodeFromRef).toHaveBeenCalledWith(
      "audio",
      CLIENT_SPEED_KEY,
      expect.any(String),
      expect.anything(),
      { source: "derived" },
    );
  });

  it("音频变速（服务端兜底）派生节点写入存储 key，不写展示 URL", async () => {
    applyAudioSpeed.mockRejectedValueOnce(new ClientUnsupportedError("unsupported"));
    serverApplyAudioSpeed.mockResolvedValueOnce(editResultResponse(SPEED_KEY));
    await openNode();
    dispatchSpeed(1.5);
    await flushMicrotasks();
    expect(serverApplyAudioSpeed).toHaveBeenCalledWith(SOURCE_KEY, 1.5, expect.any(AbortSignal));
    expect(createAudioNodeFromRef).toHaveBeenCalledWith(
      "audio",
      SPEED_KEY,
      expect.any(String),
      expect.anything(),
      { source: "derived" },
    );
  });
});
