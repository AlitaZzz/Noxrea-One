/**
 * 用户菜单薄壳：头像菜单的共享骨架（画布页左上角 / 项目页右上角共用），
 * 通过项目菜单出口统一交互与外观。
 * 统一「用户信息行 + 分割线 + 页面自定条目 + 分割线 + 退出登录」的结构；
 * 用户行以 group 条目挂进 Menu（label 为自定义 JSX，自带配色；静态不可点）。
 *
 * 页面差异通过参数注入：触发器与中段条目（items）由调用方给定
 * （画布=小 logo 触发 + 项目操作条目；项目页=头像 pill + 账户/语言条目）；
 * onLogout 由页面决定收尾（画布先弹确认框，项目页直接登出跳登录页）。
 * 放在 auth 特性层而非 components/ui：ui 层只依赖 shared，不能读取 entities/user
 * 的登录态（useCurrentUser），且退出登录属账户能力而非通用控件行为。
 */

"use client";

import { memo } from "react";
import { useTranslation } from "react-i18next";

import { ResolvedImage } from "@/components/media/ResolvedMedia";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useCurrentUser } from "@/entities/user";
import type { UserMenuProps } from "@/types/user-menu";

function UserMenuPopoverImpl({ open, onOpenChange, trigger, placement = "bottomRight", items, onItemClick, onLogout }: UserMenuProps) {
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
          <div className="flex items-center gap-2 py-1 text-foreground">
            <div className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-full text-sm font-bold">
              <ResolvedImage
                value={user?.avatarKey}
                alt=""
                className="h-full w-full object-cover"
                fallback={(
                  <span className="flex size-full items-center justify-center bg-primary text-primary-foreground">
                    {(user?.username || t("auth.defaultUser"))[0].toUpperCase()}
                  </span>
                )}
              />
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

// 外壳在程序化位置帧逐帧重渲染：触发元素、items 与回调由调用方稳定化后，本组件直接 bail。
export const UserMenuPopover = memo(UserMenuPopoverImpl);
