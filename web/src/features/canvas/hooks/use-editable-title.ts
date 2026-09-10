/**
 * 节点标题就地编辑 hook：封装双击进入编辑、回车 / 失焦保存、Esc 放弃的通用逻辑。
 */
"use client";

import { type KeyboardEvent, useCallback, useRef, useState } from "react";

import { EventNames } from "@/lib/constants";

/**
 * 节点标题编辑 hook。
 *
 * 封装了「双击进入编辑 → Input 修改 → 失焦/回车保存 / Esc 放弃」的通用逻辑。
 * currentTitle 同时作为编辑初值：调用方必须传入与标题栏显示一致的文案，
 * 否则会出现「点开后输入框初值与标题栏不符」。保存时写入 label。
 */
export function useEditableTitle(nodeId: string, currentTitle: string) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(currentTitle);
  // Esc 放弃后，输入框卸载可能触发 blur → handleSave；用标记拦掉这次保存
  const cancelledRef = useRef(false);

  const handleDblClick = useCallback(() => {
    cancelledRef.current = false;
    setDraft(currentTitle);
    setEditing(true);
  }, [currentTitle]);

  const handleSave = useCallback(() => {
    setEditing(false);
    if (cancelledRef.current) {
      cancelledRef.current = false;
      return;
    }
    if (!draft || draft === currentTitle) return;
    const data: Record<string, string> = { label: draft };
    window.dispatchEvent(
      new CustomEvent(EventNames.NODE_UPDATE_DATA, {
        detail: { nodeId, data },
      })
    );
  }, [nodeId, draft, currentTitle]);

  /** Esc：放弃本次修改，不落库 */
  const handleCancel = useCallback(() => {
    cancelledRef.current = true;
    setEditing(false);
  }, []);

  /** 统一键盘行为：Enter 保存，Esc 放弃 */
  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      // 输入法组字期间的 Enter / Esc 是选词操作，不能当成保存 / 放弃
      if (e.nativeEvent.isComposing) return;
      if (e.key === "Enter") {
        e.preventDefault();
        handleSave();
      } else if (e.key === "Escape") {
        e.preventDefault();
        handleCancel();
      }
    },
    [handleSave, handleCancel]
  );

  return { editing, draft, setDraft, handleDblClick, handleSave, handleCancel, handleKeyDown };
}
