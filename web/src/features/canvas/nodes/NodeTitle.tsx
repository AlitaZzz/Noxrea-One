/**
 * 节点标题栏（各节点共用）。
 * 统一「图标 + 标题 + 编辑铅笔 + 右侧附加信息」的排版、双击标题或点铅笔进入编辑、Enter 保存 / Esc 放弃。
 *
 * 约定：title 既是标题栏显示文案，也是进入编辑时的初值 —— 两者同源，
 * 避免出现「点开后输入框里的初值和标题栏显示不一致」。
 * 需要「显示带派生信息、编辑纯名字」的场景（如分组节点的成员数）用 display 覆盖显示文案。
 *
 * 交互：标题栏兼作拖拽把手（cursor-grab，按住可拖动节点），双击或点铅笔进入编辑。
 */
"use client";

import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { EditOutlined } from "@/components/ui/AppIcon";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useEditableTitle } from "@/features/canvas/hooks/use-editable-title";
import { NODE_TITLE_HEIGHT } from "@/lib/constants";

/** 量宽用的离屏 canvas（同字体复用，避免每次截断新建） */
let measureCtx: CanvasRenderingContext2D | null = null;

/**
 * 中间截断文本：超宽时省略号打在中间，头部（源名，身份）与尾部
 * （派生后缀，区分信息）都保留 —— 与 macOS Finder 文件名截断同一模式。
 * CSS 的 direction:rtl 技巧会把中文按 bidi 规则反向重排，不可用，
 * 故用 canvas 量宽 + 交替回收找可行的头/尾保留长度。
 */
function MidTruncate({
  children,
  className,
  style,
}: {
  children: string;
  className?: string;
  style?: React.CSSProperties;
}) {
  const text = children;
  const ref = useRef<HTMLSpanElement>(null);
  const [display, setDisplay] = useState(text);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    /** 量宽 + 中间截断：返回应显示的文案（不超宽时原样返回） */
    const clipText = (avail: number): string => {
      const cs = getComputedStyle(el);
      measureCtx ??= document.createElement("canvas").getContext("2d");
      if (!measureCtx || avail <= 0) return text;
      measureCtx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      const ellipsis = "…";
      if (measureCtx.measureText(text).width <= avail) return text;
      // 极窄：连省略号都放不下，只显示省略号
      if (measureCtx.measureText(ellipsis).width > avail) return ellipsis;
      const widthOf = (s: string) => measureCtx!.measureText(s).width;
      const availText = avail - widthOf(ellipsis);
      // 头尾按 2:1 字符预算起步（头部是身份，优先多留），超宽时交替回收保持比例
      let headLen = Math.min(Math.floor((text.length * 2) / 3), text.length - 1);
      let tailLen = Math.min(text.length - headLen, text.length - 1);
      const fits = () =>
        widthOf(text.slice(0, headLen)) + widthOf(text.slice(text.length - tailLen)) <= availText;
      while (!fits() && (headLen > 0 || tailLen > 0)) {
        if (headLen >= tailLen && headLen > 0) headLen--;
        else if (tailLen > 0) tailLen--;
      }
      return text.slice(0, headLen) + ellipsis + (tailLen > 0 ? text.slice(text.length - tailLen) : "");
    };
    // clientWidth 含左右内边距，量的是可用文本宽度
    const pad = parseFloat(getComputedStyle(el).paddingLeft) + parseFloat(getComputedStyle(el).paddingRight);
    const apply = () => setDisplay(clipText(el.clientWidth - pad));
    apply();
    // 节点宽度可手动拖拽调整，容器尺寸变化时重算
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
  }, [text]);

  return (
    <span ref={ref} className={className} style={{ ...style, overflow: "hidden", whiteSpace: "nowrap" }}>
      {display}
    </span>
  );
}

interface NodeTitleProps {
  nodeId: string;
  /** 标题文案，同时作为双击进入编辑时的初值 */
  title: string;
  /** 显示文案，缺省为 title；保尾截断（尾部派生信息不丢）要求纯文本 */
  display?: string;
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
  const { t } = useTranslation();
  const { editing, draft, setDraft, startEdit, handleSave, handleKeyDown } =
    useEditableTitle(nodeId, title);

  return (
    <div
      className={`ui-select-none group/title cursor-grab active:cursor-grabbing flex items-center justify-between px-3 py-1 text-[13px] font-medium text-white/80 ${className ?? ""}`}
      style={{ height: NODE_TITLE_HEIGHT, flexShrink: 0 }}
    >
      {editing ? (
        <span className="flex items-center gap-0.5 flex-1 min-w-0">
          {icon}
          <Input
            className="nodrag border-0 bg-transparent text-[13px] font-medium text-white/80 shadow-none focus-visible:ring-0"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={handleSave}
            onKeyDown={handleKeyDown}
            autoFocus
            // 进入编辑即全选：改名比追加更常见，全选便于一键替换
            onFocus={(e) => e.target.select()}
            style={{
              padding: "1px 4px",
              height: 20,
              background: "var(--card)",
              border: "1px solid var(--border, #525252)",
              borderRadius: 4,
              outline: "none",
              boxShadow: "none",
              width: "100%",
            }}
          />
        </span>
      ) : (
        <span className="flex items-center gap-0.5 flex-1 min-w-0" onDoubleClick={startEdit}>
          {icon}
          {/* 盒模型与编辑态 Input 一致（1px 边框 + 1px 4px 内边距），进入编辑时文字原点不跳动 */}
          <MidTruncate
            className="flex-1 min-w-0"
            style={{ padding: "1px 4px", border: "1px solid transparent", borderRadius: 4 }}
          >
            {display ?? title}
          </MidTruncate>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={t("common.edit")}
            className="nodrag shrink-0 rounded-sm p-0 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:text-foreground"
            onClick={startEdit}
          >
            <EditOutlined />
          </Button>
        </span>
      )}
      {trailing != null && trailing !== false && (
        <span className="ml-2 whitespace-nowrap text-xs text-white/30">{trailing}</span>
      )}
    </div>
  );
}
