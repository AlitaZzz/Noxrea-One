/**
 * 支持 @ 引用的提示词输入框。
 * 基于 contentEditable 实现：输入 @ 唤起候选下拉，选中后插入不可拆分的 chip，
 * 对外始终以「图N / 音N」形式输出纯文本，被各生成面板与对话面板复用。
 */
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import MentionDropdown, { type ReferenceItem } from "./MentionDropdown";
import { WaveIcon } from "@/components/common/icons/media/WaveIcon";

export type { ReferenceItem } from "./MentionDropdown";
import { MentionIconSvg } from "@/components/common/icons/chat/MentionIcon";

interface Props {
  references: ReferenceItem[];
  value: string;
  onChange: (text: string) => void;
  placeholder: string;
  style?: React.CSSProperties;
}

/** chip 显示的标签：图片为 图N，音频为 音N */
function chipLabel(r: ReferenceItem): string {
  return `${r.kind === "audio" ? "音" : "图"}${r.index + 1}`;
}

/** Extract plain text from contentEditable: chips → "图N"/"音N", <br> → \n */
function extractPlainText(root: HTMLElement): string {
  const parts: string[] = [];
  function walk(node: Node) {
    if (node.nodeType === Node.TEXT_NODE) {
      parts.push(node.textContent || "");
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as HTMLElement;
      if (el.classList.contains("mention-chip")) {
        const idx = parseInt(el.getAttribute("data-ref-index") || "0", 10);
        const kind = el.getAttribute("data-ref-kind") === "audio" ? "audio" : "image";
        parts.push(`${kind === "audio" ? "音" : "图"}${idx + 1}`);
      } else if (el.tagName === "BR") {
        parts.push("\n");
      } else {
        el.childNodes.forEach(walk);
      }
    }
  }
  root.childNodes.forEach(walk);
  return parts.join("");
}

/** Render plain text → contentEditable HTML with chip spans */
function renderHtml(text: string, references: ReferenceItem[]): string {
  const lookup = new Map<string, ReferenceItem>();
  references.forEach((r) => lookup.set(chipLabel(r), r));

  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  let html = escaped.replace(/\n/g, "<br>");

  html = html.replace(/[图音](\d+)/g, (match) => {
    const ref = lookup.get(match);
    if (!ref) return match;
    const inner =
      ref.kind === "audio"
        ? `<span class="mention-wave" style="display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;flex-shrink:0;color:#1d9e75;">${MentionIconSvg}</span>${match}`
        : `<img src="${escapeAttr(ref.thumbnail)}" style="width:20px;height:20px;border-radius:3px;object-fit:cover;flex-shrink:0;">${match}`;
    return `<span class="mention-chip" contenteditable="false" data-ref-src="${escapeAttr(ref.src)}" data-ref-index="${ref.index}" data-ref-kind="${ref.kind}" style="${escapeAttr(CHIP_STYLE)}">${inner}</span>`;
  });

  return html;
}

function escapeAttr(s: string) {
  return s.replace(/"/g, "&quot;").replace(/&/g, "&amp;");
}

/** Normalize text for comparison: strip trailing newlines browser may inject */
function norm(s: string): string {
  return s.replace(/\n+$/, "");
}

function getCursorScreenPos(editable: HTMLElement): { x: number; y: number } | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0).cloneRange();
  range.collapse(true);

  const marker = document.createTextNode("\u200B");
  range.insertNode(marker);
  const rect = range.getBoundingClientRect();
  marker.remove();

  if (rect.width === 0 && rect.height === 0 && rect.left === 0 && rect.top === 0) return null;
  return { x: rect.left, y: rect.bottom };
}

function findAtPosition(editable: HTMLElement): { node: Text; atOffset: number; query: string } | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);

  let node: Node = range.startContainer;
  if (node.nodeType !== Node.TEXT_NODE) {
    if (node === editable && editable.childNodes.length > 0) {
      const child = editable.childNodes[range.startOffset - 1];
      if (child && child.nodeType === Node.TEXT_NODE) {
        node = child;
      } else if (child && child.nodeType === Node.ELEMENT_NODE && (child as HTMLElement).classList.contains("mention-chip")) {
        return null;
      }
    }
    if (node.nodeType !== Node.TEXT_NODE) return null;
  }

  const textNode = node as Text;
  const offset = range.startOffset;
  const text = textNode.textContent || "";
  const before = text.slice(0, offset);
  const atMatch = before.match(/@([^\s@]*)$/);
  if (!atMatch) return null;

  return { node: textNode, atOffset: offset - atMatch[0].length, query: atMatch[1] };
}

