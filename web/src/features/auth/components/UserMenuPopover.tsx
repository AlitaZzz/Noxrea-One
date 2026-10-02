/**
 * 用户菜单薄壳：头像菜单的共享骨架（画布页左上角 / 项目页右上角共用），
 * 通过项目菜单出口统一交互与外观。
 * 统一「用户信息行 + 分割线 + 页面自定条目 + 分割线 + 退出登录」的结构；
 * 用户行以 group 条目挂进 Menu（label 为自定义 JSX，自带配色；静态不可点）。
 *
 * 页面差异通过参数注入：触发器与中段条目（items）由调用方给定
 * （画布=小 logo 触发 + 项目操作条目；项目页=头像 pill + 账户/语言条目）；
 * onLogout 由页面决定收尾（画布先弹确认框，项目页直接登出跳登录页）。
 * 放在 auth 特性层而非 components/ui：ui 层禁止依赖 feature（useCurrentUser）。
 */

"use client";

import type { ReactElement, ReactNode } from "react";
import { useTranslation } from "react-i18next";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useCurrentUser } from "@/features/auth/UserContext";

type UserMenuItem =
  | { type: "divider"; key?: string }
  | { type?: never; key: string; label?: ReactNode; extra?: ReactNode };

export function UserMenuPopover({ open, onOpenChange, trigger, placement = "bottomRight", items, onItemClick, onLogout }: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  trigger: ReactElement;
  /** 弹出方位：画布工具栏（左上角）用 bottomLeft，项目页头像（右上角）用 bottomRight */
  placement?: "bottomLeft" | "bottomRight";
  /** 中段业务条目：画布=项目主页/新建/删除，项目页=账户设置/语言切换 */
  items: UserMenuItem[];
  /** 中段条目点击（按 key 分发；退出登录走 onLogout，不经此处） */
  onItemClick: (key: string) => void;
  /** 退出登录动作：页面自持（确认框 / 直接登出 + 跳转目标） */
  onLogout: () => void;
}) {
  const { t } = useTranslation();
  const user = useCurrentUser();

  return (
    <DropdownMenu
      open={open}
      onOpenChange={onOpenChange}
    >
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent side="bottom" align={placement === "bottomLeft" ? "start" : "end"}>
        <DropdownMenuLabel>
          <div className="flex items-center gap-2 py-1" style={{ color: "var(--foreground)" }}>
            <div
              className="w-9 h-9 rounded-full flex items-center justify-center text-sm font-bold flex-shrink-0 overflow-hidden"
              style={{ background: user?.avatarUrl ? "transparent" : "var(--primary)", color: "var(--background)" }}
            >
              {user?.avatarUrl ? (
                <img src={user.avatarUrl} alt="" className="w-full h-full object-cover" />
              ) : (
                (user?.username || t("auth.defaultUser"))[0].toUpperCase()
              )}
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium truncate">
                {user?.username || t("auth.defaultUser")}
              </div>
            </div>
          </div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {items.map((item, index) => item.type === "divider" ? (
          <DropdownMenuSeparator key={item.key ?? `divider-${index}`} />
        ) : (
          <DropdownMenuItem key={item.key} onSelect={() => onItemClick(item.key)}>
            <span className="min-w-0 flex-1 truncate">{item.label}</span>
            {item.extra && <span className="ml-auto shrink-0">{item.extra}</span>}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onLogout}>{t("auth.logout")}</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
