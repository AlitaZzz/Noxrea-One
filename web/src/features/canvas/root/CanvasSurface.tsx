/**
 * 画布主体：装配 React Flow 实例（节点/边类型注册、视口与选区行为），
 * 编排节点增删改、连线、编组、对齐吸附、文件拖入等交互 hook；图层浮层由
 * CanvasOverlays 统一编排（节点级/全局级分文件），本组件只持有浮层状态。
 * 页面壳（项目/用户菜单、资产库、设置、快捷键、Director）不在本组件内，
 * 由 CanvasRoot 与页面层通过端口/插槽装配。
 */

"use client";

import "@xyflow/react/dist/style.css";

import {
  type Edge,
  ReactFlow,
  useReactFlow,
  useStore,
  useStoreApi,
} from "@xyflow/react";
import { type CSSProperties, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { useThemeMode } from "@/components/ui/theme-mode";
import { useAppFeedback } from "@/components/ui/use-app-feedback";
import type { AssetItem } from "@/entities/asset";
import { createAssetNode } from "@/features/canvas/assets/create-asset-node";
import AlignmentGuides from "@/features/canvas/controls/AlignmentGuides";
import { BatchConnectContext } from "@/features/canvas/controls/BatchConnectContext";
import { CanvasDotGrid } from "@/features/canvas/controls/CanvasDotGrid";
import ConnectionFlowLine from "@/features/canvas/controls/ConnectionFlowLine";
import DeletableEdge from "@/features/canvas/controls/DeletableEdge";
import { EdgeBaseWidthVariable } from "@/features/canvas/controls/EdgeBaseWidthVariable";
import { DragPreviewSession } from "@/features/canvas/drag/drag-preview-session";
import CanvasFlowLayer from "@/features/canvas/flow/CanvasFlowLayer";
import { useCanvasConnections } from "@/features/canvas/hooks/use-canvas-connections";
import { useCanvasEdgeChanges } from "@/features/canvas/hooks/use-canvas-edge-changes";
import { useCanvasEvents } from "@/features/canvas/hooks/use-canvas-events";
import { canvasRootInteractionAttrs, useCanvasInteraction } from "@/features/canvas/hooks/use-canvas-interaction";
import { useCanvasNodeChanges } from "@/features/canvas/hooks/use-canvas-node-changes";
import { useCanvasPanels } from "@/features/canvas/hooks/use-canvas-panels";
import { useCanvasPointer } from "@/features/canvas/hooks/use-canvas-pointer";
import { useCanvasViewportActions } from "@/features/canvas/hooks/use-canvas-viewport-actions";
import { useFileDrop } from "@/features/canvas/hooks/use-file-drop";
import { useGenSettingsNormalization } from "@/features/canvas/hooks/use-gen-settings-normalization";
import { useGroupOperations } from "@/features/canvas/hooks/use-group-operations";
import { useSseTaskMonitor } from "@/features/canvas/hooks/use-sse-task-monitor";
import { MarqueeSession } from "@/features/canvas/marquee/marquee-session";
import { CANVAS_NODE_TYPES } from "@/features/canvas/nodes/canvas-node-types";
import { ResizeSession } from "@/features/canvas/resize/resize-session";
import { ResizeSessionContext } from "@/features/canvas/resize/resize-session-context";
import {
  getCanvasDerived,
  selectCanvasToolbarMode,
} from "@/features/canvas/shared/canvas-derived";
import { findFreePosition, getCanvasProjectId, markDirtyImmediate, takeCanvasSnapshot, useCanvasStore } from "@/features/canvas/stores/canvas-store";
import { useHistoryStore } from "@/features/canvas/stores/history-store";
import type { AnyNode } from "@/features/canvas/types";
import {
  GROUP_NODE_PADDING,
  RAIL_CONNECT_RADIUS,
  RAIL_DOT,
} from "@/lib/constants";

import CanvasKeyboardBridge from "./CanvasKeyboardBridge";
import CanvasOverlays from "./CanvasOverlays";
import { CanvasAgentEntry, CanvasLeftPanels } from "./CanvasPanels";
import type { CanvasSurfaceSlots } from "./contracts";

// edgeTypes 必须是稳定引用。定义在组件外可彻底避免 React Flow #002 警告：
// 组件内的 useMemo 在热更新等「重挂载」场景下仍会重新求值，产生新对象。
// （nodeTypes 的稳定引用与节点渲染边界见 nodes/canvas-node-types.ts。）
const RF_EDGE_TYPES = {
  deletable: DeletableEdge,
};

// 传给 <ReactFlow> 的静态对象同样定义在组件外：程序化位置帧（如整理动画）会
// 逐帧替换 nodes 并重渲染本组件（拖动期位置帧只写 DOM，不触发渲染），
// 内联对象字面量会让 React Flow 的 props 比较全部失效。
const RF_PRO_OPTIONS = { hideAttribution: true };
const RF_DEFAULT_EDGE_OPTIONS = { type: "deletable", animated: false };
// 画布领域常量注入 React Flow 根节点，供 globals.css 的样式规则读取：
// 外框 padding 与组 body padding 同源。
// 选择外框填充不走这里：组表面已改为不透明，外框需要独立的半透明 token，
// 由 globals.css 的 --selection-frame-bg 提供。
const RF_STYLE = {
  "--rail-dot-size": `${RAIL_DOT}px`,
  "--group-node-padding": `${GROUP_NODE_PADDING}px`,
  // React Flow 暗色主题自带 #141414 画布底色，会盖住应用背景；
  // 画布底色统一由 --canvas-bg 提供（与即梦 canvas-bg 对齐）。
  "--xy-background-color": "var(--canvas-bg)",
} as CSSProperties;

interface CanvasSurfaceProps {
  /** 由 CanvasRoot 收窄的稳定插槽；弹窗类插槽不进入节点树。 */
  slots: CanvasSurfaceSlots;
}

function CanvasSurface({ slots }: CanvasSurfaceProps) {
  const {
    screenToFlowPosition,
    fitView,
    setViewport: setRfViewport,
  } = useReactFlow<AnyNode, Edge>();
  const themeMode = useThemeMode();
  const { message, notification: notif } = useAppFeedback();
  useSseTaskMonitor(notif);
  // 生成设置纠偏在数据层运行：模型目录 / 参数缓存 / 连线变化时归一化，
  // 不再依赖节点被选中，选中与面板挂载都不写节点数据。
  useGenSettingsNormalization();

  // Canvas state
  const nodes = useCanvasStore((s) => s.nodes);
  const edges = useCanvasStore((s) => s.edges);
  const addNodes = useCanvasStore((s) => s.addNodes);

  // Programmatic position frames (e.g. tidy animation) replace the nodes array
  // every frame; drag previews bypass the store entirely. Keep all cross-node
  // projections in one cached derivation so rail and edge consumers do not
  // independently scan the full canvas.
  const canvasDerived = useCanvasStore((s) => getCanvasDerived(s.nodes, s.edges));
  const selectedNodeIds = canvasDerived.selectedNodeIds;
  // selectionKey 用于聚合工具条在选区变化时关闭仍打开的「更多」菜单。
  const selectionKey = useMemo(() => Array.from(selectedNodeIds).join("\u0000"), [selectedNodeIds]);

  // 画布交互状态机：空闲 / 框选手势 / 框选已提交 / 拖动节点 / 拖线，状态互斥且由事件驱动。
  // handle、节点工具栏、生成面板的可见性与光标全部由此派生，不再各自维护布尔量。
  // 整体引用稳定（hook 内已记忆化），可直接作为依赖使用。
  const canvasInteraction = useCanvasInteraction();
  // 工具条可见性唯一判定：hidden / aggregate / per-node，见 selectCanvasToolbarMode。
  const toolbarMode = selectCanvasToolbarMode(
    canvasInteraction.showSelectionToolbars,
    canvasDerived.selectionChromeBounds,
  );

  // ---- 拖动预览会话 ----
  // 拖动期位置帧不写受控 store：会话按 rAF 合并后只写 DOM，松手一次提交。
  // 因此拖动期间本组件不再随每帧重渲染（规则见 drag/drag-preview-session.ts）。
  const canvasContainerRef = useRef<HTMLDivElement | null>(null);
  const rfStore = useStoreApi();
  // React Flow store 的 nodes：受控同步（StoreUpdater 的 passive effect）完成后才
  // 变化，是「渲染层已采用新位置」的唯一信号；拖动帧只更新 internals，不会触发。
  const renderedNodes = useStore((state) => state.nodes);
  // 会话实例只在首次渲染创建（依赖全部为稳定引用：ref、store api、模块函数）
  const [dragSession] = useState(
    () =>
      new DragPreviewSession({
        root: canvasContainerRef,
        getNodes: () => useCanvasStore.getState().nodes,
        setNodes: (next) => useCanvasStore.getState().setNodes(next),
        markDirtyImmediate,
        getZoom: () => rfStore.getState().transform[2],
      }),
  );

  // 渲染层采用新节点后：提交路径释放预览偏移，外部写入按新 store 重建会话基准
  useLayoutEffect(() => {
    dragSession.syncRenderedNodes();
  }, [renderedNodes, dragSession]);

  useEffect(() => () => dragSession.dispose(), [dragSession]);

  // ---- 框选手势会话 ----
  // React Flow 内建框选已关闭（见下方 selectionOnDrag / selectionKeyCode）：
  // 空白区左键拖拽由会话接管，激活时冻结几何索引，每帧只写选框与命中差量，
  // 松手一次提交节点/边选中态（规则见 marquee/marquee-session.ts）。
  const [marqueeSession] = useState(
    () =>
      new MarqueeSession({
        root: canvasContainerRef,
        getNodes: () => useCanvasStore.getState().nodes,
        getEdges: () => useCanvasStore.getState().edges,
        setNodes: (next) => useCanvasStore.getState().setNodes(next),
        setEdges: (next, options) => useCanvasStore.getState().setEdges(next, options),
        dispatchInteraction: (action) =>
          useCanvasStore.getState().dispatchInteraction({ type: action }),
        getProjectId: getCanvasProjectId,
        getTransform: () => rfStore.getState().transform,
        panBy: (delta) => rfStore.getState().panBy(delta),
        getNodesSelectionActive: () => rfStore.getState().nodesSelectionActive,
        setNodesSelectionActive: (active) => rfStore.setState({ nodesSelectionActive: active }),
        canStartMarquee: () => {
          const state = rfStore.getState();
          return state.elementsSelectable && !state.connection.inProgress;
        },
      }),
  );

  // 渲染层采用新节点后释放预览与抑制属性。布局副作用在绘制前执行，
  // data-marquee-active 的抑制延续到新选中落地这一帧，旧选中外框不会先闪一帧。
  useLayoutEffect(() => {
    marqueeSession.syncRenderedNodes();
  }, [renderedNodes, marqueeSession]);

  useEffect(() => {
    marqueeSession.attach();
    return () => marqueeSession.dispose();
  }, [marqueeSession]);

  // ---- 缩放手势会话 ----
  // 缩放期尺寸帧不写受控 store：会话按 rAF 合并后只写节点 wrapper 行内尺寸，
  // 松手一次提交；活动期接管本节点的尺寸回传（规则见 resize/resize-session.ts）。
  const [resizeSession] = useState(
    () =>
      new ResizeSession({
        root: canvasContainerRef,
        getNodes: () => useCanvasStore.getState().nodes,
        setNodes: (next) => useCanvasStore.getState().setNodes(next),
        markDirtyImmediate,
        takeSnapshot: takeCanvasSnapshot,
        pushHistory: (snapshot) => useHistoryStore.getState().push(snapshot),
      }),
  );

  // 渲染层采用新节点后：提交路径释放会话，外部写入按几何是否被改写决定继续/取消
  useLayoutEffect(() => {
    resizeSession.syncRenderedNodes();
  }, [renderedNodes, resizeSession]);

  // 项目切换由 CanvasRoot 按 projectId 重挂画布子树，卸载即销毁组件：
  // 缩放会话不跨项目存活。布局副作用的清理先于 syncRenderedNodes 释放。
  useLayoutEffect(() => () => resizeSession.dispose(), [resizeSession]);

  // 内置多选外框只在真正「多选」时才有意义：
  // - 单选时它只是把节点再包一圈（还带外扩），与节点自身描边重复，反而干扰；
  // - 选中的全是组节点时，组自己有边框，外框同样冗余。
  // 显隐与聚合工具条锚点共用 selectionChromeBounds.frameVisible，避免两套选区扫描漂移。
  const hideSelectionRect = !canvasDerived.selectionChromeBounds?.frameVisible;

  // 多选外框批量连线：≥2 个非组节点选中时，外框右缘出现批量输出 Handle。
  // bbox 与成员轨道钳制统一由 canvas-derived 几何投影提供
  const selectionFrame = canvasDerived.selectionFrame;

  // 批量轨道锚点：外框右缘正中。selectionFrame 由 canvasDerived 按 nodes/edges
  // 引用缓存，非位置帧变化时引用不变，锚点对象随之稳定（BatchConnectHandle 可直接 bail）
  const batchConnectAnchor = useMemo(
    () =>
      selectionFrame
        ? {
            x: selectionFrame.bbox.x + selectionFrame.bbox.width + GROUP_NODE_PADDING,
            y: selectionFrame.bbox.y + selectionFrame.bbox.height / 2,
          }
        : null,
    [selectionFrame],
  );

  // 组节点批量输出轨道不再由这里渲染：它渲染在 GroupNode 的节点 DOM 内
  // （GroupConnectRail），显隐才能走标准 Handle 规则（hover/选中/按住），
  // 与普通节点的轨道一致；参与集在拖起时从 store 现取组成员

  // 模型库 / 素材库初始化已前移至画布门页（canvas/[projectId]/page.tsx）：
  // 与项目数据并行拉齐后再放行画布，避免面板在空 store 上挂载产生空态竞态

  const { t } = useTranslation();

  // 浮层面：检查器 / 节点工具条瞬态开合 / 编辑面板宿主校验。
  // 编辑态（标注 / 裁剪 / 选帧 / 片段截取 / 音频片段截取 / 图片打光 / 多视角 / 全景）
  // 激活的节点同时决定生成面板让位与节点工具条隐藏，口径统一在 hook 内。
  const panels = useCanvasPanels({ showSelectionChrome: canvasInteraction.showSelectionChrome });
  const { resetTransientPanels } = panels;

  // 指针层：按下点补偿、节点拖动 / 点击 / 右键与画布右键菜单
  const {
    handleCanvasPressCapture,
    handleNodeDragStart,
    handleNodeDrag,
    handleNodeDragStop,
    handlePaneClick,
    handlePaneContextMenu,
    handleNodeContextMenu,
    handleNodeClick,
    handleNodeMouseEnter,
    handleAddText,
    handleAddImage,
    handleAddVideo,
    handleAddAudio,
    handleAddDirector,
  } = useCanvasPointer({
    dragSession,
    onClick: canvasInteraction.onClick,
    onNodeDragStart: canvasInteraction.onNodeDragStart,
    onNodeDragStop: canvasInteraction.onNodeDragStop,
    screenToFlowPosition,
    resetTransientPanels,
  });

  // ---- Change handlers ----

  const { handleNodesChange } = useCanvasNodeChanges({ dragSession, resizeSession });
  const { handleEdgesChange } = useCanvasEdgeChanges();

  const {
    handleConnect,
    handleConnectStart,
    handleConnectEnd,
    isValidConnection,
    pendingConnectionCreate,
    pendingPreviewAnchors,
    handleCreateConnectedNode,
    closeConnectionCreate,
    batchConnectHandlers,
  } = useCanvasConnections({
    nodes,
    screenToFlowPosition,
    onConnectStart: canvasInteraction.onConnectStart,
    onConnectEnd: canvasInteraction.onConnectEnd,
  });

  const {
    defaultViewport,
    handleViewportChange,
    handleResetView,
    handleTidyCanvas,
    tidyDisabled,
  } = useCanvasViewportActions({
    root: canvasContainerRef,
    setViewport: setRfViewport,
    fitView,
  });

  useGroupOperations();

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
    addNodes([node], { forceHistory: true });
    message.success(t("asset.added"));
  }, [addNodes, message, t]);

  useCanvasEvents(canvasContainerRef);
  const { handleDragOver, handleDragStart, handleDrop, isFileDragging } = useFileDrop(screenToFlowPosition, shouldIgnoreFileDrop, canvasContainerRef, handleAssetDrop);

  return (
    <div
      ref={canvasContainerRef}
      className={hideSelectionRect ? "canvas-container hide-selection-rect" : "canvas-container"}
      style={{ width: "100%", height: "100%", position: "relative", overflow: "hidden" }}
      onMouseDownCapture={handleCanvasPressCapture}
      onTouchStartCapture={handleCanvasPressCapture}
      onDragOver={handleDragOver}
      onDragStart={handleDragStart}
      onDrop={handleDrop}
    >
      <AlignmentGuides />
      <BatchConnectContext.Provider value={batchConnectHandlers}>
      <ResizeSessionContext.Provider value={resizeSession}>
      {/* 浮层编排：节点级与画布级浮层统一挂在两个会话 Provider 之内、React Flow
          之外；NodeToolbar / ViewportPortal 经页面层 ReactFlowProvider 的 portal
          进入画布渲染层，右键菜单与文件遮罩仍定位在画布容器内 */}
      <CanvasOverlays
        panels={panels}
        nodes={nodes}
        selectedNodeIds={selectedNodeIds}
        selectionKey={selectionKey}
        toolbarMode={toolbarMode}
        selectionFrame={selectionFrame}
        batchConnectAnchor={batchConnectAnchor}
        batchConnectHandlers={batchConnectHandlers}
        pendingConnectionCreate={pendingConnectionCreate}
        pendingPreviewAnchors={pendingPreviewAnchors}
        onSelectConnectionNode={handleCreateConnectedNode}
        onCloseConnectionCreate={closeConnectionCreate}
        contextMenuProps={{
          onAddText: handleAddText,
          onAddImage: handleAddImage,
          onAddVideo: handleAddVideo,
          onAddAudio: handleAddAudio,
          onAddDirector: handleAddDirector,
          onTidy: handleTidyCanvas,
          tidyDisabled,
          onResetView: handleResetView,
        }}
        isFileDragging={isFileDragging}
      />
      <ReactFlow
        {...canvasRootInteractionAttrs(canvasInteraction.mode)}
        data-multiselect={selectionFrame ? "true" : undefined}
        style={RF_STYLE}
        nodes={nodes}
        edges={edges}
        nodeTypes={CANVAS_NODE_TYPES}
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
        onNodeMouseEnter={handleNodeMouseEnter}
        onPaneContextMenu={handlePaneContextMenu}
        onNodeContextMenu={handleNodeContextMenu}
        defaultViewport={defaultViewport}
        // 拖动阈值取库默认 1px（2026-10-29 用户要求由 2 降到 1）：阈值只保留
        // 「点击/拖动判定」职责，按下的位移补偿与首帧由拖动会话负责（规则 2.7/2.8），
        // 阈值越大，起拖死区越长
        nodeDragThreshold={1}
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
        // 内建框选关闭（selectionOnDrag=false、selectionKeyCode=null）：空白区左键
        // 拖拽由 MarqueeSession 接管，Shift/Ctrl/Meta 也不再触发内建选择。
        panOnDrag={[1]}
        selectionOnDrag={false}
        selectionKeyCode={null}
        panActivationKeyCode="Space"
        panOnScroll={false}
        zoomOnScroll={true}
        zoomOnPinch={true}
        zoomOnDoubleClick={false}
        minZoom={0.1}
        maxZoom={5}
        // React Flow owns selected-node stacking so NodeToolbar can derive its
        // layer from the selected node instead of relying on a global override.
        elevateNodesOnSelect
        proOptions={RF_PRO_OPTIONS}
        colorMode={themeMode}
        // 连线吸附半径：xyflow 的吸附判定取「指针到 Handle 中心」的距离，Handle 中心
        // 在轨道正中（离节点边缘 RAIL_WIDTH/2）。半径盖住可见圆点加余量即可，不能取
        // 轨道外接圆——那会让磁吸远及边缘外 ~97px，相邻轨道（组与成员仅隔
        // GROUP_NODE_PADDING）吸附圈重叠、恒抢错目标；半径内取「最近」的 Handle
        connectionRadius={RAIL_CONNECT_RADIUS}
        connectionLineComponent={ConnectionFlowLine}
        defaultEdgeOptions={RF_DEFAULT_EDGE_OPTIONS}
      >
        {/* 画布点阵：参数与即梦 canvas-dot-grid 对齐，低缩放时整层隐藏 */}
        <CanvasDotGrid />

        {/* 连线本体的 1/zoom 宽度补偿：连线与其预览共用同一 CSS 变量 */}
        <EdgeBaseWidthVariable />

        {/* 连线流光层：容器插入视口节点层之前（连线之上、节点之下），流光由帧循环绘制 */}
        <CanvasFlowLayer />

        {/* 框选选框：静态元素，几何由 MarqueeSession 逐帧写 style，避免每帧 React 渲染。
            复用 React Flow 的 .react-flow__selection 视觉与层级（z-index 6） */}
        <div className="react-flow__selection react-flow__container" data-canvas-marquee="" />

        {/* 手势光标层：拖动节点/框选期间整块画布稳定接管光标，避免根属性切换触发
            全子树光标规则重算；显隐与光标见 globals.css「光标」段 */}
        <div className="canvas-gesture-cursor" aria-hidden="true" />

        {/* 左上工具条 / 左下控制条 / 右上 Agent 入口：只消费端口与壳层状态 */}
        <CanvasLeftPanels slots={slots} />
        <CanvasAgentEntry />

        {/* 快捷键由叶组件挂载：输入门变化只重渲染它，不波及节点树 */}
        <CanvasKeyboardBridge />
      </ReactFlow>
      </ResizeSessionContext.Provider>
      </BatchConnectContext.Provider>
    </div>
  );
}

// slots 由 CanvasRoot 以稳定引用下发；页面壳状态变化只经输入门 context 送达
// 叶组件（CanvasKeyboardBridge 等），不得让整棵 React Flow 子树重渲染。
export default memo(CanvasSurface);
