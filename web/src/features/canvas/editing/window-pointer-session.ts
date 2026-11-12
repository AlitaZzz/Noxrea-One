/**
 * 画布编辑面板的 window 指针会话收尾。
 *
 * pointerup / pointercancel 不是可靠的会话结束信号：窗口失焦（切标签页、
 * Alt+Tab、窗口外松手）后浏览器可能不再派发二者。只靠指针事件收尾会让拖拽
 * 会话残留——回到窗口后未按键的 pointermove 仍会继续拖动，过期会话还会在
 * 下一次 pointerup 上按旧落点补提交。
 *
 * 所有编辑面板的拖拽会话统一在 window 上监听 blur 并按取消收尾；注册与
 * 按函数身份移除只写一处，避免各会话各自漏掉某条收尾路径。
 */

export interface WindowPointerSessionHandlers {
  onMove: (event: PointerEvent) => void;
  onUp: (event: PointerEvent) => void;
  /** pointercancel：系统接管手势（触摸中断等），按取消收尾。 */
  onCancel: (event: PointerEvent) => void;
  /** 窗口失焦：浏览器可能不再补发 pointerup / pointercancel，会话必须自行收尾。 */
  onBlur: () => void;
}

/** 挂载一次拖拽会话的 window 监听，返回按函数身份移除的清理函数。 */
export function startWindowPointerSession({
  onMove,
  onUp,
  onCancel,
  onBlur,
}: WindowPointerSessionHandlers): () => void {
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onCancel);
  window.addEventListener("blur", onBlur);
  return () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onCancel);
    window.removeEventListener("blur", onBlur);
  };
}
