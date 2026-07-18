"use client";

import { useCallback, useEffect, useState, useMemo } from "react";
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  MiniMap,
  Panel,
  SelectionMode,
  NodeToolbar as RfNodeToolbar,
  type Connection,
  type NodeChange,
  type EdgeChange,
  applyNodeChanges,
  applyEdgeChanges,
  MarkerType,
  Position,
  useReactFlow,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import ImageNode from "@/components/canvas/nodes/ImageNode";
import TextNode from "@/components/canvas/nodes/TextNode";
import VideoNode from "@/components/canvas/nodes/VideoNode";
import ImageGroupNode from "@/components/canvas/nodes/ImageGroupNode";
import GroupNode from "@/components/canvas/nodes/GroupNode";
import DeletableEdge from "@/components/canvas/EdgeDeleteButton";
import { Popover, App } from "antd";
import NodeToolbarUI from "@/components/canvas/nodes/NodeToolbar";
import NodeInspector from "@/components/canvas/NodeInspector";
import CanvasControls from "@/components/canvas/CanvasControls";
import CenterToolbar from "@/components/canvas/CenterToolbar";
import GenerationPanel from "@/components/canvas/GenerationPanel";
import TextAskPanel from "@/components/canvas/TextAskPanel";
import CanvasContextMenu from "@/components/canvas/CanvasContextMenu";
import ModelConfigModal from "@/components/canvas/ModelConfigModal";
import { useCanvasStore, takeCanvasSnapshot, getViewportCenter, markDirty, markDirtyImmediate, flushAndWait, flushOnUnload } from "@/stores/canvas-store";
import { EdgeHighlightContext } from "@/lib/edge-highlight-context";
import { useSelectionStore } from "@/stores/selection-store";
import { useHistoryStore } from "@/stores/history-store";
import { useModelStore } from "@/stores/model-store";
import { useAssetsStore } from "@/stores/assets-store";
import { useProjectStore } from "@/stores/project-store";
import { useAuthStore } from "@/stores/auth-store";
import { useI18nStore } from "@/stores/i18n-store";
import { useSseTaskMonitor } from "@/hooks/use-sse-task-monitor";
import { useRouter } from "next/navigation";
import { MenuItem, MenuDivider, MenuPopover } from "@/components/common/MenuPopover";
import ConfirmModal from "@/components/common/ConfirmModal";
import AssetsModal from "@/components/assets/AssetsModal";
import { NODE_TYPE } from "@/lib/types";
import { duplicateNode, createEdge } from "@/lib/node-defaults";
import { useAddNode } from "@/hooks/use-add-node";
import { useGroupOperations } from "@/hooks/use-group-operations";
import { useCanvasEvents } from "@/hooks/use-canvas-events";
import { useFileDrop } from "@/hooks/use-file-drop";

const nodeTypes = {
  [NODE_TYPE.TEXT]: TextNode,
  [NODE_TYPE.IMAGE]: ImageNode,
  [NODE_TYPE.VIDEO]: VideoNode,
  [NODE_TYPE.IMAGE_GROUP]: ImageGroupNode,
  [NODE_TYPE.GROUP]: GroupNode,
};

const edgeTypes = {
  deletable: DeletableEdge,
};

