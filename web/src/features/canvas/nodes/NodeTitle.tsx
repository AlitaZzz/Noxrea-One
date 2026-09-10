/**
 * 节点标题栏（各节点共用）。
 * 统一「图标 + 标题 + 右侧附加信息」的排版、双击进入编辑、Enter 保存 / Esc 放弃。
 *
 * 约定：title 既是标题栏显示文案，也是双击进入编辑时的初值 —— 两者同源，
 * 避免出现「点开后输入框里的初值和标题栏显示不一致」。
 * 需要「显示带派生信息、编辑纯名字」的场景（如分组节点的成员数）用 display 覆盖显示文案。
 */
"use client";

import { Input } from "antd";
import type { ReactNode } from "react";

import { useEditableTitle } from "@/features/canvas/hooks/use-editable-title";
import { NODE_TITLE_HEIGHT } from "@/lib/constants";

interface NodeTitleProps {
  nodeId: string;
  /** 标题文案，同时作为双击进入编辑时的初值 */
  title: string;
  /** 显示文案，缺省为 title；分组节点用它显示带成员数的文案，编辑时仍是纯名字 */
  display?: ReactNode;
  /** 标题图标 */
  icon?: ReactNode;
  /** 右侧附加信息（尺寸 / 时长 / 字数等），缺省不渲染 */
  trailing?: ReactNode;
  /** 追加到标题栏容器的类名（如文本节点需要 z-10 压在正文之上） */
  className?: string;
}

export default function NodeTitle({
  nodeId,
  title,
  display,
  icon,
  trailing,
  className,
}: NodeTitleProps) {
  const { editing, draft, setDraft, handleDblClick, handleSave, handleKeyDown } =
    useEditableTitle(nodeId, title);

  return (
    <div
      className={`flex items-center justify-between px-3 py-1 text-[13px] font-medium text-white/80 ${className ?? ""}`}
      style={{ height: NODE_TITLE_HEIGHT, flexShrink: 0 }}
    >
      {editing ? (
        <span className="flex items-center gap-0.5 flex-1 min-w-0">
          {icon}
          <Input
            size="small"
            variant="borderless"
            className="nodrag text-[13px] font-medium text-white/80"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={handleSave}
            onKeyDown={handleKeyDown}
            autoFocus
            style={{
              padding: "1px 4px",
              height: 20,
              background: "var(--canvas-bg)",
              border: "1px solid var(--canvas-border, #525252)",
              borderRadius: 4,
              outline: "none",
              boxShadow: "none",
              width: "100%",
            }}
          />
        </span>
      ) : (
        <span className="flex items-center gap-0.5 flex-1 min-w-0" onDoubleClick={handleDblClick}>
          {icon}
          <span className="truncate">{display ?? title}</span>
        </span>
      )}
      {trailing != null && trailing !== false && (
        <span className="ml-2 whitespace-nowrap text-xs text-white/30">{trailing}</span>
      )}
    </div>
  );
}
