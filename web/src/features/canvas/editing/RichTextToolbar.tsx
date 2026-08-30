/**
 * 文本节点富文本编辑工具条。
 * 双击进入编辑态时显示在节点上方，提供行内格式、块级格式与撤销/重做。
 * 样式与定位完全参考裁剪 / 全景工具条：counter-scale 保证画布缩放下视觉大小恒定。
 */
"use client";

import { useViewport } from "@xyflow/react";
import { useEditorState, type Editor } from "@tiptap/react";
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
  Underline,
} from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import WheelGuard from "@/components/ui/WheelGuard";
import { MenuItem, MenuPopover } from "@/components/ui/MenuPopover";

interface Props {
  editor: Editor;
}

const HEADING_LEVELS = [1, 2, 3] as const;

export default function RichTextToolbar({ editor }: Props) {
  const { t } = useTranslation();
  const { zoom } = useViewport();
  const [headingOpen, setHeadingOpen] = useState(false);

  // 订阅编辑器事务，光标位置 / 格式状态变化时刷新激活态
  const active = useEditorState({
    editor,
    selector: ({ editor: ed }) => ({
      bold: ed.isActive("bold"),
      italic: ed.isActive("italic"),
      underline: ed.isActive("underline"),
      headingLevel: HEADING_LEVELS.find((level) => ed.isActive("heading", { level })) ?? null,
      bulletList: ed.isActive("bulletList"),
      orderedList: ed.isActive("orderedList"),
      blockquote: ed.isActive("blockquote"),
    }),
  });

  const headingLabel = active.headingLevel ? `H${active.headingLevel}` : t("richText.paragraph");

  const btnStyle = (on: boolean) => ({
    padding: 8,
    ...(on ? { background: "var(--canvas-bg-hover)", color: "#fff" } : {}),
  });

  return (
    <WheelGuard
      className="canvas-toolbar nodrag absolute left-1/2 flex items-center gap-1 rounded-xl z-40 pointer-events-auto"
      style={{
        height: 50,
        padding: "6px 10px",
        whiteSpace: "nowrap",
        bottom: `calc(100% + ${8 / zoom}px)`,
        transform: `translateX(-50%) scale(${1 / zoom})`,
        transformOrigin: "center bottom",
      }}
    >
      {/* 行内格式 */}
      <Tooltip title={t("richText.bold")}>
        <Button
          type="text"
          size="middle"
          style={btnStyle(active.bold)}
          icon={<Bold size={16} />}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => editor.chain().focus().toggleBold().run()}
        />
      </Tooltip>
      <Tooltip title={t("richText.italic")}>
        <Button
          type="text"
          size="middle"
          style={btnStyle(active.italic)}
          icon={<Italic size={16} />}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => editor.chain().focus().toggleItalic().run()}
        />
      </Tooltip>
      <Tooltip title={t("richText.underline")}>
        <Button
          type="text"
          size="middle"
          style={btnStyle(active.underline)}
          icon={<Underline size={16} />}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => editor.chain().focus().toggleUnderline().run()}
        />
      </Tooltip>

      <div className="w-px h-5 mx-1" style={{ background: "var(--canvas-border)" }} />

      {/* 块级格式 */}
      <MenuPopover
        open={headingOpen}
        onOpenChange={setHeadingOpen}
        placement="bottom"
        trigger={
          <Tooltip title={t("richText.heading")}>
            <Button
              type="text"
              size="middle"
              style={{ padding: "4px 8px", fontSize: 12, minWidth: 44, ...(active.headingLevel ? { background: "var(--canvas-bg-hover)", color: "#fff" } : {}) }}
              onMouseDown={(e) => e.preventDefault()}
            >
              {headingLabel}
            </Button>
          </Tooltip>
        }
        content={
          // 阻止菜单项 mousedown 抢走编辑器焦点，避免触发失焦退出编辑态
          <div onMouseDown={(e) => e.preventDefault()}>
            <MenuItem selected={!active.headingLevel} onClick={() => editor.chain().focus().setParagraph().run()}>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                <Type size={16} /> {t("richText.paragraph")}
              </span>
            </MenuItem>
            {HEADING_LEVELS.map((level) => (
              <MenuItem
                key={level}
                selected={active.headingLevel === level}
                onClick={() => editor.chain().focus().toggleHeading({ level }).run()}
              >
                <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                  {level === 1 ? <Heading1 size={16} /> : level === 2 ? <Heading2 size={16} /> : <Heading3 size={16} />}
                  {t(`richText.heading${level}`)}
                </span>
              </MenuItem>
            ))}
          </div>
        }
      />
      <Tooltip title={t("richText.bulletList")}>
        <Button
          type="text"
          size="middle"
          style={btnStyle(active.bulletList)}
          icon={<List size={16} />}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => editor.chain().focus().toggleBulletList().run()}
        />
      </Tooltip>
      <Tooltip title={t("richText.orderedList")}>
        <Button
          type="text"
          size="middle"
          style={btnStyle(active.orderedList)}
          icon={<ListOrdered size={16} />}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => editor.chain().focus().toggleOrderedList().run()}
        />
      </Tooltip>
      <Tooltip title={t("richText.blockquote")}>
        <Button
          type="text"
          size="middle"
          style={btnStyle(active.blockquote)}
          icon={<Quote size={16} />}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => editor.chain().focus().toggleBlockquote().run()}
        />
      </Tooltip>
      <Tooltip title={t("richText.horizontalRule")}>
        <Button
          type="text"
          size="middle"
          style={btnStyle(false)}
          icon={<Minus size={16} />}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => editor.chain().focus().setHorizontalRule().run()}
        />
      </Tooltip>

    </WheelGuard>
  );
}
