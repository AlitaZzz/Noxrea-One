/**
 * 支持 @ 引用的提示词输入框。
 * 基于 Tiptap 实现（与画布文本节点同一套编辑器）：@ 唤起候选下拉，选中后插入
 * mention 原子节点并渲染为 chip；对外始终以「图片N / 音频N / 视频N」形式输出纯文本，
 * 被各生成面板与对话面板复用。
 *
 * 编辑器扩展配置在渲染期创建，回调内不得访问 ref 或 hook 返回值。
 * 因此运行时状态收敛在 bridge（模块级 WeakMap，以编辑器 DOM 为键）中，
 * 由 React state 同步渲染快照。
 */
"use client";

import type { JSONContent } from "@tiptap/core";
import { Mention } from "@tiptap/extension-mention";
import Placeholder from "@tiptap/extension-placeholder";
import type { Node as PMNode } from "@tiptap/pm/model";
import { EditorContent, ReactNodeViewRenderer, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import type { SuggestionProps } from "@tiptap/suggestion";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import MentionChip from "./MentionChip";
import MentionDropdown from "./MentionDropdown";
import { type ReferenceItem, refLabel, refLabelKey } from "./reference";

interface Props {
  references: ReferenceItem[];
  value: string;
  onChange: (text: string) => void;
  placeholder: string;
  style?: React.CSSProperties;
}

interface MentionState {
  items: ReferenceItem[];
  position: { x: number; y: number };
}

/** 编辑器回调与 React 之间的桥接数据 */
interface SuggestionBridge {
  references: ReferenceItem[];
  onChange: (text: string) => void;
  translate: (key: string, options?: Record<string, unknown>) => string;
  mention: MentionState | null;
  selectedIndex: number;
  command: ((item: ReferenceItem) => void) | null;
}

/**
 * 编辑器 DOM → bridge。
 * suggestion 的 onKeyDown 回调只提供 view（不含 editor），故统一以编辑器 DOM 为键关联。
 */
const bridges = new WeakMap<object, SuggestionBridge>();

/** chip 在纯文本中的存储形式：图片N / 音频N / 视频N */
const MENTION_PATTERN = /(图片|音频|视频)(\d+)/g;

/** 纯文本 → 文档：chip 文本还原为 mention 节点，换行切分为段落 */
function textToDoc(text: string, references: ReferenceItem[]): JSONContent {
  const lookup = new Map(references.map((r) => [refLabel(r), r]));

  const content = text.split("\n").map((line) => {
    const inline: JSONContent[] = [];
    let last = 0;
    MENTION_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = MENTION_PATTERN.exec(line)) !== null) {
      if (match.index > last) inline.push({ type: "text", text: line.slice(last, match.index) });
      const ref = lookup.get(match[0]);
      inline.push(
        ref
          ? { type: "mention", attrs: { src: ref.src, thumbnail: ref.thumbnail, index: ref.index, kind: ref.kind } }
          : { type: "text", text: match[0] },
      );
      last = match.index + match[0].length;
    }
    if (last < line.length) inline.push({ type: "text", text: line.slice(last) });

    return { type: "paragraph", ...(inline.length ? { content: inline } : {}) };
  });

  return { type: "doc", content };
}

function filterItems(bridge: SuggestionBridge | undefined, query: string): ReferenceItem[] {
  if (!bridge) return [];
  const refs = bridge.references;
  if (!query) return refs;
  return refs.filter(
    (r) => refLabel(r).includes(query) || bridge.translate(refLabelKey(r), { index: r.index + 1 }).includes(query),
  );
}

function syncMention(
  props: SuggestionProps<ReferenceItem>,
  bridge: SuggestionBridge,
  setMention: (state: MentionState | null) => void,
  setSelectedIndex: (index: number) => void,
) {
  bridge.command = (item) => props.command(item);
  const rect = props.clientRect?.();
  const next: MentionState = { items: props.items, position: rect ? { x: rect.left, y: rect.bottom } : { x: 0, y: 0 } };

  bridge.mention = next;
  bridge.selectedIndex = 0;
  setMention(next);
  setSelectedIndex(0);
}

