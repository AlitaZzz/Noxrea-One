"use client";

import { useCallback, useEffect, useRef, useState, type DragEvent, useMemo } from "react";
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
import CanvasContextMenu, { useCtxMenu } from "@/components/canvas/CanvasContextMenu";
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
import { apiUpload } from "@/lib/api";
import { useRouter } from "next/navigation";
import { MenuItem, MenuDivider } from "@/components/common/MenuPopover";
import ConfirmModal from "@/components/common/ConfirmModal";
import AssetsModal from "@/components/assets/AssetsModal";
import { NODE_TYPE } from "@/lib/types";
import { createTextNode, createImageNode, createVideoNode, createGroupNode, duplicateNode, createEdge } from "@/lib/node-defaults";
import { GROUP_NODE_PADDING, THUMBNAIL_MAX } from "@/lib/constants";

/** Async load image or video dimensions for display */
function loadMediaDimensions(url: string, isVideo: boolean): Promise<{ w: number; h: number }> {
  return new Promise((resolve) => {
    if (isVideo) {
      const v = document.createElement("video");
      v.preload = "metadata";
      v.onloadedmetadata = () => resolve({ w: v.videoWidth || 1152, h: v.videoHeight || 768 });
      v.onerror = () => resolve({ w: 0, h: 0 });
      v.src = url;
    } else {
      const img = new window.Image();
      img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
      img.onerror = () => resolve({ w: 0, h: 0 });
      img.src = url;
    }
  });
}

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
  const notifRef = useRef(notif);
  notifRef.current = notif;

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

  // ---- Custom events: update node data ----

  useEffect(() => {
    function onUpdateData(e: Event) {
      const { nodeId, data, style, position, immediate } = (e as CustomEvent).detail;
      if (position) {
        useCanvasStore.getState().setNodes(
          useCanvasStore.getState().nodes.map((n) =>
            n.id === nodeId ? { ...n, position } : n
          )
        );
        markDirty();
      }
      updateNodeData(nodeId, data ?? {}, style);
      if (immediate) markDirtyImmediate();
    }
    window.addEventListener("node:update-data", onUpdateData);
    return () => window.removeEventListener("node:update-data", onUpdateData);
  }, [updateNodeData]);

  // ---- SSE task monitor (survives panel unmount) ----
  const sseCtrlsRef = useRef<Map<string, AbortController>>(new Map());
  const notifiedTasksRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    import("@/lib/api").then(({ BASE, getTokenHeader }) => {
      const scanAndConnect = () => {
        const allNodes = useCanvasStore.getState().nodes;
        for (const node of allNodes) {
          const d = node.data as any;
          if (!d?.task_id) continue;
          const st = d?.task_status;
          if (st !== "pending" && st !== "processing") continue;
          if (sseCtrlsRef.current.has(d.task_id)) continue;

          const taskId = d.task_id;
          const ctrl = new AbortController();
          sseCtrlsRef.current.set(taskId, ctrl);

          (async () => {
            try {
              const res = await fetch(`${BASE}/api/generate/task/${taskId}/stream`, {
                headers: { ...getTokenHeader() },
                signal: ctrl.signal,
              });
              if (!res.ok || !res.body) { sseCtrlsRef.current.delete(taskId); return; }
              const reader = res.body.getReader();
              const decoder = new TextDecoder();
              let buffer = "";
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split("\n");
                buffer = lines.pop() || "";
                for (const line of lines) {
                  if (!line.startsWith("data: ")) continue;
                  try {
                    const evt = JSON.parse(line.slice(6));
                    if (evt.status === "completed" && evt.result_url) {
                      const prompt = evt.prompt || "";
                      const label = prompt.slice(0, 20);
                      const isVideoNode = node.type === "video-node";
                      // Immediately show result with default size
                      const defW = isVideoNode ? 1152 : 1024;
                      const defH = isVideoNode ? 768 : 1024;
                      useCanvasStore.getState().updateNodeData(node.id, {
                        src: evt.result_url, label, alt: label,
                        naturalWidth: defW, naturalHeight: defH,
                        lockAspectRatio: true, _generating: false,
                        task_status: undefined, task_id: undefined,
                      });
                      markDirtyImmediate();
                      // Async load real dimensions
                      loadMediaDimensions(evt.result_url, isVideoNode).then((dims) => {
                        if (dims.w > 0) {
                          const shortSide = Math.min(dims.w, dims.h);
                          const scale = shortSide > THUMBNAIL_MAX ? THUMBNAIL_MAX / shortSide : 1;
                          const displayW = Math.round(dims.w * scale);
                          const displayH = Math.round(dims.h * scale);
                          const titleH = 24;
                          useCanvasStore.getState().updateNodeData(node.id, {
                            naturalWidth: dims.w, naturalHeight: dims.h,
                          }, { width: displayW, height: displayH + titleH });
                          markDirtyImmediate();
                        }
                      });
                      const t = useI18nStore.getState().t;
                      const desc = prompt.length > 80 ? prompt.slice(0, 77) + "..." : prompt;
                      if (!notifiedTasksRef.current.has(taskId)) {
                        notifiedTasksRef.current.add(taskId);
                        notifRef.current.success({ title: t(isVideoNode ? "generation.video.success" : "generation.image.success"), description: desc, placement: "bottomRight", duration: 5 });
                      }
                      sseCtrlsRef.current.delete(taskId);
                      return;
                    } else if (evt.status === "failed") {
                      const isVideoNode = node.type === "video-node";
                      useCanvasStore.getState().updateNodeData(node.id, {
                        _generating: false, task_status: undefined, task_id: undefined,
                      });
                      markDirtyImmediate();
                      if (!notifiedTasksRef.current.has(taskId)) {
                        notifiedTasksRef.current.add(taskId);
                        const t = useI18nStore.getState().t;
                        notifRef.current.error({ title: t(isVideoNode ? "generation.video.failed" : "generation.image.failed"), description: evt.error || "", placement: "bottomRight", duration: 5 });
                      }
                      sseCtrlsRef.current.delete(taskId);
                      return;
                    }
                  } catch {}
                }
              }
            } catch { /* SSE disconnected */ }
            sseCtrlsRef.current.delete(taskId);
          })();
        }
      };

      scanAndConnect();
      const timer = setInterval(scanAndConnect, 3000);
      return () => {
        clearInterval(timer);
        for (const ctrl of sseCtrlsRef.current.values()) ctrl.abort();
        sseCtrlsRef.current.clear();
      };
    });
  }, [markDirty]);

  // ---- Custom events: copy node ----

  useEffect(() => {
    function onCopyNode(e: Event) {
      const { nodeId } = (e as CustomEvent).detail;
      const allNodes = useCanvasStore.getState().nodes;
      const target = allNodes.find((n) => n.id === nodeId);
      if (target) copySelected([target]);
    }
    window.addEventListener("canvas:copy-node", onCopyNode);
    return () => window.removeEventListener("canvas:copy-node", onCopyNode);
  }, [copySelected]);

  // ---- Custom events: delete nodes (from toolbar) ----

  useEffect(() => {
    function onDeleteNodes(e: Event) {
      const { nodeIds } = (e as CustomEvent).detail;
      pushHistory(takeCanvasSnapshot());
      removeNodes(nodeIds);
    }
    window.addEventListener("canvas:delete-nodes", onDeleteNodes);
    return () => window.removeEventListener("canvas:delete-nodes", onDeleteNodes);
  }, [pushHistory, removeNodes]);

  // ---- Right-click context menu on canvas ----

  const showCtx = useCtxMenu((s) => s.show);
  const hideCtx = useCtxMenu((s) => s.hide);
  const clipboard = useSelectionStore((s) => s.clipboard);

  useEffect(() => {
    function onCanvasDblClick(e: MouseEvent) {
      const target = e.target as HTMLElement;
      if (target.closest(".react-flow__pane") && !target.closest(".react-flow__node")) {
        showCtx(e.clientX, e.clientY);
      }
    }
    function preventCtx(e: Event) { e.preventDefault(); }
    document.addEventListener("dblclick", onCanvasDblClick, true);
    document.addEventListener("contextmenu", preventCtx, { capture: true });
    return () => {
      document.removeEventListener("dblclick", onCanvasDblClick, true);
      document.removeEventListener("contextmenu", preventCtx, { capture: true });
    };
  }, [showCtx]);

  const handleAddText = useCallback(() => {
    pushHistory(takeCanvasSnapshot());
    const { x: cx, y: cy } = getViewportCenter();
    addNodes([createTextNode({ x: cx - 120, y: cy - 80 })]);
  }, [pushHistory, addNodes]);

  const handleAddImage = useCallback(() => {
    pushHistory(takeCanvasSnapshot());
    const { x: cx, y: cy } = getViewportCenter();
    addNodes([createImageNode({ x: cx - 120, y: cy - 80 })]);
  }, [pushHistory, addNodes]);

  const handleAddVideo = useCallback(() => {
    pushHistory(takeCanvasSnapshot());
    const { x: cx, y: cy } = getViewportCenter();
    addNodes([createVideoNode({ x: cx - 200, y: cy - 100 })]);
  }, [pushHistory, addNodes]);

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

  // ---- Custom events: delete edges (from edge X button) ----

  useEffect(() => {
    function onDeleteEdges(e: Event) {
      const { edgeIds } = (e as CustomEvent).detail;
      pushHistory(takeCanvasSnapshot());
      removeEdges(edgeIds);
    }
    window.addEventListener("canvas:delete-edges", onDeleteEdges);
    return () => window.removeEventListener("canvas:delete-edges", onDeleteEdges);
  }, [pushHistory, removeEdges]);

  // ---- Custom events: group / ungroup nodes ----

  useEffect(() => {
    function onGroupNodes() {
      const allNodes = useCanvasStore.getState().nodes;
      const selected = allNodes.filter((n) => n.selected && n.type !== NODE_TYPE.GROUP);
      if (selected.length < 2) return;

      // Calculate bounding box of selected nodes
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const n of selected) {
        const w = Number(n.style?.width) || 200;
        const h = Number(n.style?.height) || 120;
        minX = Math.min(minX, n.position.x);
        minY = Math.min(minY, n.position.y);
        maxX = Math.max(maxX, n.position.x + w);
        maxY = Math.max(maxY, n.position.y + h);
      }

      const groupX = minX - GROUP_NODE_PADDING;
      const groupY = minY - GROUP_NODE_PADDING;
      const groupW = maxX - minX + GROUP_NODE_PADDING * 2;
      const groupH = maxY - minY + GROUP_NODE_PADDING * 2;

      pushHistory(takeCanvasSnapshot());

      const groupNode = createGroupNode(
        { x: groupX, y: groupY },
        { width: groupW, height: groupH }
      );

      const store = useCanvasStore.getState();
      // Move selected nodes to be children of the group
      const updatedNodes = store.nodes.map((n) => {
        if (selected.find((s) => s.id === n.id)) {
          return {
            ...n,
            parentId: groupNode.id,
            position: {
              x: n.position.x - groupX,
              y: n.position.y - groupY,
            },
            extent: "parent" as const,
            selected: false,
          };
        }
        return n;
      });

      store.setNodes([{ ...groupNode, selected: true }, ...updatedNodes]);
      markDirtyImmediate();
    }

    function onUngroupNodes() {
      const allNodes = useCanvasStore.getState().nodes;
      const selectedGroup = allNodes.filter((n) => n.selected && n.type === NODE_TYPE.GROUP);
      if (selectedGroup.length === 0) return;

      pushHistory(takeCanvasSnapshot());

      const store = useCanvasStore.getState();
      let newNodes = [...store.nodes];

      for (const group of selectedGroup) {
        const groupX = group.position.x;
        const groupY = group.position.y;

        // Move children back to absolute positions
        newNodes = newNodes.map((n) => {
          if (n.parentId === group.id) {
            return {
              ...n,
              parentId: undefined,
              extent: undefined,
              position: {
                x: n.position.x + groupX,
                y: n.position.y + groupY,
              },
            };
          }
          return n;
        });

        // Remove the group node
        newNodes = newNodes.filter((n) => n.id !== group.id);
      }

      // Clear all edges connected to removed group nodes
      const removedIds = new Set(selectedGroup.map((g) => g.id));
      const newEdges = store.edges.filter(
        (e) => !removedIds.has(e.source) && !removedIds.has(e.target)
      );

      store.setNodes(newNodes);
      store.setEdges(newEdges);
      markDirtyImmediate();
    }

    window.addEventListener("canvas:group-nodes", onGroupNodes);
    window.addEventListener("canvas:ungroup-nodes", onUngroupNodes);
    return () => {
      window.removeEventListener("canvas:group-nodes", onGroupNodes);
      window.removeEventListener("canvas:ungroup-nodes", onUngroupNodes);
    };
  }, [pushHistory, addNodes]);

  // ---- File drop on canvas → create image node ----

  const handleDragOver = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }, []);

  const handleDrop = useCallback(
    async (e: DragEvent) => {
      e.preventDefault();
      const file = e.dataTransfer.files?.[0];
      if (!file || !file.type.startsWith("image/")) return;
      const pos = screenToFlowPosition({ x: e.clientX, y: e.clientY });
      try {
        const formData = new FormData();
        formData.append("file", file);
        const res = await apiUpload<{ url: string }>("/api/files/upload?category=images", formData);
        if (res.code === 200 && res.data?.url) {
          const src = res.data.url;
          const img = new window.Image();
          img.onload = () => {
            pushHistory(takeCanvasSnapshot());
            const node = createImageNode(pos, src);
            node.data.naturalWidth = img.naturalWidth;
            node.data.naturalHeight = img.naturalHeight;
            node.data.label = file.name;
            node.data.alt = file.name;
            const nw = img.naturalWidth, nh = img.naturalHeight;
            const shortSide = Math.min(nw, nh);
            const scale = shortSide > THUMBNAIL_MAX ? THUMBNAIL_MAX / shortSide : 1;
            const displayW = Math.round(nw * scale);
            const displayH = Math.round(nh * scale);
            node.style = { width: displayW, height: displayH };
            addNodes([node]);
          };
          img.src = src;
        }
      } catch (e) { console.error("Drop upload failed:", e); }
    },
    [screenToFlowPosition, pushHistory, addNodes]
  );

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
              <Popover
                content={
                  <div className="flex flex-col p-2 gap-0.5" style={{ margin: -12, background: "var(--canvas-bg)", borderRadius: 8, minWidth: 180 }}>
                    {/* User info */}
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
                    <style>{`.menu-popover-item:hover { background: var(--canvas-bg-hover) !important; }`}</style>
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
                  </div>
                }
                trigger="click"
                placement="bottomLeft"
                open={toolbarMenuOpen}
                onOpenChange={setToolbarMenuOpen}
              >
                <div className="flex shrink-0 cursor-pointer items-center gap-1 hover:bg-white/10 rounded px-0.5 py-0.5 transition-colors">
                  <img src="/favicon.ico" alt="Noxrea" style={{ width: 24, height: 24 }} />
                  <svg
                    width="10" height="10" viewBox="0 0 16 16"
                    className="shrink-0 transition-transform duration-200"
                    style={{ color: "var(--canvas-text-dim)", transform: toolbarMenuOpen ? "rotate(180deg)" : "none" }}
                  >
                    <g transform="translate(4.7 5.8)">
                      <path d="M6.2 0.1C6.36 -0.06 6.61 -0.06 6.77 0.1L7.19 0.52C7.35 0.68 7.35 0.93 7.19 1.09L4.15 4.13C3.87 4.4 3.43 4.4 3.16 4.13L0.12 1.09C-0.04 0.93 -0.04 0.68 0.12 0.52L0.54 0.1C0.7 -0.07 0.95 -0.07 1.11 0.1L3.65 2.64L6.2 0.1Z" fill="currentColor"/>
                    </g>
                  </svg>
                </div>
              </Popover>
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
