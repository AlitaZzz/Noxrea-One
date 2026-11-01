/**
 * 支持 @ 引用的提示词输入框。
 * 基于 Tiptap 实现（与画布文本节点同一套编辑器）：@ 唤起候选下拉，选中后插入
 * mention 原子节点并渲染为 chip；对外始终以「图片N / 音频N / 视频N」形式输出纯文本，
 * 被各生成面板与对话面板复用。
 *
 * 编辑器扩展配置在渲染期创建，回调内不得访问 ref 或 hook 返回值。
 * 因此运行时状态收敛在 bridge（模块级 WeakMap，以编辑器 DOM 为键）中，
 * 由 React state 同步渲染快照。
 *
 * 生成面板宿主常驻后本编辑器不再随面板卸载：nodeId 变化时以新目标的文本
 * 重建 EditorState（插件状态整体重新初始化，撤销栈不会跨目标串联），
 * 面板隐藏时只关闭 @ 候选并失焦，内容与撤销栈保留给同一目标的再次显示。
 */
"use client";

import type { JSONContent } from "@tiptap/core";
import { Mention } from "@tiptap/extension-mention";
import Placeholder from "@tiptap/extension-placeholder";
import type { Node as PMNode } from "@tiptap/pm/model";
import { EditorState } from "@tiptap/pm/state";
import { EditorContent, ReactNodeViewRenderer, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import type { SuggestionProps } from "@tiptap/suggestion";
import { exitSuggestion } from "@tiptap/suggestion";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { GenerationPanelActiveProvider } from "./generation-panel-active";
import MentionChip from "./MentionChip";
import MentionDropdown from "./MentionDropdown";
import { PRESET_TOKEN_PATTERN, presetTokenOf } from "./prompt-presets";
import { type ReferenceItem, type ReferenceItemAttrs, refLabel, refLabelKey } from "./reference";

/** mention chip 的纯文本序列化：素材 → refLabel，预设 → @[preset:id] 令牌（往返一致） */
function mentionPlainText(attrs: ReferenceItemAttrs): string {
  return attrs.kind === "preset" ? presetTokenOf(attrs.presetId || "") : refLabel(attrs as ReferenceItem);
}

interface Props {
  /** 当前目标节点：变化时重建编辑器状态（撤销栈不跨目标） */
  nodeId: string;
  /** 面板是否可见：隐藏时关闭 @ 候选并失焦，编辑器实例与内容保留 */
  active: boolean;
  references: ReferenceItem[];
  value: string;
  onChange: (text: string) => void;
  placeholder: string;
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
  /** 当前 @ 查询被用户主动关闭；直到再次输入内容前，Suggestion 不应重开。 */
  dismissed: boolean;
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

/** 纯文本 → 文档：chip 文本还原为 mention 节点，换行切分为段落。
 *  预设令牌按语法还原（匹配 PRESET_TOKEN_PATTERN 即建节点，不查目录）——
 *  解析是 text + references 的纯函数，不依赖异步目录数据；目录只影响
 *  chip 标签展示（MentionChip 自行解析，未知预设显示占位文案）。 */
export function textToDoc(text: string, references: ReferenceItem[]): JSONContent {
  const lookup = new Map(references.map((r) => [refLabel(r), r]));

  const content = text.split("\n").map((line) => {
    const inline: JSONContent[] = [];

    // 收集本行全部命中（素材 mention + preset 令牌），按位置排序后切片还原
    const hits: Array<{ start: number; end: number; node: JSONContent }> = [];
    MENTION_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = MENTION_PATTERN.exec(line)) !== null) {
      const ref = lookup.get(match[0]);
      hits.push({
        start: match.index,
        end: match.index + match[0].length,
        node: ref
          ? { type: "mention", attrs: { src: ref.src, index: ref.index, kind: ref.kind } }
          : { type: "text", text: match[0] },
      });
    }
    PRESET_TOKEN_PATTERN.lastIndex = 0;
    while ((match = PRESET_TOKEN_PATTERN.exec(line)) !== null) {
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
      dismissMention(bridge, setMention);
      return true;
    default:
      return false;
  }
}

function closeMention(bridge: SuggestionBridge, setMention: (state: MentionState | null) => void) {
  bridge.mention = null;
  // Tiptap may deliver the old onExit after a new onStart; the next onStart
  // replaces this reference, so clearing it here would create a command race.
  setMention(null);
}

function dismissMention(bridge: SuggestionBridge, setMention: (state: MentionState | null) => void) {
  bridge.dismissed = true;
  closeMention(bridge, setMention);
}

const MentionPrompt = ({ nodeId, active, references, value, onChange, placeholder }: Props) => {
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
        // 扩展默认属性，承载引用素材信息（供 chip 渲染与纯文本序列化）；
        // 缩略图不落 attrs：URL 属渲染期派生（MentionChip 由 src 推导）
        addAttributes() {
          return {
            src: { default: "" },
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
          allow: ({ editor, state, range }) => {
            if (bridges.get(editor.view.dom)?.dismissed) return false;
            const mentionType = state.schema.nodes.mention;
            if (!mentionType) return false;
            return Boolean(state.doc.resolve(range.from).parent.type.contentMatch.matchType(mentionType));
          },
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
      handleDOMEvents: {
        mousedown: (view) => {
          const bridge = bridges.get(view.dom);
          if (bridge?.mention) {
            dismissMention(bridge, setMention);
            exitSuggestion(view);
          }
          return false;
        },
      },
      handleTextInput: (view) => {
        const bridge = bridges.get(view.dom);
        if (bridge) bridge.dismissed = false;
        return false;
      },
      handlePaste: (view) => {
        const bridge = bridges.get(view.dom);
        if (bridge) bridge.dismissed = false;
        return false;
      },
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
      dismissed: false,
      selectedIndex: 0,
      command: null,
    };
    bridge.references = references;
    bridge.onChange = onChange;
    bridge.translate = t as SuggestionBridge["translate"];
    bridges.set(editor.view.dom, bridge);
  }, [editor, references, onChange, t]);

  // 目标切换：以新目标的文本重建编辑器状态。EditorState.create 会重新初始化
  // 全部插件状态（含 history）——旧目标的撤销栈不会作用到新目标的内容上；
  // updateState 不经过 Tiptap 的 dispatchTransaction，不触发 onUpdate，
  // 因此不会把新内容反写回节点。放在 bridge 同步之后、value 同步之前：
  // 重建后的文本已等于新 value，后续同步 effect 会自然跳过。
  //
  // 重建不能在 layout effect 中同步执行：文档里的 mention chip 是 React NodeView，
  // 视图更新会同步创建 ReactRenderer；Tiptap 在编辑器内容已初始化后调用 flushSync
  // 挂载它，flushSync 不允许发生在 React 提交阶段（浏览器报
  // "flushSync was called from inside a lifecycle method"）。
  // 因此由 layout effect 调度微任务：微任务在本次提交结束、浏览器绘制前执行，
  // 既不处于 React 生命周期，又能保证首帧就是新目标内容，不闪旧提示词。
  // 上一次渲染看到的目标：只用于发现「目标切换」并调度重建。
  // 与下方 contentTargetRef 不能合并——后者记录文档实际承载的目标，由重建微任务
  // 完成后才推进，两者在切换提交到微任务执行之间必然不同。
  const prevNodeIdRef = useRef(nodeId);
  const rebuildSourceRef = useRef({ nodeId, value, references });
  const rebuildScheduledRef = useRef(false);
  // 编辑器文档当前承载的目标。重建完成前仍指向上一个目标：
  // 目标切换的提交阶段文档还是旧目标的，此时内容同步 effect 若用新目标的
  // references / onChange 去改文档，会把旧内容写进新目标（例如把旧 chip 当作
  // 「已移除的引用」删除，并把空文本回写成新目标的提示词）。
  const contentTargetRef = useRef(nodeId);

  // 关闭 @ 候选：bridge 交互态 + body 级 Portal 下拉。目标切换与面板隐藏共用。
  const closeMentionUi = useCallback(() => {
    if (!editor) return;
    const bridge = bridges.get(editor.view.dom);
    if (bridge) {
      bridge.mention = null;
      bridge.dismissed = false;
    }
    setMention(null);
    exitSuggestion(editor.view);
  }, [editor]);

  useLayoutEffect(() => {
    rebuildSourceRef.current = { nodeId, value, references };
    if (!editor || prevNodeIdRef.current === nodeId) return;
    prevNodeIdRef.current = nodeId;

    closeMentionUi();

    if (rebuildScheduledRef.current) return;
    rebuildScheduledRef.current = true;
    queueMicrotask(() => {
      rebuildScheduledRef.current = false;
      if (!editor || editor.isDestroyed) return;
      // 同一轮提交内连续切换目标时，以最后一次渲染的 nodeId / value / references 为准
      const source = rebuildSourceRef.current;
      // 切回原目标：文档在此期间从未离开该目标（旧目标的清理与同步 effect 都被
      // contentTargetRef 挡住），无需重建——重建会清空撤销栈并重置选区。
      if (source.nodeId === contentTargetRef.current) return;
      editor.view.updateState(
        EditorState.create({
          schema: editor.state.schema,
          doc: editor.state.schema.nodeFromJSON(textToDoc(source.value, source.references)),
          plugins: editor.state.plugins,
        }),
      );
      contentTargetRef.current = source.nodeId;
      editor.commands.blur();
    });
  }, [editor, nodeId, value, references, closeMentionUi]);

  // 面板隐藏：关闭 @ 候选并失焦，内容与撤销栈留给同一目标再次显示。
  useEffect(() => {
    if (!editor || active) return;
    // 隐藏是外部事件：下拉与 bridge 交互态必须在同一时机同步清空，否则再次显示会复活旧候选。
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 外部事件驱动的同步收尾
    closeMentionUi();
    editor.commands.blur();
  }, [active, editor, closeMentionUi]);

  // 外部变更 value（切换节点 / AI 回填）时同步进编辑器；序列化结果一致则跳过，避免循环。
  // 延后到微任务，避免 Tiptap 的 NodeView 更新在 React effect 生命周期内触发 flushSync。
  // 注：textToDoc 不依赖目录数据，presets 不再是解析输入，无需参与本同步。
  // 面板隐藏时 value 是宿主给的占位值（真实 genSettings 已停止订阅），不得写入编辑器；
  // 重新可见时本 effect 以实时 value 再同步一次。
  useEffect(() => {
    if (!editor || !active) return;
    // 文档仍属于上一个目标：本次提交由重建微任务接管，不能把新目标的 value 写进旧文档
    if (contentTargetRef.current !== nodeId) return;
    if (editor.getText({ blockSeparator: "\n" }) === value) return;

    let cancelled = false;
    const timer = window.setTimeout(() => {
      if (cancelled || editor.isDestroyed) return;
      if (editor.getText({ blockSeparator: "\n" }) === value) return;
      editor.commands.setContent(textToDoc(value, references), { emitUpdate: false });
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [active, nodeId, value, references, editor]);

  // 引用变化：同步 chip 序号（图片1 ↔ 图片2），并移除已从参考区删除的引用
  // preset chip 无对应引用，跳过清理（其持久化由 genSettings.prompt 直接承载）。
  // 面板隐藏时 references 是空占位（上游投影已停止），清理会误删全部 chip；
  // 重新可见时以实时 references 再同步。
  // 文档仍属于上一个目标时同样跳过：重建微任务会按新目标的 references 重建文档，
  // 这里若按新 references 清理旧文档，会删掉旧 chip 并把结果回写进新目标。
  useEffect(() => {
    if (!editor || !active) return;
    if (contentTargetRef.current !== nodeId) return;
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
  }, [active, nodeId, references, editor]);

  return (
    <div className="relative">
      <div className="scrollbar-ui w-full min-h-[100px] max-h-[240px] overflow-y-auto rounded-md border-0 bg-transparent p-0">
        <GenerationPanelActiveProvider value={active}>
          <EditorContent editor={editor} />
        </GenerationPanelActiveProvider>
      </div>
      {active && mention && mention.items.length > 0 && (
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
          onClose={() => {
            if (editor && !editor.isDestroyed) {
              const bridge = bridges.get(editor.view.dom);
              if (bridge) {
                dismissMention(bridge, setMention);
              } else {
                setMention(null);
              }
              exitSuggestion(editor.view);
              return;
            }
            setMention(null);
          }}
        />
      )}
    </div>
  );
};

export default MentionPrompt;
