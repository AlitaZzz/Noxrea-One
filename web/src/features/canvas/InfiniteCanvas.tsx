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
import { App } from "antd";
import { useRouter } from "next/navigation";
import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import OfflineIndicator from "@/components/layout/OfflineIndicator";
import ConfirmModal from "@/components/ui/ConfirmModal";
import { AgentIcon } from "@/components/ui/icons/canvas/AgentIcon";
import { ChevronDownIcon } from "@/components/ui/icons/common/ChevronDownIcon";
import { DirUploadIcon } from "@/components/ui/icons/director/DirUploadIcon";
import { MenuDivider, MenuItem, MenuPopover } from "@/components/ui/MenuPopover";
import { createAssetNode } from "@/features/assets/add-asset";
import AssetsModal from "@/features/assets/components/AssetsModal";
import { useAssetsStore } from "@/features/assets/store";
import type { AssetItem } from "@/features/assets/types";
import { useAuthStore } from "@/features/auth/store";
import { useCurrentUser } from "@/features/auth/UserContext";
import CanvasAgentDrawer from "@/features/canvas/agent/components/AgentDrawer";
import CanvasAgentRuntimeBridge from "@/features/canvas/agent/Runtime";
import { runSuppressed } from "@/features/canvas/agent/user-action-tracker";
import AlignmentGuides from "@/features/canvas/controls/AlignmentGuides";
import CanvasContextMenu from "@/features/canvas/controls/CanvasContextMenu";
import CanvasControls from "@/features/canvas/controls/CanvasControls";
import ConnectionCreateMenu, { type PendingConnectionCreate } from "@/features/canvas/controls/ConnectionCreateMenu";
import ConnectionFlowLine from "@/features/canvas/controls/ConnectionFlowLine";
import DeletableEdge from "@/features/canvas/controls/DeletableEdge";
import PendingConnectionPreview from "@/features/canvas/controls/PendingConnectionPreview";
import SelectionFrameHandles from "@/features/canvas/controls/SelectionFrameHandles";
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
import { isTidyAnimating, useTidyAnimation } from "@/features/canvas/hooks/use-tidy-animation";
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
import { computeFittedGroupRect } from "@/features/canvas/shared/group-bounds";
import { bumpRefOrderToTail } from "@/features/canvas/shared/ref-order";
import { computeTidyLayout } from "@/features/canvas/shared/tidy-layout";
import { findFreePosition, flushAndWait, flushOnUnload, markDirty, markDirtyImmediate, syncLiveViewport, takeCanvasSnapshot, useCanvasStore } from "@/features/canvas/stores/canvas-store";
import { useContextMenuStore } from "@/features/canvas/stores/context-menu-store";
import { useHistoryStore } from "@/features/canvas/stores/history-store";
import type { AnyNode, ImageNodeData, VideoNodeData } from "@/features/canvas/types";
import { useProjectStore } from "@/features/project/store";
import ApiSettingsDrawer from "@/features/settings/ApiSettingsDrawer";
import { useSseTaskMonitor } from "@/hooks/use-sse-task-monitor";
import { canConnect, EDGE_BASE_COLOR, HANDLE_SIZE, LAYOUT_GAP, NODE_TYPE, RAIL_CONNECT_RADIUS, RAIL_DOT, TIDY_ANIMATION_DURATION, TIDY_MAX_ANIMATED_NODES } from "@/lib/constants";
import { showGlobalMessage } from "@/lib/global-message";
import { useModelStore } from "@/lib/model-store";
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
  const { notification: notif } = App.useApp();
  useSseTaskMonitor(notif);

  // Canvas state
  const nodes = useCanvasStore((s) => s.nodes);
  const edges = useCanvasStore((s) => s.edges);
  const setNodes = useCanvasStore((s) => s.setNodes);
  const setEdges = useCanvasStore((s) => s.setEdges);
  const addNodes = useCanvasStore((s) => s.addNodes);
  const background = useCanvasStore((s) => s.background);
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
    const groupIds = new Set(
      nodes.filter((n) => n.type === NODE_TYPE.GROUP).map((n) => n.id),
    );
    const topLevel = nodes.filter((n) => {
      if (n.type === NODE_TYPE.GROUP) return true;
      const gid = (n.data as { groupId?: string } | undefined)?.groupId;
      return !gid || !groupIds.has(gid);
    });
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

  // 多选外框批量连线：≥2 个非组节点选中时，外框右缘出现批量输出 Handle
  const selectionFrame = useMemo(() => {
    const sel = nodes.filter((n) => n.selected && n.type !== NODE_TYPE.GROUP);
    if (sel.length < 2) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of sel) {
      const w = Number(n.style?.width) || n.measured?.width || 200;
      const h = Number(n.style?.height) || n.measured?.height || 120;
      minX = Math.min(minX, n.position.x);
      minY = Math.min(minY, n.position.y);
      maxX = Math.max(maxX, n.position.x + w);
      maxY = Math.max(maxY, n.position.y + h);
    }
    return { ids: sel.map((n) => n.id), bbox: { x: minX, y: minY, width: maxX - minX, height: maxY - minY } };
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
  const authUser = useCurrentUser();
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
      // 项目恢复是程序化写入，不算用户操作，不进动作历史
      runSuppressed(() => useCanvasStore.getState().restoreFromProject(project));
      // defaultViewport 仅首次挂载生效，切换项目需手动同步 React Flow 内部 viewport
      const vp = useCanvasStore.getState().viewport;
      setRfViewport(vp, { duration: 0 });
      // 切换/加载项目 = 历史归零。修复 undo 弹出即应用后不再需要基线快照
      // （旧基线是为了规避 undo 偏移下的 emptySnapshot 兜底），同时避免
      // 撤销穿透到上一个项目的画布内容。
      useHistoryStore.getState().clear();
    }
  }, [activeProjectId, setRfViewport]);

  // 编辑态（标注 / 裁剪 / 选帧 / 片段截取 / 音频片段截取 / 图片打光 / 多视角）激活的节点：生成面板必须让位，
  // 否则同一节点会同时挂上下两个浮层（生成面板在下方，编辑条也在附近）
  const editingNodeId = annotatingNodeId ?? croppingNodeId ?? frameCaptureNodeId ?? clipCaptureNodeId ?? audioClipNodeId ?? lightingNodeId ?? angleEditorNodeId;

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
    if (audioClipNodeId && !audioClipNode) st.setAudioClipNodeId(null);
    if (croppingNodeId && !cropNode) st.setCroppingNodeId(null);
  }, [
    frameCaptureNodeId, frameStripNode,
    clipCaptureNodeId, clipStripNode,
    lightingNodeId, lightingNode,
    angleEditorNodeId, angleEditorNode,
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
  const { animateTo, cancel: cancelTidy } = useTidyAnimation();

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

      // 整理动画播放期间用户开始拖拽：立即取消动画，
      // 否则动画每帧写入的位置会与 React Flow 的拖拽状态互相覆盖
      if (isTidyAnimating() && positionChanges.length > 0) {
        cancelTidy();
      }

      let appliedNodes: AnyNode[];
      let newGuides: AlignmentGuide[] = [];

      // 提前检测正在被拖拽的组节点（可能同时拖多个组），并收集各自成员节点 ID。
      // 成员节点在分组拖动时只需跟随平移，不应被独立磁吸，否则会导致累积偏移。
      const draggedGroups = positionChanges
        .map((c) => currentNodes.find((n) => n.id === c.id))
        .filter((n): n is AnyNode => n?.type === NODE_TYPE.GROUP);
      const draggedGroupIds = new Set(draggedGroups.map((g) => g.id));
      const groupChildIds = new Set<string>();
      if (draggedGroups.length > 0) {
        for (const n of currentNodes) {
          if (n.type !== NODE_TYPE.GROUP && n.data?.groupId && draggedGroupIds.has(n.data.groupId)) {
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

      // 拖动组节点时，手动把同 groupId 的成员节点同步平移相同 delta（支持多组同拖，
      // 每个组按自身 delta 平移各自成员）。关键：delta 必须基于分组节点吸附后的
      // 最终位置来计算，而非 React Flow 报告的原始位置，否则分组与成员之间
      // 会产生累积偏移。
      let finalNodes = appliedNodes;
      if (draggedGroups.length > 0) {
        finalNodes = appliedNodes.map((n) => {
          if (n.type === NODE_TYPE.GROUP) return n;
          const gid = n.data?.groupId;
          if (!gid || !draggedGroupIds.has(gid)) return n;
          const groupNode = currentNodes.find((g) => g.id === gid);
          const snappedGroup = appliedNodes.find((g) => g.id === gid);
          if (!groupNode || !snappedGroup) return n;
          const deltaX = snappedGroup.position.x - groupNode.position.x;
          const deltaY = snappedGroup.position.y - groupNode.position.y;
          if (deltaX === 0 && deltaY === 0) return n;
          return { ...n, position: { x: n.position.x + deltaX, y: n.position.y + deltaY } };
        });
      }

      setNodes(finalNodes);
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
      const state = useCanvasStore.getState();
      const nodeById = new Map(state.nodes.map((n) => [n.id, n]));
      const src = nodeById.get(connection.source || "");
      const tgt = nodeById.get(connection.target || "");
      if (!src || !tgt) return;

      // 多选扇出：拖线起点/终点在多选集合（≥2 非组节点）中时，
      // 扩展为「所有选中节点 ↔ 对端节点」的批量连线，逐个按类型校验
      const selected = state.nodes.filter((n) => n.selected && n.type !== NODE_TYPE.GROUP);
      const pairs: { source: string; target: string }[] = [];
      const inSelection = (n: AnyNode) => selected.some((s) => s.id === n.id);
      if (selected.length > 1 && inSelection(src) && !inSelection(tgt)) {
        for (const s of selected) {
          if (canConnect(s.type, tgt.type)) pairs.push({ source: s.id, target: tgt.id });
        }
      } else if (selected.length > 1 && inSelection(tgt) && !inSelection(src)) {
        for (const t of selected) {
          if (canConnect(src.type, t.type)) pairs.push({ source: src.id, target: t.id });
        }
      } else {
        pairs.push({ source: src.id, target: tgt.id });
      }
      batchConnect(pairs);
    },
    [batchConnect]
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
      // 仅在连接未落到目标节点（空白画布）上时弹出菜单
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

      // 计算发起端连线锚点在画布坐标系中的坐标，供菜单期间持续渲染预览线。
      // 锚点恒为节点边缘垂直正中（圆点跟随只是视觉反馈，见 ConnectionSideRail）：
      // source Handle 在节点右侧、target Handle 在节点左侧
      const sourceWidth = sourceNode.measured?.width ?? sourceNode.width ?? 0;
      const sourceHeight = sourceNode.measured?.height ?? sourceNode.height ?? 0;
      const sourceAnchor: { x: number; y: number } =
        direction === "output"
          ? { x: sourceNode.position.x + sourceWidth, y: sourceNode.position.y + sourceHeight / 2 }
          : { x: sourceNode.position.x, y: sourceNode.position.y + sourceHeight / 2 };

      setPendingConnectionCreate({
        sourceNodeIds: [sourceNode.id],
        sourceNodeTypes: [sourceNode.type ?? ""],
        direction,
        canvasPosition,
        screenPosition: { x: clientX, y: clientY },
        sourceAnchor,
      });
    },
    [screenToFlowPosition, canvasInteraction]
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

      addNodes([newNode]);
      // 批量接线：逐个按类型校验（批量连线时部分选中节点可能不兼容新节点类型），
      // 输出方向：各选中节点 → 新节点；输入方向：新节点 → 各选中节点
      const nodeById = new Map(useCanvasStore.getState().nodes.map((n) => [n.id, n]));
      const pairs = sourceNodeIds
        .map((id) => nodeById.get(id))
        .filter((n): n is AnyNode => !!n)
        .flatMap((n) => {
          const ok = direction === "output" ? canConnect(n.type, newNode.type) : canConnect(newNode.type, n.type);
          if (!ok) return [];
          return [
            direction === "output"
              ? { source: n.id, target: newNode.id }
              : { source: newNode.id, target: n.id },
          ];
        });
      batchConnect(pairs);
    },
    [pendingConnectionCreate, addNodes, batchConnect]
  );

  /** 框选外框 Handle（右缘 = 输出方向）拖到已有节点：批量扇出，逐个按类型校验 */
  const connectSelectionToNode = useCallback(
    (selectedIds: string[], targetId: string) => {
      const nodeById = new Map(useCanvasStore.getState().nodes.map((n) => [n.id, n]));
      const tgt = nodeById.get(targetId);
      if (!tgt) return;
      const pairs = selectedIds
        .map((id) => nodeById.get(id))
        .filter((n): n is AnyNode => !!n && n.id !== targetId)
        .flatMap((n) => (canConnect(n.type, tgt.type) ? [{ source: n.id, target: targetId }] : []));
      batchConnect(pairs);
    },
    [batchConnect]
  );

  /** 框选外框 Handle 拖到空白：弹出「创建连接节点」菜单，创建后批量接驳全部选中节点 */
  const openSelectionCreateMenu = useCallback(
    (
      selectedIds: string[],
      canvasPosition: { x: number; y: number },
      screenPosition: { x: number; y: number },
      sourceAnchor: { x: number; y: number }
    ) => {
      const selected = useCanvasStore.getState().nodes.filter((n) => selectedIds.includes(n.id));
      if (selected.length === 0) return;
      setPendingConnectionCreate({
        sourceNodeIds: selected.map((n) => n.id),
        sourceNodeTypes: selected.map((n) => n.type ?? ""),
        direction: "output",
        canvasPosition,
        screenPosition,
        sourceAnchor,
      });
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
    canvasInteraction.onNodeDragStart();
  }, [pushHistory, canvasInteraction]);

  const handleNodeDragStop = useCallback(
    (_: unknown, rawNode: AnyNode) => {
      canvasInteraction.onNodeDragStop();
      markDirtyImmediate();
      setAlignmentGuides([]);

      const allNodes = useCanvasStore.getState().nodes;
      // 以 store 中的最终位置为准：拖组时成员位置由组 delta 同步，
      // React Flow 内部状态与 store 可能不一致
      const draggedNode = allNodes.find((n) => n.id === rawNode.id) ?? rawNode;
      if (draggedNode.type === NODE_TYPE.GROUP) return;

      const nodeW = Number(draggedNode.style?.width) || draggedNode.width || 0;
      const nodeH = Number(draggedNode.style?.height) || draggedNode.height || 0;
      const centerX = draggedNode.position.x + nodeW / 2;
      const centerY = draggedNode.position.y + nodeH / 2;
      const insideGroup = (g: AnyNode) => {
        const gw = Number(g.style?.width) || g.width || 0;
        const gh = Number(g.style?.height) || g.height || 0;
        return (
          centerX >= g.position.x &&
          centerX <= g.position.x + gw &&
          centerY >= g.position.y &&
          centerY <= g.position.y + gh
        );
      };

      // 统一判定归属：中心点仍在原组内 → 不变；离开原组 / 原组已不存在 →
      // 按落点重新判定（一次拖拽即可完成跨组换组或脱离）
      const oldGroupId = draggedNode.data?.groupId;
      const oldGroup = oldGroupId
        ? allNodes.find((n) => n.type === NODE_TYPE.GROUP && n.id === oldGroupId)
        : undefined;
      let nextGroupId: string | undefined = oldGroupId;
      if (!oldGroup || !insideGroup(oldGroup)) {
        nextGroupId = allNodes.find((n) => n.type === NODE_TYPE.GROUP && insideGroup(n))?.id;
      }

      if (nextGroupId === oldGroupId) return;

      // 不在此处 pushHistory：拖拽开始（handleNodeDragStart）已压入拖拽前快照，
      // 否则会把"拖动前"状态重复压栈，导致撤销/重做丢失真正的组外状态。
      const withMembership = allNodes.map((n) =>
        n.id === draggedNode.id
          ? ({ ...n, data: { ...n.data, groupId: nextGroupId } } as AnyNode)
          : n
      );

      // 组框随成员变化自适应：加入 → 扩张覆盖成员（只扩不缩）；
      // 脱离后变空 → 收缩到最小尺寸，避免留下巨大空壳
      const touchedGroupIds = new Set<string>();
      if (oldGroupId) touchedGroupIds.add(oldGroupId);
      if (nextGroupId) touchedGroupIds.add(nextGroupId);
      const finalNodes = withMembership.map((n) => {
        if (n.type !== NODE_TYPE.GROUP || !touchedGroupIds.has(n.id)) return n;
        const members = withMembership.filter(
          (m) => m.type !== NODE_TYPE.GROUP && m.data?.groupId === n.id
        );
        const rect = computeFittedGroupRect(n, members);
        if (!rect) return n;
        return {
          ...n,
          position: { x: rect.x, y: rect.y },
          style: { ...n.style, width: rect.width, height: rect.height },
        } as AnyNode;
      });

      setNodes(finalNodes);
    },
    [canvasInteraction, markDirtyImmediate, setAlignmentGuides, setNodes]
  );

  const handlePaneClick = useCallback(() => {
    // 点击空白：视为「点击选中」语义，恢复选中态 UI
    canvasInteraction.onClick();
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
  }, [fitView]);

  /**
   * 整理画布：把所有节点重排为整齐网格，分组连同成员作为整体块平移。
   * 排序依据自动选择 —— 有连线走拓扑序（上游在前），否则走读序。
   */
  const handleTidyCanvas = useCallback(() => {
    const store = useCanvasStore.getState();
    if (store.nodes.length < 2) return;

    const result = computeTidyLayout(store.nodes, store.edges, {
      mode: "auto",
      snapSize: store.snapToGrid ? store.snapGridSize : 0,
    });
    if (result.movedCount === 0) return;

    // setNodes 不自动压栈，整理前显式压一次，保证整块布局可一步撤销
    useHistoryStore.getState().push(takeCanvasSnapshot());

    // 节点过多时直接落位，避免每帧 setNodes 掉帧
    if (result.movedCount > TIDY_MAX_ANIMATED_NODES) {
      setNodes(
        store.nodes.map((n) => {
          const p = result.positions.get(n.id);
          return p ? { ...n, position: p } : n;
        }),
      );
      markDirtyImmediate();
      fitView({ duration: 300 });
      return;
    }

    animateTo(result.positions, {
      duration: TIDY_ANIMATION_DURATION,
      onDone: () => {
        markDirtyImmediate();
        fitView({ duration: 300 });
      },
    });
  }, [animateTo, fitView, setNodes]);

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
    showGlobalMessage().success(t("asset.added"));
  }, [addNodes, t]);

  const canvasContainerRef = useRef<HTMLDivElement | null>(null);
  const { handleDragOver, handleDragStart, handleDrop, isFileDragging } = useFileDrop(screenToFlowPosition, shouldIgnoreFileDrop, canvasContainerRef, handleAssetDrop);

  // ---- Component unmount: browser back, route change → save current state ----
  useEffect(() => {
    return () => { flushOnUnload(); };
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
      <ReactFlow
        data-interaction={canvasInteraction.mode}
        style={{ "--handle-size": `${HANDLE_SIZE}px`, "--rail-dot-size": `${RAIL_DOT}px` } as CSSProperties}
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
        colorMode="dark"
        // 连线吸附半径：xyflow 的吸附判定取「指针到 Handle 中心」的距离，Handle 中心
        // 在轨道正中（离节点边缘 RAIL_WIDTH/2），要整条轨道（最远到四角）都能吸附落线，
        // 取轨道外接圆半径。放大是安全的——React Flow 在半径内取「最近」的 Handle
        connectionRadius={RAIL_CONNECT_RADIUS}
        connectionLineComponent={ConnectionFlowLine}
        defaultEdgeOptions={{
          type: "deletable",
          animated: false,
          style: { stroke: EDGE_BASE_COLOR, strokeWidth: 2 },
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
        {/* pointer-events: none —— Panel 是绝对定位块，其透明留白（含 30px 内边距）会拦截画布点击与框选；仅内部控件恢复 auto */}
        <Panel position="top-left" style={{ margin: 0, marginLeft: canvasExplorerOpen ? DRAWER_WIDTH : 0, transition: "margin-left 0.2s ease", pointerEvents: "none" }}>
          <div style={{ paddingLeft: 30, paddingTop: 30 }}>
            <div
              className="flex h-9 shrink-0 items-center gap-1 rounded-lg px-2 transition-colors w-[280px] select-none"
              style={{
                // 磨砂玻璃：背景 70% 不透明度 + 背景模糊，透出并柔化画布内容
                background: "color-mix(in srgb, var(--canvas-bg) 70%, transparent)",
                backdropFilter: "blur(10px)",
                WebkitBackdropFilter: "blur(10px)",
                border: "1px solid var(--canvas-border)",
                pointerEvents: "auto",
              }}
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
                        runSuppressed(() => useCanvasStore.getState().restoreFromProject(proj));
                        // 画布身份以 URL 为准，新建后同步地址（replace 避免堆积历史记录）；
                        // 视口同步由 activeProjectId effect 完成（restoreFromProject 置默认视口 → setRfViewport）
                        router.replace(`/canvas/${proj.id}`);
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
                  border: "1px solid var(--canvas-border, #3a3a3a)",
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
            {(annotatingNodeId === nid || croppingNodeId === nid || editingTextNodeId === nid || frameCaptureNodeId === nid || clipCaptureNodeId === nid || audioClipNodeId === nid || lightingNodeId === nid || angleEditorNodeId === nid || multiExpandedNodeId === nid || (n?.type === NODE_TYPE.IMAGE && (n?.data as ImageNodeData | undefined)?.panorama)) ? null : (
              <NodeToolbarUI
                nodeId={nid}
                nodeType={n?.type}
                onShowInspector={(id) => setInspectedNodeId(id)}
                onOpenFrameStrip={(id) => useCanvasStore.getState().setFrameCaptureNodeId(id)}
                onOpenClipStrip={(id) => useCanvasStore.getState().setClipCaptureNodeId(id)}
                onOpenAudioClip={(id) => useCanvasStore.getState().setAudioClipNodeId(id)}
                onOpenLighting={(id) => useCanvasStore.getState().setLightingNodeId(id)}
              />
            )}
          </RfNodeToolbar>
        )})}

        {/* 框选外框批量连线 Handle（≥2 个非组节点选中时出现） */}
        {selectionFrame && (
          <SelectionFrameHandles
            bbox={selectionFrame.bbox}
            selectedIds={selectionFrame.ids}
            onConnectToNode={connectSelectionToNode}
            onConnectToBlank={openSelectionCreateMenu}
            onDragStart={canvasInteraction.onConnectStart}
            onDragEnd={canvasInteraction.onConnectEnd}
            screenToFlowPosition={screenToFlowPosition}
          />
        )}

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

      <AssetsModal
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
          style={{ background: "color-mix(in srgb, var(--canvas-bg) 55%, transparent)", pointerEvents: "none" }}
        >
          <div
            className="flex flex-col items-center gap-4 rounded-2xl px-16 py-12"
            style={{ border: "2px dashed var(--canvas-border-light)", background: "color-mix(in srgb, var(--canvas-bg) 40%, transparent)" }}
          >
            <DirUploadIcon
              className="animate-bounce"
              style={{ width: 56, height: 56, color: "var(--canvas-accent)" }}
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