export default function InfiniteCanvas() {
  const router = useRouter();
  const { screenToFlowPosition, fitView } = useReactFlow();
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
  const viewport = useCanvasStore((s) => s.viewport);
  const setViewport = useCanvasStore((s) => s.setViewport);
  const background = useCanvasStore((s) => s.background);
  const theme = useCanvasStore((s) => s.theme);
  const minimapVisible = useCanvasStore((s) => s.minimapVisible);
  const snapToGrid = useCanvasStore((s) => s.snapToGrid);
  const snapGridSize = useCanvasStore((s) => s.snapGridSize);

  // Selection — computed from node.selected (React Flow's source of truth)
  const selectedNodeIds = useMemo(
    () => new Set(nodes.filter((n) => n.selected).map((n) => n.id)),
    [nodes]
  );

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

  useEffect(() => { setEditName(projectName); }, [projectName]);
  useEffect(() => {
    const project = useProjectStore.getState().activeProject();
    if (project) {
      useCanvasStore.getState().restoreFromProject(project);
    }
  }, [activeProjectId]);

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
    return { id: sel[0].id, content: (sel[0].data as any).content || "" };
  }, [nodes]);

  // Inspector state
  const [inspectedNodeId, setInspectedNodeId] = useState<string | null>(null);
  const [toolbarMenuOpen, setToolbarMenuOpen] = useState(false);
  const [editName, setEditName] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [logoutConfirmOpen, setLogoutConfirmOpen] = useState(false);
  const [assetsOpen, setAssetsOpen] = useState(false);
  const inspectedNode = nodes.find((n) => n.id === inspectedNodeId) || null;

  // ---- Change handlers ----

  const handleNodesChange = useCallback(
    (changes: NodeChange[]) => {
      const applied = applyNodeChanges(changes, nodes);
      let appliedNodes;
      if (snapToGrid) {
        // Snap position changes to grid
        appliedNodes = applied.map((n) => ({
          ...n,
          position: {
            x: Math.round(n.position.x / snapGridSize) * snapGridSize,
            y: Math.round(n.position.y / snapGridSize) * snapGridSize,
          },
        }));
      } else {
        appliedNodes = applied;
      }
      setNodes(appliedNodes);
      // Only mark dirty for position changes (user drag).
      // Exclude select (pure UI) and dimensions (React Flow internal DOM measurement).
      if (changes.some((c) => c.type === "position")) {
        markDirty();
      }
    },
    [nodes, setNodes, snapToGrid, snapGridSize]
  );

  const handleEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      setEdges(applyEdgeChanges(changes, edges));
    },
    [edges, setEdges]
  );

  const handleConnect = useCallback(
    (connection: Connection) => {
      pushHistory(takeCanvasSnapshot());
      setEdges([...edges, createEdge(connection.source || "", connection.target || "")]);
      markDirtyImmediate();
    },
    [edges, setEdges, pushHistory]
  );

  const handleViewportChange = useCallback(
    (vp: { x: number; y: number; zoom: number }) => {
      setViewport({ x: vp.x, y: vp.y, zoom: vp.zoom });
      markDirty();
    },
    [setViewport]
  );

  // End of drag / resize → push history
  const handleMoveEnd = useCallback(() => {
    pushHistory(takeCanvasSnapshot());
  }, [pushHistory]);

  const handleNodeDragStop = useCallback(() => {
    pushHistory(takeCanvasSnapshot());
    markDirtyImmediate();
  }, [pushHistory]);

  const handlePaneClick = useCallback(() => {
    // Deselect all nodes and edges
    setNodes(nodes.map((n) => ({ ...n, selected: false })));
    setEdges(edges.map((e) => ({ ...e, selected: false })));
  }, [nodes, edges, setNodes, setEdges]);

  // Explicitly handle node selection — React Flow's internal click detection
  // may miss clicks that land on interactive child elements (inputs, selects, etc.)
  const handleNodeClick = useCallback(
    (_event: React.MouseEvent, node: Record<string, unknown>) => {
      const nodeId = node.id as string;
      setNodes(
        nodes.map((n) => ({
          ...n,
          selected: n.id === nodeId,
        }))
      );
    },
    [nodes, setNodes]
  );

  const clipboard = useSelectionStore((s) => s.clipboard);

  useGroupOperations();
  useCanvasEvents();
  const { addNode: addNodeAtCenter } = useAddNode();
  const handleAddText = useCallback(() => addNodeAtCenter("text"), [addNodeAtCenter]);
  const handleAddImage = useCallback(() => addNodeAtCenter("image"), [addNodeAtCenter]);
  const handleAddVideo = useCallback(() => addNodeAtCenter("video"), [addNodeAtCenter]);

  const handlePaste = useCallback(() => {
    const clip = useSelectionStore.getState().clipboard;
    if (!clip || !clip.nodes.length) return;
    pushHistory(takeCanvasSnapshot());
    const newNodes = clip.nodes.map((n: any) => duplicateNode(n, { x: 30, y: 30 }));
    addNodes(newNodes);
  }, [pushHistory, addNodes]);

  const handleSelectAll = useCallback(() => {
    setNodes(nodes.map((n) => ({ ...n, selected: true })));
  }, [nodes, setNodes]);

  const handleResetView = useCallback(() => {
    const s = useCanvasStore.getState();
    s.resetViewport();
    fitView({ duration: 300 });
  }, []);

  // ---- File drop on canvas → create image node ----

  const { handleDragOver, handleDrop } = useFileDrop(screenToFlowPosition, notif);

  // ---- Highlight selected node's connections ----

  const highlightedEdges = edges.map((e) => ({
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
  }));

  // ---- Component unmount: browser back, route change → save current state ----
  useEffect(() => {
    return () => { flushOnUnload(); };
  }, []);

  return (
    <div
      style={{ width: "100%", height: "100%" }}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      <EdgeHighlightContext.Provider value={highlightedEdgeIds}>
      <ReactFlow
        nodes={nodes}
        edges={highlightedEdges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={handleNodesChange}
        onEdgesChange={handleEdgesChange}
        onConnect={handleConnect}
        onViewportChange={handleViewportChange}
        onMoveEnd={handleMoveEnd}
        onNodeDragStop={handleNodeDragStop}
        onPaneClick={handlePaneClick}
        onNodeClick={handleNodeClick}
        defaultViewport={viewport}
        selectionMode={SelectionMode.Partial}
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
        <Panel position="top-left" style={{ margin: 0, padding: 0 }}>
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
                    <svg width="10" height="10" viewBox="0 0 16 16" className="shrink-0 transition-transform duration-200"
                      style={{ color: "var(--canvas-text-dim)", transform: toolbarMenuOpen ? "rotate(180deg)" : "none" }}>
                      <g transform="translate(4.7 5.8)"><path d="M6.2 0.1C6.36 -0.06 6.61 -0.06 6.77 0.1L7.19 0.52C7.35 0.68 7.35 0.93 7.19 1.09L4.15 4.13C3.87 4.4 3.43 4.4 3.16 4.13L0.12 1.09C-0.04 0.93 -0.04 0.68 0.12 0.52L0.54 0.1C0.7 -0.07 0.95 -0.07 1.11 0.1L3.65 2.64L6.2 0.1Z" fill="currentColor"/></g>
                    </svg>
                  </div>
                }
                placement="bottomLeft"
                content={
                  <>
                    <div className="flex items-center gap-2 px-1 py-1.5">
                      <div className="w-9 h-9 rounded-full flex items-center justify-center text-sm font-bold flex-shrink-0 overflow-hidden"
                        style={{ background: "#1677ff", color: "#fff" }}>
                        {authUser?.avatar ? (
                          <img src={authUser.avatar} alt="" className="w-full h-full object-cover" />
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
                  t.select();
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
        <Panel position="bottom-left" style={{ margin: 0, padding: 0 }}>
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
                nodeColor={(n) => {
                  const t = n.type;
                  if (t === NODE_TYPE.TEXT) return "#1677ff";
                  if (t === NODE_TYPE.IMAGE) return "#52c41a";
                  if (t === NODE_TYPE.VIDEO) return "#13c2c2";
                  if (t === NODE_TYPE.IMAGE_GROUP) return "#52c41a";
                  if (t === NODE_TYPE.GROUP) return "#722ed1";
                  return "#1677ff";
                }}
                maskColor="rgba(255,255,255,0.08)"
              />
            )}
            <CanvasControls onOpenSettings={() => setSettingsOpen(true)} onOpenAssets={() => setAssetsOpen(true)} />
          </div>
        </Panel>

        {/* Generation panel — follows selected empty image node */}
        {genTargetId && (
          <RfNodeToolbar nodeId={genTargetId} position={Position.Bottom} align="center" offset={12}>
            <GenerationPanel key={genTargetId} nodeId={genTargetId} type="image" />
          </RfNodeToolbar>
        )}

        {/* Generation panel — follows selected video node */}
        {genTargetVideoId && (
          <RfNodeToolbar nodeId={genTargetVideoId} position={Position.Bottom} align="center" offset={12}>
            <GenerationPanel key={genTargetVideoId} nodeId={genTargetVideoId} type="video" />
          </RfNodeToolbar>
        )}

        {textTarget && (
          <RfNodeToolbar nodeId={textTarget.id} position={Position.Bottom} align="center" offset={12}>
            <TextAskPanel nodeId={textTarget.id} currentContent={textTarget.content} />
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
            <NodeToolbarUI
              nodeId={nid}
              nodeType={n?.type}
              onShowInspector={(id) => setInspectedNodeId(id)}
            />
          </RfNodeToolbar>
        )})}
      </ReactFlow>
      </EdgeHighlightContext.Provider>

      <CanvasContextMenu
        onAddText={handleAddText}
        onAddImage={handleAddImage}
        onAddVideo={handleAddVideo}
        onSelectAll={handleSelectAll}
        onPaste={handlePaste}
        onResetView={handleResetView}
        hasClipboard={!!clipboard?.nodes?.length}
      />

      <NodeInspector
        open={inspectedNodeId !== null}
        node={inspectedNode}
        onClose={() => setInspectedNodeId(null)}
      />

      <ModelConfigModal
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
    </div>
  );
}
