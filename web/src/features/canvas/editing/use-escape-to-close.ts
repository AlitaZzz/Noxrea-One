import { useEffect } from "react";

import { useCanvasInputBlocked } from "@/features/canvas/root/CanvasInputGateContext";
import { isEditableTarget } from "@/features/canvas/shared/dom";

/** Esc 关闭面板：与点击画布空白（取消选中后面板自动卸载）形成一致的退出路径。
    输入框编辑中（重命名等按键目标为可编辑元素）与上层浮层（输入门打开）时
    的 Esc 不归面板管，避免一次按键同时关掉两层 */
export default function useEscapeToClose(onClose: () => void) {
  const inputBlocked = useCanvasInputBlocked();

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (isEditableTarget(e.target)) return;
      if (inputBlocked) return;
      onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [inputBlocked, onClose]);
}
