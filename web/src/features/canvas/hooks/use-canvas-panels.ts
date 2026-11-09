/**
 * 画布浮层状态 hook：节点检查器、节点工具条的瞬态开合，以及跟随选中节点
 * 挂载的媒体编辑面板宿主校验。
 *
 * 面板开关本身仍由 canvas store 的既有字段承担；这里只做单值投影、宿主
 * 合法性兜底（节点被删除 / 取消选中 / 换类型后关闭面板）与稳定关闭回调。
 */
"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import type { GenerationPanelTarget } from "@/features/canvas/panels/GenerationPanelHost";
import { selectMediaEditorNodeId } from "@/features/canvas/shared/canvas-edit-actions";
import { genKindOfNode } from "@/features/canvas/shared/gen-settings-node";
import { isNodeInUiState } from "@/features/canvas/stores/canvas-store";
import { useCanvasStore } from "@/features/canvas/stores/canvas-store";
import type {
  AnyNode,
  AudioNode,
  ImageNode,
  ImageNodeData,
  VideoNode,
  VideoNodeData,
} from "@/features/canvas/types";
import { NODE_TYPE } from "@/lib/constants";

export interface UseCanvasPanelsOptions {
  /** 生成面板等重装饰是否显示（与交互状态机同口径）。 */
  showSelectionChrome: boolean;
}

/** 面板引用值：无宿主或未持有源时为空串；源变化即触发面板重挂载。 */
function mediaSrcOf(node: AnyNode | null): string {
  return node ? ((node.data as { src?: string }).src ?? "") : "";
}

/** 宿主判定：节点类型匹配且仍持有可编辑媒体源；配合 selected 决定面板去留。 */
function isVideoWithSrc(node: AnyNode): node is VideoNode {
  return node.type === NODE_TYPE.VIDEO && Boolean((node.data as VideoNodeData).src);
}

function isImageWithSrc(node: AnyNode): node is ImageNode {
  return node.type === NODE_TYPE.IMAGE && Boolean((node.data as ImageNodeData).src);
}

function isAudioWithSrc(node: AnyNode): node is AudioNode {
  return node.type === NODE_TYPE.AUDIO && Boolean((node.data as { src?: string }).src);
}

/** 裁剪面板由视频与图片两个面板共用，两类宿主都必须放行。 */
function isCropHost(node: AnyNode): node is ImageNode | VideoNode {
  if (node.type === NODE_TYPE.VIDEO) return Boolean((node.data as VideoNodeData).src);
  if (node.type === NODE_TYPE.IMAGE) return Boolean((node.data as ImageNodeData).src);
  return false;
}

/**
 * 面板宿主校验：节点被删除、取消选中、换类型或清空媒体源后立即关闭面板。
 * 右键菜单撤销 / 框选改选等路径不经过 pane 与节点点击，必须在这里收敛。
 */
function usePanelHost<T extends AnyNode>(
  nodes: readonly AnyNode[],
  nodeId: string | null,
  isHost: (node: AnyNode) => node is T,
): T | null {
  return useMemo(() => {
    if (!nodeId) return null;
    const node = nodes.find((candidate) => candidate.id === nodeId);
    return node && node.selected && isHost(node) ? node : null;
  }, [nodes, nodeId, isHost]);
}

