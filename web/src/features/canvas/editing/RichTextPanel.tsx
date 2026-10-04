/**
 * 文本节点富文本编辑面板。
 * 双击进入编辑态时显示在节点上方，提供行内格式、块级格式与撤销/重做。
 * 定位由 RfNodeToolbar 恒定尺寸处理（与其它编辑工具栏统一）。
 */
"use client";

import { type Editor,useEditorState } from "@tiptap/react";
import { NodeToolbar as RfNodeToolbar, Position } from "@xyflow/react";
import { useTranslation } from "react-i18next";

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
} from "@/components/ui/AppIcon";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Toggle } from "@/components/ui/toggle";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
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

export default function RichTextPanel({ editor, nodeId }: Props) {
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

  return (
    <RfNodeToolbar nodeId={nodeId} position={Position.Top} align="center" offset={8} isVisible>
      <WheelGuard
        data-rich-text-toolbar=""
        // 统一阻止 mousedown 默认行为：点击工具条任意位置（含按钮间隙/背景）都不抢走编辑器焦点，
        // 否则编辑器失焦会触发退出编辑态。焦点不转移，光标位置也得以保留。
        onMouseDown={(e) => e.preventDefault()}
        className="canvas-toolbar nodrag flex h-[50px] items-center gap-1 rounded-xl whitespace-nowrap px-2.5 py-1.5"
      >
        {/* 行内格式 */}
        <Tooltip><TooltipTrigger asChild>
            <Toggle size="sm" pressed={active.bold} className="size-8 p-0"
              onClick={() => editor.chain().focus().toggleBold().run()}
            ><Bold size={16} /></Toggle>
          </TooltipTrigger><TooltipContent>{t("richText.bold")}</TooltipContent></Tooltip>
        <Tooltip><TooltipTrigger asChild>
            <Toggle size="sm" pressed={active.italic} className="size-8 p-0"
              onClick={() => editor.chain().focus().toggleItalic().run()}
            ><Italic size={16} /></Toggle>
          </TooltipTrigger><TooltipContent>{t("richText.italic")}</TooltipContent></Tooltip>
        <Separator orientation="vertical" className="mx-1 h-5" />

        {/* 段落类型 — 平铺，无需二级菜单 */}
        <Tooltip><TooltipTrigger asChild>
            <Toggle size="sm" pressed={!active.headingLevel} className="size-8 p-0"
              onClick={() => editor.chain().focus().setParagraph().run()}
            ><Type size={16} /></Toggle>
          </TooltipTrigger><TooltipContent>{t("richText.paragraph")}</TooltipContent></Tooltip>
        {HEADING_BUTTONS.map(({ level, Icon }) => (
          <Tooltip key={level}><TooltipTrigger asChild>
              <Toggle size="sm" pressed={active.headingLevel === level} className="size-8 p-0"
                onClick={() => editor.chain().focus().toggleHeading({ level }).run()}
              ><Icon size={16} /></Toggle>
            </TooltipTrigger><TooltipContent>{t(`richText.heading${level}`)}</TooltipContent></Tooltip>
        ))}
        <Separator orientation="vertical" className="mx-1 h-5" />

        {/* 块级结构 */}
        <Tooltip><TooltipTrigger asChild>
            <Toggle size="sm" pressed={active.bulletList} className="size-8 p-0"
              onClick={() => editor.chain().focus().toggleBulletList().run()}
            ><List size={16} /></Toggle>
          </TooltipTrigger><TooltipContent>{t("richText.bulletList")}</TooltipContent></Tooltip>
        <Tooltip><TooltipTrigger asChild>
            <Toggle size="sm" pressed={active.orderedList} className="size-8 p-0"
              onClick={() => editor.chain().focus().toggleOrderedList().run()}
            ><ListOrdered size={16} /></Toggle>
          </TooltipTrigger><TooltipContent>{t("richText.orderedList")}</TooltipContent></Tooltip>
        <Tooltip><TooltipTrigger asChild>
            <Toggle size="sm" pressed={active.blockquote} className="size-8 p-0"
              onClick={() => editor.chain().focus().toggleBlockquote().run()}
            ><Quote size={16} /></Toggle>
          </TooltipTrigger><TooltipContent>{t("richText.blockquote")}</TooltipContent></Tooltip>
        <Tooltip><TooltipTrigger asChild>
            <Button variant="ghost" iconOnly
              onClick={() => editor.chain().focus().setHorizontalRule().run()}
            ><Minus size={16} /></Button>
          </TooltipTrigger><TooltipContent>{t("richText.horizontalRule")}</TooltipContent></Tooltip>

      </WheelGuard>
    </RfNodeToolbar>
  );
}
