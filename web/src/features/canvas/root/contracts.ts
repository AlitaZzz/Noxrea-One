/**
 * 画布页面级公共契约（`specs/canvas-root-decomposition.md`）。
 *
 * 页面（app 层）只通过本契约与 `CanvasRoot` 交互：项目身份、对外端口与
 * 外部 UI 插槽全部显式注入，画布不反向依赖 settings / assets / auth / project。
 */
import type { ReactElement, ReactNode } from "react";

import type { AssetItem } from "@/entities/asset";

/** 画布向外发起的一次性动作（导航、开关外部浮层）。 */
export interface CanvasPorts {
  /** 打开资产库弹窗（显隐由页面持有）。 */
  onOpenAssets: () => void;
  /** 打开渠道配置抽屉（显隐由页面持有）。 */
  onOpenSettings: () => void;
  /** 打开快捷键说明弹窗（显隐由页面持有）。 */
  onOpenShortcuts: () => void;
  /** 打开指定 Director 节点的全屏编辑器。 */
  onOpenDirector: (nodeId: string) => void;
}

/** 外部 UI 插槽：画布只负责在正确位置渲染，内容与状态由页面提供。 */
export interface CanvasSlots {
  /** 左上角用户菜单：触发元素与开合状态由 ProjectToolbar 提供。 */
  userMenu: (api: {
    /** 菜单触发器（按钮元素），由工具栏构造、页面插槽贴到菜单上。 */
    trigger: ReactElement;
    open: boolean;
    onOpenChange: (open: boolean) => void;
  }) => ReactNode;
  /** 资源管理器中的资产快捷区：只注入插入动作。 */
  assetBrowser: (api: { onInsertAsset: (asset: AssetItem) => void }) => ReactNode;
  /** 资产库弹窗：开合由页面闭包绑定，插槽 API 只含插入动作。 */
  assetsDialog: (api: {
    onInsertAsset: (asset: AssetItem) => void;
    onInsertAssets: (assets: AssetItem[]) => void;
  }) => ReactNode;
}

export interface CanvasRootProps {
  /** URL 项目身份（唯一真相源），同时作为画布媒体子树的 remount key。 */
  projectId: string;
  ports: CanvasPorts;
  slots: CanvasSlots;
  /** 页面浮层打开时阻断画布输入（与画布内部编辑面板的 modalOpen 合并）。 */
  inputBlocked?: boolean;
}

/** CanvasSurface 只接收 userMenu；assetBrowser 由 CanvasRoot 直接下发给 CanvasExplorer，assetsDialog 由 CanvasRoot 单独挂载。 */
export type CanvasSurfaceSlots = Pick<CanvasSlots, "userMenu">;