export function useCanvasPanels({ showSelectionChrome }: UseCanvasPanelsOptions) {
  const nodes = useCanvasStore((s) => s.nodes);
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
  const editingNodeId = useCanvasStore(selectMediaEditorNodeId);

  // Inspector state
  const [inspectedNodeId, setInspectedNodeId] = useState<string | null>(null);
  const [gridMenuNodeId, setGridMenuNodeId] = useState<string | null>(null);
  const [toolbarDismissSignal, setToolbarDismissSignal] = useState(0);
  const handleGridMenuOpenChange = useCallback((nodeId: string, open: boolean) => {
    setGridMenuNodeId(open ? nodeId : null);
  }, []);
  const inspectedNode = nodes.find((n) => n.id === inspectedNodeId) || null;

  // 媒体编辑面板的宿主节点：任何一项宿主条件失效（删除 / 取消选中 / 换类型 /
  // 清空 src）都让面板随宿主卸载，避免旧源状态残留
  const frameStripNode = usePanelHost(nodes, frameCaptureNodeId, isVideoWithSrc);
  const clipStripNode = usePanelHost(nodes, clipCaptureNodeId, isVideoWithSrc);
  const lightingNode = usePanelHost(nodes, lightingNodeId, isImageWithSrc);
  const angleEditorNode = usePanelHost(nodes, angleEditorNodeId, isImageWithSrc);
  const panoramaNode = usePanelHost(nodes, panoramaNodeId, isImageWithSrc);
  const audioClipNode = usePanelHost(nodes, audioClipNodeId, isAudioWithSrc);
  // 三个编辑面板的 key 与引用值共用同一取值：源变化即重挂载，
  // 不残留旧源的播放 / 选区 / 代理状态
  const frameStripRef = mediaSrcOf(frameStripNode);
  const clipStripRef = mediaSrcOf(clipStripNode);
  const audioClipRef = mediaSrcOf(audioClipNode);

  // 画面裁剪面板的宿主节点：面板本体挂在节点内部，但残留 id 的兜底
  // 清理与其它编辑面板一致（裁剪确认不自关，关闭由节点侧/这里的校验驱动）。
  // croppingNodeId 由视频与图片两个裁剪面板共用，两类宿主都必须放行，
  // 否则图片裁剪会在打开的同一帧被这里的校验清掉
  const cropNode = usePanelHost(nodes, croppingNodeId, isCropHost);

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

  // 面板 onClose 使用稳定引用，避免交互面板因画布状态同步重复挂载 window 监听
  const closeFrameStripPanel = useCallback(() => useCanvasStore.getState().setFrameCaptureNodeId(null), []);
  const closeClipStripPanel = useCallback(() => useCanvasStore.getState().setClipCaptureNodeId(null), []);
  const closeLightingPanel = useCallback(() => useCanvasStore.getState().setLightingNodeId(null), []);
  const closeAngleEditorPanel = useCallback(() => useCanvasStore.getState().setAngleEditorNodeId(null), []);
  const closeAudioClipPanel = useCallback(() => useCanvasStore.getState().setAudioClipNodeId(null), []);
  const closeInspector = useCallback(() => setInspectedNodeId(null), []);

  /** 点击画布 / 节点时收起瞬态浮层：网格菜单与节点工具条弹层。 */
  const resetTransientPanels = useCallback(() => {
    setGridMenuNodeId(null);
    setToolbarDismissSignal((value) => value + 1);
  }, []);

  // 编辑态节点：生成面板必须让位，否则同一节点会同时挂上下两个浮层。
  // 单个被选中的生成节点 → 面板目标；类型 → 能力走 genKindOfNode（与面板宿主同一来源）。
  const generationPanelTarget = useMemo<GenerationPanelTarget | null>(() => {
    if (!showSelectionChrome) return null;
    if (editingNodeId) return null;
    const sel = nodes.filter((n) => n.selected);
    if (sel.length !== 1) return null;
    const node: AnyNode = sel[0];
    const kind = genKindOfNode(node);
    if (!kind) return null;
    // 上传 / 派生图片与上传视频的内容来自外部，没有可编辑的生成参数
    if (node.type === NODE_TYPE.IMAGE) {
      const src = (node.data as ImageNodeData).source;
      if (src === "upload" || src === "derived") return null;
    } else if (node.type === NODE_TYPE.VIDEO && (node.data as VideoNodeData).source === "upload") {
      return null;
    }
    return { kind, nodeId: node.id };
  }, [nodes, showSelectionChrome, editingNodeId]);

  /** 节点工具条让位判定：该节点正被某种编辑模式占用时隐藏工具条。 */
  const isNodeInEditorUiState = useCallback(
    (nodeId: string) =>
      isNodeInUiState(
        {
          multiExpandedNodeId,
          annotatingNodeId,
          croppingNodeId,
          editingTextNodeId,
          frameCaptureNodeId,
          clipCaptureNodeId,
          lightingNodeId,
          audioClipNodeId,
          angleEditorNodeId,
          panoramaNodeId,
        },
        nodeId,
      ),
    [
      multiExpandedNodeId,
      annotatingNodeId,
      croppingNodeId,
      editingTextNodeId,
      frameCaptureNodeId,
      clipCaptureNodeId,
      lightingNodeId,
      audioClipNodeId,
      angleEditorNodeId,
      panoramaNodeId,
    ],
  );

  return {
    editingNodeId,
    editingTextNodeId,
    generationPanelTarget,
    inspectedNodeId,
    inspectedNode,
    openInspector: setInspectedNodeId,
    closeInspector,
    gridMenuNodeId,
    handleGridMenuOpenChange,
    toolbarDismissSignal,
    resetTransientPanels,
    isNodeInEditorUiState,
    frameStripNode,
    frameStripRef,
    closeFrameStripPanel,
    clipStripNode,
    clipStripRef,
    closeClipStripPanel,
    lightingNode,
    closeLightingPanel,
    angleEditorNode,
    closeAngleEditorPanel,
    audioClipNode,
    audioClipRef,
    closeAudioClipPanel,
  };
}

/** 浮层状态投影：供 CanvasOverlays 子树按需消费。 */
export type CanvasPanels = ReturnType<typeof useCanvasPanels>;
