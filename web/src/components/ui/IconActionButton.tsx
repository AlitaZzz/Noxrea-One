/**
 * 纯图标圆形动作按钮。
 * 统一「向上提交主操作」的视觉语言：反色 ↑ 箭头，无 hover 变色（仅亮度提升）。
 * 三态：默认 ↑（提交）/ loading（处理中 spinner）/ cancel（红底 ✕，语义为取消进行中的任务，仍可点击）。
 */
"use client";

import { ArrowUpOutlined, CloseOutlined, LoadingOutlined } from "@ant-design/icons";

interface IconActionButtonProps {
  onClick?: () => void;
  disabled?: boolean;
  /** 处理中：图标切换为 loading spinner */
  loading?: boolean;
  /** 取消态：红底 + ✕（点击取消任务），仍可点击 */
  cancel?: boolean;
}

export default function IconActionButton({ onClick, disabled, loading = false, cancel = false }: IconActionButtonProps) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg transition-[filter] hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
      style={{ background: cancel ? "var(--canvas-danger)" : "var(--canvas-text)", color: "var(--canvas-bg)" }}
    >
      {cancel ? <CloseOutlined style={{ fontSize: 14 }} /> : loading ? <LoadingOutlined style={{ fontSize: 14 }} /> : <ArrowUpOutlined style={{ fontSize: 14 }} />}
    </button>
  );
}
