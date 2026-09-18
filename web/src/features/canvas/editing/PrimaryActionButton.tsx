/**
 * 编辑工具栏共用的「确认」按钮：反色 ↑ 箭头，无 hover 变色（仅亮度提升）。
 * 片段截取 / 变速 / 标注 / 裁剪 / 视频画面裁剪工具栏与多角度、光照弹窗共用，
 * 避免样式漂移。
 */
"use client";

import { ArrowUpOutlined, LoadingOutlined } from "@ant-design/icons";

interface PrimaryActionButtonProps {
  onClick?: () => void;
  disabled?: boolean;
  /** 处理中：图标切换为 loading spinner */
  loading?: boolean;
  /** sm = 32px 方圆角（编辑工具栏默认）；lg = 36px 全圆（弹窗底部主操作） */
  size?: "sm" | "lg";
}

const SIZE_CLASS: Record<NonNullable<PrimaryActionButtonProps["size"]>, string> = {
  sm: "h-8 w-8 rounded-lg",
  lg: "h-9 w-9 rounded-full",
};

export default function PrimaryActionButton({ onClick, disabled, loading = false, size = "sm" }: PrimaryActionButtonProps) {
  const iconSize = size === "lg" ? 16 : 14;
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`flex cursor-pointer items-center justify-center transition-[filter] hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50 ${SIZE_CLASS[size]}`}
      style={{ background: "var(--canvas-text)", color: "var(--canvas-bg)" }}
    >
      {loading ? <LoadingOutlined style={{ fontSize: iconSize }} /> : <ArrowUpOutlined style={{ fontSize: iconSize }} />}
    </button>
  );
}
