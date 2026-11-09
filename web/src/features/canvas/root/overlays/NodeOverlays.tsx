/**
 * 节点级画布浮层：跟随节点 id 挂载的生成面板、动态编辑面板、节点工具条
 * 与节点检查器。
 *
 * 本文件只决定挂载、可见与位置；裁剪、截取、标注等业务规则由各面板自身
 * 承担。依赖 React Flow context 的浮层由页面层的 ReactFlowProvider 提供
 * 上下文（NodeToolbar 经 portal 渲染进画布渲染层）。
 */
"use client";

import { NodeToolbar as RfNodeToolbar, Position } from "@xyflow/react";
import dynamic from "next/dynamic";

import NodeInspector from "@/features/canvas/debug/NodeInspector";
import type { CanvasPanels } from "@/features/canvas/hooks/use-canvas-panels";
import NodeToolbarUI from "@/features/canvas/nodes/NodeToolbar";
import GenerationPanelHost from "@/features/canvas/panels/GenerationPanelHost";
import type { CanvasToolbarMode } from "@/features/canvas/shared/canvas-derived";
import { useCanvasStore } from "@/features/canvas/stores/canvas-store";
import type { AnyNode, ImageNodeData } from "@/features/canvas/types";

const AudioClipStripPanel = dynamic(() => import("@/features/canvas/editing/AudioClipStripPanel"), { ssr: false });
const ClipStripPanel = dynamic(() => import("@/features/canvas/editing/ClipStripPanel"), { ssr: false });
const FrameStripPanel = dynamic(() => import("@/features/canvas/editing/FrameStripPanel"), { ssr: false });
const LightingPanel = dynamic(() => import("@/features/canvas/editing/LightingPanel"), { ssr: false });
const MultiAngleEditor = dynamic(() => import("@/features/canvas/editing/MultiAngleEditor"), { ssr: false });

// 节点工具条动作 → store 派发。定义在组件外保证引用稳定，使 NodeToolbarUI
// （memo）在程序化位置帧重渲染时直接 bail，不随每帧重新绑定。
const openFrameStrip = (id: string) => useCanvasStore.getState().setFrameCaptureNodeId(id);
const openClipStrip = (id: string) => useCanvasStore.getState().setClipCaptureNodeId(id);
const openAudioClip = (id: string) => useCanvasStore.getState().setAudioClipNodeId(id);
const openLighting = (id: string) => useCanvasStore.getState().setLightingNodeId(id);

export interface NodeOverlaysProps {
  /** 浮层状态投影（宿主校验、瞬态开合与关闭回调）。 */
  panels: CanvasPanels;
  nodes: AnyNode[];
  selectedNodeIds: ReadonlySet<string>;
  toolbarMode: CanvasToolbarMode;
}

export function NodeOverlays({ panels, nodes, selectedNodeIds, toolbarMode }: NodeOverlaysProps) {
  const {
    inspectedNodeId,
    inspectedNode,
    openInspector,
    closeInspector,
    gridMenuNodeId,
    handleGridMenuOpenChange,
    toolbarDismissSignal,
    isNodeInEditorUiState,
    generationPanelTarget,
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
  } = panels;

  return (
    <>
      {/* 生成面板 — 三类面板常驻，跟随单选切换 nodeId 与显隐 */}
      <GenerationPanelHost target={generationPanelTarget} />

      {/* 帧序列面板 — 跟随选中视频节点，不随画布缩放，轨道尺寸恒定 */}
      {frameStripNode && (
        <RfNodeToolbar nodeId={frameStripNode.id} position={Position.Bottom} align="center" offset={12}>
          <FrameStripPanel
            // key 带 src：换源（替换/生成回填）时面板整体重挂，播放头与
            // 代理状态对新源重新初始化，而不是拿旧选区比例套新视频
            key={`${frameStripNode.id}:${frameStripRef}`}
            nodeId={frameStripNode.id}
            videoRef={frameStripRef}
            onClose={closeFrameStripPanel}
          />
        </RfNodeToolbar>
      )}

      {/* 片段截取面板 — 与帧序列面板同构互斥：打开其一时先关掉另一个 */}
      {clipStripNode && (
        <RfNodeToolbar nodeId={clipStripNode.id} position={Position.Bottom} align="center" offset={12}>
          <ClipStripPanel
            // key 带 src（与音频截取面板一致）：换源时面板重挂，选区与代理
            // 对新源重新初始化——否则旧区间比例会被静默套在新视频时长上
            key={`${clipStripNode.id}:${clipStripRef}`}
            nodeId={clipStripNode.id}
            videoRef={clipStripRef}
            onClose={closeClipStripPanel}
          />
        </RfNodeToolbar>
      )}

      {/* 图片打光面板 — 跟随选中图片节点，不随画布缩放，尺寸恒定 */}
      {lightingNode && (
        <RfNodeToolbar nodeId={lightingNode.id} position={Position.Bottom} align="center" offset={12}>
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
        <RfNodeToolbar nodeId={angleEditorNode.id} position={Position.Bottom} align="center" offset={12}>
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
        <RfNodeToolbar nodeId={audioClipNode.id} position={Position.Bottom} align="center" offset={12}>
          <AudioClipStripPanel
            key={`${audioClipNode.id}:${audioClipRef}`}
            nodeId={audioClipNode.id}
            audioRef={audioClipRef}
            onClose={closeAudioClipPanel}
          />
        </RfNodeToolbar>
      )}

      {/* Node toolbars — 框选手势与拖动期间不渲染，框选提交后恢复。
          多选时整体让位给聚合工具条，避免每个选中节点各挂一条 */}
      {toolbarMode.kind === "per-node" && Array.from(selectedNodeIds).map((nid) => {
        const n = nodes.find((x) => x.id === nid);
        return (
          <RfNodeToolbar key={nid} nodeId={nid} position={Position.Top} align="center" offset={8}>
            {isNodeInEditorUiState(nid) ? null : (
              <NodeToolbarUI
                nodeId={nid}
                nodeType={n?.type}
                onShowInspector={openInspector}
                onOpenFrameStrip={openFrameStrip}
                onOpenClipStrip={openClipStrip}
                onOpenAudioClip={openAudioClip}
                onOpenLighting={openLighting}
                gridOpen={gridMenuNodeId === nid}
                onGridOpenChange={handleGridMenuOpenChange}
                dismissSignal={toolbarDismissSignal}
              />
            )}
          </RfNodeToolbar>
        );
      })}

      <NodeInspector
        open={inspectedNodeId !== null}
        node={inspectedNode}
        onClose={closeInspector}
      />
    </>
  );
}
