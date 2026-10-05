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
  MiniMap,
  type NodeChange,
  NodeToolbar as RfNodeToolbar,
  Panel,
  Position,
  ReactFlow,
  SelectionMode,
  useReactFlow,
} from "@xyflow/react";
import { useRouter } from "next/navigation";
import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import OfflineIndicator from "@/components/layout/OfflineIndicator";
import { EditOutlined } from "@/components/ui/AppIcon";
import { AgentIcon } from "@/components/ui/AppIcon";
import { ChevronDownIcon } from "@/components/ui/AppIcon";
import { DirUploadIcon } from "@/components/ui/AppIcon";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import ConfirmModal from "@/components/ui/ConfirmModal";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { useAppFeedback } from "@/components/ui/use-app-feedback";
import { createAssetNode } from "@/features/assets/add-asset";
import AssetsDialog from "@/features/assets/components/AssetsDialog";
import type { AssetItem } from "@/features/assets/types";
import { UserMenuPopover } from "@/features/auth/components/UserMenuPopover";
import { useAuthStore } from "@/features/auth/store";
import { useCurrentUser } from "@/features/auth/UserContext";
import CanvasAgentDrawer from "@/features/canvas/agent/components/AgentDrawer";
import CanvasAgentRuntimeBridge from "@/features/canvas/agent/Runtime";
import AlignmentGuides from "@/features/canvas/controls/AlignmentGuides";
import BatchConnectHandle from "@/features/canvas/controls/BatchConnectHandle";
import CanvasContextMenu from "@/features/canvas/controls/CanvasContextMenu";
import CanvasControls from "@/features/canvas/controls/CanvasControls";
import ConnectionCreateMenu, { type PendingConnectionCreate } from "@/features/canvas/controls/ConnectionCreateMenu";
import ConnectionFlowLine from "@/features/canvas/controls/ConnectionFlowLine";
import DeletableEdge from "@/features/canvas/controls/DeletableEdge";
import PendingConnectionPreview from "@/features/canvas/controls/PendingConnectionPreview";
import NodeInspector from "@/features/canvas/debug/NodeInspector";
import AudioClipStripPanel from "@/features/canvas/editing/AudioClipStripPanel";
import ClipStripPanel from "@/features/canvas/editing/ClipStripPanel";
import FrameStripPanel from "@/features/canvas/editing/FrameStripPanel";
import LightingPanel from "@/features/canvas/editing/LightingPanel";
import MultiAngleEditor from "@/features/canvas/editing/MultiAngleEditor";
import CanvasExplorer, { DRAWER_WIDTH } from "@/features/canvas/explorer/CanvasExplorer";
import { type AddNodeType, useAddNode } from "@/features/canvas/hooks/use-add-node";
import type { AlignmentGuide } from "@/features/canvas/hooks/use-alignment-guides";
import { computeAlignment,isAlignmentCandidate } from "@/features/canvas/hooks/use-alignment-guides";
import { useCanvasEvents } from "@/features/canvas/hooks/use-canvas-events";
import { useCanvasInteraction } from "@/features/canvas/hooks/use-canvas-interaction";
import { useFileDrop } from "@/features/canvas/hooks/use-file-drop";
import { useGroupOperations } from "@/features/canvas/hooks/use-group-operations";
import { applyTidyLayout, isTidyAnimating, useTidyAnimation } from "@/features/canvas/hooks/use-tidy-animation";
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
import { buildConnectionPairs, buildFanInPairs, buildFanoutPairs, connectionWouldCreate } from "@/features/canvas/shared/connection-rules";
import { buildNodeIndex, findGroupAtPoint, nodeAbsolutePosition, pruneEmptyGroups, refitGroupRects, resolveDropGroupId } from "@/features/canvas/shared/group-bounds";
import { findNodeAtFlowPoint, nodeEdgeAnchor } from "@/features/canvas/shared/node-hit-test";
import { bumpRefOrderToTail } from "@/features/canvas/shared/ref-order";
import { computeSelectionFrame } from "@/features/canvas/shared/selection-frame";
import { findFreePosition, flushAndWait, flushBeforeUnload, isNodeInUiState, markDirty, markDirtyImmediate, syncLiveViewport, takeCanvasSnapshot, useCanvasStore } from "@/features/canvas/stores/canvas-store";
import { useContextMenuStore } from "@/features/canvas/stores/context-menu-store";
import { useHistoryStore } from "@/features/canvas/stores/history-store";
import type { AnyNode, ImageNodeData, VideoNodeData } from "@/features/canvas/types";
import { useProjectStore } from "@/features/project/store";
import ApiSettingsDrawer from "@/features/settings/ApiSettingsDrawer";
import { useSseTaskMonitor } from "@/hooks/use-sse-task-monitor";
import { EDGE_BASE_COLOR, GROUP_NODE_PADDING, LAYOUT_GAP, NODE_TYPE, RAIL_CONNECT_RADIUS, RAIL_DOT } from "@/lib/constants";
import { BatchConnectContext, type BatchConnectHandlers } from "@/providers/BatchConnectContext";
import { EdgeHighlightContext } from "@/providers/EdgeHighlightContext";

// nodeTypes / edgeTypes 必须是稳定引用。定义在组件外可彻底避免 React Flow #002 警告：
// 组件内的 useMemo 在热更新等「重挂载」场景下仍会重新求值，产生新对象。
const RF_NODE_TYPES = {
  [NODE_TYPE.TEXT]: TextNode,
  [NODE_TYPE.IMAGE]: ImageNode,
  [NODE_TYPE.VIDEO]: VideoNode,
  [NODE_TYPE.AUDIO]: AudioNode,
  [NODE_TYPE.GROUP]: GroupNode,
  [NODE_TYPE.DIRECTOR]: DirectorNode,
};

const RF_EDGE_TYPES = {
  deletable: DeletableEdge,
};

