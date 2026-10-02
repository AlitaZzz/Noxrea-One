/**
 * 通用二次确认弹窗。
 * 接收标题与正文文案，渲染取消 / 确定两个按钮，按钮文案缺省时取 i18n 默认值。
 */
"use client";

import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

interface Props {
  open: boolean;
  title: string;
  content: string;
  okText?: string;
  cancelText?: string;
  /** 确定按钮进入加载态并阻止重复提交，用于异步 onOk。 */
  confirmLoading?: boolean;
  /** 确定按钮的语义变体；删除等不可逆操作使用 destructive。 */
  confirmVariant?: "default" | "destructive" | "primary";
  /** 只保留确定按钮（无取消语义的强制流程，如会话过期）；Esc / 遮罩关闭同样走 onCancel。 */
  hideCancel?: boolean;
  onOk: () => void;
  onCancel: () => void;
  /** 显式指定 zIndex（默认由 layer depth 推导）。Drawer 等非 layer 容器内使用时传更高值（如 1050）。 */
  zIndex?: number;
  /** 挂到 body 呈现全屏遮罩，打断底层上下文；默认跟随父 layer 嵌套挂载。 */
  global?: boolean;
}

export default function ConfirmModal({ open, title, content, okText, cancelText, confirmLoading, confirmVariant = "default", hideCancel, onOk, onCancel, zIndex, global: isGlobal = false }: Props) {
  const { t } = useTranslation();

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => { if (!nextOpen) onCancel(); }}>
      <DialogContent global={isGlobal} zIndex={zIndex} className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{content}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          {!hideCancel && (
            <DialogClose asChild>
              <Button variant="outline" disabled={confirmLoading}>{cancelText ?? t("common.cancel")}</Button>
            </DialogClose>
          )}
          <Button variant={confirmVariant} loading={confirmLoading} onClick={onOk}>{okText ?? t("common.confirm")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
