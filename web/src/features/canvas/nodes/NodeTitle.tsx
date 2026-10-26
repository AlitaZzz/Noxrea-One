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

import { type ReactNode, useEffect, useRef, useState } from "react";
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
function clipText(el: HTMLElement, text: string, avail: number): string {
  measureCtx ??= document.createElement("canvas").getContext("2d");
  if (!measureCtx || avail <= 0) return text;
  const cs = getComputedStyle(el);
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
}

/**
 * 共享尺寸观察者：每个标题各建一个 ResizeObserver 会在 90 节点画布挂载时
 * 制造 90 个观察者，并在 layout effect 里同步量宽 —— 后者发生在 React 提交期，
 * 每读一次 clientWidth 都把刚提交的 DOM 重新布局一遍。
 * 改为单观察者分发：首个回调即初始测量，此时布局已完成，读尺寸不再触发提交期重排。
 */
const clipCallbacks = new Map<Element, (avail: number) => void>();
let clipObserver: ResizeObserver | null = null;

function observeClip(el: Element, cb: (avail: number) => void): () => void {
  clipObserver ??= new ResizeObserver((entries) => {
    for (const entry of entries) {
      // contentRect 即文本可用宽度（不含 padding），无需再读计算样式
      clipCallbacks.get(entry.target)?.(entry.contentRect.width);
    }
  });
  clipCallbacks.set(el, cb);
  clipObserver.observe(el);
  return () => {
    clipCallbacks.delete(el);
    clipObserver?.unobserve(el);
    if (clipCallbacks.size === 0) {
      clipObserver?.disconnect();
      clipObserver = null;
    }
  };
}

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
  // 记录截断结果及其对应的原文；原文变化时先显示原文（overflow 会裁切），
  // 等尺寸回调写入新结果，避免在渲染期读旧文案的截断结果。
  const [clipped, setClipped] = useState<{ text: string; display: string } | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    return observeClip(el, (avail) => {
      const next = clipText(el, text, avail);
      setClipped((prev) => {
        // 不超宽：显示原文即是目标状态，无需额外渲染
        if (next === text) return prev?.text === text ? null : prev;
        return prev?.text === text && prev.display === next ? prev : { text, display: next };
      });
    });
  }, [text]);

  const display = clipped?.text === text ? clipped.display : text;

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
      className={`ui-select-none group/title cursor-grab active:cursor-grabbing flex items-center justify-between px-3 py-1 text-[13px] font-medium text-foreground ${className ?? ""}`}
      style={{ height: NODE_TITLE_HEIGHT, flexShrink: 0 }}
    >
      {editing ? (
        <span className="flex items-center gap-0.5 flex-1 min-w-0">
          {icon}
          <Input
            className="nodrag h-5 w-full min-w-0 rounded border border-border bg-card px-1 py-px text-[13px] font-medium text-foreground shadow-none outline-none focus-visible:border-border focus-visible:ring-0 dark:bg-card"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={handleSave}
            onKeyDown={handleKeyDown}
            autoFocus
            // 进入编辑即全选：改名比追加更常见，全选便于一键替换
            onFocus={(e) => e.target.select()}
          />
        </span>
      ) : (
        <span className="flex items-center gap-0.5 flex-1 min-w-0" onDoubleClick={startEdit}>
          {icon}
          {/* 盒模型与编辑态 Input 一致（1px 边框 + 1px 4px 内边距），进入编辑时文字原点不跳动 */}
          <MidTruncate
            className="min-w-0 flex-1 rounded border border-transparent px-1 py-px"
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
        <span className="ml-2 whitespace-nowrap text-xs text-muted-foreground">{trailing}</span>
      )}
    </div>
  );
}