/**
 * 下拉键盘导航。返回 true 表示按键已被消费，
 * 阻止 ProseMirror 继续处理（避免 Enter 同时插入换行）。
 */
function handleSuggestionKeyDown(
  event: KeyboardEvent,
  bridge: SuggestionBridge,
  setMention: (state: MentionState | null) => void,
  setSelectedIndex: (index: number) => void,
): boolean {
  const current = bridge.mention;
  if (!current) return false;
  const items = current.items;

  switch (event.key) {
    case "ArrowDown": {
      const next = Math.min(bridge.selectedIndex + 1, items.length - 1);
      bridge.selectedIndex = next;
      setSelectedIndex(next);
      return true;
    }
    case "ArrowUp": {
      const next = Math.max(bridge.selectedIndex - 1, 0);
      bridge.selectedIndex = next;
      setSelectedIndex(next);
      return true;
    }
    case "Enter": {
      const item = items[bridge.selectedIndex];
      if (item) bridge.command?.(item);
      return true;
    }
    case "Escape":
      bridge.mention = null;
      setMention(null);
      return true;
    default:
      return false;
  }
}

function closeMention(bridge: SuggestionBridge, setMention: (state: MentionState | null) => void) {
  bridge.mention = null;
  bridge.command = null;
  setMention(null);
}

