/**
 * 画布菜单状态仓库：记录弹出坐标、显隐与上下文类型。
 *
 * 菜单有两种触发方式、三类上下文，职责互不重叠：
 * - create：左键双击空白处 → 新增各类节点
 * - canvas：右键空白处     → 粘贴 / 全选 / 整理 / 重置视图
 * - node  ：右键节点上     → 复制 / 删除
 */
import { create } from "zustand";

/** 菜单上下文类型，决定渲染哪些菜单项 */
export type CanvasMenuKind = "create" | "canvas" | "node";

interface CtxState {
  x: number; y: number; visible: boolean;
  /** 上下文类型；缺省 create 以兼容既有的双击调用 */
  kind: CanvasMenuKind;
  /** kind 为 node 时的目标节点 id */
  nodeId: string | null;
  show: (x: number, y: number, kind?: CanvasMenuKind, nodeId?: string) => void;
  hide: () => void;
}

/** 画布菜单状态（独立于组件，hooks 和组件均可使用） */
export const useContextMenuStore = create<CtxState>((set) => ({
  x: 0, y: 0, visible: false, kind: "create", nodeId: null,
  show: (x, y, kind = "create", nodeId) =>
    set({ x, y, visible: true, kind, nodeId: nodeId ?? null }),
  hide: () => set({ visible: false }),
}));
