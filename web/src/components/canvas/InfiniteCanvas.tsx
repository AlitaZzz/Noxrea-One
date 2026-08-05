"use client";

import "@xyflow/react/dist/style.css";

import {
  applyEdgeChanges,
  applyNodeChanges,
  Background,
  BackgroundVariant,
  type Connection,
  type Edge,
  type EdgeChange,
  MarkerType,
  MiniMap,
  type NodeChange,
  NodeToolbar as RfNodeToolbar,
  Panel,
  Position,
  ReactFlow,
  SelectionMode,
  useReactFlow,
} from "@xyflow/react";
import { App,Popover, Tooltip } from "antd";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo,useState } from "react";

import AlignmentGuides from "@/components/canvas/AlignmentGuides";
import AssetsModal from "@/components/assets/AssetsModal";
import CanvasContextMenu from "@/components/canvas/CanvasContextMenu";
import CanvasControls from "@/components/canvas/CanvasControls";
import CanvasSidebar, { DRAWER_WIDTH } from "@/components/canvas/CanvasSidebar";
import ChatPanel from "@/components/canvas/ChatPanel";
import CenterToolbar from "@/components/canvas/CenterToolbar";
import { AgentIcon } from "@/components/common/icons/canvas/AgentIcon";
import DeletableEdge from "@/components/canvas/EdgeDeleteButton";
import ImageGenerationPanel from "@/components/canvas/ImageGenerationPanel";
import ApiSettingsDrawer from "@/components/canvas/ApiSettingsDrawer";
import NodeInspector from "@/components/canvas/NodeInspector";
import VideoGenerationPanel from "@/components/canvas/VideoGenerationPanel";
import type { AlignmentGuide } from "@/hooks/use-alignment-guides";
import { computeAlignment } from "@/hooks/use-alignment-guides";
import DirectorNode from "@/components/canvas/nodes/DirectorNode";
import GroupNode from "@/components/canvas/nodes/GroupNode";
import ImageNode from "@/components/canvas/nodes/ImageNode";
import NodeToolbarUI from "@/components/canvas/nodes/NodeToolbar";
import TextNode from "@/components/canvas/nodes/TextNode";
import VideoNode from "@/components/canvas/nodes/VideoNode";
import AudioNode from "@/components/canvas/nodes/AudioNode";
import TextGenerationPanel from "@/components/canvas/TextGenerationPanel";
import ConfirmModal from "@/components/common/ConfirmModal";
import { MenuDivider, MenuItem, MenuPopover } from "@/components/common/MenuPopover";
import { ChevronDownIcon } from "@/components/common/icons/ChevronDownIcon";
import { useAddNode } from "@/hooks/use-add-node";
import { useCanvasEvents } from "@/hooks/use-canvas-events";
import { useFileDrop } from "@/hooks/use-file-drop";
import { useGroupOperations } from "@/hooks/use-group-operations";
import { useSseTaskMonitor } from "@/hooks/use-sse-task-monitor";
import { EdgeHighlightContext } from "@/lib/edge-highlight-context";
import { createEdge } from "@/lib/node-defaults";
import { type AnyNode,NODE_TYPE } from "@/lib/types";
import { NODE_TYPE_COLOR } from "@/lib/node-colors";
import { useAssetsStore } from "@/stores/assets-store";
import { useAuthStore } from "@/stores/auth-store";
import { flushAndWait, flushOnUnload,getViewportCenter, markDirty, markDirtyImmediate, syncLiveViewport, takeCanvasSnapshot, useCanvasStore } from "@/stores/canvas-store";
import { useHistoryStore } from "@/stores/history-store";
import { useI18nStore } from "@/stores/i18n-store";
import { useModelStore } from "@/stores/model-store";
import { useProjectStore } from "@/stores/project-store";
import { useSelectionStore } from "@/stores/selection-store";

