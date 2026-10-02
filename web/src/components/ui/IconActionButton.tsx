/**
 * 纯图标圆形动作按钮。
 * 统一「向上提交主操作」的视觉语言：反色 ↑ 箭头，无 hover 变色（仅亮度提升）。
 * 三态：默认 ↑（提交）/ loading（处理中 spinner）/ cancel（红底 ✕，语义为取消进行中的任务，仍可点击）。
 */
"use client";

import { ArrowUpOutlined, CloseOutlined } from "@/components/ui/AppIcon";
import { Button } from "@/components/ui/button";

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
    <Button
      type="button"
      variant={cancel ? "destructive" : "default"}
      size="icon-sm"
      disabled={disabled}
      loading={loading && !cancel}
      onClick={onClick}
      aria-label={cancel ? "Cancel" : loading ? "Loading" : "Submit"}
    >
      {cancel ? <CloseOutlined aria-hidden="true" /> : <ArrowUpOutlined aria-hidden="true" />}
    </Button>
  );
}
