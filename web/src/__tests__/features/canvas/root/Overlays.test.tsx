/**
 * 画布浮层挂载条件（NodeOverlays / GlobalOverlays / CanvasOverlays）。
 *
 * 浮层编排只决定「挂载、可见与位置」：节点级面板跟随宿主 id，节点工具条按
 * 工具条模式与编辑态让位；画布级浮层按选区几何、待创建连线与拖拽状态门控。
 * 子面板全部替换为标记组件，本文件只断言挂载条件与 props 透传。
 */
// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import type { ComponentProps, ComponentType, ReactNode } from "react";
import { Suspense } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type CanvasContextMenu from "@/features/canvas/controls/CanvasContextMenu";
import type { CanvasPanels } from "@/features/canvas/hooks/use-canvas-panels";
import type { CanvasToolbarMode, SelectionFrame } from "@/features/canvas/shared/canvas-derived";
import type { AnyNode } from "@/features/canvas/types";
import { NODE_TYPE } from "@/lib/constants";

vi.mock("next/dynamic", async () => {
  const { lazy } = await import("react");
  return {
    default: (
      loader: () => Promise<{ default: ComponentType<Record<string, unknown>> }>,
    ) => lazy(loader),
  };
});

vi.mock("react-i18next", () => import("@/__tests__/test-utils/react-i18next-mock"));

vi.mock("@xyflow/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@xyflow/react")>();
  return {
    ...actual,
    NodeToolbar: ({ children }: { children?: ReactNode }) => <>{children}</>,
  };
});

vi.mock("@/features/canvas/panels/GenerationPanelHost", () => ({
  default: () => <div data-testid="gen-host" />,
}));
vi.mock("@/features/canvas/nodes/NodeToolbar", () => ({
  default: ({ nodeId }: { nodeId: string }) => <div data-testid={`toolbar-${nodeId}`} />,
}));
vi.mock("@/features/canvas/debug/NodeInspector", () => ({
  default: ({ open }: { open: boolean }) => (
    <div data-testid="inspector" data-open={String(open)} />
  ),
}));
vi.mock("@/features/canvas/editing/FrameStripPanel", () => ({
  default: ({ nodeId }: { nodeId: string }) => (
    <div data-testid="frame-panel" data-node-id={nodeId} />
  ),
}));
vi.mock("@/features/canvas/editing/ClipStripPanel", () => ({
  default: ({ nodeId }: { nodeId: string }) => (
    <div data-testid="clip-panel" data-node-id={nodeId} />
  ),
}));
vi.mock("@/features/canvas/editing/AudioClipStripPanel", () => ({
  default: ({ nodeId }: { nodeId: string }) => (
    <div data-testid="audio-clip-panel" data-node-id={nodeId} />
  ),
}));
vi.mock("@/features/canvas/editing/LightingPanel", () => ({
  default: ({ nodeId }: { nodeId: string }) => (
    <div data-testid="lighting-panel" data-node-id={nodeId} />
  ),
}));
vi.mock("@/features/canvas/editing/MultiAngleEditor", () => ({
  default: ({ nodeId }: { nodeId: string }) => (
    <div data-testid="angle-panel" data-node-id={nodeId} />
  ),
}));

vi.mock("@/features/canvas/controls/SelectionToolbar", () => ({
  SelectionToolbarLayer: () => <div data-testid="selection-toolbar" />,
}));
vi.mock("@/features/canvas/controls/BatchConnectHandle", () => ({
  default: () => <div data-testid="batch-handle" />,
}));
vi.mock("@/features/canvas/controls/PendingConnectionPreview", () => ({
  default: ({ from }: { from: { x: number; y: number } }) => (
    <div data-testid="pending-preview" data-x={from.x} />
  ),
}));
vi.mock("@/features/canvas/controls/CanvasContextMenu", () => ({
  default: () => <div data-testid="context-menu" />,
}));
vi.mock("@/features/canvas/controls/ConnectionCreateMenu", () => ({
  default: () => <div data-testid="create-menu" />,
}));

