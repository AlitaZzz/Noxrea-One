/**
 * 主操作按钮（PrimaryActionButton）：反色 ↑ 箭头，无 hover 变色（仅亮度提升）。
 * 统一「向上提交主操作」的视觉语言：编辑工具栏 = 应用/确认，生成面板 = 生成。
 * 片段截取 / 变速 / 标注 / 裁剪 / 视频画面裁剪 / 多角度 / 光照共用，避免样式漂移。
 */
"use client";

import { ArrowUpOutlined, LoadingOutlined } from "@ant-design/icons";

interface PrimaryActionButtonProps {
  onClick?: () => void;
  disabled?: boolean;
  /** 处理中：图标切换为 loading spinner */
  loading?: boolean;
}

export default function PrimaryActionButton({ onClick, disabled, loading = false }: PrimaryActionButtonProps) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg transition-[filter] hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
      style={{ background: "var(--canvas-text)", color: "var(--canvas-bg)" }}
    >
      {loading ? <LoadingOutlined style={{ fontSize: 14 }} /> : <ArrowUpOutlined style={{ fontSize: 14 }} />}
    </button>
  );
}