const CHIP_STYLE =
  "display:inline-flex;align-items:center;gap:4px;padding:2px 6px 2px 3px;margin:0 2px;border-radius:5px;font-size:13px;line-height:1;background:transparent;border:1px solid var(--canvas-border,#3a3a3a);white-space:nowrap;cursor:default;user-select:none;vertical-align:middle;color:var(--canvas-text)";

const MentionPrompt = ({ references, value, onChange, placeholder, style }: Props) => {
  const editableRef = useRef<HTMLDivElement>(null);
  const [mentionActive, setMentionActive] = useState(false);
  const [mentionQuery, setMentionQuery] = useState("");
  const [mentionPos, setMentionPos] = useState({ x: 0, y: 0 });
  const referencesRef = useRef(references);
  referencesRef.current = references;

  // Sync DOM ← value when value/references change externally
  useEffect(() => {
    if (!editableRef.current) return;
    const current = norm(extractPlainText(editableRef.current));
    const target = norm(value);
    if (current !== target) {
      editableRef.current.innerHTML = renderHtml(value, references);
    }
  }, [value, references]);

  // Update chip labels when refOrder changes
  useEffect(() => {
    if (!editableRef.current) return;
    const chips = editableRef.current.querySelectorAll<HTMLElement>(".mention-chip");
    let changed = false;
    chips.forEach((chip) => {
      const src = chip.getAttribute("data-ref-src");
      const kind = chip.getAttribute("data-ref-kind") === "audio" ? "audio" : "image";
      const ref = references.find((r) => r.src === src && r.kind === kind);
      if (ref) {
        const oldIdx = chip.getAttribute("data-ref-index");
        if (oldIdx !== String(ref.index)) {
          chip.setAttribute("data-ref-index", String(ref.index));
          const labelText = chipLabel(ref);
          const textNode = Array.from(chip.childNodes).find(
            (n) => n.nodeType === Node.TEXT_NODE,
          );
          if (textNode) textNode.textContent = labelText;
          else chip.appendChild(document.createTextNode(labelText));
          changed = true;
        }
      } else {
        const text = chip.textContent || "";
        chip.replaceWith(document.createTextNode(text));
        changed = true;
      }
    });
    if (changed) {
      const newText = extractPlainText(editableRef.current);
      onChange(newText);
    }
  }, [references]); // eslint-disable-line react-hooks/exhaustive-deps

  const checkMention = useCallback(() => {
    if (!editableRef.current) return;
    const refs = referencesRef.current;
    if (refs.length === 0) {
      setMentionActive(false);
      return;
    }
    const atInfo = findAtPosition(editableRef.current);
    if (atInfo) {
      setMentionQuery(atInfo.query);
      const pos = getCursorScreenPos(editableRef.current);
      if (pos) setMentionPos(pos);
      setMentionActive(true);
    } else {
      setMentionActive(false);
    }
  }, []);

  const syncAndCheck = useCallback(() => {
    if (!editableRef.current) return;
    const text = extractPlainText(editableRef.current);
    onChange(text);
    checkMention();
  }, [onChange, checkMention]);

  const handleSelectMention = useCallback(
    (item: ReferenceItem) => {
      if (!editableRef.current) return;
      const atInfo = findAtPosition(editableRef.current);
      if (!atInfo) { setMentionActive(false); return; }

      const { node: textNode, atOffset } = atInfo;
      const sel = window.getSelection();
      if (!sel) return;

      const range = document.createRange();
      const endOffset = sel.getRangeAt(0).startContainer === textNode
        ? sel.getRangeAt(0).startOffset : textNode.length;
      range.setStart(textNode, atOffset);
      range.setEnd(textNode, endOffset);
      range.deleteContents();

      const chip = document.createElement("span");
      chip.className = "mention-chip";
      chip.contentEditable = "false";
      chip.setAttribute("data-ref-src", item.src);
      chip.setAttribute("data-ref-index", String(item.index));
      chip.setAttribute("data-ref-kind", item.kind);
      chip.setAttribute("style", CHIP_STYLE);

      if (item.kind === "audio") {
        const wave = document.createElement("span");
        wave.style.cssText =
          "display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;flex-shrink:0;color:#1d9e75;";
        wave.innerHTML = MentionIconSvg;
        chip.appendChild(wave);
      } else {
        const img = document.createElement("img");
        img.src = item.thumbnail;
        img.style.cssText = "width:20px;height:20px;border-radius:3px;object-fit:cover;flex-shrink:0;";
        chip.appendChild(img);
      }
      chip.appendChild(document.createTextNode(chipLabel(item)));

      range.insertNode(chip);

      const newRange = document.createRange();
      newRange.setStartAfter(chip);
      newRange.collapse(true);
      sel.removeAllRanges();
      sel.addRange(newRange);

      setMentionActive(false);
      onChange(extractPlainText(editableRef.current));
    },
    [onChange],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (mentionActive) {
        if (["ArrowDown", "ArrowUp", "Enter", "Escape"].includes(e.key)) {
          if (e.key === "Escape") { e.preventDefault(); setMentionActive(false); }
          return;
        }
      }

      if (e.key === "Backspace" && editableRef.current) {
        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0) return;
        const range = sel.getRangeAt(0);
        if (!range.collapsed) return;

        const node = range.startContainer;
        const offset = range.startOffset;

        const delChip = (el: ChildNode) => {
          if (el && el.nodeType === Node.ELEMENT_NODE && (el as HTMLElement).classList.contains("mention-chip")) {
            e.preventDefault();
            el.remove();
            onChange(extractPlainText(editableRef.current!));
            return true;
          }
          return false;
        };

        if (node.nodeType === Node.TEXT_NODE && offset === 0) {
          if (delChip(node.previousSibling!)) return;
        }
        if (node === editableRef.current) {
          if (delChip(editableRef.current.childNodes[offset - 1])) return;
        }
      }

      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        if (editableRef.current) {
          document.execCommand("insertLineBreak");
          onChange(extractPlainText(editableRef.current));
        }
      }
    },
    [mentionActive, onChange],
  );

  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => {
      e.preventDefault();
      document.execCommand("insertText", false, e.clipboardData.getData("text/plain"));
      if (editableRef.current) {
        onChange(extractPlainText(editableRef.current));
      }
    },
    [onChange],
  );

  const filteredRefs = mentionQuery
    ? references.filter((r) => chipLabel(r).includes(mentionQuery))
    : references;
  const showDropdown = mentionActive && filteredRefs.length > 0;

  return (
    <div style={{ position: "relative" }}>
      <style>{`
        .mention-editable:focus {
          outline: none !important;
          box-shadow: none !important;
          border-color: transparent !important;
        }
        .mention-editable:empty::before {
          content: attr(data-placeholder);
          color: var(--canvas-text-muted, #888);
          pointer-events: none;
        }
        .mention-scroll::-webkit-scrollbar { width: 6px; }
        .mention-scroll::-webkit-scrollbar-thumb {
          background: var(--canvas-border, #3a3a3a);
          border-radius: 3px;
        }
      `}</style>
      <div
        className="mention-scroll"
        style={{
          width: "100%", minHeight: 100, maxHeight: 240,
          overflowY: "auto", padding: 0,
          borderRadius: 6, background: "transparent", border: "none",
          ...style,
        }}
      >
        <div
          ref={editableRef}
          className="mention-editable nodrag"
          contentEditable
          suppressContentEditableWarning
          data-placeholder={placeholder}
          onInput={syncAndCheck}
          onKeyUp={syncAndCheck}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          onBlur={() => { setTimeout(() => setMentionActive(false), 200); }}
          style={{
            width: "100%", minHeight: 100, padding: "8px 0",
            fontSize: 13, lineHeight: 1.6, color: "var(--canvas-text)",
            background: "transparent", border: "none",
            wordBreak: "break-word", whiteSpace: "pre-wrap", outline: "none",
          }}
        />
      </div>
      {showDropdown &&
        createPortal(
          <MentionDropdown
            items={filteredRefs}
            position={mentionPos}
            onSelect={handleSelectMention}
            onClose={() => setMentionActive(false)}
          />,
          document.body,
        )}
    </div>
  );
};

export default MentionPrompt;
