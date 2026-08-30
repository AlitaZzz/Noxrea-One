/**
 * 文本节点（text-node）渲染组件。
 * 展示 / 就地编辑文本内容与节点标题，支持清空、生成中状态展示、
 * 四角缩放与上下连接桩；内容变更通过自定义事件回传画布层统一落库。
 * 内容采用 Tiptap 富文本编辑：content 存 HTML 供编辑器渲染，
 * plainText 存纯文本供下游节点消费。
 */
"use client";

import Placeholder from "@tiptap/extension-placeholder";
import { Markdown } from "@tiptap/markdown";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Handle, type NodeProps, Position } from "@xyflow/react";
import { Input } from "antd";
import { type FocusEvent, memo, useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

import { TextIcon } from "@/components/ui/icons/media/TextIcon";
import RichTextToolbar from "@/features/canvas/editing/RichTextToolbar";
import { useEditableTitle } from "@/features/canvas/hooks/use-editable-title";
import { markDirtyImmediate, useCanvasStore } from "@/features/canvas/stores/canvas-store";
import type { TextNode as TextNodeType } from "@/features/canvas/types";
import { EventNames, isGenerating, NODE_HANDLE_TOP, NODE_TITLE_HEIGHT, NODE_TYPE, NODE_TYPE_COLOR, TEXT_NODE_MIN_HEIGHT, TEXT_NODE_MIN_WIDTH } from "@/lib/constants";

import GeneratingOverlay from "./GeneratingOverlay";
import ResizeHandle from "./ResizeHandle";

function TextNode({ id, data, selected }: NodeProps<TextNodeType>) {
  const { t } = useTranslation();
  const content = data.content || "";
  const plainText = data.plainText || "";
  // 编辑态由 store 全局驱动（与裁剪/标注模式一致），进入编辑时隐藏节点工具条
  const editingContent = useCanvasStore((s) => s.editingTextNodeId) === id;

  const { editing: editingTitle, draft: titleDraft, setDraft: setTitleDraft, handleDblClick: handleTitleDblClick, handleSave: handleTitleSave } =
    useEditableTitle(id, data.label || t("node.text"));

  const editorRef = useRef<Editor | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ undoRedo: false }),
      Markdown,
      Placeholder.configure({ placeholder: t("node.textPlaceholder"), showOnlyWhenEditable: false }),
    ],
    content,
    editable: false,
    immediatelyRender: false,
    editorProps: {
      attributes: {
        "data-text-editor": "",
      },
      // 粘贴纯文本时按 Markdown 解析；富文本粘贴（含 HTML）仍走默认解析
      handlePaste: (view, event) => {
        const editorInstance = editorRef.current;
        if (!editorInstance) return false;
        if (event.clipboardData?.getData("text/html")) return false;
        const text = event.clipboardData?.getData("text/plain") ?? "";
        if (!text) return false;
        editorInstance.commands.insertContent(text, { contentType: "markdown" });
        return true;
      },
    },
    onUpdate: ({ editor }) => {
      // 空文档（仅剩一个空段落 <p></p>）时存空串，避免把无意义的空段落写进数据
      const html = editor.isEmpty ? "" : editor.getHTML();
      window.dispatchEvent(
        new CustomEvent(EventNames.NODE_UPDATE_DATA, {
          detail: {
            nodeId: id,
            data: { content: html, plainText: editor.getText({ blockSeparator: "\n" }) },
          },
        })
      );
    },
  });

  // 同步 editor 实例到 ref，供 handlePaste 等编辑器外回调使用
  useEffect(() => {
    editorRef.current = editor;
  }, [editor]);

  // 外部修改 content（如 AI 生成回填）时同步到编辑器，否则编辑器不会自动刷新
  useEffect(() => {
    if (!editor || editingContent) return;
    const html = content || "";
    const current = editor.isEmpty ? "" : editor.getHTML();
    if (html !== current) editor.commands.setContent(html);
  }, [editor, content, editingContent]);

  // 编辑态切换：setEditable + 聚焦到末尾
  useEffect(() => {
    if (!editor) return;
    editor.setEditable(editingContent);
    if (editingContent) {
      requestAnimationFrame(() => editor.commands.focus("end"));
    }
  }, [editor, editingContent]);

  const exitEditing = useCallback(() => {
    useCanvasStore.getState().setEditingTextNodeId(null);
    window.getSelection()?.removeAllRanges();
  }, []);

  // 焦点仍在编辑态 UI 内（编辑器自身 / 富文本工具条）时保持编辑态，
  // 兜底键盘 Tab 等焦点确实转移的场景，避免误退出
  const handleEditorBlur = useCallback((e: FocusEvent<HTMLDivElement>) => {
    const next = e.relatedTarget as HTMLElement | null;
    if (next && (e.currentTarget.contains(next) || next.closest("[data-rich-text-toolbar]"))) return;
    exitEditing();
  }, [exitEditing]);

  const handleClear = useCallback(() => {
    useCanvasStore.getState().updateNodeData(id, { content: "", plainText: "" });
    markDirtyImmediate();
    editor?.commands.setContent("");
    useCanvasStore.getState().setEditingTextNodeId(id);
    requestAnimationFrame(() => editor?.commands.focus("end"));
  }, [id, editor]);

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

  // 编辑状态下阻止 mousedown 冒泡到 React Flow 画布，避免拖动节点/触发框选
  useEffect(() => {
    const el = editor?.view.dom;
    if (!el || !editingContent) return;
    const stopMouse = (e: MouseEvent) => e.stopPropagation();
    el.addEventListener("mousedown", stopMouse);
    return () => el.removeEventListener("mousedown", stopMouse);
  }, [editor, editingContent]);

  // 编辑态或选中态下消费滚轮：仅作用于节点内滚动，不冒泡到画布缩放/平移
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || (!editingContent && !selected)) return;
    const stopWheel = (e: WheelEvent) => e.stopPropagation();
    el.addEventListener("wheel", stopWheel);
    return () => el.removeEventListener("wheel", stopWheel);
  }, [editingContent, selected]);

  const generating = isGenerating(data.taskBinding);
  const charCount = plainText.length;

  return (
    <div className="group relative w-full h-full flex flex-col">
      {/* Title tab */}
      <div className="flex items-center px-4 py-1 text-[13px] font-medium text-white/80 z-10" style={{ height: NODE_TITLE_HEIGHT, flexShrink: 0 }}>
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
          useCanvasStore.getState().setEditingTextNodeId(id);
        }}
      >
        <div
          ref={scrollRef}
          className={`flex-1 overflow-auto p-4 ${editingContent ? "nodrag" : ""}`}
          style={{ pointerEvents: editingContent || selected ? "auto" : "none" }}
          onBlur={handleEditorBlur}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              editor?.commands.blur();
            }
          }}
        >
          <EditorContent editor={editor} />
        </div>
        {generating && <GeneratingOverlay absolute rounded startedAt={data.taskBinding?.startedAt} />}
      </div>

      {/* 富文本编辑工具条：定位在节点上方，counter-scale 保持视觉大小恒定 */}
      {editingContent && editor && (
        <div className="pointer-events-none absolute inset-0 overflow-visible">
          <RichTextToolbar editor={editor} />
        </div>
      )}

      {selected && (
        <ResizeHandle nodeId={id} corner="bottom-right" minWidth={TEXT_NODE_MIN_WIDTH} minHeight={TEXT_NODE_MIN_HEIGHT} />
      )}

      <Handle type="target" position={Position.Left} style={{ background: NODE_TYPE_COLOR[NODE_TYPE.TEXT], top: NODE_HANDLE_TOP }} />
      <Handle type="source" position={Position.Right} style={{ background: NODE_TYPE_COLOR[NODE_TYPE.TEXT], top: NODE_HANDLE_TOP }} />
    </div>
  );
}

export default memo(TextNode);
