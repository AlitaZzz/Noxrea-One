/**
 * 文本节点（text-node）渲染组件。
 * 展示 / 就地编辑文本内容与节点标题，支持清空、复制、下载、生成中状态展示、
 * 四角缩放与上下连接桩；内容变更通过自定义事件回传画布层统一落库。
 * 内容采用 Tiptap 富文本编辑：content 存 HTML 供编辑器渲染，
 * plainText 存纯文本供下游节点消费，复制 / 下载时序列化为 Markdown。
 */
"use client";

import Placeholder from "@tiptap/extension-placeholder";
import { Markdown } from "@tiptap/markdown";
import { type Editor,EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Handle, type NodeProps, Position } from "@xyflow/react";
import { type FocusEvent, memo, useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

import { TextIcon } from "@/components/ui/icons/media/TextIcon";
import RichTextPanel from "@/features/canvas/editing/RichTextPanel";
import { markDirtyImmediate, useCanvasStore } from "@/features/canvas/stores/canvas-store";
import type { TextNode as TextNodeType } from "@/features/canvas/types";
import { EventNames, isGenerating, NODE_HANDLE_TOP, TEXT_NODE_MIN_HEIGHT, TEXT_NODE_MIN_WIDTH } from "@/lib/constants";
import { showGlobalMessage } from "@/lib/global-message";
import { sanitizeFileName } from "@/lib/utils/file-name";
import { copyText, downloadTextFile } from "@/lib/utils/text-export";

import GeneratingOverlay from "./GeneratingOverlay";
import NodeTitle from "./NodeTitle";
import ResizeHandle from "./ResizeHandle";

function TextNode({ id, data, selected }: NodeProps<TextNodeType>) {
  const { t } = useTranslation();
  const content = data.content || "";
  const plainText = data.plainText || "";
  // 编辑态由 store 全局驱动（与裁剪/标注模式一致），进入编辑时隐藏节点工具条
  const editingContent = useCanvasStore((s) => s.editingTextNodeId) === id;

  const editorRef = useRef<Editor | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // 编辑器初始化（含内容规范化事务）不算用户编辑：不回写数据、不压历史，
  // 否则节点挂载会幽灵压栈把 redo 栈清空，表现为撤销「按了一下没反应」
  const editorReadyRef = useRef(false);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ undoRedo: false, underline: false }),
      // marked 默认按 CommonMark 把段内单换行当软换行（保留为文本 \n）：编辑器
      // pre-wrap 下看起来正常，但 getHTML 存的裸 \n 在刷新后按 HTML 规则解析
      // 会被折叠成空格，行结构丢失。breaks:true 让单换行直接变成 <br>，往返稳定。
      Markdown.configure({ markedOptions: { breaks: true } }),
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
    onCreate: () => {
      editorReadyRef.current = true;
    },
    onUpdate: ({ editor }) => {
      if (!editorReadyRef.current) return;
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

  // 外部修改 content（如 AI 生成回填）时同步到编辑器，否则编辑器不会自动刷新。
  // emitUpdate:false——这是程序化回显而非用户编辑，若触发 onUpdate 会经
  // NODE_UPDATE_DATA → updateNodeData 走一次历史压栈，把 redo 栈清空
  // （撤销恢复节点 → 重挂回填 → 幽灵压栈，Ctrl+Z 看似失效）。
  useEffect(() => {
    if (!editor || editingContent) return;
    const html = content || "";
    const current = editor.isEmpty ? "" : editor.getHTML();
    if (html !== current) editor.commands.setContent(html, { emitUpdate: false });
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
    // emitUpdate:false——updateNodeData 已压过历史， setContent 回显再触发一次
    // onUpdate 会经 NODE_UPDATE_DATA 重复压栈，清空后 Ctrl+Z 看似失灵
    editor?.commands.setContent("", { emitUpdate: false });
  }, [id, editor]);

  // 导出为 Markdown：保留标题、列表、加粗等富文本结构，供复制 / 下载复用
  const getMarkdown = useCallback(() => editor?.getMarkdown() ?? "", [editor]);

  const handleCopy = useCallback(async () => {
    const md = getMarkdown();
    if (!md) return;
    const ok = await copyText(md);
    showGlobalMessage().success(ok ? t("common.copied") : t("common.copyFailed"));
  }, [getMarkdown, t]);

  const handleDownload = useCallback(() => {
    const md = getMarkdown();
    if (!md) return;
    // 文件名取节点标题，空标题回退到默认名；清理非法字符避免保存失败
    const name = sanitizeFileName((data.label || "").trim()) || t("node.text");
    downloadTextFile(`${name}.md`, md);
  }, [getMarkdown, data.label, t]);

  // Listen for node action events from NodeToolbar
  const actionRefs = useRef({ handleClear, handleCopy, handleDownload });
  useEffect(() => {
    actionRefs.current = { handleClear, handleCopy, handleDownload };
  }, [handleClear, handleCopy, handleDownload]);
  useEffect(() => {
    function onNodeAction(e: Event) {
      const ce = e as CustomEvent;
      if (ce.detail?.nodeId !== id) return;
      switch (ce.detail?.action) {
        case "clear": actionRefs.current.handleClear(); break;
        case "copy": void actionRefs.current.handleCopy(); break;
        case "download": actionRefs.current.handleDownload(); break;
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
      <NodeTitle
        nodeId={id}
        className="z-10"
        icon={<TextIcon className="shrink-0" />}
        title={data.label || t("node.text")}
        trailing={
          charCount > 0 ? (
            <span style={charCount > 500 ? { color: "var(--canvas-warning, #faad14)" } : undefined}>{charCount}</span>
          ) : null
        }
      />

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
          <RichTextPanel editor={editor} nodeId={id} />
        </div>
      )}

      {selected && (
        <ResizeHandle nodeId={id} corner="bottom-right" minWidth={TEXT_NODE_MIN_WIDTH} minHeight={TEXT_NODE_MIN_HEIGHT} />
      )}

      <Handle type="target" position={Position.Left} style={{ top: NODE_HANDLE_TOP }} />
      <Handle type="source" position={Position.Right} style={{ top: NODE_HANDLE_TOP }} />
    </div>
  );
}

export default memo(TextNode);