import type { BatchConnectHandlers } from "@/features/canvas/controls/BatchConnectContext";
import type { PendingConnectionCreate } from "@/features/canvas/controls/ConnectionCreateMenu";
import CanvasOverlays from "@/features/canvas/root/CanvasOverlays";
import { GlobalOverlays } from "@/features/canvas/root/overlays/GlobalOverlays";
import { NodeOverlays } from "@/features/canvas/root/overlays/NodeOverlays";

function node(id: string, type: string = NODE_TYPE.VIDEO): AnyNode {
  return {
    id,
    type,
    position: { x: 0, y: 0 },
    data: { label: id, src: "store/key.mp4" },
  } as AnyNode;
}

/** 编辑面板宿主在 CanvasPanels 里是窄化节点类型；测试只关心 id 与 src。 */
function videoNode(id: string) {
  return node(id) as unknown as NonNullable<CanvasPanels["frameStripNode"]>;
}
function imageNode(id: string) {
  return node(id, NODE_TYPE.IMAGE) as unknown as NonNullable<CanvasPanels["lightingNode"]>;
}
function audioNode(id: string) {
  return node(id, NODE_TYPE.AUDIO) as unknown as NonNullable<CanvasPanels["audioClipNode"]>;
}

function makePanels(overrides: Partial<CanvasPanels> = {}): CanvasPanels {
  return {
    editingNodeId: null,
    editingTextNodeId: null,
    generationPanelTarget: null,
    inspectedNodeId: null,
    inspectedNode: null,
    openInspector: vi.fn(),
    closeInspector: vi.fn(),
    gridMenuNodeId: null,
    handleGridMenuOpenChange: vi.fn(),
    toolbarDismissSignal: 0,
    resetTransientPanels: vi.fn(),
    isNodeInEditorUiState: () => false,
    frameStripNode: null,
    frameStripRef: "",
    closeFrameStripPanel: vi.fn(),
    clipStripNode: null,
    clipStripRef: "",
    closeClipStripPanel: vi.fn(),
    lightingNode: null,
    closeLightingPanel: vi.fn(),
    angleEditorNode: null,
    closeAngleEditorPanel: vi.fn(),
    audioClipNode: null,
    audioClipRef: "",
    closeAudioClipPanel: vi.fn(),
    ...overrides,
  };
}

const batchConnectHandlers: BatchConnectHandlers = {
  onConnect: vi.fn(),
  onConnectToBlank: vi.fn(),
  onDragStart: vi.fn(),
  onDragEnd: vi.fn(),
  screenToFlowPosition: (pos) => pos,
};

const contextMenuProps = {} as ComponentProps<typeof CanvasContextMenu>;

function makeGlobalProps(overrides: Partial<Parameters<typeof GlobalOverlays>[0]> = {}) {
  return {
    editingNodeId: null,
    editingTextNodeId: null,
    selectionKey: "",
    toolbarMode: { kind: "hidden" } as CanvasToolbarMode,
    selectionFrame: null,
    batchConnectAnchor: null,
    batchConnectHandlers,
    pendingConnectionCreate: null,
    pendingPreviewAnchors: [],
    onSelectConnectionNode: vi.fn(),
    onCloseConnectionCreate: vi.fn(),
    contextMenuProps,
    isFileDragging: false,
    ...overrides,
  } satisfies Parameters<typeof GlobalOverlays>[0];
}

function renderNodeOverlays(
  panels: CanvasPanels,
  options: {
    nodes?: AnyNode[];
    selectedNodeIds?: ReadonlySet<string>;
    toolbarMode?: CanvasToolbarMode;
  } = {},
) {
  return render(
    <Suspense fallback={null}>
      <NodeOverlays
        panels={panels}
        nodes={options.nodes ?? []}
        selectedNodeIds={options.selectedNodeIds ?? new Set()}
        toolbarMode={options.toolbarMode ?? { kind: "hidden" }}
      />
    </Suspense>,
  );
}

function renderGlobal(overrides: Partial<Parameters<typeof GlobalOverlays>[0]> = {}) {
  return render(<GlobalOverlays {...makeGlobalProps(overrides)} />);
}

