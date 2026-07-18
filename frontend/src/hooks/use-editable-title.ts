"use client";

import { useState, useCallback } from "react";
import { EventNames } from "@/lib/eventNames";

/**
 * 节点标题编辑 hook。
 *
 * 封装了「双击进入编辑 → Input 修改 → 失焦/回车保存」的通用逻辑。
 * 保存时同时设置 label 和 alt（调用方通过 syncAlt 控制）。
 */
export function useEditableTitle(
  nodeId: string,
  currentLabel: string,
  options?: { syncAlt?: boolean },
) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(currentLabel);

  const handleDblClick = useCallback(() => {
    setDraft(currentLabel);
    setEditing(true);
  }, [currentLabel]);

  const handleSave = useCallback(() => {
    setEditing(false);
    if (!draft || draft === currentLabel) return;
    const data: Record<string, string> = { label: draft };
    if (options?.syncAlt) data.alt = draft;
    window.dispatchEvent(
      new CustomEvent(EventNames.NODE_UPDATE_DATA, {
        detail: { nodeId, data },
      })
    );
  }, [nodeId, draft, currentLabel, options?.syncAlt]);

  return { editing, draft, setDraft, handleDblClick, handleSave };
}
