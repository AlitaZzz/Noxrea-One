import { useEffect } from "react";

import { isEditableTarget } from "@/features/canvas/shared/dom";
import { useCanvasStore } from "@/features/canvas/stores/canvas-store";

/** Esc 关闭面板：与点击画布空白（取消选中后面板自动卸载）形成一致的退出路径。
    输入框编辑中（重命名等按键目标为可编辑元素）与上层弹窗（modalOpen）打开时
    的 Esc 不归面板管，避免一次按键同时关掉两层 */
export default function useEscapeToClose(onClose: () => void) {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (isEditableTarget(e.target)) return;
      const st = useCanvasStore.getState();
      if (st.modalOpen || st.directorOverlayOpen) return;
      onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);
}