export default function InfiniteCanvas() {
  const router = useRouter();
  const { screenToFlowPosition, fitView, setViewport: setRfViewport } = useReactFlow();
  const user = useCurrentUser();
  const { message, notification: notif } = useAppFeedback();
  useSseTaskMonitor(notif);

  // Canvas state
  const nodes = useCanvasStore((s) => s.nodes);
  const edges = useCanvasStore((s) => s.edges);
  const setNodes = useCanvasStore((s) => s.setNodes);
  const setEdges = useCanvasStore((s) => s.setEdges);
  const addNodes = useCanvasStore((s) => s.addNodes);
  const minimapVisible = useCanvasStore((s) => s.minimapVisible);
  const snapToGrid = useCanvasStore((s) => s.snapToGrid);
  const snapGridSize = useCanvasStore((s) => s.snapGridSize);
  const snapThreshold = useCanvasStore((s) => s.snapThreshold);
  const annotatingNodeId = useCanvasStore((s) => s.annotatingNodeId);
  const croppingNodeId = useCanvasStore((s) => s.croppingNodeId);
  const editingTextNodeId = useCanvasStore((s) => s.editingTextNodeId);
  const frameCaptureNodeId = useCanvasStore((s) => s.frameCaptureNodeId);
  const clipCaptureNodeId = useCanvasStore((s) => s.clipCaptureNodeId);
  const lightingNodeId = useCanvasStore((s) => s.lightingNodeId);
  const angleEditorNodeId = useCanvasStore((s) => s.angleEditorNodeId);
  const panoramaNodeId = useCanvasStore((s) => s.panoramaNodeId);
  const audioClipNodeId = useCanvasStore((s) => s.audioClipNodeId);
  const multiExpandedNodeId = useCanvasStore((s) => s.multiExpandedNodeId);

  // Selection — computed from node.selected (React Flow's source of truth)
  const selectedNodeIds = useMemo(
    () => new Set(nodes.filter((n) => n.selected).map((n) => n.id)),
    [nodes]
  );

  // 画布交互状态机：空闲 / 框选 / 拖动节点 / 拖线，四种状态互斥且由事件驱动。
  // handle、节点工具栏、生成面板的可见性与光标全部由此派生，不再各自维护布尔量。
  // 整体引用稳定（hook 内已记忆化），可直接作为依赖使用。
  const canvasInteraction = useCanvasInteraction();

  // 整理需要至少 2 个顶层块（组连同成员算一个块），否则菜单置灰
  const tidyDisabled = useMemo(() => {
    // parentId 是唯一结构关系：成员（有 parentId 且父存在）不算顶层块
    const groupIds = new Set(
      nodes.filter((n) => n.type === NODE_TYPE.GROUP).map((n) => n.id),
    );
    const topLevel = nodes.filter(
      (n) => n.type === NODE_TYPE.GROUP || !n.parentId || !groupIds.has(n.parentId),
    );
    return topLevel.length < 2;
  }, [nodes]);

  // 内置多选外框只在真正「多选」时才有意义：
  // - 单选时它只是把节点再包一圈（还带 40px 外扩），与节点自身描边重复，反而干扰；
  // - 选中的全是组节点时，组自己有边框，外框同样冗余。
  const hideSelectionRect = useMemo(() => {
    const selected = nodes.filter((n) => n.selected);
    if (selected.length < 2) return true;
    return selected.every((n) => n.type === NODE_TYPE.GROUP);
  }, [nodes]);

  // 多选外框批量连线：≥2 个非组节点选中时，外框右缘出现批量输出 Handle。
  // bbox 计算的唯一口径在 shared/selection-frame（同时用于成员轨道钳制）
  const selectionFrame = useMemo(() => computeSelectionFrame(nodes), [nodes]);

  // 组节点批量输出轨道不再由这里渲染：它渲染在 GroupNode 的节点 DOM 内
  // （GroupConnectRail），显隐才能走标准 Handle 规则（hover/选中/按住），
  // 与普通节点的轨道一致；参与集在拖起时从 store 现取组成员

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

  // 模型库 / 素材库初始化已前移至画布门页（canvas/[projectId]/page.tsx）：
  // 与项目数据并行拉齐后再放行画布，避免面板在空 store 上挂载产生空态竞态

  // 当前激活项目（agent 等子组件按 projectId 寻址）
  const activeProjectId = useProjectStore((s) => s.activeProjectId);
  const projectName = useProjectStore((s) => s.activeProject()?.name || "");
  const { t } = useTranslation();

  const [editName, setEditName] = useState(projectName);
  const [isEditingName, setIsEditingName] = useState(false);
  const [prevProjectName, setPrevProjectName] = useState(projectName);
  if (projectName !== prevProjectName) {
    setPrevProjectName(projectName);
    setEditName(projectName);
  }
  // 画布内容恢复的唯一入口在页面层（page.tsx 按 URL projectId 拉取后 restore）：
  // 本组件仅在 loader 门开启（恢复已完成）后挂载，此处不再重复恢复。
  // React Flow 内部视口跟随 restoreFromProject：订阅应用次数信号。
  // 恢复出的视口与 _liveViewport 一致，syncLiveViewport 的同值守卫不会误标脏。
  const viewportSyncCount = useCanvasStore((s) => s.viewportSyncCount);
  useEffect(() => {
    setRfViewport(useCanvasStore.getState().viewport, { duration: 0 });
  }, [viewportSyncCount, setRfViewport]);

  // 编辑态（标注 / 裁剪 / 选帧 / 片段截取 / 音频片段截取 / 图片打光 / 多视角 / 全景）激活的节点：生成面板必须让位，
  // 否则同一节点会同时挂上下两个浮层（生成面板在下方，编辑条也在附近）
  const editingNodeId = annotatingNodeId ?? croppingNodeId ?? frameCaptureNodeId ?? clipCaptureNodeId ?? audioClipNodeId ?? lightingNodeId ?? angleEditorNodeId ?? panoramaNodeId;

  // Check if a single image node is selected
  const genTargetId = useMemo(() => {
    if (!canvasInteraction.showSelectionChrome) return null;
    if (editingNodeId) return null;
    const sel = nodes.filter((n) => n.selected);
    if (sel.length !== 1) return null;
    if (sel[0].type !== NODE_TYPE.IMAGE) return null;
    const src = (sel[0].data as ImageNodeData).source;
    if (src === "upload" || src === "derived") return null;
    return sel[0].id;
  }, [nodes, canvasInteraction.showSelectionChrome, editingNodeId]);

  // Check if a single video node is selected
  const genTargetVideoId = useMemo(() => {
    if (!canvasInteraction.showSelectionChrome) return null;
    if (editingNodeId) return null;
    const sel = nodes.filter((n) => n.selected);
    if (sel.length !== 1) return null;
    if (sel[0].type !== NODE_TYPE.VIDEO) return null;
    if ((sel[0].data as VideoNodeData).source === "upload") return null;
    return sel[0].id;
  }, [nodes, canvasInteraction.showSelectionChrome, editingNodeId]);

  // Check if a single TextNode is selected
  const textTarget = useMemo(() => {
    if (!canvasInteraction.showSelectionChrome) return null;
    const sel = nodes.filter((n) => n.selected);
    if (sel.length !== 1) return null;
    if (sel[0].type !== NODE_TYPE.TEXT) return null;
    return { id: sel[0].id };
  }, [nodes, canvasInteraction.showSelectionChrome]);

  // Inspector state
  const [inspectedNodeId, setInspectedNodeId] = useState<string | null>(null);
  const [toolbarMenuOpen, setToolbarMenuOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [logoutConfirmOpen, setLogoutConfirmOpen] = useState(false);
  const [assetsOpen, setAssetsOpen] = useState(false);
  const [canvasExplorerOpen, setCanvasExplorerOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [gridMenuNodeId, setGridMenuNodeId] = useState<string | null>(null);
  const [toolbarDismissSignal, setToolbarDismissSignal] = useState(0);
  const handleGridMenuOpenChange = useCallback((nodeId: string, open: boolean) => {
    setGridMenuNodeId(open ? nodeId : null);
  }, []);
  const [alignmentGuides, setAlignmentGuides] = useState<AlignmentGuide[]>([]);
  const inspectedNode = nodes.find((n) => n.id === inspectedNodeId) || null;

  // 帧序列面板的宿主节点：节点被删除、取消选中或类型变化后立即关闭面板
  const frameStripNode = useMemo(() => {
    if (!frameCaptureNodeId) return null;
    const n = nodes.find((x) => x.id === frameCaptureNodeId);
    if (!n || n.type !== NODE_TYPE.VIDEO || !n.selected) return null;
    // src 清空（清除/撤销）会让 <video> 卸载，面板必须随宿主一起关闭
    if (!(n.data as VideoNodeData).src) return null;
    return n;
  }, [frameCaptureNodeId, nodes]);

  // 片段截取面板的宿主节点：同上
  const clipStripNode = useMemo(() => {
    if (!clipCaptureNodeId) return null;
    const n = nodes.find((x) => x.id === clipCaptureNodeId);
    if (!n || n.type !== NODE_TYPE.VIDEO || !n.selected) return null;
    if (!(n.data as VideoNodeData).src) return null;
    return n;
  }, [clipCaptureNodeId, nodes]);

  // 打光面板的宿主节点：节点被删除、取消选中或类型变化后立即关闭面板
  const lightingNode = useMemo(() => {
    if (!lightingNodeId) return null;
    const n = nodes.find((x) => x.id === lightingNodeId);
    if (!n || n.type !== NODE_TYPE.IMAGE || !n.selected) return null;
    if (!(n.data as ImageNodeData).src) return null;
    return n;
  }, [lightingNodeId, nodes]);

  // 多视角面板的宿主节点：同打光面板
  const angleEditorNode = useMemo(() => {
    if (!angleEditorNodeId) return null;
    const n = nodes.find((x) => x.id === angleEditorNodeId);
    if (!n || n.type !== NODE_TYPE.IMAGE || !n.selected) return null;
    if (!(n.data as ImageNodeData).src) return null;
    return n;
  }, [angleEditorNodeId, nodes]);

  // 全景查看的宿主节点：同打光/多视角——节点删除、取消选中或类型变化后立即退出全景
  const panoramaNode = useMemo(() => {
    if (!panoramaNodeId) return null;
    const n = nodes.find((x) => x.id === panoramaNodeId);
    if (!n || n.type !== NODE_TYPE.IMAGE || !n.selected) return null;
    if (!(n.data as ImageNodeData).src) return null;
    return n;
  }, [panoramaNodeId, nodes]);

  // 音频片段截取面板的宿主节点：节点被删除、取消选中或类型变化后立即关闭面板
  const audioClipNode = useMemo(() => {
    if (!audioClipNodeId) return null;
    const n = nodes.find((x) => x.id === audioClipNodeId);
    if (!n || n.type !== NODE_TYPE.AUDIO || !n.selected) return null;
    if (!(n.data as { src?: string }).src) return null;
    return n;
  }, [audioClipNodeId, nodes]);

  // 画面裁剪面板的宿主节点：面板本体挂在节点内部，但残留 id 的兜底
  // 清理与其它编辑面板一致（裁剪确认不自关，关闭由节点侧/这里的校验驱动）。
  // 注意 croppingNodeId 由视频与图片两个裁剪面板共用，两种宿主都要放行，
  // 否则图片裁剪会在打开的同一帧被这里的校验清掉
  const cropNode = useMemo(() => {
    if (!croppingNodeId) return null;
    const n = nodes.find((x) => x.id === croppingNodeId);
    if (!n || !n.selected) return null;
    if (n.type === NODE_TYPE.VIDEO) {
      if (!(n.data as VideoNodeData).src) return null;
    } else if (n.type === NODE_TYPE.IMAGE) {
      if (!(n.data as ImageNodeData).src) return null;
    } else {
      return null;
    }
    return n;
  }, [croppingNodeId, nodes]);

  // 宿主校验兜底：右键菜单撤销 / 框选改选等路径不经过 pane 与节点点击，
  // 必须在这里清掉残留的面板宿主 id，否则面板卸载后 id 悬空——
  // isMediaEditorOpen 恒真导致全部画布快捷键失效，重选节点还会幽灵重开面板
  useEffect(() => {
    const st = useCanvasStore.getState();
    if (frameCaptureNodeId && !frameStripNode) st.setFrameCaptureNodeId(null);
    if (clipCaptureNodeId && !clipStripNode) st.setClipCaptureNodeId(null);
    if (lightingNodeId && !lightingNode) st.setLightingNodeId(null);
    if (angleEditorNodeId && !angleEditorNode) st.setAngleEditorNodeId(null);
    if (panoramaNodeId && !panoramaNode) st.setPanoramaNodeId(null);
    if (audioClipNodeId && !audioClipNode) st.setAudioClipNodeId(null);
    if (croppingNodeId && !cropNode) st.setCroppingNodeId(null);
  }, [
    frameCaptureNodeId, frameStripNode,
    clipCaptureNodeId, clipStripNode,
    lightingNodeId, lightingNode,
    angleEditorNodeId, angleEditorNode,
    panoramaNodeId, panoramaNode,
    audioClipNodeId, audioClipNode,
    croppingNodeId, cropNode,
  ]);

  // 面板 onClose 提升为稳定引用：InfiniteCanvas 拖动节点时每帧重渲染，
  // 内联箭头会让各面板（useEscapeToClose deps [onClose]）每帧重挂 window 监听
  const closeFrameStripPanel = useCallback(() => useCanvasStore.getState().setFrameCaptureNodeId(null), []);
  const closeClipStripPanel = useCallback(() => useCanvasStore.getState().setClipCaptureNodeId(null), []);
  const closeLightingPanel = useCallback(() => useCanvasStore.getState().setLightingNodeId(null), []);
  const closeAngleEditorPanel = useCallback(() => useCanvasStore.getState().setAngleEditorNodeId(null), []);
  const closeAudioClipPanel = useCallback(() => useCanvasStore.getState().setAudioClipNodeId(null), []);

  // 画布整理：位移动画控制器（整理触发动画，拖拽时取消动画）
  const { cancel: cancelTidy } = useTidyAnimation();

  // ---- Change handlers ----

  const handleNodesChange = useCallback(
    (changes: NodeChange<AnyNode>[]) => {
      const currentNodes = useCanvasStore.getState().nodes;

      const applied = applyNodeChanges(changes, currentNodes);

      // 检查是否有节点正在被拖拽（拖动中的位置变更，供吸附共用）。
      // 组移动带动成员由 React Flow Sub Flow 原生处理（成员相对坐标不变、
      // 绝对位置随父重算），这里只处理单个被拖节点的吸附。
      const positionChanges = changes.filter(
        (c): c is Extract<NodeChange<AnyNode>, { type: "position" }> =>
          c.type === "position" && c.dragging === true,
      );
      const draggedNodeIds = new Set(positionChanges.map((c) => c.id));

      // 整理动画播放期间用户开始拖拽：立即取消动画，
      // 否则动画每帧写入的位置会与 React Flow 的拖拽状态互相覆盖
      if (isTidyAnimating() && positionChanges.length > 0) {
        cancelTidy();
      }

      let appliedNodes: AnyNode[];
      let newGuides: AlignmentGuide[] = [];

      if (snapToGrid) {
        // 吸附与对齐判定统一在绝对坐标空间：成员 position 是组内相对坐标，
        // 先换算为绝对值，吸附结果再换回相对坐标写回
        const nodeById = buildNodeIndex(currentNodes);
        const absPositionOf = (n: AnyNode) => nodeAbsolutePosition(n, nodeById);

        if (draggedNodeIds.size === 1) {
          const draggedId = positionChanges[0].id;
          const dragged = applied.find((n) => n.id === draggedId);
          if (!dragged) {
            appliedNodes = applied;
          } else {
            // 父节点在拖拽中不动（拖成员时组未被拖拽），绝对位置 = 父位置 + 相对位置
            const absPos = absPositionOf(dragged);
            const nodeSize = {
              width: Number(dragged.style?.width) || Number(dragged.measured?.width) || 200,
              height: Number(dragged.style?.height) || Number(dragged.measured?.height) || 120,
            };
            // 空间分区：只对可能产生吸附的邻近节点构建边界，大幅降低大画布下每帧开销
            const dragBounds = { id: draggedId, position: absPos, ...nodeSize };
            const nodeBounds = applied
              .filter((m) => m.id !== draggedId && isAlignmentCandidate(dragBounds, {
                id: m.id,
                position: absPositionOf(m),
                width: Number(m.style?.width) || Number(m.measured?.width) || 200,
                height: Number(m.style?.height) || Number(m.measured?.height) || 120,
              }, snapThreshold, LAYOUT_GAP))
              .map((m) => ({
                id: m.id,
                position: absPositionOf(m),
                width: Number(m.style?.width) || Number(m.measured?.width) || 200,
                height: Number(m.style?.height) || Number(m.measured?.height) || 120,
              }));

            const result = computeAlignment(
              dragBounds,
              nodeBounds,
              snapThreshold,
              LAYOUT_GAP,
            );

            let absX = result.snapX ?? Math.round(absPos.x / snapGridSize) * snapGridSize;
            let absY = result.snapY ?? Math.round(absPos.y / snapGridSize) * snapGridSize;
            newGuides = result.guides;
            const parent = dragged.parentId ? nodeById.get(dragged.parentId) : undefined;
            if (parent) {
              absX -= parent.position.x;
              absY -= parent.position.y;
            }
            // 位置未变化则复用原引用，避免无关节点重渲染
            if (dragged.position.x === absX && dragged.position.y === absY) {
              appliedNodes = applied;
            } else {
              appliedNodes = applied.map((n) =>
                n.id === draggedId ? { ...n, position: { x: absX, y: absY } } : n,
              );
            }
          }
        } else if (draggedNodeIds.size > 1) {
          // 多选拖动：跳过节点间对齐吸附（避免 O(n²) 且多选对齐意义不大），
          // 照常跟随 React Flow 移动；未拖拽节点保持 store 位置
          appliedNodes = applied.map((n) => {
            if (draggedNodeIds.has(n.id)) return n;
            const original = nodeById.get(n.id);
            return original && (original.position.x !== n.position.x || original.position.y !== n.position.y)
              ? { ...n, position: original.position }
              : n;
          });
        } else {
          // 非拖拽批次（如拖拽结束的 dragging:false 汇总、dimension 变更）：
          // 保持 store 中的位置，避免释放鼠标时被未吸附的位置覆盖
          appliedNodes = applied.map((n) => {
            const original = nodeById.get(n.id);
            return original && (original.position.x !== n.position.x || original.position.y !== n.position.y)
              ? { ...n, position: original.position }
              : n;
          });
        }
      } else {
        // snapToGrid 关闭：位置变更原样采用（含组拖动的成员自动跟随）
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
    [cancelTidy, setNodes, snapToGrid, snapGridSize, snapThreshold],
  );

  const handleEdgesChange = useCallback(
    (changes: EdgeChange<Edge>[]) => {
      setEdges(applyEdgeChanges(changes, useCanvasStore.getState().edges));
    },
    [setEdges]
  );

  /** 批量建边：去重已存在的连线，新边统一触发参考置尾与落库 */
  const batchConnect = useCallback(
    (pairs: { source: string; target: string }[]) => {
      if (pairs.length === 0) return;
      const state = useCanvasStore.getState();
      const existing = new Set(state.edges.map((e) => `${e.source}->${e.target}`));
      const fresh = pairs
        .filter((p) => !existing.has(`${p.source}->${p.target}`))
        .map((p) => createEdge(p.source, p.target));
      if (fresh.length === 0) return;
      setEdges([...state.edges, ...fresh]);
      bumpRefOrderToTail(fresh);
      markDirtyImmediate();
    },
    [setEdges]
  );

  const handleConnect = useCallback(
    (connection: Connection) => {
      if (!connection.source || !connection.target) return;
      // 扇出语义、类型校验与自连排除统一在 buildConnectionPairs（见 shared/connection-rules）
      const pairs = buildConnectionPairs(
        connection.source,
        connection.target,
        useCanvasStore.getState().nodes
      );
      batchConnect(pairs);
    },
    [batchConnect]
  );

  // 节点连接规则：xyflow 拖线磁吸时的合法性判定（connectionStatus / 松手 onConnect 的开关）。
  // 与松手建边、拖拽反馈共用 connection-rules 的「会产生新边」口径：多选扇出为全有或
  // 全无——全部选中节点与对端类型可连（任一不可连即整体拒绝）且至少产生一条新边
  // 才合法，全部已连 / 自连也不合法——不会出现「显示可连却建不出边」或自环边。
  const isValidConnection = useCallback(
    (connection: Connection | Edge) => {
      const srcId = connection.source;
      const tgtId = connection.target;
      if (!srcId || !tgtId) return true;
      const state = useCanvasStore.getState();
      const known = state.nodes.some((n) => n.id === srcId) && state.nodes.some((n) => n.id === tgtId);
      if (!known) return true;
      return connectionWouldCreate(srcId, tgtId, state);
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
      canvasInteraction.onConnectStart();
    },
    [canvasInteraction]
  );

  const handleConnectEnd = useCallback(
    (event: MouseEvent | TouchEvent, connectionState: FinalConnectionState) => {
      // 连接结束（成功或取消）复位交互状态
      canvasInteraction.onConnectEnd();
      // 由起始 Handle 的 type 判断连接方向：
      //   source = 从右侧输出 Handle 拖出 → 新节点为下游（output）
      //   target = 从左侧输入 Handle 拉入 → 新节点为上游（input）
      // 使用 onConnectStart 记录的 handleType（比 connectionState.fromHandle.type 更可靠）
      const direction: "input" | "output" =
        connectStartHandleTypeRef.current === "target" ? "input" : "output";
      connectStartHandleTypeRef.current = null;
      // 连接未磁吸到目标节点的轨道 Handle（toNode 为空）：可能落在节点本体或空白处，
      // 前者下方直接建边，后者弹出创建菜单
      const toNode = "toNode" in connectionState ? connectionState.toNode : null;
      if (toNode) return;

      const sourceNode = "fromNode" in connectionState ? connectionState.fromNode : null;
      if (!sourceNode) return;

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

      // 松手落在节点本体（未磁吸到轨道）→ 不弹创建菜单：按「这次连接会不会产生
      // 新边」判定（connection-rules：多选扇出聚合 + 类型校验 + 自连/已连去重，
      // 与 isValidConnection、拖拽反馈同口径），可连则直接建边（走 handleConnect，
      // 继承扇出与置尾），否则静默取消——拖拽中的毛玻璃反馈已提示不可连。
      // 命中测试与 ConnectionFlowLine 的实时反馈共用 node-hit-test。
      const state = useCanvasStore.getState();
      const hit = findNodeAtFlowPoint(state.nodes, canvasPosition);
      if (hit) {
        const connection =
          direction === "output"
            ? { source: sourceNode.id, target: hit.id, sourceHandle: null, targetHandle: null }
            : { source: hit.id, target: sourceNode.id, sourceHandle: null, targetHandle: null };
        if (connectionWouldCreate(connection.source, connection.target, state)) {
          handleConnect(connection);
        }
        return;
      }

      // 落点为空白 → 弹创建菜单。预览线的锚点不再随状态存储，渲染时按
      // sourceNodeIds + direction 逐节点取边缘锚点（见下方菜单预览渲染块）
      setPendingConnectionCreate({
        sourceNodeIds: [sourceNode.id],
        sourceNodeTypes: [sourceNode.type ?? ""],
        direction,
        canvasPosition,
        screenPosition: { x: clientX, y: clientY },
      });
    },
    [screenToFlowPosition, canvasInteraction, handleConnect]
  );

  const handleCreateConnectedNode = useCallback(
    (nodeType: string) => {
      if (!pendingConnectionCreate) return;
      const { sourceNodeIds, canvasPosition, direction } = pendingConnectionCreate;

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

      // 落点创建即归组：与拖入归组同规则「包含即归属」（group-bounds）。
      // 菜单创建是唯一不经过 drag stop 归属判定的放置入口，此前组内落点
      // 建节点会落在组里却不归属（不随组移动、不算成员）。
      // 以新节点中心点判定（媒体节点加载前无实测尺寸，中心 ≈ 落点本身）
      const newW = Number(newNode.style?.width) || 0;
      const newH = Number(newNode.style?.height) || 0;
      const joinedGroupId = findGroupAtPoint(useCanvasStore.getState().nodes, {
        x: newNode.position.x + newW / 2,
        y: newNode.position.y + newH / 2,
      });
      if (joinedGroupId) {
        const group = useCanvasStore
          .getState()
          .nodes.find((n) => n.id === joinedGroupId);
        if (group) {
          // 归组：绝对落点换算为组内相对坐标 + parentId 结构关系
          newNode = {
            ...newNode,
            parentId: joinedGroupId,
            position: {
              x: newNode.position.x - group.position.x,
              y: newNode.position.y - group.position.y,
            },
          } as AnyNode;
        }
      }

      addNodes([newNode]);
      // 组框随新成员只扩不缩（与拖入加入路径同一 refitGroupRects）；
      // addNodes 已压入创建前快照，撤销一并回滚归组与扩框
      if (joinedGroupId) {
        setNodes(refitGroupRects(useCanvasStore.getState().nodes, [joinedGroupId]));
        markDirtyImmediate();
      }
      // 批量接线与菜单门控同口径（全有或全无，connection-rules）：
      // 输出方向 buildFanoutPairs（各选中 → 新节点），输入方向 buildFanInPairs（新节点 → 各选中）
      const nodeById = new Map(useCanvasStore.getState().nodes.map((n) => [n.id, n]));
      const participants = sourceNodeIds
        .map((id) => nodeById.get(id))
        .filter((n): n is AnyNode => !!n);
      const pairs =
        direction === "output"
          ? buildFanoutPairs(participants, newNode)
          : buildFanInPairs(newNode, participants);
      batchConnect(pairs);
    },
    [pendingConnectionCreate, addNodes, batchConnect, setNodes]
  );

  /** 菜单期间的束线预览锚点：按 sourceNodeIds 逐节点取右/左边缘正中
   *  （多选扇出每个选中节点一根，单节点即一根），无有效盒尺寸的节点跳过。
   *  锚点统一在绝对坐标空间计算（成员 position 是组内相对坐标） */
  const pendingPreviewAnchors = useMemo(() => {
    if (!pendingConnectionCreate) return [];
    const nodeById = buildNodeIndex(nodes);
    const side = pendingConnectionCreate.direction === "output" ? "right" : "left";
    return pendingConnectionCreate.sourceNodeIds
      .map((id) => nodeById.get(id))
      .flatMap((n) => {
        const anchor = n ? nodeEdgeAnchor(n, side, nodeById) : null;
        return anchor ? [anchor] : [];
      });
  }, [pendingConnectionCreate, nodes]);

  /** 批量 Handle 拖到空白：弹出「创建连接节点」菜单，创建后批量接驳全部参与节点
   *  （框选 = 选中节点，组 = 组成员；菜单按参与类型全有或全无门控选项，
   *  方向随拖线轨道：output 新节点在下游，input 新节点在上游） */
  const openBatchCreateMenu = useCallback(
    (
      participantIds: string[],
      canvasPosition: { x: number; y: number },
      screenPosition: { x: number; y: number },
      direction: "output" | "input"
    ) => {
      const selected = useCanvasStore.getState().nodes.filter((n) => participantIds.includes(n.id));
      if (selected.length === 0) return;
      setPendingConnectionCreate({
        sourceNodeIds: selected.map((n) => n.id),
        sourceNodeTypes: selected.map((n) => n.type ?? ""),
        direction,
        canvasPosition,
        screenPosition,
      });
    },
    []
  );

  /** 组节点批量轨道（GroupConnectRail）的接驳回调：渲染在节点 DOM 内，
   *  不能经 props 透传，也不能塞进持久化的 node data，经 Context 注入。
   *  onConnect 直接用 batchConnect——候选对已由 use-batch-connect-drag 按方向
   *  构建并全有或全无校验，这里只负责建边与去重 */
  const batchConnectHandlers = useMemo<BatchConnectHandlers>(
    () => ({
      onConnect: batchConnect,
      onConnectToBlank: openBatchCreateMenu,
      onDragStart: canvasInteraction.onConnectStart,
      onDragEnd: canvasInteraction.onConnectEnd,
      screenToFlowPosition,
    }),
    [batchConnect, openBatchCreateMenu, canvasInteraction, screenToFlowPosition]
  );

  const handleViewportChange = useCallback(
    (vp: { x: number; y: number; zoom: number }) => {
      syncLiveViewport({ x: vp.x, y: vp.y, zoom: vp.zoom });
    },
    []
  );

  const handleNodeDragStart = useCallback(() => {
    pushHistory(takeCanvasSnapshot());
    canvasInteraction.onNodeDragStart();
    // 拖入高亮随每次拖拽重新开始计算（上一轮残留即刻清空）
    useCanvasStore.getState().setDragOverGroup(null);
  }, [pushHistory, canvasInteraction]);

  // 拖入组高亮：拖拽中实时以「落点归属」同口径（resolveDropGroupId）计算
  // 松手将加入的组，组边框高亮反馈归属结果；组节点拖拽不参与。
  // 只在归属「将变化」时高亮：悬停在自己当前组内归属不变，高亮即噪音
  const handleNodeDrag = useCallback((_: unknown, rawNode: AnyNode) => {
    if (rawNode.type === NODE_TYPE.GROUP) return;
    const { nodes, setDragOverGroup } = useCanvasStore.getState();
    const next = resolveDropGroupId(nodes, rawNode);
    setDragOverGroup(next && next !== rawNode.parentId ? next : null);
  }, []);

  const handleNodeDragStop = useCallback(
    (_: unknown, rawNode: AnyNode) => {
      canvasInteraction.onNodeDragStop();
      markDirtyImmediate();
      setAlignmentGuides([]);
      useCanvasStore.getState().setDragOverGroup(null);

      const allNodes = useCanvasStore.getState().nodes;
      // 以 store 中的最终位置为准：React Flow 回调里的快照可能滞后
      const draggedNode = allNodes.find((n) => n.id === rawNode.id) ?? rawNode;
      if (draggedNode.type === NODE_TYPE.GROUP) return;

      // 统一判定归属（resolveDropGroupId，与拖入高亮共用同一口径；
      // 成员中心以绝对坐标判定）
      const oldParentId = draggedNode.parentId;
      const nextParentId = resolveDropGroupId(allNodes, draggedNode);

      if (nextParentId === oldParentId) return;

      // 不在此处 pushHistory：拖拽开始（handleNodeDragStart）已压入拖拽前快照，
      // 否则会把"拖动前"状态重复压栈，导致撤销/重做丢失真正的组外状态。
      // 归属变化伴随坐标换算：加入新组 → 绝对位置换算为组内相对；脱离 → 换算回绝对
      const nodeById = buildNodeIndex(allNodes);
      const absPos = nodeAbsolutePosition(draggedNode, nodeById);
      const withMembership = allNodes.map((n) => {
        if (n.id !== draggedNode.id) return n;
        let position = absPos;
        const newParent = nextParentId ? nodeById.get(nextParentId) : undefined;
        if (newParent) {
          position = {
            x: absPos.x - newParent.position.x,
            y: absPos.y - newParent.position.y,
          };
        }
        return { ...n, parentId: nextParentId, position } as AnyNode;
      });

      // 成员全部脱离的旧组：空组即删（唯一口径见 pruneEmptyGroups），
      // 组框重算对已删除的组自然跳过
      const touchedGroupIds = new Set<string>();
      if (oldParentId) touchedGroupIds.add(oldParentId);
      if (nextParentId) touchedGroupIds.add(nextParentId);
      const finalNodes = refitGroupRects(pruneEmptyGroups(withMembership), touchedGroupIds);

      setNodes(finalNodes);
    },
    [canvasInteraction, setAlignmentGuides, setNodes]
  );

  const handlePaneClick = useCallback(() => {
    // React Flow 的 pane 本身不可聚焦；点击画布时主动结束控件焦点，
    // 让 shadcn 控件的 focus-visible ring 不会残留在控制条上。
    const activeElement = document.activeElement;
    if (activeElement instanceof HTMLElement && activeElement !== document.body) {
      activeElement.blur();
    }
    // 点击空白：视为「点击选中」语义，恢复选中态 UI
    canvasInteraction.onClick();
    setGridMenuNodeId(null);
    setToolbarDismissSignal((value) => value + 1);
    // Exit all node editor modes when clicking the canvas pane
    useCanvasStore.getState().closeForeignNodeEditors(null);
    // Deselect all nodes and edges。
    // 无选中项时不重建数组：否则每次点击空白都会产生新的 nodes / edges 引用，
    // 触发下游 useMemo（如 highlightedEdgeIds）与 React Flow 的无谓重算。
    const s = useCanvasStore.getState();
    if (s.nodes.some((n) => n.selected)) {
      setNodes(s.nodes.map((n) => ({ ...n, selected: false })));
    }
    if (s.edges.some((e) => e.selected)) {
      setEdges(s.edges.map((e) => ({ ...e, selected: false })), { skipHistory: true });
    }
  }, [canvasInteraction, setNodes, setEdges]);

  // 右键空白处 → 画布级操作菜单（粘贴 / 全选 / 整理 / 重置视图）。
  // 原生菜单由 use-canvas-events 的 preventCtx 统一屏蔽，这里只负责唤起自定义菜单。
  const handlePaneContextMenu = useCallback((e: React.MouseEvent | MouseEvent) => {
    e.preventDefault();
    useContextMenuStore.getState().show(e.clientX, e.clientY, "canvas");
  }, []);

  // 右键节点 → 节点级操作菜单（复制 / 删除）。
  // 标准行为：若该节点尚未选中，先单选它，让菜单明确作用在它身上。
  const handleNodeContextMenu = useCallback((e: React.MouseEvent, node: AnyNode) => {
    const target = e.target as HTMLElement;
    // 文本节点编辑态（Tiptap contenteditable）与输入框：放行浏览器原生右键菜单，
    // 供复制 / 粘贴 / 拼写检查。与 use-canvas-events 的 preventCtx 同一套豁免选择器。
    if (target.closest("input, textarea, [contenteditable='true'], [contenteditable='']")) return;
    e.preventDefault();
    const store = useCanvasStore.getState();
    if (!node.selected) {
      store.setNodes(store.nodes.map((n) => ({ ...n, selected: n.id === node.id })));
    }
    useContextMenuStore.getState().show(e.clientX, e.clientY, "node", node.id);
  }, []);

  // Explicitly handle node selection — React Flow's internal click detection
  // may miss clicks that land on interactive child elements (inputs, selects, etc.)
  const handleNodeClick = useCallback(
    (_event: React.MouseEvent, node: Record<string, unknown>) => {
      const nodeId = node.id as string;
      // 单击节点（含修饰键点击）属于点击选择，恢复选中态 UI
      canvasInteraction.onClick();
      setGridMenuNodeId(null);
      setToolbarDismissSignal((value) => value + 1);
      // Exit editor modes opened on other nodes
      useCanvasStore.getState().closeForeignNodeEditors(nodeId);
      // 当按下修饰键时，由 React Flow 通过 onNodesChange 处理多选
      if (_event.ctrlKey || _event.metaKey || _event.shiftKey) return;

      setNodes(
        useCanvasStore.getState().nodes.map((n) => ({
          ...n,
          selected: n.id === nodeId,
        }))
      );
    },
    [canvasInteraction, setNodes]
  );

  // 框选开始：标记本次选择来自框选，抑制工具栏/面板渲染（直到下次单击节点/空白）。
  // 注意用 onSelectionStart 而非 onSelectionDragStart：后者依赖“已选中的节点集合”，
  // 框选前若无选中节点则不会触发，导致“框选恰好一个节点”仍弹出工具栏/面板。
  const handleSelectionStart = useCallback(() => {
    canvasInteraction.onSelectionStart();
  }, [canvasInteraction]);

  useGroupOperations();
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
  }, [fitView]);

  /**
   * 整理画布：编排单源在 applyTidyLayout（与 Agent 桥共用）。
   * 排序依据自动选择 —— 有连线走拓扑序（上游在前），否则走读序。
   */
  const handleTidyCanvas = useCallback(() => {
    applyTidyLayout({ fitView });
  }, [fitView]);

  // ---- File drop on canvas → create image node ----

  const shouldIgnoreFileDrop = useCallback((target: HTMLElement) => {
    // 资产弹窗与资产抽屉都不是画布落点：拖到其上不建节点、不触发上传遮罩
    return target.closest('.asset-library-modal, .canvas-asset-drawer') !== null;
  }, []);

  // 资产抽屉卡片拖入画布：在落点直接建资产节点（不走上传管道）
  const handleAssetDrop = useCallback((data: unknown, pos: { x: number; y: number }) => {
    if (!data || typeof data !== "object") return;
    const asset = data as AssetItem;
    const node = createAssetNode(asset, pos, findFreePosition);
    if (node) addNodes([node]);
    message.success(t("asset.added"));
  }, [addNodes, message, t]);

  const canvasContainerRef = useRef<HTMLDivElement | null>(null);
  useCanvasEvents(canvasContainerRef);
  const { handleDragOver, handleDragStart, handleDrop, isFileDragging } = useFileDrop(screenToFlowPosition, shouldIgnoreFileDrop, canvasContainerRef, handleAssetDrop);

  // ---- Component unmount: browser back, route change → save current state ----
  useEffect(() => {
    return () => { flushBeforeUnload(); };
  }, []);

  // 中键拖拽同样能平移，但 React Flow 的 .draggable 只在 panOnDrag 含左键 0 时挂载，
  // 中键按下不会自动变抓手。这里手动补光标，与按住空格的手感保持一致。
  useEffect(() => {
    const el = canvasContainerRef.current;
    if (!el) return;

    const onDown = (e: MouseEvent) => {
      // 只在中键、且确实按在画布内时才切换光标
      if (e.button !== 1 || !el.contains(e.target as Node)) return;
      // d3-zoom 接管中键平移时没有 preventDefault，Windows/Chrome 会弹出中键自动滚动，
      // 它的原生光标会盖住 CSS 抓手。这里在捕获阶段拦掉默认行为（不影响平移本身）。
      e.preventDefault();
      el.classList.add("middle-panning");
    };
    // 中键若在窗口外松开，mouseup 不会派发到 window，靠 blur 兜底复位
    const onUp = () => el.classList.remove("middle-panning");

    // 必须用捕获阶段：中键平移被 React Flow 底层的 d3-zoom 接管后，d3-zoom 会在目标元素上
    // stopImmediatePropagation()，冒泡阶段挂到 window 的监听收不到该事件。
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("mouseup", onUp, true);
    window.addEventListener("blur", onUp);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("mouseup", onUp, true);
      window.removeEventListener("blur", onUp);
      el.classList.remove("middle-panning");
    };
  }, []);

  return (
    <div
      ref={canvasContainerRef}
      className={hideSelectionRect ? "canvas-container hide-selection-rect" : "canvas-container"}
      style={{ width: "100%", height: "100%", position: "relative", overflow: "hidden" }}
      onDragOver={handleDragOver}
      onDragStart={handleDragStart}
      onDrop={handleDrop}
    >
      <AlignmentGuides guides={alignmentGuides} />
      <EdgeHighlightContext.Provider value={highlightedEdgeIds}>
      <BatchConnectContext.Provider value={batchConnectHandlers}>
      <ReactFlow
        data-interaction={canvasInteraction.mode}
        data-multiselect={selectionFrame ? "true" : undefined}
        style={{ "--rail-dot-size": `${RAIL_DOT}px` } as CSSProperties}
        nodes={nodes}
        edges={edges}
        nodeTypes={RF_NODE_TYPES}
        edgeTypes={RF_EDGE_TYPES}
        onNodesChange={handleNodesChange}
        onEdgesChange={handleEdgesChange}
        onConnect={handleConnect}
        onConnectStart={handleConnectStart}
        onConnectEnd={handleConnectEnd}
        isValidConnection={isValidConnection}
        onViewportChange={handleViewportChange}
        onNodeDrag={handleNodeDrag}
        onNodeDragStart={handleNodeDragStart}
        onNodeDragStop={handleNodeDragStop}
        onPaneClick={handlePaneClick}
        onNodeClick={handleNodeClick}
        onPaneContextMenu={handlePaneContextMenu}
        onNodeContextMenu={handleNodeContextMenu}
        onSelectionStart={handleSelectionStart}
        defaultViewport={defaultViewport}
        selectionMode={SelectionMode.Partial}
        nodeDragThreshold={2}
        nodeClickDistance={3}
        multiSelectionKeyCode={["Shift", "Control", "Meta"]}
        deleteKeyCode={[]}
        // RF 的 a11y 焦点路径（节点聚焦后方向键移动）永久关闭：方向键移动由
        // use-canvas-keyboard 统一持有（nudgeSelectedNodes），不依赖焦点状态——
        // 编辑面板打开时其顶部守卫让位给面板滑轨，关闭后即刻恢复，且
        // 「关闭面板后方向键失灵」的焦点归还问题从根上消除
        disableKeyboardA11y
        nodesFocusable={false}
        fitView={false}
        // 画布导航（Figma 约定）：左键拖空白 = 框选，空格+拖拽 或 中键 = 平移。
        // panOnDrag 去掉左键 0、只留中键 1；按住空格时 React Flow 会把 panOnDrag 视为 true。
        panOnDrag={[1]}
        selectionOnDrag={true}
        panActivationKeyCode="Space"
        panOnScroll={false}
        zoomOnScroll={true}
        zoomOnPinch={true}
        zoomOnDoubleClick={false}
        minZoom={0.1}
        maxZoom={5}
        elevateNodesOnSelect={false}
        proOptions={{ hideAttribution: true }}
        colorMode={user?.theme === "light" ? "light" : "dark"}
        // 连线吸附半径：xyflow 的吸附判定取「指针到 Handle 中心」的距离，Handle 中心
        // 在轨道正中（离节点边缘 RAIL_WIDTH/2）。半径盖住可见圆点加余量即可，不能取
        // 轨道外接圆——那会让磁吸远及边缘外 ~97px，相邻轨道（组与成员仅隔
        // GROUP_NODE_PADDING）吸附圈重叠、恒抢错目标；半径内取「最近」的 Handle
        connectionRadius={RAIL_CONNECT_RADIUS}
        connectionLineComponent={ConnectionFlowLine}
        defaultEdgeOptions={{
          type: "deletable",
          animated: false,
          style: { stroke: EDGE_BASE_COLOR, strokeWidth: 2 },
        }}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1.5} color="var(--input)" />

        {/* Top-left panel: quick toolbar */}
        {/* pointer-events: none —— Panel 是绝对定位块，其透明留白（含 30px 内边距）会拦截画布点击与框选；仅内部控件恢复 auto */}
        <Panel position="top-left" style={{ margin: 0, marginLeft: canvasExplorerOpen ? DRAWER_WIDTH : 0, transition: "margin-left 0.2s ease", pointerEvents: "none" }}>
          <div style={{ paddingLeft: 30, paddingTop: 30 }}>
            <Card className="pointer-events-auto flex h-9 w-[280px] shrink-0 flex-row items-center gap-1 rounded-lg border-border bg-card/70 px-2 py-0 backdrop-blur-[10px]">
              <UserMenuPopover
                open={toolbarMenuOpen}
                onOpenChange={setToolbarMenuOpen}
                placement="bottomLeft"
                items={[
                  { key: "home", label: t("project.home") },
                  { type: "divider" },
                  { key: "new", label: t("project.new") },
                  { key: "delete", label: t("project.delete") },
                ]}
                onItemClick={(key) => {
                  if (key === "home") {
                    void (async () => {
                      await flushAndWait();
                      router.push("/project");
                    })();
                  } else if (key === "new") {
                    void (async () => {
                      await flushAndWait();
                      await useProjectStore.getState().createProject();
                      // 画布身份以 URL 为准：router.replace 触发页面层拉取并恢复，
                      // loader 门随后放行新画布（恢复入口收口在 page.tsx）
                      router.replace(`/canvas/${useProjectStore.getState().activeProjectId}`);
                    })();
                  } else if (key === "delete") {
                    setDeleteConfirmOpen(true);
                  }
                }}
                onLogout={() => setLogoutConfirmOpen(true)}
                trigger={
                  <Button type="button" variant="ghost" size="sm" aria-label={t("auth.accountSettings")} className="h-7 shrink-0 gap-1 rounded px-1">
                    <img src="/favicon.ico" alt="Noxrea" style={{ width: 24, height: 24 }} />
                    <ChevronDownIcon
                      className="shrink-0 transition-transform duration-200"
                      style={{ width: 10, height: 10, transform: toolbarMenuOpen ? "rotate(180deg)" : "none" }}
                    />
                  </Button>
                }
              />
              <Separator orientation="vertical" className="mx-0.5 h-5" />
              {isEditingName ? (
                <Input
                  className="bg-transparent text-sm outline-none border-none flex-1 min-w-0"
                  style={{ height: 24, cursor: "text" }}
                  placeholder={t("project.untitled")}
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
                    if (e.nativeEvent.isComposing) return;
                    if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                    if (e.key === "Escape") { setIsEditingName(false); setEditName(projectName); }
                  }}
                />
              ) : (
                /* 编辑入口对齐节点标题：双击文字或点悬停铅笔（样式见 NodeTitle） */
                <div
                  className="flex items-center flex-1 min-w-0 group/name"
                  style={{ height: 24 }}
                >
                  <div
                    className="text-sm min-w-0 truncate"
                    style={{ color: "var(--foreground)", height: 24, lineHeight: "24px", cursor: "default", userSelect: "none" }}
                    onDoubleClick={() => setIsEditingName(true)}
                  >
                    {editName || "Untitled"}
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    aria-label={t("common.edit")}
                    className="ml-1.5 shrink-0 opacity-0 transition-opacity group-hover/name:opacity-100 focus-visible:opacity-100"
                    onClick={() => setIsEditingName(true)}
                  >
                    <EditOutlined />
                  </Button>
                </div>
              )}
            </Card>

          </div>
        </Panel>

        {/* Bottom-left panel: minimap + controls */}
        {/* pointer-events: none —— 小地图(180)比控制条窄，其右侧透明留白会拦截画布点击与框选 */}
        <Panel position="bottom-left" style={{ margin: 0, marginLeft: canvasExplorerOpen ? DRAWER_WIDTH : 0, transition: "margin-left 0.2s ease", pointerEvents: "none" }}>
          <div className="flex flex-col gap-2" style={{ paddingLeft: 30, paddingBottom: 30 }}>
            {minimapVisible && (
              <MiniMap
                pannable
                zoomable
                // React Flow 会在小地图 SVG 里自动渲染 <title>（悬停出原生英文提示）；
                // 该版本实现是 ariaLabel ?? 默认文案，传 null 会回落到默认，必须传空串才短路掉 <title>
                ariaLabel=""
                style={{
                  // Panel 默认 absolute + bottom/right 定位，改为 relative 才能排进下方的纵向 flex 流
                  position: "relative",
                  border: "1px solid var(--border, #3a3a3a)",
                  width: 180,
                  height: 120,
                  pointerEvents: "auto",
                }}
                // 小地图不按类型着色，用库默认节点色（类型区分由画布本体的图标/颜色承担）
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
        <Panel position="top-right" style={{ margin: 0, paddingRight: 30, paddingTop: 30, pointerEvents: "none" }}>
          <div className="flex items-center gap-2" style={{ pointerEvents: "auto" }}>
            <OfflineIndicator />
            <button
              type="button"
              onClick={() => setChatOpen(true)}
              className="canvas-agent-btn"
            >
              <AgentIcon style={{ width: 22, height: 22 }} />
              <span className="text-base font-medium">{t("agent.title")}</span>
            </button>
          </div>
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

        {/* 帧序列面板 — 跟随选中视频节点，不随画布缩放，轨道尺寸恒定 */}
        {frameStripNode && (
          <RfNodeToolbar nodeId={frameStripNode.id} position={Position.Bottom} align="center" offset={12} style={{ zIndex: 9999 }}>
            <FrameStripPanel
              // key 带 src：换源（替换/生成回填）时面板整体重挂，播放头与
              // 代理状态对新源重新初始化，而不是拿旧选区比例套新视频
              key={`${frameStripNode.id}:${(frameStripNode.data as { src?: string }).src ?? ""}`}
              nodeId={frameStripNode.id}
              videoSrc={(frameStripNode.data as { src?: string }).src ?? ""}
              onClose={closeFrameStripPanel}
            />
          </RfNodeToolbar>
        )}

        {/* 片段截取面板 — 与帧序列面板同构互斥：打开其一时先关掉另一个 */}
        {clipStripNode && (
          <RfNodeToolbar nodeId={clipStripNode.id} position={Position.Bottom} align="center" offset={12} style={{ zIndex: 9999 }}>
            <ClipStripPanel
              // key 带 src（与音频截取面板一致）：换源时面板重挂，选区与代理
              // 对新源重新初始化——否则旧区间比例会被静默套在新视频时长上
              key={`${clipStripNode.id}:${(clipStripNode.data as { src?: string }).src ?? ""}`}
              nodeId={clipStripNode.id}
              videoSrc={(clipStripNode.data as { src?: string }).src ?? ""}
              onClose={closeClipStripPanel}
            />
          </RfNodeToolbar>
        )}

        {/* 图片打光面板 — 跟随选中图片节点，不随画布缩放，尺寸恒定 */}
        {lightingNode && (
          <RfNodeToolbar nodeId={lightingNode.id} position={Position.Bottom} align="center" offset={12} style={{ zIndex: 9999 }}>
            <LightingPanel
              key={lightingNode.id}
              src={(lightingNode.data as ImageNodeData).src ?? ""}
              nodeId={lightingNode.id}
              onClose={closeLightingPanel}
            />
          </RfNodeToolbar>
        )}

        {/* 多视角编辑面板 — 与打光面板同形态，悬浮于选中图片节点下方 */}
        {angleEditorNode && (
          <RfNodeToolbar nodeId={angleEditorNode.id} position={Position.Bottom} align="center" offset={12} style={{ zIndex: 9999 }}>
            <MultiAngleEditor
              key={angleEditorNode.id}
              nodeId={angleEditorNode.id}
              src={(angleEditorNode.data as ImageNodeData).src ?? ""}
              onClose={closeAngleEditorPanel}
            />
          </RfNodeToolbar>
        )}

        {/* 音频片段截取面板 — 与视频片段截取面板同构互斥：选区操作全部在下方悬浮面板内 */}
        {audioClipNode && (
          <RfNodeToolbar nodeId={audioClipNode.id} position={Position.Bottom} align="center" offset={12} style={{ zIndex: 9999 }}>
            <AudioClipStripPanel
              key={`${audioClipNode.id}:${(audioClipNode.data as { src?: string }).src ?? ""}`}
              nodeId={audioClipNode.id}
              audioSrc={(audioClipNode.data as { src?: string }).src ?? ""}
              onClose={closeAudioClipPanel}
            />
          </RfNodeToolbar>
        )}

        {/* Node toolbars — 仅空闲/点击选中态显示（框选与拖动节点期间不渲染） */}
        {canvasInteraction.showSelectionChrome && Array.from(selectedNodeIds).map((nid) => {
          const n = nodes.find((x) => x.id === nid);
          return (
          <RfNodeToolbar key={nid} nodeId={nid} position={Position.Top} align="center" offset={8}>
            {(isNodeInUiState({ multiExpandedNodeId, annotatingNodeId, croppingNodeId, editingTextNodeId, frameCaptureNodeId, clipCaptureNodeId, lightingNodeId, audioClipNodeId, angleEditorNodeId, panoramaNodeId }, nid)) ? null : (
              <NodeToolbarUI
                nodeId={nid}
                nodeType={n?.type}
                onShowInspector={(id) => setInspectedNodeId(id)}
                onOpenFrameStrip={(id) => useCanvasStore.getState().setFrameCaptureNodeId(id)}
                onOpenClipStrip={(id) => useCanvasStore.getState().setClipCaptureNodeId(id)}
                onOpenAudioClip={(id) => useCanvasStore.getState().setAudioClipNodeId(id)}
                onOpenLighting={(id) => useCanvasStore.getState().setLightingNodeId(id)}
                gridOpen={gridMenuNodeId === nid}
                onGridOpenChange={handleGridMenuOpenChange}
                dismissSignal={toolbarDismissSignal}
              />
            )}
          </RfNodeToolbar>
        )})}

        {/* 批量连线轨道（框选外框专用，右缘 = 输出方向）：≥2 个非组节点选中时，
            条带锚在外框右缘正中、自此向右延伸，参与集 = 选中节点，常显（外框不是
            节点，无显隐规则可依托）。条带高取常量 RAIL_WIDTH（外框恒高于 80px）。
            组节点的批量轨道由 GroupNode 内部的 GroupConnectRail 渲染 */}
        {selectionFrame && (
          <BatchConnectHandle
            anchor={{
              x: selectionFrame.bbox.x + selectionFrame.bbox.width + GROUP_NODE_PADDING,
              y: selectionFrame.bbox.y + selectionFrame.bbox.height / 2,
            }}
            participantIds={selectionFrame.ids}
            onConnect={batchConnect}
            onConnectToBlank={openBatchCreateMenu}
            onDragStart={canvasInteraction.onConnectStart}
            onDragEnd={canvasInteraction.onConnectEnd}
            screenToFlowPosition={screenToFlowPosition}
          />
        )}

        {/* 拖拽连线落在空白、弹出创建菜单期间：持续渲染绿色流光预览线。
            多选扇出时每个选中节点一根（与拖拽中的束线预览一致），单节点即一根；
            锚点按 direction 取节点右/左边缘正中，无有效盒尺寸的节点跳过 */}
        {pendingConnectionCreate &&
          pendingPreviewAnchors.map((anchor, i) => (
            <PendingConnectionPreview
              key={i}
              from={anchor}
              to={pendingConnectionCreate.canvasPosition}
              fromPosition={pendingConnectionCreate.direction === "output" ? Position.Right : Position.Left}
            />
          ))}
      </ReactFlow>
      </BatchConnectContext.Provider>
      </EdgeHighlightContext.Provider>

      <CanvasContextMenu
        onAddText={handleAddText}
        onAddImage={handleAddImage}
        onAddVideo={handleAddVideo}
        onAddAudio={handleAddAudio}
        onAddDirector={handleAddDirector}
        onTidy={handleTidyCanvas}
        tidyDisabled={tidyDisabled}
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
        content={t("project.deleteConfirm", { name: projectName })}
        okText={t("common.delete")}
        confirmVariant="destructive"
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
          setLogoutConfirmOpen(false);
          // 等 cookie 清除完成再导航，否则 proxy.ts 仍凭 cookie 放行并弹回应用
          void useAuthStore.getState().logout().finally(() => router.push("/"));
        }}
        onCancel={() => setLogoutConfirmOpen(false)}
      />

      <AssetsDialog
        open={assetsOpen}
        onClose={() => setAssetsOpen(false)}
      />

      <CanvasExplorer
        open={canvasExplorerOpen}
        onClose={() => setCanvasExplorerOpen(false)}
      />

      {/* Agent 运行时桥：把 React Flow 实例能力注册给工具执行器 */}
      <CanvasAgentRuntimeBridge />

      <CanvasAgentDrawer
        open={chatOpen}
        onClose={() => setChatOpen(false)}
        projectId={activeProjectId ?? undefined}
      />

      {/* 拖入文件时的全屏模糊遮罩 + 释放提示 */}
      {isFileDragging && (
        <div
          className="absolute inset-0 z-50 flex items-center justify-center backdrop-blur-md"
          style={{ background: "color-mix(in srgb, var(--card) 55%, transparent)", pointerEvents: "none" }}
        >
          <div
            className="flex flex-col items-center gap-4 rounded-2xl px-16 py-12"
            style={{ border: "2px dashed var(--input)", background: "color-mix(in srgb, var(--card) 40%, transparent)" }}
          >
            <DirUploadIcon
              className="animate-bounce"
              style={{ width: 56, height: 56, color: "var(--primary)" }}
            />
            <div className="text-lg font-medium" style={{ color: "var(--foreground)" }}>
              {t("file.dropToAdd")}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
