/**
 * CanvasSurface 内常驻的 React Flow Panel 外壳。
 *
 * 左上面板（项目/用户菜单 + 保存状态）、左下控制条与右上 Agent 入口只依赖页面端口与
 * 画布壳层状态；独立成组件后，资源管理器开合只重渲染这些 Panel，
 * 不波及 CanvasSurface 的节点/边渲染。
 */
"use client";

import { MiniMap, Panel } from "@xyflow/react";
import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";

import { AgentIcon } from "@/components/ui/AppIcon";
import { Button } from "@/components/ui/button";
import CanvasControls from "@/features/canvas/controls/CanvasControls";
import ProjectToolbar from "@/features/canvas/controls/ProjectToolbar";
import { DRAWER_WIDTH } from "@/features/canvas/explorer/CanvasExplorer";
import LimeRing from "@/features/canvas/shared/LimeRing";
import { useCanvasStore } from "@/features/canvas/stores/canvas-store";
import { cn } from "@/lib/utils";

import CanvasSaveStatusIndicator from "./CanvasSaveStatusIndicator";
import { useCanvasShell } from "./CanvasShellContext";
import type { CanvasSurfaceSlots } from "./contracts";

const explorerMargin = (open: boolean) => ({
  margin: 0,
  marginLeft: open ? DRAWER_WIDTH : 0,
  transition: "margin-left 0.2s ease",
  pointerEvents: "none" as const,
});

/** 面板右缘保留的视觉间距，避免内容贴边或压到滚动条。 */
const PANEL_RIGHT_INSET = 12;

// 宽度上限由同一个抽屉常量派生；CSS 变量让 Tailwind 断点类保持静态可扫描。
const leftRowStyle = {
  pointerEvents: "none",
  "--left-row-max": `calc(100vw - ${PANEL_RIGHT_INSET}px)`,
  "--left-row-drawer-max": `calc(100vw - ${DRAWER_WIDTH + PANEL_RIGHT_INSET}px)`,
} as CSSProperties;

// 元素引用稳定：资源管理器 / 小地图重渲染时 ProjectToolbar 的 memo 仍可命中
const saveStatusTrailing = <CanvasSaveStatusIndicator />;

export function CanvasLeftPanels({ slots }: { slots: CanvasSurfaceSlots }) {
  const { explorerOpen } = useCanvasShell();
  const minimapVisible = useCanvasStore((s) => s.minimapVisible);

  return (
    <>
      {/* Top-left panel: project toolbar（尾部含保存状态） */}
      {/* pointer-events: none —— Panel 是绝对定位块，其透明留白（含 30px 内边距）会拦截画布点击与框选；仅项目卡片恢复 auto */}
      <Panel position="top-left" style={explorerMargin(explorerOpen)}>
        {/* 抽屉打开且 <1024px 时 Agent 下移到下一行；左上行随抽屉收窄并保留右侧间距 */}
        <div
          className={cn(
            "flex max-w-[var(--left-row-max)] items-center pl-[30px] pt-[30px]",
            explorerOpen && "md:max-lg:max-w-[var(--left-row-drawer-max)]",
          )}
          style={leftRowStyle}
        >
          <ProjectToolbar userMenu={slots.userMenu} trailing={saveStatusTrailing} />
        </div>
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
  const { explorerOpen, openAgent } = useCanvasShell();

  return (
    <Panel position="top-right" style={{ margin: 0, paddingRight: 30, paddingTop: 30, pointerEvents: "none" }}>
      {/* 窄屏（<768px）下移；资源管理器打开时左上整行右移，1024px 以下同样下移，避免覆盖保存状态 */}
      {/* Panel 的 pointer-events:none 会继承到子树，行内控件必须自行恢复命中 */}
      <div
        className={cn("flex items-center max-md:mt-11", explorerOpen && "max-lg:mt-11")}
        style={{ pointerEvents: "auto" }}
      >
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
