/**
 * 文本节点（text-node）渲染组件。
 * 展示 / 就地编辑文本内容与节点标题，支持清空、生成中状态展示、
 * 四角缩放与上下连接桩；内容变更通过自定义事件回传画布层统一落库。
 */
"use client";

import { Handle, type NodeProps, Position } from "@xyflow/react";
import { Input } from "antd";
import { memo, useCallback, useEffect, useRef, useState } from "react";

import { TextIcon } from "@/components/ui/icons/media/TextIcon";
import { useEditableTitle } from "@/features/canvas/hooks/use-editable-title";
import { EventNames, isGenerating, NODE_HANDLE_TOP, NODE_TITLE_HEIGHT, NODE_TYPE,NODE_TYPE_COLOR, TEXT_NODE_MIN_HEIGHT, TEXT_NODE_MIN_WIDTH } from "@/lib/constants";
import type { TextNode as TextNodeType } from "@/features/canvas/types";
import { markDirtyImmediate, useCanvasStore } from "@/features/canvas/stores/canvas-store";
import { useTranslation } from "react-i18next";

import ResizeHandle from "./ResizeHandle";

function TextNode({ id, data, selected }: NodeProps<TextNodeType>) {
  const { t } = useTranslation();
  const content = data.content || "";
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [editingContent, setEditingContent] = useState(false);

  const { editing: editingTitle, draft: titleDraft, setDraft: setTitleDraft, handleDblClick: handleTitleDblClick, handleSave: handleTitleSave } =
    useEditableTitle(id, data.label || t("node.text"));

  const exitEditing = useCallback(() => {
    const el = textareaRef.current;
    if (el) {
      const len = el.value.length;
      el.setSelectionRange(len, len);
      el.blur();
    }
    window.getSelection()?.removeAllRanges();
    setEditingContent(false);
  }, []);

  const handleChange = useCallback(
    (value: string) => {
      window.dispatchEvent(
        new CustomEvent(EventNames.NODE_UPDATE_DATA, {
          detail: { nodeId: id, data: { content: value } },
        })
      );
    },
    [id]
  );

  const handleClear = useCallback(() => {
    useCanvasStore.getState().updateNodeData(id, { content: "" });
    markDirtyImmediate();
    setEditingContent(true);
  }, [id]);

  // Listen for node action events from NodeToolbar
  const actionRefs = useRef({ handleClear });
  useEffect(() => {
    actionRefs.current = { handleClear };
  }, [handleClear]);
  useEffect(() => {
    function onNodeAction(e: Event) {
      const ce = e as CustomEvent;
      if (ce.detail?.nodeId !== id) return;
      switch (ce.detail?.action) {
        case "clear": actionRefs.current.handleClear(); break;
      }
    }
    window.addEventListener(EventNames.CANVAS_NODE_ACTION, onNodeAction);
    return () => window.removeEventListener(EventNames.CANVAS_NODE_ACTION, onNodeAction);
  }, [id]);

  // 编辑状态下阻止 wheel / mousedown 冒泡到 React Flow 画布
  useEffect(() => {
    const el = textareaRef.current;
    if (!el || !editingContent) return;
    const stopWheel = (e: WheelEvent) => e.stopPropagation();
    const stopMouse = (e: MouseEvent) => e.stopPropagation();
    el.addEventListener("wheel", stopWheel, { passive: false });
    el.addEventListener("mousedown", stopMouse);
    return () => {
      el.removeEventListener("wheel", stopWheel);
      el.removeEventListener("mousedown", stopMouse);
    };
  }, [editingContent]);

  const generating = isGenerating(data.taskBinding);
  const charCount = content.length;

  return (
    <div className="group relative w-full h-full flex flex-col">
      {/* Title tab */}
      <div className="flex items-center px-3 py-1 text-[13px] font-medium text-white/80 z-10" style={{ height: NODE_TITLE_HEIGHT, flexShrink: 0 }}>
        {editingTitle ? (
          <span className="flex items-center gap-1 flex-1 min-w-0">
            <TextIcon className="shrink-0" />
            <Input
              size="small"
              variant="borderless"
              className="nodrag"
              value={titleDraft}
              onChange={(e) => setTitleDraft(e.target.value)}
              onBlur={handleTitleSave}
              onPressEnter={handleTitleSave}
              autoFocus
              style={{ padding: "1px 4px", height: 20, background: "var(--canvas-bg)", border: "1px solid #525252", borderRadius: 4, outline: "none", boxShadow: "none", width: "100%" }}
            />
          </span>
        ) : (
          <span className="flex items-center gap-1 flex-1 min-w-0">
            <TextIcon className="shrink-0 mr-1" />
            <span className="truncate cursor-default" onDoubleClick={handleTitleDblClick}>
              {data.label || t("node.text")}
            </span>
          </span>
        )}
        {charCount > 0 && (
          <span
            className="text-xs whitespace-nowrap ml-2"
            style={{ color: charCount > 500 ? "#faad14" : "rgba(255,255,255,0.3)" }}
          >
            {charCount}
          </span>
        )}
      </div>

      {/* Body */}
      <div
        className={`node-body relative flex-1 flex flex-col overflow-hidden rounded-lg ${selected ? "node-selected" : ""}`}
        style={{ background: "var(--canvas-bg, #262626)" }}
        onDoubleClick={(e) => {
          e.stopPropagation();
          setEditingContent(true);
          requestAnimationFrame(() => {
            textareaRef.current?.focus();
            // 触发一次 mousemove 让浏览器刷新 cursor
            const rect = textareaRef.current?.getBoundingClientRect();
            if (rect) {
              const evt = new MouseEvent("mousemove", { clientX: rect.left + 1, clientY: rect.top + 1 });
              window.dispatchEvent(evt);
            }
          });
        }}
      >
        <style>{`
          [data-text-node] { cursor: auto; }
          [data-text-node]::-webkit-scrollbar { cursor: default; }
          [data-text-node]::-webkit-scrollbar-thumb { cursor: default; }
        `}</style>
        <textarea
          ref={textareaRef}
          data-text-node
          className={`flex-1 w-full resize-none border-none outline-none p-3 text-sm text-white/80 placeholder:text-white/20 ${editingContent ? "nodrag" : ""}`}
          style={{ background: "transparent", pointerEvents: editingContent ? "auto" : "none", cursor: "auto" }}
          placeholder={t("node.textPlaceholder")}
          value={content}
          onChange={(e) => handleChange(e.target.value)}
          readOnly={!editingContent}
          onBlur={exitEditing}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              textareaRef.current?.blur();
            }
          }}
        />
        {generating && (
          <div className="absolute inset-0 rounded-lg flex flex-col items-center justify-center gap-3 overflow-hidden" style={{ background: "var(--canvas-bg, #262626)" }}>
            <div className="absolute inset-0" style={{ background: "radial-gradient(circle at 50% 45%, rgba(59,130,246,0.35), transparent 70%)", animation: "breathe 3s ease-in-out infinite" }} />
            <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
            <span className="text-sm text-white/50">{t("common.generating")}</span>
          </div>
        )}
      </div>

      {selected && (
        <ResizeHandle nodeId={id} corner="bottom-right" minWidth={TEXT_NODE_MIN_WIDTH} minHeight={TEXT_NODE_MIN_HEIGHT} />
      )}

      <Handle type="target" position={Position.Left} style={{ background: NODE_TYPE_COLOR[NODE_TYPE.TEXT], top: NODE_HANDLE_TOP }} />
      <Handle type="source" position={Position.Right} style={{ background: NODE_TYPE_COLOR[NODE_TYPE.TEXT], top: NODE_HANDLE_TOP }} />
    </div>
  );
}

export default memo(TextNode);
