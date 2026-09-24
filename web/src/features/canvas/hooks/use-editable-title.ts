/**
 * 节点标题就地编辑 hook：封装进入编辑（双击标题 / 点铅笔）、回车 / 失焦保存、Esc 放弃的通用逻辑。
 */
"use client";

import { type KeyboardEvent, useCallback, useRef, useState } from "react";

import { EventNames } from "@/lib/constants";

/**
 * 节点标题编辑 hook。
 *
 * 封装了「进入编辑 → Input 修改 → 失焦/回车保存 / Esc 放弃」的通用逻辑。
 * currentTitle 同时作为编辑初值：调用方必须传入与标题栏显示一致的文案，
 * 否则会出现「点开后输入框初值与标题栏不符」。保存时写入 label。
 */
export function useEditableTitle(nodeId: string, currentTitle: string) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(currentTitle);
  // Esc 放弃后，输入框卸载可能触发 blur → handleSave；用标记拦掉这次保存
  const cancelledRef = useRef(false);

  const startEdit = useCallback(() => {
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
    // 空值也允许保存：清空输入 = 清除标题（label 写空串），头部显示回退到类型名；
    // trim 防止纯空格被当成有效标题（空格串是真值，显示层回退会失效）
    const next = draft.trim();
    if (next === currentTitle) return;
    const data: Record<string, string> = { label: next };
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

  return { editing, draft, setDraft, startEdit, handleSave, handleCancel, handleKeyDown };
}
