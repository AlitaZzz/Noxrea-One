/**
 * CanvasSurface 内常驻的 React Flow Panel 外壳。
 *
 * 左上面板（项目/用户菜单）、左下控制条与右上 Agent 入口只依赖页面端口与
 * 画布壳层状态；独立成组件后，资源管理器开合只重渲染这些 Panel，
 * 不波及 CanvasSurface 的节点/边渲染。
 */
"use client";

import { MiniMap, Panel } from "@xyflow/react";
import { useTranslation } from "react-i18next";

import { AgentIcon } from "@/components/ui/AppIcon";
import { Button } from "@/components/ui/button";
import CanvasControls from "@/features/canvas/controls/CanvasControls";
import ProjectToolbar from "@/features/canvas/controls/ProjectToolbar";
import { DRAWER_WIDTH } from "@/features/canvas/explorer/CanvasExplorer";
import LimeRing from "@/features/canvas/shared/LimeRing";
import { useCanvasStore } from "@/features/canvas/stores/canvas-store";

import { useCanvasShell } from "./CanvasShellContext";
import type { CanvasSurfaceSlots } from "./contracts";
import OfflineIndicator from "./OfflineIndicator";

const explorerMargin = (open: boolean) => ({
  margin: 0,
  marginLeft: open ? DRAWER_WIDTH : 0,
  transition: "margin-left 0.2s ease",
  pointerEvents: "none" as const,
});

export function CanvasLeftPanels({ slots }: { slots: CanvasSurfaceSlots }) {
  const { explorerOpen } = useCanvasShell();
  const minimapVisible = useCanvasStore((s) => s.minimapVisible);

  return (
    <>
      {/* Top-left panel: quick toolbar */}
      {/* pointer-events: none —— Panel 是绝对定位块，其透明留白（含 30px 内边距）会拦截画布点击与框选；仅内部控件恢复 auto */}
      <Panel position="top-left" style={explorerMargin(explorerOpen)}>
        <ProjectToolbar userMenu={slots.userMenu} />
      </Panel>

      {/* Bottom-left panel: minimap + controls */}
      {/* pointer-events: none —— 小地图(180)比控制条窄，其右侧透明留白会拦截画布点击与框选 */}
      <Panel position="bottom-left" style={explorerMargin(explorerOpen)}>
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
          <CanvasControls />
        </div>
      </Panel>
    </>
  );
}

export function CanvasAgentEntry() {
  const { t } = useTranslation();
  const { openAgent } = useCanvasShell();

  return (
    <Panel position="top-right" style={{ margin: 0, paddingRight: 30, paddingTop: 30, pointerEvents: "none" }}>
      <div className="flex items-center gap-2" style={{ pointerEvents: "auto" }}>
        <OfflineIndicator />
        <Button
          type="button"
          variant="outline"
          size="lg"
          className="agent-flow-button bg-background dark:bg-background"
          onClick={openAgent}
        >
          <LimeRing />
          <AgentIcon style={{ width: 22, height: 22 }} />
          <span className="text-base font-medium">{t("agent.title")}</span>
        </Button>
      </div>
    </Panel>
  );
}
