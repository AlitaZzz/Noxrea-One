/**
 * 画布根容器组件。
 * 装配 React Flow 实例（节点/边类型注册、视口与选区行为），编排节点增删改、
 * 连线、编组、对齐吸附、文件拖入与快捷键等交互 hook，并挂载画布内各类浮层
 * （生成面板、侧边栏、资产库、对话面板、渠道配置抽屉、右键菜单）。
 * 自身只做编排与状态桥接，具体业务下沉到各 hook 与子组件。
 */
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
  type FinalConnectionState,
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
import { App, Tooltip } from "antd";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import ConfirmModal from "@/components/ui/ConfirmModal";
import { AgentIcon } from "@/components/ui/icons/canvas/AgentIcon";
import { ChevronDownIcon } from "@/components/ui/icons/common/ChevronDownIcon";
import { DirUploadIcon } from "@/components/ui/icons/director/DirUploadIcon";
import { MenuDivider, MenuItem, MenuPopover } from "@/components/ui/MenuPopover";
import AgentDrawer from "@/features/agent/components/AgentDrawer";
import AssetsModal from "@/features/assets/components/AssetsModal";
import { useAssetsStore } from "@/features/assets/store";
import { useAuthStore } from "@/features/auth/store";
import AlignmentGuides from "@/features/canvas/controls/AlignmentGuides";
import CanvasContextMenu from "@/features/canvas/controls/CanvasContextMenu";
import CanvasControls from "@/features/canvas/controls/CanvasControls";
import ConnectionCreateMenu, { type PendingConnectionCreate } from "@/features/canvas/controls/ConnectionCreateMenu";
import ConnectionFlowLine from "@/features/canvas/controls/ConnectionFlowLine";
import DeletableEdge from "@/features/canvas/controls/DeletableEdge";
import PendingConnectionPreview from "@/features/canvas/controls/PendingConnectionPreview";
import NodeInspector from "@/features/canvas/debug/NodeInspector";
import CanvasExplorer, { DRAWER_WIDTH } from "@/features/canvas/explorer/CanvasExplorer";
import { type AddNodeType,useAddNode } from "@/features/canvas/hooks/use-add-node";
import type { AlignmentGuide } from "@/features/canvas/hooks/use-alignment-guides";
import { computeAlignment,isAlignmentCandidate } from "@/features/canvas/hooks/use-alignment-guides";
import { useCanvasEvents } from "@/features/canvas/hooks/use-canvas-events";
import { useFileDrop } from "@/features/canvas/hooks/use-file-drop";
import { useGroupOperations } from "@/features/canvas/hooks/use-group-operations";
import { createAudioNode, createEdge, createImageNode, createTextNode, createVideoNode } from "@/features/canvas/node-defaults";
import AudioNode from "@/features/canvas/nodes/AudioNode";
import DirectorNode from "@/features/canvas/nodes/DirectorNode";
import GroupNode from "@/features/canvas/nodes/GroupNode";
import ImageNode from "@/features/canvas/nodes/ImageNode";
import NodeToolbarUI from "@/features/canvas/nodes/NodeToolbar";
import TextNode from "@/features/canvas/nodes/TextNode";
import VideoNode from "@/features/canvas/nodes/VideoNode";
import ImageGenerationPanel from "@/features/canvas/panels/ImageGenerationPanel";
import TextGenerationPanel from "@/features/canvas/panels/TextGenerationPanel";
import VideoGenerationPanel from "@/features/canvas/panels/VideoGenerationPanel";
import { flushAndWait, flushOnUnload, markDirty, markDirtyImmediate, syncLiveViewport, takeCanvasSnapshot, useCanvasStore } from "@/features/canvas/stores/canvas-store";
import { useContextMenuStore } from "@/features/canvas/stores/context-menu-store";
import { useHistoryStore } from "@/features/canvas/stores/history-store";
import { useSelectionStore } from "@/features/canvas/stores/selection-store";
import { bumpRefOrderToTail } from "@/features/canvas/shared/ref-order";
import type { AnyNode, ImageNodeData, VideoNodeData } from "@/features/canvas/types";
import { useProjectStore } from "@/features/project/store";
import ApiSettingsDrawer from "@/features/settings/ApiSettingsDrawer";
import { useSseTaskMonitor } from "@/hooks/use-sse-task-monitor";
import { canConnect,LAYOUT_GAP, NODE_TITLE_HEIGHT, NODE_TYPE, NODE_TYPE_COLOR } from "@/lib/constants";
import { useModelStore } from "@/lib/model-store";
import { EdgeHighlightContext } from "@/providers/edge-highlight-context";

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



  // When all selected nodes are groups, hide the built-in selection rect
  // (group nodes have their own border, the rect is redundant)
  const hideSelectionRect = useMemo(() => {
    const selected = nodes.filter((n) => n.selected);
    return selected.length > 0 && selected.every((n) => n.type === NODE_TYPE.GROUP);
  }, [nodes]);

  // 冻结 defaultViewport 引用——React Flow 仅在首次挂载时读取此值，
  // 后续 viewport 变更走 store + setRfViewport，绝不能让此 prop 随渲染更新，
  // 否则会触发 onViewportChange -> setViewport -> 重渲染 -> defaultViewport 变 -> ∞
  const defaultViewport = useMemo(() => useCanvasStore.getState().viewport, []);

  // Edges connected to any selected node → trigger multi-dot flow animation
  const highlightedEdgeIds = useMemo(
    () => new Set(edges.filter((e) => selectedNodeIds.has(e.source) || selectedNodeIds.has(e.target)).map((e) => e.id)),
    [edges, selectedNodeIds]
  );

  // History
  const pushHistory = useHistoryStore((s) => s.push);

  // Initialize stores
  useEffect(() => { useModelStore.getState().initialize(); useAssetsStore.getState().initialize(); }, []);

  // When switching projects, load the new project's canvas
  const activeProjectId = useProjectStore((s) => s.activeProjectId);
  const projectName = useProjectStore((s) => s.activeProject()?.name || "");
  const authUser = useAuthStore((s) => s.user);
  const { t } = useTranslation();

  const [editName, setEditName] = useState(projectName);
  const [isEditingName, setIsEditingName] = useState(false);
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
    const src = (sel[0].data as ImageNodeData).source;
    if (src === "upload" || src === "derived") return null;
    return sel[0].id;
  }, [nodes]);

  // Check if a single video node is selected
  const genTargetVideoId = useMemo(() => {
    const sel = nodes.filter((n) => n.selected);
    if (sel.length !== 1) return null;
    if (sel[0].type !== NODE_TYPE.VIDEO) return null;
    if ((sel[0].data as VideoNodeData).source === "upload") return null;
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
  const [canvasExplorerOpen, setCanvasExplorerOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [alignmentGuides, setAlignmentGuides] = useState<AlignmentGuide[]>([]);
  const inspectedNode = nodes.find((n) => n.id === inspectedNodeId) || null;

  // ---- Change handlers ----

  const handleNodesChange = useCallback(
    (changes: NodeChange<AnyNode>[]) => {
      const currentNodes = useCanvasStore.getState().nodes;

      const applied = applyNodeChanges(changes, currentNodes);

      // 检查是否有节点正在被拖拽（拖动中的位置变更，供吸附与组跟随共用）
      const positionChanges = changes.filter(
        (c): c is Extract<NodeChange<AnyNode>, { type: "position" }> =>
          c.type === "position" && c.dragging === true,
      );
      const draggedNodeIds = new Set(positionChanges.map((c) => c.id));

      let appliedNodes: AnyNode[];
      let newGuides: AlignmentGuide[] = [];

      // 提前检测是否在拖拽分组节点，并收集其成员节点 ID。
      // 成员节点在分组拖动时只需跟随平移，不应被独立磁吸，否则会导致累积偏移。
      const groupDrag = positionChanges.find((c) => {
        const node = currentNodes.find((n) => n.id === c.id);
        return node?.type === NODE_TYPE.GROUP;
      });
      const groupChildIds = new Set<string>();
      if (groupDrag) {
        for (const n of currentNodes) {
          if (n.type !== NODE_TYPE.GROUP && n.data?.groupId === groupDrag.id) {
            groupChildIds.add(n.id);
          }
        }
      }

      // 性能关键：未变化的节点保持原引用（返回 n 本身），仅对位置真正变化的节点
      // 创建新对象引用。否则每帧对全部节点 spread 重建，React Flow 会认为所有节点
      // 都变了而全量重渲染，拖拽时开销巨大。
      if (snapToGrid) {
        appliedNodes = applied.map((n) => {
          // 分组成员节点在分组拖动时：丢弃 React Flow 的多选位移，使用原始位置，
          // 后面会通过 delta 同步平移，避免双倍位移破坏布局间距。
          if (groupChildIds.has(n.id)) {
            const original = currentNodes.find((orig) => orig.id === n.id);
            return original ?? n;
          }

          let posX = n.position.x;
          let posY = n.position.y;

          // 拖拽中的节点：仅单选时尝试节点间对齐吸附，多选直接移动不吸附（避免 O(n²) 且多选对齐意义不大）
          if (draggedNodeIds.has(n.id) && draggedNodeIds.size === 1) {
            const nodeSize = {
              width: Number(n.style?.width) || Number(n.measured?.width) || 200,
              height: Number(n.style?.height) || Number(n.measured?.height) || 120,
            };
            // 空间分区：只对可能产生吸附的邻近节点构建边界，大幅降低大画布下每帧开销
            const dragBounds = { id: n.id, position: { x: posX, y: posY }, ...nodeSize };
            const nodeBounds = applied
              .filter((m) => m.id === n.id || isAlignmentCandidate(dragBounds, {
                id: m.id,
                position: { x: m.position.x, y: m.position.y },
                width: Number(m.style?.width) || Number(m.measured?.width) || 200,
                height: Number(m.style?.height) || Number(m.measured?.height) || 120,
              }, snapThreshold, LAYOUT_GAP))
              .map((m) => ({
                id: m.id,
                position: { x: m.position.x, y: m.position.y },
                width: Number(m.style?.width) || Number(m.measured?.width) || 200,
                height: Number(m.style?.height) || Number(m.measured?.height) || 120,
              }));

            const result = computeAlignment(
              dragBounds,
              nodeBounds,
              snapThreshold,
              LAYOUT_GAP,
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
          } else if (!draggedNodeIds.has(n.id)) {
            // 非拖拽变更（如 dimension 等）：保持 store 中的位置，避免释放鼠标时被未吸附的位置覆盖
            const original = currentNodes.find((orig) => orig.id === n.id);
            posX = original?.position.x ?? posX;
            posY = original?.position.y ?? posY;
          }
          // 多选拖动时：跳过节点间对齐吸附，但照常跟随 React Flow 移动（posX/posY 保持 n.position 的拖拽值）

          // 位置未变化则复用原引用，避免无关节点重渲染
          if (n.position.x === posX && n.position.y === posY) return n;
          return {
            ...n,
            position: { x: posX, y: posY },
          };
        });
      } else {
        // snapToGrid 关闭：仍需处理分组子节点，避免 React Flow 多选位移 + delta 双倍移动
        appliedNodes = applied.map((n) => {
          if (groupChildIds.has(n.id)) {
            const original = currentNodes.find((orig) => orig.id === n.id);
            return original ?? n;
          }
          return n;
        });
      }

      // 拖动组节点时，手动把同 groupId 的成员节点同步平移相同 delta。
      // 关键：delta 必须基于分组节点吸附后的最终位置来计算，而非 React Flow
      // 报告的原始位置，否则分组与成员之间会产生累积偏移。
      let finalNodes = appliedNodes;
      if (groupDrag) {
        const groupNode = currentNodes.find((n) => n.id === groupDrag.id);
        const snappedGroup = appliedNodes.find((n) => n.id === groupDrag.id);
        if (groupNode && snappedGroup) {
          const deltaX = snappedGroup.position.x - groupNode.position.x;
          const deltaY = snappedGroup.position.y - groupNode.position.y;
          if (deltaX !== 0 || deltaY !== 0) {
            finalNodes = appliedNodes.map((n) => {
              if (n.id === groupDrag.id || n.type === NODE_TYPE.GROUP) return n;
              if (n.data?.groupId === groupDrag.id) {
                return { ...n, position: { x: n.position.x + deltaX, y: n.position.y + deltaY } };
              }
              return n;
            });
          }
        }
      }

      setNodes(finalNodes);
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
    (changes: EdgeChange<Edge>[]) => {
      setEdges(applyEdgeChanges(changes, useCanvasStore.getState().edges));
    },
    [setEdges]
  );

  const handleConnect = useCallback(
    (connection: Connection) => {
      setEdges([...useCanvasStore.getState().edges, createEdge(connection.source || "", connection.target || "")]);
      // 「重连 = 重新入列」：参考边（重新）建立后，对应参考置尾（含 ✕ 后重连、断开重连）
      bumpRefOrderToTail([{ source: connection.source || "", target: connection.target || "" }]);
      markDirtyImmediate();
    },
    [setEdges]
  );

  // 节点连接规则：根据源/目标节点类型判断连接是否合法
  const isValidConnection = useCallback(
    (connection: Connection | Edge) => {
      const srcId = connection.source;
      const tgtId = connection.target;
      if (!srcId || !tgtId) return true;
      const allNodes = useCanvasStore.getState().nodes;
      const sourceNode = allNodes.find((n) => n.id === srcId);
      const targetNode = allNodes.find((n) => n.id === tgtId);
      if (!sourceNode || !targetNode) return true;
      return canConnect(sourceNode.type, targetNode.type);
    },
    []
  );

  // ── 拖拽连线到空白处弹出「创建连接节点」菜单 ──
  const [pendingConnectionCreate, setPendingConnectionCreate] = useState<PendingConnectionCreate | null>(null);
  // 记录连接起始 Handle 类型（onConnectStart 提供，比 onConnectEnd 的 fromHandle.type 可靠）
  const connectStartHandleTypeRef = useRef<"source" | "target" | null>(null);

  const handleConnectStart = useCallback(
    (_: unknown, params: { handleType: "source" | "target" | null }) => {
      connectStartHandleTypeRef.current = params.handleType ?? null;
    },
    []
  );

  const handleConnectEnd = useCallback(
    (event: MouseEvent | TouchEvent, connectionState: FinalConnectionState) => {
      // 仅在连接未落到目标节点（空白画布）上时弹出菜单
      const toNode = "toNode" in connectionState ? connectionState.toNode : null;
      if (toNode) return;

      const sourceNode = "fromNode" in connectionState ? connectionState.fromNode : null;
      if (!sourceNode) return;

      // 由起始 Handle 的 type 判断连接方向：
      //   source = 从右侧输出 Handle 拖出 → 新节点为下游（output）
      //   target = 从左侧输入 Handle 拉入 → 新节点为上游（input）
      // 使用 onConnectStart 记录的 handleType（比 connectionState.fromHandle.type 更可靠）
      const direction: "input" | "output" =
        connectStartHandleTypeRef.current === "target" ? "input" : "output";
      connectStartHandleTypeRef.current = null;

      // 取鼠标/触摸的屏幕坐标
      let clientX = 0, clientY = 0;
      if ("changedTouches" in event && event.changedTouches.length > 0) {
        clientX = event.changedTouches[0].clientX;
        clientY = event.changedTouches[0].clientY;
      } else if ("clientX" in event) {
        clientX = event.clientX;
        clientY = event.clientY;
      }

      const canvasPosition = screenToFlowPosition({ x: clientX, y: clientY });

      // 计算发起端 Handle 锚点在画布坐标系中的坐标，供菜单期间持续渲染预览线。
      // source Handle 在节点右侧、target Handle 在节点左侧，纵向均取节点中心。
      const sourceWidth = sourceNode.measured?.width ?? sourceNode.width ?? 0;
      const sourceHeight = sourceNode.measured?.height ?? sourceNode.height ?? 0;
      const sourceAnchor: { x: number; y: number } =
        direction === "output"
          ? { x: sourceNode.position.x + sourceWidth, y: sourceNode.position.y + sourceHeight / 2 + NODE_TITLE_HEIGHT / 2 }
          : { x: sourceNode.position.x, y: sourceNode.position.y + sourceHeight / 2 + NODE_TITLE_HEIGHT / 2 };

      setPendingConnectionCreate({
        sourceNodeId: sourceNode.id,
        sourceNodeType: sourceNode.type ?? "",
        direction,
        canvasPosition,
        screenPosition: { x: clientX, y: clientY },
        sourceAnchor,
      });
    },
    [screenToFlowPosition]
  );

  const handleCreateConnectedNode = useCallback(
    (nodeType: string) => {
      if (!pendingConnectionCreate) return;
      const { sourceNodeId, canvasPosition, direction } = pendingConnectionCreate;

      let newNode: AnyNode;
      switch (nodeType) {
        case NODE_TYPE.TEXT:
          newNode = createTextNode(canvasPosition);
          break;
        case NODE_TYPE.IMAGE:
          newNode = createImageNode(canvasPosition);
          break;
        case NODE_TYPE.VIDEO:
          newNode = createVideoNode(canvasPosition);
          break;
        case NODE_TYPE.AUDIO:
          newNode = createAudioNode(canvasPosition);
          break;
        default:
          return;
      }

      addNodes([newNode]);
      // 输出方向：源节点 → 新节点；输入方向：新节点 → 源节点
      const edge =
        direction === "output"
          ? createEdge(sourceNodeId, newNode.id)
          : createEdge(newNode.id, sourceNodeId);
      setEdges([...useCanvasStore.getState().edges, edge]);
      markDirtyImmediate();
    },
    [pendingConnectionCreate, addNodes, setEdges]
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

  const handleNodeDragStop = useCallback(
    (_: unknown, draggedNode: AnyNode) => {
      markDirtyImmediate();
      setAlignmentGuides([]);

      const allNodes = useCanvasStore.getState().nodes;

      // 成员节点：拖拽停止后，若中心点已离开所属组的矩形范围，则脱离组
      if (draggedNode.type !== NODE_TYPE.GROUP && draggedNode.data?.groupId) {
        const group = allNodes.find((n) => n.id === draggedNode.data?.groupId);
        if (group) {
          const groupW = Number(group.style?.width) || group.width || 0;
          const groupH = Number(group.style?.height) || group.height || 0;
          const nodeW = Number(draggedNode.style?.width) || draggedNode.width || 0;
          const nodeH = Number(draggedNode.style?.height) || draggedNode.height || 0;
          const centerX = draggedNode.position.x + nodeW / 2;
          const centerY = draggedNode.position.y + nodeH / 2;
          if (
            centerX < group.position.x ||
            centerY < group.position.y ||
            centerX > group.position.x + groupW ||
            centerY > group.position.y + groupH
          ) {
            // 不在此处 pushHistory：拖拽开始（handleNodeDragStart）已压入拖拽前快照，
            // 否则会把"拖出前"状态重复压栈，导致撤销/重做丢失真正的组外状态。
            setNodes(
              allNodes.map((n) =>
                n.id === draggedNode.id
                  ? ({ ...n, data: { ...n.data, groupId: undefined } } as AnyNode)
                  : n
              )
            );
          }
        }
      } else if (draggedNode.type !== NODE_TYPE.GROUP) {
        // 独立节点：拖拽停止后，若中心点落入某组矩形内，则加入该组
        const nodeW = Number(draggedNode.style?.width) || draggedNode.width || 0;
        const nodeH = Number(draggedNode.style?.height) || draggedNode.height || 0;
        const centerX = draggedNode.position.x + nodeW / 2;
        const centerY = draggedNode.position.y + nodeH / 2;

        const targetGroup = allNodes.find(
          (n) =>
            n.type === NODE_TYPE.GROUP &&
            n.id !== draggedNode.id &&
            centerX >= n.position.x &&
            centerX <= n.position.x + (Number(n.style?.width) || 0) &&
            centerY >= n.position.y &&
            centerY <= n.position.y + (Number(n.style?.height) || 0)
        );

        if (targetGroup) {
          // 不在此处 pushHistory：拖拽开始（handleNodeDragStart）已压入拖拽前快照，
          // 否则会把"拖入前"状态重复压栈，导致撤销/重做丢失真正的组内状态。
          setNodes(
            allNodes.map((n) =>
              n.id === draggedNode.id
                ? ({ ...n, data: { ...n.data, groupId: targetGroup.id } } as AnyNode)
                : n
            )
          );
        }
      }
    },
    [markDirtyImmediate, setAlignmentGuides, setNodes, pushHistory]
  );

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
      // 当按下修饰键时，由 React Flow 通过 onNodesChange 处理多选
      if (_event.ctrlKey || _event.metaKey || _event.shiftKey) return;

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
  const { addNode } = useAddNode();
  // 从右键/双击菜单新增节点时，锚定到触发菜单的点击点（世界坐标）
  const addNodeAtMenu = useCallback(
    (type: AddNodeType) => {
      const { x, y } = useContextMenuStore.getState();
      addNode(type, screenToFlowPosition({ x, y }));
    },
    [addNode, screenToFlowPosition],
  );
  const handleAddText = useCallback(() => addNodeAtMenu("text"), [addNodeAtMenu]);
  const handleAddImage = useCallback(() => addNodeAtMenu("image"), [addNodeAtMenu]);
  const handleAddVideo = useCallback(() => addNodeAtMenu("video"), [addNodeAtMenu]);
  const handleAddAudio = useCallback(() => addNodeAtMenu("audio"), [addNodeAtMenu]);
  const handleAddDirector = useCallback(() => addNodeAtMenu("director"), [addNodeAtMenu]);

  const handleResetView = useCallback(() => {
    const s = useCanvasStore.getState();
    s.resetViewport();
    fitView({ duration: 300 });
  }, []);

  // ---- File drop on canvas → create image node ----

  const shouldIgnoreFileDrop = useCallback((target: HTMLElement) => {
    return target.closest('.asset-library-modal') !== null;
  }, []);

  const canvasContainerRef = useRef<HTMLDivElement | null>(null);
  const { handleDragOver, handleDrop, isFileDragging } = useFileDrop(screenToFlowPosition, notif, shouldIgnoreFileDrop, canvasContainerRef);

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
      ref={canvasContainerRef}
      className={hideSelectionRect ? "canvas-container hide-selection-rect" : "canvas-container"}
      style={{ width: "100%", height: "100%", position: "relative", overflow: "hidden" }}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      <AlignmentGuides guides={alignmentGuides} />
      <EdgeHighlightContext.Provider value={highlightedEdgeIds}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={rfNodeTypes}
        edgeTypes={rfEdgeTypes}
        onNodesChange={handleNodesChange}
        onEdgesChange={handleEdgesChange}
        onConnect={handleConnect}
        onConnectStart={handleConnectStart}
        onConnectEnd={handleConnectEnd}
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
        multiSelectionKeyCode={["Shift", "Control", "Meta"]}
        deleteKeyCode={[]}
        fitView={false}
        panOnDrag={[0, 1]}
        panOnScroll={false}
        zoomOnScroll={true}
        zoomOnPinch={true}
        zoomOnDoubleClick={false}
        minZoom={0.1}
        maxZoom={5}
        elevateNodesOnSelect={false}
        proOptions={{ hideAttribution: true }}
        colorMode={theme}
        connectionLineComponent={ConnectionFlowLine}
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
        <Panel position="top-left" style={{ margin: 0, padding: 0, marginLeft: canvasExplorerOpen ? DRAWER_WIDTH : 0, transition: "margin-left 0.2s ease" }}>
          <div style={{ paddingLeft: 30, paddingTop: 30 }}>
            <div
              className="flex h-8 shrink-0 items-center gap-1 rounded-lg px-2 transition-colors w-[280px] select-none"
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
                  <div className="select-none">
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
                    <MenuItem onClick={async () => { setToolbarMenuOpen(false); await flushAndWait(); router.push("/project"); }}>{t("project.home")}</MenuItem>
                    <MenuDivider />
                    <MenuItem onClick={async () => {
                        setToolbarMenuOpen(false);
                        await flushAndWait();
                        const proj = await useProjectStore.getState().createProject();
                        useProjectStore.getState().setActiveProject(proj.id);
                        useCanvasStore.getState().restoreFromProject(proj);
                        setTimeout(() => fitView({ duration: 300 }), 50);
                      }}>{t("project.new")}</MenuItem>
                    <MenuItem onClick={() => { setToolbarMenuOpen(false); setDeleteConfirmOpen(true); }}>{t("project.delete")}</MenuItem>
                    <MenuDivider />
                    <MenuItem onClick={() => {
                        setToolbarMenuOpen(false);
                        setLogoutConfirmOpen(true);
                      }}>{t("auth.logout")}</MenuItem>
                  </div>
                }
              />
              <div className="w-px h-5 mx-0.5" style={{ background: "var(--canvas-border)" }} />
              {isEditingName ? (
                <input
                  className="bg-transparent text-sm outline-none border-none flex-1 min-w-0"
                  style={{ color: "var(--canvas-text)", height: 24, cursor: "text" }}
                  placeholder="Untitled"
                  autoFocus
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  onFocus={(e) => e.target.setSelectionRange(0, e.target.value.length)}
                  onBlur={() => {
                    setIsEditingName(false);
                    const activeId = useProjectStore.getState().activeProjectId;
                    if (activeId && editName.trim()) {
                      useProjectStore.getState().renameProject(activeId, editName.trim());
                    }
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                  }}
                />
              ) : (
                <div
                  className="text-sm flex-1 min-w-0 truncate"
                  style={{ color: "var(--canvas-text)", height: 24, lineHeight: "24px", cursor: "default", userSelect: "none" }}
                  onDoubleClick={() => setIsEditingName(true)}
                >
                  {editName || "Untitled"}
                </div>
              )}
            </div>

          </div>
        </Panel>

        {/* Bottom-left panel: minimap + controls */}
        <Panel position="bottom-left" style={{ margin: 0, padding: 0, marginLeft: canvasExplorerOpen ? DRAWER_WIDTH : 0, transition: "margin-left 0.2s ease" }}>
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
              onOpenCanvasExplorer={() => setCanvasExplorerOpen((v) => !v)}
              canvasExplorerOpen={canvasExplorerOpen}
            />
          </div>
        </Panel>

        {/* Top-right panel: agent entry */}
        <Panel position="top-right" style={{ margin: 0, padding: 0, paddingRight: 30, paddingTop: 30 }}>
          <Tooltip title={t("agent.title")}>
            <button
              type="button"
              onClick={() => setChatOpen(true)}
              className="canvas-agent-btn"
            >
              <AgentIcon style={{ width: 18, height: 18 }} />
              <span className="text-sm font-medium">{t("agent.title")}</span>
            </button>
          </Tooltip>
        </Panel>

        {/* Generation panel — follows selected empty image node */}
        {genTargetId && (
          <RfNodeToolbar nodeId={genTargetId} position={Position.Bottom} align="center" offset={12} style={{ zIndex: 9999 }}>
            <ImageGenerationPanel key={genTargetId} nodeId={genTargetId} />
          </RfNodeToolbar>
        )}

        {/* Generation panel — follows selected video node */}
        {genTargetVideoId && (
          <RfNodeToolbar nodeId={genTargetVideoId} position={Position.Bottom} align="center" offset={12} style={{ zIndex: 9999 }}>
            <VideoGenerationPanel key={genTargetVideoId} nodeId={genTargetVideoId} />
          </RfNodeToolbar>
        )}

        {textTarget && (
          <RfNodeToolbar nodeId={textTarget.id} position={Position.Bottom} align="center" offset={12} style={{ zIndex: 9999 }}>
            <TextGenerationPanel nodeId={textTarget.id} />
          </RfNodeToolbar>
        )}

        {/* Node toolbars */}
        {Array.from(selectedNodeIds).map((nid) => {
          const n = nodes.find((x) => x.id === nid);
          return (
          <RfNodeToolbar key={nid} nodeId={nid} position={Position.Top} align="center" offset={8}>
            {(annotatingNodeId === nid || croppingNodeId === nid || (n?.type === NODE_TYPE.IMAGE && (n.data as ImageNodeData)?.panorama)) ? null : (
              <NodeToolbarUI
                nodeId={nid}
                nodeType={n?.type}
                onShowInspector={(id) => setInspectedNodeId(id)}
              />
            )}
          </RfNodeToolbar>
        )})}

        {/* 拖拽连线落在空白、弹出创建菜单期间：持续渲染绿色流光预览线 */}
        {pendingConnectionCreate && (
          <PendingConnectionPreview
            from={pendingConnectionCreate.sourceAnchor}
            to={pendingConnectionCreate.canvasPosition}
            fromPosition={pendingConnectionCreate.direction === "output" ? Position.Right : Position.Left}
          />
        )}
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

      {pendingConnectionCreate && (
        <ConnectionCreateMenu
          pending={pendingConnectionCreate}
          onSelect={handleCreateConnectedNode}
          onClose={() => setPendingConnectionCreate(null)}
        />
      )}

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
        title={t("project.delete")}
        content={projectName ? `${t("project.deleteConfirm")} "${projectName}"?` : t("project.deleteConfirm")}
        okText={t("common.delete")}
        cancelText={t("common.cancel")}
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
        title={t("auth.logout")}
        content={t("auth.logoutConfirm")}
        okText={t("auth.logout")}
        cancelText={t("common.cancel")}
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

      <CanvasExplorer
        open={canvasExplorerOpen}
        onClose={() => setCanvasExplorerOpen(false)}
      />

      <AgentDrawer
        open={chatOpen}
        onClose={() => setChatOpen(false)}
        projectId={activeProjectId ? Number(activeProjectId) : undefined}
      />

      {/* 拖入文件时的全屏模糊遮罩 + 释放提示 */}
      {isFileDragging && (
        <div
          className="absolute inset-0 z-50 flex items-center justify-center backdrop-blur-md"
          style={{ background: "color-mix(in srgb, var(--canvas-bg) 55%, transparent)", pointerEvents: "none" }}
        >
          <div
            className="flex flex-col items-center gap-4 rounded-2xl px-16 py-12"
            style={{ border: "2px dashed var(--canvas-border-light)", background: "color-mix(in srgb, var(--canvas-bg) 40%, transparent)" }}
          >
            <DirUploadIcon
              className="animate-bounce"
              style={{ width: 56, height: 56, color: "rgb(29, 158, 117)" }}
            />
            <div className="text-lg font-medium" style={{ color: "var(--canvas-text)" }}>
              {t("file.dropToAdd")}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
