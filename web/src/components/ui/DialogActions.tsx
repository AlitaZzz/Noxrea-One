/**
 * 弹窗底部动作区：取消（次行动）+ 主行动。
 *
 * 全站弹窗 footer 的唯一形态来源：容器样式与「取消」按钮的文案 / 禁用时机在此统一，
 * 主行动按钮由调用方提供——各自的主按钮差异较大（保存 / 确认 / 删除 / 需要 Tooltip 包裹），
 * 强行参数化只会长出开关，故只收敛真正重复的一半。
 */
"use client";

import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import AppButton from "@/components/ui/AppButton";

interface DialogActionsProps {
  /** 主行动按钮（variant / loading / disabled 由调用方决定） */
  children: ReactNode;
  onCancel: () => void;
  cancelText?: string;
  /** 主行动进行中时禁用取消，避免中途改主意导致状态不一致 */
  cancelDisabled?: boolean;
  /** 只保留主行动（无取消语义的强制流程，如会话过期） */
  hideCancel?: boolean;
}

export default function DialogActions({
  children,
  onCancel,
  cancelText,
  cancelDisabled,
  hideCancel = false,
}: DialogActionsProps) {
  const { t } = useTranslation();

  return (
    <div className="app-dialog-footer">
      {!hideCancel && (
        <AppButton onClick={onCancel} disabled={cancelDisabled}>
          {cancelText ?? t("common.cancel")}
        </AppButton>
      )}
      {children}
    </div>
  );
}
