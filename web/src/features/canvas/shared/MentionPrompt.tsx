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
import { findPreset, PRESET_TOKEN_PATTERN, presetTokenOf, type PromptPreset } from "./prompt-presets";
import { type ReferenceItem, type ReferenceItemAttrs, refLabel, refLabelKey } from "./reference";

/** mention chip 的纯文本序列化：素材 → refLabel，预设 → @[preset:id] 令牌（往返一致） */
function mentionPlainText(attrs: ReferenceItemAttrs): string {
  return attrs.kind === "preset" ? presetTokenOf(attrs.presetId || "") : refLabel(attrs as ReferenceItem);
}

interface Props {
  references: ReferenceItem[];
  presets?: PromptPreset[];
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
function textToDoc(text: string, references: ReferenceItem[], presets?: PromptPreset[]): JSONContent {
  const lookup = new Map(references.map((r) => [refLabel(r), r]));

  const content = text.split("\n").map((line) => {
    const inline: JSONContent[] = [];

    // 收集本行全部命中（素材 mention + 已知 preset 令牌），按位置排序后切片还原
    const hits: Array<{ start: number; end: number; node: JSONContent }> = [];
    MENTION_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = MENTION_PATTERN.exec(line)) !== null) {
      const ref = lookup.get(match[0]);
      hits.push({
        start: match.index,
        end: match.index + match[0].length,
        node: ref
          ? { type: "mention", attrs: { src: ref.src, thumbnail: ref.thumbnail, index: ref.index, kind: ref.kind } }
          : { type: "text", text: match[0] },
      });
    }
    PRESET_TOKEN_PATTERN.lastIndex = 0;
    while ((match = PRESET_TOKEN_PATTERN.exec(line)) !== null) {
      if (!presets || !findPreset(presets, match[1])) continue;
      hits.push({
        start: match.index,
        end: match.index + match[0].length,
        node: { type: "mention", attrs: { kind: "preset", presetId: match[1] } },
      });
    }
    hits.sort((a, b) => a.start - b.start);

    let pos = 0;
    for (const hit of hits) {
      if (hit.start < pos) continue; // 重叠保护（理论上不会发生）
      if (hit.start > pos) inline.push({ type: "text", text: line.slice(pos, hit.start) });
      inline.push(hit.node);
      pos = hit.end;
    }
    if (pos < line.length) inline.push({ type: "text", text: line.slice(pos) });

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

const MentionPrompt = ({ references, presets, value, onChange, placeholder, style }: Props) => {
  const { t } = useTranslation();

  const [mention, setMention] = useState<MentionState | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);

  const editor = useEditor({
    extensions: [
      // prompt 保持纯文本语义：仅保留文档 / 段落 / 文本 / 换行 / 撤销重做，关闭全部富文本格式。
      // hardBreak 必须开启——聊天窗口/网页复制的剪贴板 HTML 用 <br> 表达换行，
      // 关掉它解析时 <br> 被丢弃、多段文本黏成一段；开启后 <br> 转换行节点并序列化回 \n
      StarterKit.configure({
        blockquote: false,
        bold: false,
        bulletList: false,
        code: false,
        codeBlock: false,
        dropcursor: false,
        gapcursor: false,
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
            presetId: { default: "" },
          };
        },
        addNodeView() {
          return ReactNodeViewRenderer(MentionChip);
        },
      }).configure({
        HTMLAttributes: { class: "mention-chip" },
        // 纯文本化：素材 chip 输出为「图片N / 音频N / 视频N」，预设 chip 输出为 @[preset:id] 令牌
        renderText: ({ node }) => mentionPlainText(node.attrs as ReferenceItemAttrs),
        renderHTML: ({ options, node }) => ["span", options.HTMLAttributes, mentionPlainText(node.attrs as ReferenceItemAttrs)],
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
    content: textToDoc(value, references, presets),
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

  // 外部变更 value（切换节点 / AI 回填）时同步进编辑器；序列化结果一致则跳过，避免循环。
  // 延后到微任务，避免 Tiptap 的 NodeView 更新在 React effect 生命周期内触发 flushSync。
  useEffect(() => {
    if (!editor) return;
    if (editor.getText({ blockSeparator: "\n" }) === value) return;

    let cancelled = false;
    const timer = window.setTimeout(() => {
      if (cancelled || editor.isDestroyed) return;
      if (editor.getText({ blockSeparator: "\n" }) === value) return;
      editor.commands.setContent(textToDoc(value, references, presets), { emitUpdate: false });
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [value, references, presets, editor]);

  // 引用变化：同步 chip 序号（图片1 ↔ 图片2），并移除已从参考区删除的引用
  // preset chip 无对应引用，跳过清理（其持久化由 genSettings.prompt 直接承载）
  useEffect(() => {
    if (!editor) return;
    const { state } = editor;
    const tr = state.tr;

    // 先收集全部 mention，再从后往前处理——删除节点会改变文档结构，倒序可避免位置偏移
    const entries: Array<{ pos: number; node: PMNode; ref: ReferenceItem | undefined }> = [];
    state.doc.descendants((node, pos) => {
      if (node.type.name !== "mention") return;
      if ((node.attrs as ReferenceItemAttrs).kind === "preset") return;
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
