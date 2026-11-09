"use client";

import { useCallback, useMemo, useState } from "react";

import type { AssetItem } from "@/entities/asset";
import CanvasAgentDrawer from "@/features/canvas/agent/components/AgentDrawer";
import CanvasAgentRuntimeBridge from "@/features/canvas/agent/Runtime";
import { createAssetNode } from "@/features/canvas/assets/create-asset-node";
import CanvasExplorer from "@/features/canvas/explorer/CanvasExplorer";
import CanvasMediaLoadingProvider from "@/features/canvas/shared/CanvasMediaLoadingProvider";
import {
  findFreePosition,
  getViewportCenter,
  useCanvasStore,
} from "@/features/canvas/stores/canvas-store";

import CanvasInputGateContext from "./CanvasInputGateContext";
import { CanvasPortsContext } from "./CanvasPortsContext";
import CanvasShellContext, { type CanvasShell } from "./CanvasShellContext";
import CanvasSurface from "./CanvasSurface";
import type { CanvasRootProps } from "./contracts";

/**
 * 画布根组件：持有画布壳层状态（资源管理器 / Agent 抽屉），装配媒体加载
 * Provider，并把页面注入的端口与插槽下发到各层。页面壳的浮层不在此处。
 */
export default function CanvasRoot({
  projectId,
  ports,
  slots,
  inputBlocked = false,
}: CanvasRootProps) {
  const modalOpen = useCanvasStore((s) => s.modalOpen);
  const addNodes = useCanvasStore((s) => s.addNodes);
  const { userMenu, assetBrowser, assetsDialog } = slots;

  const [explorerOpen, setExplorerOpen] = useState(false);
  const [agentOpen, setAgentOpen] = useState(false);
  const toggleExplorer = useCallback(() => setExplorerOpen((open) => !open), []);
  const closeExplorer = useCallback(() => setExplorerOpen(false), []);
  const openAgent = useCallback(() => setAgentOpen(true), []);
  const closeAgent = useCallback(() => setAgentOpen(false), []);

  const shell = useMemo<CanvasShell>(
    () => ({ explorerOpen, toggleExplorer, openAgent }),
    [explorerOpen, toggleExplorer, openAgent],
  );

  // 资产插入：视口中心为锚点，批量按 8 列错位，单次压栈。
  const insertAssets = useCallback(
    (assets: readonly AssetItem[]) => {
      if (assets.length === 0) return;
      const center = getViewportCenter();
      const nodes = assets.map((asset, i) =>
        createAssetNode(
          asset,
          { x: center.x + (i % 8) * 40, y: center.y + Math.floor(i / 8) * 40 },
          findFreePosition,
        ),
      );
      addNodes(nodes, { forceHistory: true });
    },
    [addNodes],
  );

  const assetBrowserApi = useMemo(
    () => ({ onInsertAsset: (asset: AssetItem) => insertAssets([asset]) }),
    [insertAssets],
  );
  const assetsDialogApi = useMemo(
    () => ({
      onInsertAsset: (asset: AssetItem) => insertAssets([asset]),
      onInsertAssets: (assets: AssetItem[]) => insertAssets(assets),
    }),
    [insertAssets],
  );

  // assetsDialog 是唯一随开合变化的插槽：只交给 CanvasRoot 挂载，
  // 不进入 CanvasSurface 的 props，避免弹窗开合重渲染节点树。
  const surfaceSlots = useMemo(() => ({ userMenu }), [userMenu]);
  const assetBrowserNode = useMemo(
    () => assetBrowser(assetBrowserApi),
    [assetBrowser, assetBrowserApi],
  );

  const inputGate = inputBlocked || modalOpen;

  return (
    <CanvasPortsContext.Provider value={ports}>
      <CanvasInputGateContext.Provider value={inputGate}>
        <CanvasShellContext.Provider value={shell}>
          <CanvasMediaLoadingProvider key={projectId}>
            <CanvasSurface slots={surfaceSlots} />
          </CanvasMediaLoadingProvider>
          <CanvasExplorer
            open={explorerOpen}
            onClose={closeExplorer}
            assetBrowser={assetBrowserNode}
          />
          <CanvasAgentRuntimeBridge />
          <CanvasAgentDrawer
            open={agentOpen}
            onClose={closeAgent}
            projectId={projectId}
          />
          {assetsDialog(assetsDialogApi)}
        </CanvasShellContext.Provider>
      </CanvasInputGateContext.Provider>
    </CanvasPortsContext.Provider>
  );
}
