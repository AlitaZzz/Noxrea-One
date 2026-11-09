/**
 * 用户菜单的跨模块契约类型。
 * 菜单 UI 归 `features/auth`；画布与项目页通过 app 注入的 slot 消费，
 * 只依赖这里的结构性 props，不导入 auth feature。
 */
import type { ReactElement, ReactNode } from "react";

export type UserMenuItem =
  | { type: "divider"; key?: string }
  | { type?: never; key: string; label?: ReactNode; extra?: ReactNode };

export interface UserMenuProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  trigger: ReactElement;
  /** 弹出方位：画布工具栏（左上角）用 bottomLeft，项目页头像（右上角）用 bottomRight */
  placement?: "bottomLeft" | "bottomRight";
  items: UserMenuItem[];
  onItemClick: (key: string) => void;
  onLogout: () => void;
}

/** 账号设置弹窗 slot（由 app 注入 features/auth 的实现）。 */
export interface AccountSettingsProps {
  open: boolean;
  onClose: () => void;
}