/** CanvasOverlays 的全局 props 不包含编辑态与工具条模式（由 panels 提供） */
function makeCanvasGlobalProps(overrides: Partial<Parameters<typeof GlobalOverlays>[0]> = {}) {
  const {
    editingNodeId: _editingNodeId,
    editingTextNodeId: _editingTextNodeId,
    toolbarMode: _toolbarMode,
    ...rest
  } = makeGlobalProps(overrides);
  return rest;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("NodeOverlays 挂载条件", () => {
  it("无面板宿主：只有常驻生成面板宿主与关闭态检查器", () => {
    renderNodeOverlays(makePanels());

    expect(screen.getByTestId("gen-host")).toBeInTheDocument();
    expect(screen.getByTestId("inspector")).toHaveAttribute("data-open", "false");
    expect(screen.queryByTestId("frame-panel")).toBeNull();
    expect(screen.queryByTestId("clip-panel")).toBeNull();
    expect(screen.queryByTestId("audio-clip-panel")).toBeNull();
    expect(screen.queryByTestId("lighting-panel")).toBeNull();
    expect(screen.queryByTestId("angle-panel")).toBeNull();
  });

  it("各编辑面板只在宿主节点存在时挂载，并收到宿主 id", async () => {
    renderNodeOverlays(
      makePanels({
        frameStripNode: videoNode("v1"),
        frameStripRef: "store/key.mp4",
        clipStripNode: videoNode("v2"),
        clipStripRef: "store/key.mp4",
        audioClipNode: audioNode("a1"),
        audioClipRef: "store/key.m4a",
        lightingNode: imageNode("i1"),
        angleEditorNode: imageNode("i2"),
      }),
    );

    expect(await screen.findByTestId("frame-panel")).toHaveAttribute("data-node-id", "v1");
    expect(await screen.findByTestId("clip-panel")).toHaveAttribute("data-node-id", "v2");
    expect(await screen.findByTestId("audio-clip-panel")).toHaveAttribute("data-node-id", "a1");
    expect(await screen.findByTestId("lighting-panel")).toHaveAttribute("data-node-id", "i1");
    expect(await screen.findByTestId("angle-panel")).toHaveAttribute("data-node-id", "i2");
  });

  it("per-node 工具条只渲染选中且不在编辑态的节点", () => {
    renderNodeOverlays(
      makePanels({ isNodeInEditorUiState: (id) => id === "b" }),
      {
        nodes: [node("a"), node("b")],
        selectedNodeIds: new Set(["a", "b"]),
        toolbarMode: { kind: "per-node" },
      },
    );

    expect(screen.getByTestId("toolbar-a")).toBeInTheDocument();
    expect(screen.queryByTestId("toolbar-b")).toBeNull();
  });

  it("hidden / aggregate 模式不渲染任何节点工具条", () => {
    const nodes = [node("a")];
    const selectedNodeIds = new Set(["a"]);
    const { rerender } = renderNodeOverlays(makePanels(), {
      nodes,
      selectedNodeIds,
      toolbarMode: { kind: "hidden" },
    });
    expect(screen.queryByTestId("toolbar-a")).toBeNull();

    rerender(
      <Suspense fallback={null}>
        <NodeOverlays
          panels={makePanels()}
          nodes={nodes}
          selectedNodeIds={selectedNodeIds}
          toolbarMode={{ kind: "aggregate", bounds: {} as never }}
        />
      </Suspense>,
    );
    expect(screen.queryByTestId("toolbar-a")).toBeNull();
  });

  it("检查器随 inspectedNodeId 打开并收到节点", () => {
    const inspected = node("n1");
    renderNodeOverlays(makePanels({ inspectedNodeId: "n1", inspectedNode: inspected }));

    expect(screen.getByTestId("inspector")).toHaveAttribute("data-open", "true");
  });
});

describe("GlobalOverlays 挂载条件", () => {
  it("聚合工具条只在 aggregate 模式且无编辑态时渲染", () => {
    const aggregate = { kind: "aggregate", bounds: {} as never } as CanvasToolbarMode;
    const { rerender } = renderGlobal({ toolbarMode: aggregate });
    expect(screen.getByTestId("selection-toolbar")).toBeInTheDocument();

    rerender(<GlobalOverlays {...makeGlobalProps({ toolbarMode: aggregate, editingNodeId: "n1" })} />);
    expect(screen.queryByTestId("selection-toolbar")).toBeNull();

    rerender(
      <GlobalOverlays
        {...makeGlobalProps({ toolbarMode: aggregate, editingTextNodeId: "n2" })}
      />,
    );
    expect(screen.queryByTestId("selection-toolbar")).toBeNull();

    rerender(<GlobalOverlays {...makeGlobalProps({ toolbarMode: { kind: "per-node" } })} />);
    expect(screen.queryByTestId("selection-toolbar")).toBeNull();
  });

  it("批量连线轨道只在选区外框与锚点同时存在时渲染", () => {
    const frame: SelectionFrame = {
      ids: ["a", "b"],
      bbox: { x: 0, y: 0, width: 200, height: 100 },
    };
    const { rerender } = renderGlobal({
      selectionFrame: frame,
      batchConnectAnchor: { x: 200, y: 50 },
    });
    expect(screen.getByTestId("batch-handle")).toBeInTheDocument();

    rerender(<GlobalOverlays {...makeGlobalProps({ selectionFrame: frame })} />);
    expect(screen.queryByTestId("batch-handle")).toBeNull();
  });

  it("待创建连线：每个锚点一根预览线，同时出现创建菜单", () => {
    const pending: PendingConnectionCreate = {
      sourceNodeIds: ["a", "b"],
      sourceNodeTypes: [NODE_TYPE.TEXT, NODE_TYPE.TEXT],
      direction: "output",
      canvasPosition: { x: 300, y: 200 },
      screenPosition: { x: 300, y: 200 },
    };
    const { rerender } = renderGlobal({
      pendingConnectionCreate: pending,
      pendingPreviewAnchors: [{ x: 100, y: 50 }, { x: 300, y: 50 }],
    });

    expect(screen.getAllByTestId("pending-preview")).toHaveLength(2);
    expect(screen.getByTestId("create-menu")).toBeInTheDocument();

    rerender(<GlobalOverlays {...makeGlobalProps({ pendingPreviewAnchors: [] })} />);
    expect(screen.queryByTestId("pending-preview")).toBeNull();
    expect(screen.queryByTestId("create-menu")).toBeNull();
  });

  it("右键菜单常驻；文件拖拽遮罩只在拖入时出现", () => {
    const { rerender } = renderGlobal();
    expect(screen.getByTestId("context-menu")).toBeInTheDocument();
    expect(screen.queryByText("file.dropToAdd")).toBeNull();

    rerender(<GlobalOverlays {...makeGlobalProps({ isFileDragging: true })} />);
    expect(screen.getByText("file.dropToAdd")).toBeInTheDocument();
  });
});

describe("CanvasOverlays 编排", () => {
  it("节点级与画布级浮层共享同一份状态投影", () => {
    const panels = makePanels({
      frameStripNode: videoNode("v1"),
      frameStripRef: "store/key.mp4",
    });
    render(
      <Suspense fallback={null}>
        <CanvasOverlays
          panels={panels}
          nodes={[node("a")]}
          selectedNodeIds={new Set(["a"])}
          toolbarMode={{ kind: "per-node" }}
          {...makeCanvasGlobalProps()}
        />
      </Suspense>,
    );

    expect(screen.getByTestId("toolbar-a")).toBeInTheDocument();
    expect(screen.getByTestId("context-menu")).toBeInTheDocument();
  });

  it("编辑态从 panels 传入画布级浮层：聚合工具条让位", () => {
    render(
      <Suspense fallback={null}>
        <CanvasOverlays
          panels={makePanels({ editingNodeId: "n1" })}
          nodes={[]}
          selectedNodeIds={new Set()}
          toolbarMode={{ kind: "aggregate", bounds: {} as never }}
          {...makeCanvasGlobalProps()}
        />
      </Suspense>,
    );

    expect(screen.queryByTestId("selection-toolbar")).toBeNull();
  });
});