export default function InfiniteCanvas() {
  const router = useRouter();
  const { screenToFlowPosition, fitView, setViewport: setRfViewport } = useReactFlow();
  const { notification: notif } = App.useApp();
  useSseTaskMonitor(notif);

  // Canvas state
  const nodes = useCanvasStore((s) => s.nodes);
  const edges = useCanvasStore((s) => s.edges);
  const setNodes = useCanvasStore((s) => s.setNodes);
  const setEdges = useCanvasStore((s) => s.setEdges);
  const addNodes = useCanvasStore((s) => s.addNodes);
  const updateNodeData = useCanvasStore((s) => s.updateNodeData);
  const removeNodes = useCanvasStore((s) => s.removeNodes);
  const removeEdges = useCanvasStore((s) => s.removeEdges);
  const background = useCanvasStore((s) => s.background);
  const theme = useCanvasStore((s) => s.theme);
  const minimapVisible = useCanvasStore((s) => s.minimapVisible);
  const snapToGrid = useCanvasStore((s) => s.snapToGrid);
  const snapGridSize = useCanvasStore((s) => s.snapGridSize);
  const snapThreshold = useCanvasStore((s) => s.snapThreshold);
  const annotatingNodeId = useCanvasStore((s) => s.annotatingNodeId);
  const croppingNodeId = useCanvasStore((s) => s.croppingNodeId);

  // Selection — computed from node.selected (React Flow's source of truth)
  const selectedNodeIds = useMemo(
    () => new Set(nodes.filter((n) => n.selected).map((n) => n.id)),
    [nodes]
  );

  // 冻结 defaultViewport 引用——React Flow 仅在首次挂载时读取此值，
  // 后续 viewport 变更走 store + setRfViewport，绝不能让此 prop 随渲染更新，
  // 否则会触发 onViewportChange -> setViewport -> 重渲染 -> defaultViewport 变 -> ∞
  const defaultViewport = useMemo(() => useCanvasStore.getState().viewport, []);

  // Edges connected to any selected node → trigger multi-dot flow animation
  const highlightedEdgeIds = useMemo(
    () => new Set(edges.filter((e) => selectedNodeIds.has(e.source) || selectedNodeIds.has(e.target)).map((e) => e.id)),
    [edges, selectedNodeIds]
  );

  // Clipboard for copy/paste
  const copySelected = useSelectionStore((s) => s.copySelected);

  // History
  const pushHistory = useHistoryStore((s) => s.push);

  // Initialize stores
  useEffect(() => { useModelStore.getState().initialize(); useAssetsStore.getState().initialize(); }, []);

  // When switching projects, load the new project's canvas
  const activeProjectId = useProjectStore((s) => s.activeProjectId);
  const projectName = useProjectStore((s) => s.activeProject()?.name || "");
  const authUser = useAuthStore((s) => s.user);
  const t = useI18nStore((s) => s.t);

  const [editName, setEditName] = useState(projectName);
  const [prevProjectName, setPrevProjectName] = useState(projectName);
  if (projectName !== prevProjectName) {
    setPrevProjectName(projectName);
    setEditName(projectName);
  }
  useEffect(() => {
    const project = useProjectStore.getState().activeProject();
    if (project) {
      useCanvasStore.getState().restoreFromProject(project);
      // defaultViewport 仅首次挂载生效，切换项目需手动同步 React Flow 内部 viewport
      const vp = useCanvasStore.getState().viewport;
      setRfViewport(vp, { duration: 0 });
      // 切换/加载项目 = 历史归零。修复 undo 弹出即应用后不再需要基线快照
      // （旧基线是为了规避 undo 偏移下的 emptySnapshot 兜底），同时避免
      // 撤销穿透到上一个项目的画布内容。
      useHistoryStore.getState().clear();
    }
  }, [activeProjectId, setRfViewport]);

  // Check if a single image node is selected
  const genTargetId = useMemo(() => {
    const sel = nodes.filter((n) => n.selected);
    if (sel.length !== 1) return null;
    if (sel[0].type !== NODE_TYPE.IMAGE) return null;
    return sel[0].id;
  }, [nodes]);

  // Check if a single video node is selected
  const genTargetVideoId = useMemo(() => {
    const sel = nodes.filter((n) => n.selected);
    if (sel.length !== 1) return null;
    if (sel[0].type !== NODE_TYPE.VIDEO) return null;
    return sel[0].id;
  }, [nodes]);

  // Check if a single TextNode is selected
  const textTarget = useMemo(() => {
    const sel = nodes.filter((n) => n.selected);
    if (sel.length !== 1) return null;
    if (sel[0].type !== NODE_TYPE.TEXT) return null;
    return { id: sel[0].id };
  }, [nodes]);

  // Inspector state
  const [inspectedNodeId, setInspectedNodeId] = useState<string | null>(null);
  const [toolbarMenuOpen, setToolbarMenuOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [logoutConfirmOpen, setLogoutConfirmOpen] = useState(false);
  const [assetsOpen, setAssetsOpen] = useState(false);
  const [canvasSidebarOpen, setCanvasSidebarOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [alignmentGuides, setAlignmentGuides] = useState<AlignmentGuide[]>([]);
  const inspectedNode = nodes.find((n) => n.id === inspectedNodeId) || null;

  // ---- Change handlers ----

  const handleNodesChange = useCallback(
    (changes: NodeChange[]) => {
      const applied = applyNodeChanges(changes, useCanvasStore.getState().nodes) as AnyNode[];
      let appliedNodes: AnyNode[];
      let newGuides: AlignmentGuide[] = [];

      if (snapToGrid) {
        // 检查是否有节点正在被拖拽
        const positionChanges = changes.filter(
          (c) => c.type === "position" && (c as unknown as { dragging?: boolean }).dragging,
        );
        const draggedNodeIds = new Set(positionChanges.map((c) => (c as { id: string }).id));

        appliedNodes = applied.map((n) => {
          let posX = n.position.x;
          let posY = n.position.y;

          // 对于拖拽中的节点，先尝试节点间对齐吸附
          if (draggedNodeIds.has(n.id) && draggedNodeIds.size <= 3) {
            const nodeSize = {
              width: Number(n.style?.width) || Number(n.measured?.width) || 200,
              height: Number(n.style?.height) || Number(n.measured?.height) || 120,
            };
            const nodeBounds = applied.map((m) => ({
              id: m.id,
              position: { x: m.position.x, y: m.position.y },
              width: Number(m.style?.width) || Number(m.measured?.width) || 200,
              height: Number(m.style?.height) || Number(m.measured?.height) || 120,
            }));

            const result = computeAlignment(
              { id: n.id, position: { x: posX, y: posY }, ...nodeSize },
              nodeBounds,
              snapThreshold,
            );

            if (result.snapX !== null) {
              posX = result.snapX;
            } else {
              posX = Math.round(posX / snapGridSize) * snapGridSize;
            }

            if (result.snapY !== null) {
              posY = result.snapY;
            } else {
              posY = Math.round(posY / snapGridSize) * snapGridSize;
            }

            newGuides = result.guides;
          } else {
            // 非拖拽变更：仅网格吸附
            posX = Math.round(posX / snapGridSize) * snapGridSize;
            posY = Math.round(posY / snapGridSize) * snapGridSize;
          }

          return {
            ...n,
            position: { x: posX, y: posY },
          };
        });
      } else {
        appliedNodes = applied;
      }

      setNodes(appliedNodes);
      setAlignmentGuides(newGuides);

      // Only mark dirty for position changes (user drag).
      // Exclude select (pure UI) and dimensions (React Flow internal DOM measurement).
      if (changes.some((c) => c.type === "position")) {
        markDirty();
      }
    },
    [setNodes, snapToGrid, snapGridSize, snapThreshold],
  );

  const handleEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      setEdges(applyEdgeChanges(changes, useCanvasStore.getState().edges));
    },
    [setEdges]
  );

  const handleConnect = useCallback(
    (connection: Connection) => {
      setEdges([...useCanvasStore.getState().edges, createEdge(connection.source || "", connection.target || "")]);
      markDirtyImmediate();
    },
    [setEdges]
  );

  // IMAGE / TEXT 节点的上游仅接受 TEXT / IMAGE 类型
  const isValidConnection = useCallback(
    (connection: Connection | Edge) => {
      const srcId = connection.source;
      const tgtId = connection.target;
      if (!srcId || !tgtId) return true;
      const allNodes = useCanvasStore.getState().nodes;
      const sourceNode = allNodes.find((n) => n.id === srcId);
      const targetNode = allNodes.find((n) => n.id === tgtId);
      if (!sourceNode || !targetNode) return true;
      if (targetNode.type === NODE_TYPE.IMAGE || targetNode.type === NODE_TYPE.TEXT) {
        return sourceNode.type === NODE_TYPE.TEXT || sourceNode.type === NODE_TYPE.IMAGE;
      }
      return true;
    },
    []
  );

  const handleViewportChange = useCallback(
    (vp: { x: number; y: number; zoom: number }) => {
      syncLiveViewport({ x: vp.x, y: vp.y, zoom: vp.zoom });
    },
    []
  );

  const handleNodeDragStart = useCallback(() => {
    pushHistory(takeCanvasSnapshot());
  }, [pushHistory]);

  const handleNodeDragStop = useCallback(() => {
    // 只在拖拽开始时压栈（改动前压栈约定）。此前这里的第二次 pushHistory
    // 是为了掩盖 undo() 的偏移，修复后必须移除，否则会产生一次"空撤销"。
    markDirtyImmediate();
    setAlignmentGuides([]);
  }, []);

  const handlePaneClick = useCallback(() => {
    // Exit annotation and crop mode when clicking the canvas pane
    useCanvasStore.getState().setAnnotatingNodeId(null);
    useCanvasStore.getState().setCroppingNodeId(null);
    // Deselect all nodes and edges
    setNodes(useCanvasStore.getState().nodes.map((n) => ({ ...n, selected: false })));
    setEdges(useCanvasStore.getState().edges.map((e) => ({ ...e, selected: false })), { skipHistory: true });
  }, [setNodes, setEdges]);

  // Explicitly handle node selection — React Flow's internal click detection
  // may miss clicks that land on interactive child elements (inputs, selects, etc.)
  const handleNodeClick = useCallback(
    (_event: React.MouseEvent, node: Record<string, unknown>) => {
      const nodeId = node.id as string;
      // Exit annotation and crop mode when clicking a different node
      const currentAnnotating = useCanvasStore.getState().annotatingNodeId;
      if (currentAnnotating && currentAnnotating !== nodeId) {
        useCanvasStore.getState().setAnnotatingNodeId(null);
      }
      const currentCropping = useCanvasStore.getState().croppingNodeId;
      if (currentCropping && currentCropping !== nodeId) {
        useCanvasStore.getState().setCroppingNodeId(null);
      }
      setNodes(
        useCanvasStore.getState().nodes.map((n) => ({
          ...n,
          selected: n.id === nodeId,
        }))
      );
    },
    [setNodes]
  );

  useGroupOperations();
  useCanvasEvents();
  const { addNode: addNodeAtCenter } = useAddNode();
  const handleAddText = useCallback(() => addNodeAtCenter("text"), [addNodeAtCenter]);
  const handleAddImage = useCallback(() => addNodeAtCenter("image"), [addNodeAtCenter]);
  const handleAddVideo = useCallback(() => addNodeAtCenter("video"), [addNodeAtCenter]);
  const handleAddAudio = useCallback(() => addNodeAtCenter("audio"), [addNodeAtCenter]);
  const handleAddDirector = useCallback(() => addNodeAtCenter("director"), [addNodeAtCenter]);

  const handleResetView = useCallback(() => {
    const s = useCanvasStore.getState();
    s.resetViewport();
    fitView({ duration: 300 });
  }, []);

  // ---- File drop on canvas → create image node ----

  const shouldIgnoreFileDrop = useCallback((target: HTMLElement) => {
    return target.closest('.asset-library-modal') !== null;
  }, []);

  const { handleDragOver, handleDrop } = useFileDrop(screenToFlowPosition, notif, shouldIgnoreFileDrop);

  // ---- Highlight selected node's connections ----

  const highlightedEdges = useMemo(
    () =>
      edges.map((e) => ({
        ...e,
        style: {
          ...e.style,
          stroke:
            selectedNodeIds.has(e.source) || selectedNodeIds.has(e.target)
              ? "#1D9E75"
              : (e.style?.stroke as string) || (theme === "dark" ? "#666" : "#999"),
          strokeWidth:
            selectedNodeIds.has(e.source) || selectedNodeIds.has(e.target) ? 3 : 2,
        },
      })),
    [edges, selectedNodeIds, theme]
  );

  // ---- Component unmount: browser back, route change → save current state ----
  useEffect(() => {
    return () => { flushOnUnload(); };
  }, []);

  // Memoize nodeTypes/edgeTypes to avoid stale references (React Flow #002 warning)
  const rfNodeTypes = useMemo(() => ({
    [NODE_TYPE.TEXT]: TextNode,
    [NODE_TYPE.IMAGE]: ImageNode,
    [NODE_TYPE.VIDEO]: VideoNode,
    [NODE_TYPE.AUDIO]: AudioNode,
    [NODE_TYPE.GROUP]: GroupNode,
    [NODE_TYPE.DIRECTOR]: DirectorNode,
  }), []);

  const rfEdgeTypes = useMemo(() => ({
    deletable: DeletableEdge,
  }), []);

  return (
    <div
      style={{ width: "100%", height: "100%", position: "relative", overflow: "hidden" }}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      <AlignmentGuides guides={alignmentGuides} />
      <EdgeHighlightContext.Provider value={highlightedEdgeIds}>
      <ReactFlow
        nodes={nodes}
        edges={highlightedEdges}
        nodeTypes={rfNodeTypes}
        edgeTypes={rfEdgeTypes}
        onNodesChange={handleNodesChange}
        onEdgesChange={handleEdgesChange}
        onConnect={handleConnect}
        isValidConnection={isValidConnection}
        onViewportChange={handleViewportChange}
        onNodeDragStart={handleNodeDragStart}
        onNodeDragStop={handleNodeDragStop}
        onPaneClick={handlePaneClick}
        onNodeClick={handleNodeClick}
        defaultViewport={defaultViewport}
        selectionMode={SelectionMode.Partial}
        nodeDragThreshold={2}
        nodeClickDistance={3}
        multiSelectionKeyCode="Shift"
        deleteKeyCode={[]}
        fitView={false}
        panOnDrag={[0, 1]}
        panOnScroll={false}
        zoomOnScroll={true}
        zoomOnPinch={true}
        zoomOnDoubleClick={false}
        minZoom={0.1}
        maxZoom={5}
        proOptions={{ hideAttribution: true }}
        colorMode={theme}
        connectionLineStyle={{ stroke: "#1677ff", strokeWidth: 2 }}
        defaultEdgeOptions={{
          type: "deletable",
          animated: false,
          style: { stroke: "#666", strokeWidth: 2 },
          markerEnd: { type: MarkerType.ArrowClosed, color: "#666" },
        }}
      >
        <Background
          variant={
            background === "dots"
              ? BackgroundVariant.Dots
              : background === "grid"
                ? BackgroundVariant.Lines
                : undefined
          }
          gap={background === "grid" ? 40 : 20}
          size={background === "dots" ? 1.5 : 0.5}
          color={"var(--canvas-border-light)"}
          style={background === "blank" ? { display: "none" } : undefined}
        />

        {/* Top-left panel: quick toolbar */}
        <Panel position="top-left" style={{ margin: 0, padding: 0, marginLeft: canvasSidebarOpen ? DRAWER_WIDTH : 0, transition: "margin-left 0.2s ease" }}>
          <div style={{ paddingLeft: 30, paddingTop: 30 }}>
            <div
              className="flex h-8 shrink-0 items-center gap-1 rounded-lg px-2 transition-colors w-[280px]"
              style={{ background: "var(--canvas-bg)", border: "1px solid var(--canvas-border)" }}
            >
              <MenuPopover
                open={toolbarMenuOpen}
                onOpenChange={setToolbarMenuOpen}
                trigger={
                  <div className="flex shrink-0 cursor-pointer items-center gap-1 hover:bg-white/10 rounded px-0.5 py-0.5 transition-colors">
                    <img src="/favicon.ico" alt="Noxrea" style={{ width: 24, height: 24 }} />
                    <ChevronDownIcon
                      className="shrink-0 transition-transform duration-200"
                      style={{ color: "var(--canvas-text-dim)", width: 10, height: 10, transform: toolbarMenuOpen ? "rotate(180deg)" : "none" }}
                    />
                  </div>
                }
                placement="bottomLeft"
                content={
                  <>
                    <div className="flex items-center gap-2 px-1 py-1.5">
                      <div className="w-9 h-9 rounded-full flex items-center justify-center text-sm font-bold flex-shrink-0 overflow-hidden"
                        style={{ background: "#1677ff", color: "#fff" }}>
                        {authUser?.avatarUrl ? (
                          <img src={authUser.avatarUrl} alt="" className="w-full h-full object-cover" />
                        ) : (
                          (authUser?.username || "G")[0].toUpperCase()
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium truncate" style={{ color: "var(--canvas-text)" }}>
                          {authUser?.username || "Guest"}
                        </div>
                      </div>
                    </div>
                    <MenuDivider />
                    <MenuItem onClick={async () => { setToolbarMenuOpen(false); await flushAndWait(); router.push("/project"); }}>{t("home")}</MenuItem>
                    <MenuDivider />
                    <MenuItem onClick={async () => {
                        setToolbarMenuOpen(false);
                        await flushAndWait();
                        const proj = await useProjectStore.getState().createProject();
                        useProjectStore.getState().setActiveProject(proj.id);
                        useCanvasStore.getState().restoreFromProject(proj);
                        setTimeout(() => fitView({ duration: 300 }), 50);
                      }}>{t("new.project")}</MenuItem>
                    <MenuItem onClick={() => { setToolbarMenuOpen(false); setDeleteConfirmOpen(true); }}>{t("delete.project")}</MenuItem>
                    <MenuDivider />
                    <MenuItem dimmed onClick={() => {
                        setToolbarMenuOpen(false);
                        setLogoutConfirmOpen(true);
                      }}>{t("logout")}</MenuItem>
                  </>
                }
              />
              <div className="w-px h-5 mx-0.5" style={{ background: "var(--canvas-border)" }} />
              <input
                className="bg-transparent text-sm outline-none border-none flex-1 min-w-0 cursor-default"
                style={{ color: "var(--canvas-text)", height: 24 }}
                placeholder="Untitled"
                readOnly
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                onDoubleClick={(e) => {
                  const t = e.target as HTMLInputElement;
                  t.removeAttribute("readOnly");
                  t.focus();
                  t.setSelectionRange(t.value.length, t.value.length);
                }}
                onBlur={(e) => {
                  const t = e.target as HTMLInputElement;
                  t.setAttribute("readOnly", "true");
                  const activeId = useProjectStore.getState().activeProjectId;
                  if (activeId && t.value.trim()) {
                    useProjectStore.getState().renameProject(activeId, t.value.trim());
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                }}
              />
            </div>

          </div>
        </Panel>

        {/* Bottom-left panel: minimap + controls */}
        <Panel position="bottom-left" style={{ margin: 0, padding: 0, marginLeft: canvasSidebarOpen ? DRAWER_WIDTH : 0, transition: "margin-left 0.2s ease" }}>
          <div className="flex flex-col gap-2" style={{ paddingLeft: 30, paddingBottom: 30 }}>
            {minimapVisible && (
              <MiniMap
                pannable
                zoomable
                style={{
                  position: "relative",
                  left: 0,
                  right: "auto",
                  bottom: 0,
                  background: "var(--canvas-bg, #262626)",
                  border: "1px solid var(--canvas-border, #3a3a3a)",
                  borderRadius: 8,
                  width: 180,
                  height: 120,
                }}
                nodeColor={(n) => NODE_TYPE_COLOR[n.type ?? ""] ?? "#1677ff"}
                maskColor="rgba(255,255,255,0.08)"
              />
            )}
            <CanvasControls
              onOpenSettings={() => setSettingsOpen(true)}
              onOpenAssets={() => setAssetsOpen(true)}
              onOpenCanvasSidebar={() => setCanvasSidebarOpen((v) => !v)}
              canvasSidebarOpen={canvasSidebarOpen}
            />
          </div>
        </Panel>

        {/* Top-right panel: agent entry */}
        <Panel position="top-right" style={{ margin: 0, padding: 0, paddingRight: 30, paddingTop: 30 }}>
          <Tooltip title={t("agent")}>
            <button
              type="button"
              onClick={() => setChatOpen(true)}
              className="canvas-agent-btn"
            >
              <AgentIcon style={{ width: 18, height: 18 }} />
              <span className="text-sm font-medium">{t("agent")}</span>
            </button>
          </Tooltip>
        </Panel>

        {/* Generation panel — follows selected empty image node */}
        {genTargetId && (
          <RfNodeToolbar nodeId={genTargetId} position={Position.Bottom} align="center" offset={12}>
            <ImageGenerationPanel key={genTargetId} nodeId={genTargetId} />
          </RfNodeToolbar>
        )}

        {/* Generation panel — follows selected video node */}
        {genTargetVideoId && (
          <RfNodeToolbar nodeId={genTargetVideoId} position={Position.Bottom} align="center" offset={12}>
            <VideoGenerationPanel key={genTargetVideoId} nodeId={genTargetVideoId} />
          </RfNodeToolbar>
        )}

        {textTarget && (
          <RfNodeToolbar nodeId={textTarget.id} position={Position.Bottom} align="center" offset={12}>
            <TextGenerationPanel nodeId={textTarget.id} />
          </RfNodeToolbar>
        )}

        {/* Bottom-center: add node toolbar */}
        <Panel position="bottom-center" style={{ margin: 0, padding: 0, paddingBottom: 30 }}>
          <CenterToolbar />
        </Panel>

        {/* Node toolbars */}
        {Array.from(selectedNodeIds).map((nid) => {
          const n = nodes.find((x) => x.id === nid);
          return (
          <RfNodeToolbar key={nid} nodeId={nid} position={Position.Top} align="center" offset={-8}>
            {(annotatingNodeId === nid || croppingNodeId === nid) ? null : (
              <NodeToolbarUI
                nodeId={nid}
                nodeType={n?.type}
                onShowInspector={(id) => setInspectedNodeId(id)}
              />
            )}
          </RfNodeToolbar>
        )})}
      </ReactFlow>
      </EdgeHighlightContext.Provider>

      <CanvasContextMenu
        onAddText={handleAddText}
        onAddImage={handleAddImage}
        onAddVideo={handleAddVideo}
        onAddAudio={handleAddAudio}
        onAddDirector={handleAddDirector}
        onResetView={handleResetView}
      />

      <NodeInspector
        open={inspectedNodeId !== null}
        node={inspectedNode}
        onClose={() => setInspectedNodeId(null)}
      />

      <ApiSettingsDrawer
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
      />

      <ConfirmModal
        open={deleteConfirmOpen}
        title={t("delete.project")}
        content={projectName ? `${t("project.delete.confirm")} "${projectName}"?` : t("project.delete.confirm")}
        okText={t("delete")}
        cancelText={t("cancel")}
        onOk={async () => {
          await flushAndWait();
          const activeId = useProjectStore.getState().activeProjectId;
          if (activeId) useProjectStore.getState().deleteProject(activeId);
          setDeleteConfirmOpen(false);
          router.push("/project");
        }}
        onCancel={() => setDeleteConfirmOpen(false)}
      />

      <ConfirmModal
        open={logoutConfirmOpen}
        title={t("logout")}
        content={t("logout.confirm")}
        okText={t("logout")}
        cancelText={t("cancel")}
        onOk={() => {
          useAuthStore.getState().logout();
          setLogoutConfirmOpen(false);
          router.push("/");
        }}
        onCancel={() => setLogoutConfirmOpen(false)}
      />

      <AssetsModal
        open={assetsOpen}
        onClose={() => setAssetsOpen(false)}
      />

      <CanvasSidebar
        open={canvasSidebarOpen}
        onClose={() => setCanvasSidebarOpen(false)}
      />

      <ChatPanel
        open={chatOpen}
        onClose={() => setChatOpen(false)}
      />
    </div>
  );
}
