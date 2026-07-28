"use client";

import { FontSizeOutlined } from "@ant-design/icons";
import { Handle, type NodeProps, Position } from "@xyflow/react";
import { Input } from "antd";
import { memo, useCallback, useEffect, useRef, useState } from "react";

import { TEXT_NODE_MIN_HEIGHT, TEXT_NODE_MIN_WIDTH } from "@/lib/constants";
import { EventNames } from "@/lib/event-names";
import type { TextNode as TextNodeType } from "@/lib/types";
import { isGenerating } from "@/lib/types";
import { markDirtyImmediate, useCanvasStore } from "@/stores/canvas-store";
import { useI18nStore } from "@/stores/i18n-store";
import { useEditableTitle } from "@/hooks/use-editable-title";

import ResizeHandle from "./ResizeHandle";

function TextNode({ id, data, selected }: NodeProps<TextNodeType>) {
  useI18nStore((s) => s.lang);
  const t = useI18nStore((s) => s.t);
  const content = data.content || "";
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [editingContent, setEditingContent] = useState(false);

  const { editing: editingTitle, draft: titleDraft, setDraft: setTitleDraft, handleDblClick: handleTitleDblClick, handleSave: handleTitleSave } =
    useEditableTitle(id, data.label || t("text.node"));

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
      <div className="flex items-center px-3 py-1 text-[13px] font-medium text-white/80 z-10">
        {editingTitle ? (
          <span className="flex items-center gap-1 flex-1 min-w-0">
            <FontSizeOutlined className="shrink-0" />
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
            <FontSizeOutlined className="shrink-0 mr-1" />
            <span className="truncate cursor-default" onDoubleClick={handleTitleDblClick}>
              {data.label || t("text.node")}
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
        <textarea
          ref={textareaRef}
          className={`flex-1 w-full resize-none border-none outline-none p-3 text-sm text-white/80 placeholder:text-white/20 ${editingContent ? "nodrag" : ""}`}
          style={{ background: "transparent", pointerEvents: editingContent ? "auto" : "none", cursor: editingContent ? "text" : "inherit" }}
          placeholder={t("text.placeholder")}
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
          <div className="absolute inset-0 rounded-lg flex flex-col items-center justify-center gap-3" style={{ background: "var(--canvas-bg, #262626)" }}>
            <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
            <span className="text-sm text-white/50">{t("generating")}</span>
          </div>
        )}
      </div>

      {selected && (
        <ResizeHandle nodeId={id} corner="bottom-right" minWidth={TEXT_NODE_MIN_WIDTH} minHeight={TEXT_NODE_MIN_HEIGHT} />
      )}

      <Handle type="target" position={Position.Left} style={{ width: 10, height: 10, background: "#1677ff" }} />
      <Handle type="source" position={Position.Right} style={{ width: 10, height: 10, background: "#1677ff" }} />
    </div>
  );
}

export default memo(TextNode);
