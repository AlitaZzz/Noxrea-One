/**
 * 全站统一按钮。
 *
 * 背景：此前按钮有 9 类写法（弹窗按钮、工具条按钮、覆盖层圆按钮、纯文字按钮、
 * 危险按钮……），同一个「36px 高 / 8px 圆角」的样式在各文件里手写了一遍又一遍，
 * hover 还有用 JS state 模拟的。这里把视觉收敛到 CSS 类（.app-btn 及其修饰符）：
 *   - 调用点只关心「变体 + 尺寸 + 是否纯图标」，不再写 background / border / color；
 *   - hover / active / disabled 由 CSS 统一处理，不会再出现某个按钮忘了写 hover；
 *   - 颜色全部取 --canvas-* 语义变量，换主题时自动跟随。
 *
 * 变体语义（勿混用）：
 *   primary 白色填充 + 深色字 → 一个视图里唯一的「主行动」
 *   default 深色底 + 描边     → 次行动 / 取消
 *   ghost   透明底无描边       → 工具条图标按钮、纯文字按钮
 *   danger  红色描边 + 红字   → 删除等破坏性操作（不要用 primary 顶替）
 */
"use client";

import { type ButtonHTMLAttributes, forwardRef, type ReactNode } from "react";

export type AppButtonVariant = "primary" | "default" | "ghost" | "danger";
export type AppButtonSize = "sm" | "md";

interface Props extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className"> {
  variant?: AppButtonVariant;
  size?: AppButtonSize;
  /** 撑满父容器宽度 */
  block?: boolean;
  /** 纯图标：宽度收敛为与高度相等、内边距归零 */
  iconOnly?: boolean;
  loading?: boolean;
  /** 布局用（如 absolute 定位），不要用它改按钮视觉 */
  className?: string;
  children?: ReactNode;
}

const AppButton = forwardRef<HTMLButtonElement, Props>(function AppButton(
  { variant = "default", size = "md", block, iconOnly, loading, disabled, className, children, ...rest },
  ref,
) {
  const classes = [
    "app-btn",
    `app-btn--${variant}`,
    `app-btn--${size}`,
    block ? "app-btn--block" : "",
    iconOnly ? "app-btn--icon" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <button
      ref={ref}
      type="button"
      className={classes}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading && !iconOnly ? "处理中..." : children}
    </button>
  );
});

export default AppButton;
