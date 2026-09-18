/**
 * 文本节点富文本编辑工具条。
 * 双击进入编辑态时显示在节点上方，提供行内格式、块级格式与撤销/重做。
 * 定位由 RfNodeToolbar 恒定尺寸处理（与其它编辑工具栏统一）。
 */
"use client";

import { type Editor,useEditorState } from "@tiptap/react";
import { NodeToolbar as RfNodeToolbar, Position } from "@xyflow/react";
import { Button, Tooltip } from "antd";
import {
  Bold,
  Heading1,
  Heading2,
  Heading3,
  Italic,
  List,
  ListOrdered,
  Minus,
  Quote,
  Type,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import WheelGuard from "@/components/ui/WheelGuard";

interface Props {
  editor: Editor;
  /** 所属文本节点 id：RfNodeToolbar 定位用 */
  nodeId: string;
}

/** 标题级别按纽：级别 + 对应图标，直接平铺在工具条上 */
const HEADING_BUTTONS = [
  { level: 1, Icon: Heading1 },
  { level: 2, Icon: Heading2 },
  { level: 3, Icon: Heading3 },
] as const;

export default function RichTextToolbar({ editor, nodeId }: Props) {
  const { t } = useTranslation();
  // 订阅编辑器事务，光标位置 / 格式状态变化时刷新激活态
  const active = useEditorState({
    editor,
    selector: ({ editor: ed }) => ({
      bold: ed.isActive("bold"),
      italic: ed.isActive("italic"),
      headingLevel: HEADING_BUTTONS.find(({ level }) => ed.isActive("heading", { level }))?.level ?? null,
      bulletList: ed.isActive("bulletList"),
      orderedList: ed.isActive("orderedList"),
      blockquote: ed.isActive("blockquote"),
    }),
  });

  const btnStyle = (on: boolean) => ({
    padding: 8,
    ...(on ? { background: "var(--canvas-bg-hover)", color: "#fff" } : {}),
  });

  return (
    <RfNodeToolbar nodeId={nodeId} position={Position.Top} align="center" offset={8} isVisible>
    <WheelGuard
      data-rich-text-toolbar=""
      // 统一阻止 mousedown 默认行为：点击工具条任意位置（含按钮间隙/背景）都不抢走编辑器焦点，
      // 否则编辑器失焦会触发退出编辑态。焦点不转移，光标位置也得以保留。
      onMouseDown={(e) => e.preventDefault()}
      className="canvas-toolbar nodrag flex items-center gap-1 rounded-xl"
      style={{
        height: 50,
        padding: "6px 10px",
        whiteSpace: "nowrap",
      }}
    >
      {/* 行内格式 */}
      <Tooltip title={t("richText.bold")}>
        <Button
          type="text"
          size="middle"
          style={btnStyle(active.bold)}
          icon={<Bold size={16} />}
          onClick={() => editor.chain().focus().toggleBold().run()}
        />
      </Tooltip>
      <Tooltip title={t("richText.italic")}>
        <Button
          type="text"
          size="middle"
          style={btnStyle(active.italic)}
          icon={<Italic size={16} />}
          onClick={() => editor.chain().focus().toggleItalic().run()}
        />
      </Tooltip>
      <div className="w-px h-5 mx-1" style={{ background: "var(--canvas-border)" }} />

      {/* 段落类型 — 平铺，无需二级菜单 */}
      <Tooltip title={t("richText.paragraph")}>
        <Button
          type="text"
          size="middle"
          style={btnStyle(!active.headingLevel)}
          icon={<Type size={16} />}
          onClick={() => editor.chain().focus().setParagraph().run()}
        />
      </Tooltip>
      {HEADING_BUTTONS.map(({ level, Icon }) => (
        <Tooltip key={level} title={t(`richText.heading${level}`)}>
          <Button
            type="text"
            size="middle"
            style={btnStyle(active.headingLevel === level)}
            icon={<Icon size={16} />}
            onClick={() => editor.chain().focus().toggleHeading({ level }).run()}
          />
        </Tooltip>
      ))}
      <div className="w-px h-5 mx-1" style={{ background: "var(--canvas-border)" }} />

      {/* 块级结构 */}
      <Tooltip title={t("richText.bulletList")}>
        <Button
          type="text"
          size="middle"
          style={btnStyle(active.bulletList)}
          icon={<List size={16} />}
          onClick={() => editor.chain().focus().toggleBulletList().run()}
        />
      </Tooltip>
      <Tooltip title={t("richText.orderedList")}>
        <Button
          type="text"
          size="middle"
          style={btnStyle(active.orderedList)}
          icon={<ListOrdered size={16} />}
          onClick={() => editor.chain().focus().toggleOrderedList().run()}
        />
      </Tooltip>
      <Tooltip title={t("richText.blockquote")}>
        <Button
          type="text"
          size="middle"
          style={btnStyle(active.blockquote)}
          icon={<Quote size={16} />}
          onClick={() => editor.chain().focus().toggleBlockquote().run()}
        />
      </Tooltip>
      <Tooltip title={t("richText.horizontalRule")}>
        <Button
          type="text"
          size="middle"
          style={btnStyle(false)}
          icon={<Minus size={16} />}
          onClick={() => editor.chain().focus().setHorizontalRule().run()}
        />
      </Tooltip>

    </WheelGuard>
    </RfNodeToolbar>
  );
}