const MentionPrompt = ({ references, value, onChange, placeholder, style }: Props) => {
  const { t } = useTranslation();

  const [mention, setMention] = useState<MentionState | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);

  const editor = useEditor({
    extensions: [
      // prompt 保持纯文本语义：仅保留文档 / 段落 / 文本 / 撤销重做，关闭全部富文本格式
      StarterKit.configure({
        blockquote: false,
        bold: false,
        bulletList: false,
        code: false,
        codeBlock: false,
        dropcursor: false,
        gapcursor: false,
        hardBreak: false,
        heading: false,
        horizontalRule: false,
        italic: false,
        link: false,
        listItem: false,
        listKeymap: false,
        orderedList: false,
        strike: false,
        trailingNode: false,
        underline: false,
      }),
      Mention.extend({
        // 扩展默认属性，承载引用素材信息（供 chip 渲染与纯文本序列化）
        addAttributes() {
          return {
            src: { default: "" },
            thumbnail: { default: "" },
            index: { default: 0 },
            kind: { default: "image" },
          };
        },
        addNodeView() {
          return ReactNodeViewRenderer(MentionChip);
        },
      }).configure({
        HTMLAttributes: { class: "mention-chip" },
        // 纯文本化：chip 输出为「图片N / 音频N / 视频N」
        renderText: ({ node }) => refLabel(node.attrs as unknown as ReferenceItem),
        renderHTML: ({ options, node }) => ["span", options.HTMLAttributes, refLabel(node.attrs as unknown as ReferenceItem)],
        // 退格直接整体删除 @ 触发符与 chip
        deleteTriggerWithBackspace: true,
        suggestion: {
          char: "@",
          // 不限制 @ 前的字符（默认仅允许空格前缀），输入即唤起候选
          allowedPrefixes: null,
          items: ({ editor, query }) => filterItems(bridges.get(editor.view.dom), query),
          render: () => ({
            onStart: (props) => {
              const bridge = bridges.get(props.editor.view.dom);
              if (bridge) syncMention(props, bridge, setMention, setSelectedIndex);
            },
            onUpdate: (props) => {
              const bridge = bridges.get(props.editor.view.dom);
              if (bridge) syncMention(props, bridge, setMention, setSelectedIndex);
            },
            onKeyDown: ({ view, event }) => {
              const bridge = bridges.get(view.dom);
              return bridge ? handleSuggestionKeyDown(event, bridge, setMention, setSelectedIndex) : false;
            },
            onExit: ({ editor }) => {
              const bridge = bridges.get(editor.view.dom);
              if (bridge) closeMention(bridge, setMention);
            },
          }),
        },
      }),
      Placeholder.configure({ placeholder }),
    ],
    content: textToDoc(value, references),
    onUpdate: ({ editor }) => {
      const bridge = bridges.get(editor.view.dom);
      bridge?.onChange(editor.getText({ blockSeparator: "\n" }));
    },
    editorProps: {
      attributes: { class: "mention-editable nodrag" },
    },
    immediatelyRender: false,
  });

  // 建立 / 刷新桥接数据（保留 mention 等交互态，避免重建下拉）
  useEffect(() => {
    if (!editor) return;
    const bridge: SuggestionBridge = bridges.get(editor.view.dom) ?? {
      references,
      onChange,
      translate: t as SuggestionBridge["translate"],
      mention: null,
      selectedIndex: 0,
      command: null,
    };
    bridge.references = references;
    bridge.onChange = onChange;
    bridge.translate = t as SuggestionBridge["translate"];
    bridges.set(editor.view.dom, bridge);
  }, [editor, references, onChange, t]);

  // 外部变更 value（切换节点 / AI 回填）时同步进编辑器；序列化结果一致则跳过，避免循环
  useEffect(() => {
    if (!editor) return;
    if (editor.getText({ blockSeparator: "\n" }) === value) return;
    editor.commands.setContent(textToDoc(value, references), { emitUpdate: false });
  }, [value, references, editor]);

  // 引用变化：同步 chip 序号（图片1 ↔ 图片2），并移除已从参考区删除的引用
  useEffect(() => {
    if (!editor) return;
    const { state } = editor;
    const tr = state.tr;

    // 先收集全部 mention，再从后往前处理——删除节点会改变文档结构，倒序可避免位置偏移
    const entries: Array<{ pos: number; node: PMNode; ref: ReferenceItem | undefined }> = [];
    state.doc.descendants((node, pos) => {
      if (node.type.name !== "mention") return;
      entries.push({
        pos,
        node,
        ref: references.find((r) => r.src === node.attrs.src && r.kind === node.attrs.kind),
      });
    });

    let changed = false;
    for (let i = entries.length - 1; i >= 0; i--) {
      const { pos, node, ref } = entries[i];

      if (!ref) {
        // 引用已被移除：连同 chip 一起删除，并吃掉紧邻的一个空格，避免留下双空格
        let from = pos;
        let to = pos + node.nodeSize;
        const before = tr.doc.textBetween(Math.max(0, pos - 1), pos);
        const after = to < tr.doc.content.size ? tr.doc.textBetween(to, to + 1) : "";

        if (before === " ") from -= 1;
        else if (after === " ") to += 1;

        tr.delete(from, to);
        changed = true;
      } else if (ref.index !== node.attrs.index) {
        tr.setNodeMarkup(pos, undefined, { ...node.attrs, index: ref.index });
        changed = true;
      }
    }

    if (!changed) return;
    tr.setMeta("addToHistory", false);
    editor.view.dispatch(tr);
    bridges.get(editor.view.dom)?.onChange(editor.getText({ blockSeparator: "\n" }));
  }, [references, editor]);

  return (
    <div style={{ position: "relative" }}>
      <div
        className="mention-scroll"
        style={{
          width: "100%",
          minHeight: 100,
          maxHeight: 240,
          overflowY: "auto",
          padding: 0,
          borderRadius: 6,
          background: "transparent",
          border: "none",
          ...style,
        }}
      >
        <EditorContent editor={editor} />
      </div>
      {mention && mention.items.length > 0 &&
        createPortal(
          <MentionDropdown
            items={mention.items}
            position={mention.position}
            selectedIndex={selectedIndex}
            onHover={(index) => {
              const target = editor ? bridges.get(editor.view.dom) : undefined;
              if (!target) return;
              target.selectedIndex = index;
              setSelectedIndex(index);
            }}
            onSelect={(item) => {
              const target = editor ? bridges.get(editor.view.dom) : undefined;
              target?.command?.(item);
            }}
          />,
          document.body,
        )}
    </div>
  );
};

export default MentionPrompt;
