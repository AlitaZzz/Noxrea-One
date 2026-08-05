/**
 * 画布 AI 对话抽屉。
 * 提供多轮会话（新建 / 历史切换）、附件上传、技能调用与模型选择，
 * 流式接收回复并以 Markdown 渲染（经 sanitize 白名单放宽后允许有限 HTML）。
 */
"use client";

import { ArrowUpOutlined, CloseOutlined, ThunderboltOutlined } from "@ant-design/icons";
import { Drawer, Button, Tooltip } from "antd";
import { MenuPopover, MenuItem } from "@/components/common/MenuPopover";
import { useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";

/** 允许 AI 输出中嵌入的 HTML 标签与属性，在 defaultSchema 基础上放宽 */
const sanitizeSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    "*": [...(defaultSchema.attributes?.["*"] ?? []), "style", "className", "class"],
    div: ["style", "className", "class"],
    span: ["style", "className", "class"],
    table: ["style", "className", "class"],
    td: ["colspan", "rowspan", "style", "class"],
    th: ["colspan", "rowspan", "style", "class"],
    img: ["src", "alt", "width", "height", "style", "class"],
    a: ["href", "target", "rel", "style", "class"],
  },
  tagNames: [
    ...(defaultSchema.tagNames ?? []),
    "div", "span", "table", "thead", "tbody", "tr", "td", "th",
    "details", "summary", "figure", "figcaption",
  ],
};

import SkillPanel from "./SkillPanel";
import { NewChatIcon } from "@/components/common/icons/chat/NewChatIcon";
import { HistoryIcon } from "@/components/common/icons/chat/HistoryIcon";
import { AttachIcon } from "@/components/common/icons/chat/AttachIcon";
import { ChevronDownIcon } from "@/components/common/icons/ChevronDownIcon";
import { useChatStream } from "@/hooks/use-chat-stream";
import { useModelStore } from "@/stores/model-store";
import { useCanvasStore } from "@/stores/canvas-store";
import { apiRaw } from "@/lib/api";

interface Props {
  open: boolean;
  onClose: () => void;
}

/** 右侧 Agent 对话抽屉（antd Drawer 外壳 + markdown 渲染 + 技能面板 + 工具续轮） */
export default function ChatPanel({ open, onClose }: Props) {
  // 模型列表来自已配置的渠道（不写死），确保 store 已初始化
  // 与生成面板一致：选项值为「渠道名/模型名」，显示带渠道前缀以便区分同名模型
  const channels = useModelStore((s) => s.channels);
  const initialize = useModelStore((s) => s.initialize);
  const modelOptions = channels.flatMap((c) =>
    c.models
      .filter((m) => m.capabilities?.includes("text"))
      .map((m) => ({ value: `${c.name}/${m.name}`, name: m.name }))
  );

  // activeModel 来自 canvasStore.agentModel（project 级持久化，落盘到 canvasData）
  const agentModel = useCanvasStore((s) => s.agentModel);
  const setAgentModel = useCanvasStore((s) => s.setAgentModel);
  // 若 store 尚无值（旧项目 / 未加载），回退到首个可用模型
  const activeModel = agentModel ?? modelOptions[0]?.value ?? "gpt-4o";
  const activeModelName = activeModel.includes("/") ? activeModel.split("/").pop()! : activeModel;
  const { messages, isStreaming, error, sendChat, stopStream, newChat, chatTitle, renameChat, sessions, loadSessions, loadHistory, deleteChat } = useChatStream(activeModelName);
  const isDark = useCanvasStore((s) => s.theme) === "dark";
  const listRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState("");
  const [skillNames, setSkillNames] = useState<{ name: string; displayTitle?: string }[]>([]);

  // 初始化模型配置（幂等）；列表就绪后若当前选中项不在列表中则回退首项
  useEffect(() => {
    void initialize();
  }, [initialize]);
  // 拉取技能名列表，供斜杠命令解析时使用
  useEffect(() => {
    let alive = true;
    apiRaw("/api/chat/skills")
      .then((r) => (r.ok ? r.json() : []))
      .then((list: { name: string; displayTitle?: string }[]) => {
        if (alive && Array.isArray(list)) setSkillNames(list);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  useEffect(() => {
    if (modelOptions.length && !modelOptions.some((m) => m.value === agentModel)) {
      setAgentModel(modelOptions[0].value);
    }
  }, [modelOptions, agentModel, setAgentModel]);

  // 新消息到达时滚到底部
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const syncDraft = useCallback(() => {
    setDraft(composerRef.current?.innerText ?? "");
  }, []);

  const [activeSkill, setActiveSkill] = useState<string | null>(null);

  const canSend = !!draft.trim() || !!activeSkill;

  const handleSend = useCallback(() => {
    const text = composerRef.current?.innerText ?? "";
    if ((!text.trim() && !activeSkill) || isStreaming) return;
    const skills = activeSkill
      ? [{ name: activeSkill, displayTitle: skillNames.find((s) => s.name === activeSkill)?.displayTitle }]
      : undefined;
    void sendChat(text, skills);
    if (composerRef.current) composerRef.current.innerText = "";
    // 不清除 activeSkill —— skill 保持激活直到用户显式点击 × 移除，
    // 这样同一对话内后续消息会继续带上 skill 标签
    setDraft("");
  }, [isStreaming, sendChat, activeSkill, skillNames]);

  const handleSkillSelect = useCallback((skillName: string) => {
    setActiveSkill(skillName);
    if (composerRef.current) composerRef.current.focus();
  }, []);

  const [modelOpen, setModelOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);

  // 标题就地重命名
  const [editing, setEditing] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const startRename = useCallback(() => {
    setTitleDraft(chatTitle ?? "");
    setEditing(true);
  }, [chatTitle]);
  const commitRename = useCallback(() => {
    const t = titleDraft.trim();
    if (t) void renameChat(t);
    setEditing(false);
  }, [titleDraft, renameChat]);

  // 相对时间：分钟→小时→天→日期
  const formatRelative = useCallback((iso: string) => {
    const diff = Date.now() - new Date(iso).getTime();
    const min = Math.floor(diff / 60000);
    if (min < 1) return "刚刚";
    if (min < 60) return `${min}分钟`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}小时`;
    const day = Math.floor(hr / 24);
    if (day < 7) return `${day}天`;
    const d = new Date(iso);
    const p = (n: number) => `${n}`.padStart(2, "0");
    return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())}`;
  }, []);

  return (
    <Drawer
      open={open}
      onClose={onClose}
      size={420}
      mask={false}
      closable={{ placement: "end" }}
      title={
        editing ? (
          <input
            autoFocus
            className="chat-title-input"
            value={titleDraft}
            onChange={(e) => setTitleDraft(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitRename();
              if (e.key === "Escape") setEditing(false);
            }}
          />
        ) : (
          <span
            className="chat-title"
            title="点击重命名"
            onClick={startRename}
          >
            {chatTitle ?? "新对话"}
          </span>
        )
      }
      extra={
        <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
          <Tooltip title="新对话" placement="bottom">
            <button
              type="button"
              className="chat-header-btn"
              aria-label="新对话"
              onClick={() => newChat()}
            >
              <NewChatIcon />
            </button>
          </Tooltip>
          <MenuPopover
            open={historyOpen}
            onOpenChange={(o) => {
              setHistoryOpen(o);
              if (o) void loadSessions();
            }}
            placement="bottomRight"
            overlayClassName="chat-history-popover"
            content={
              <div className="chat-history-body">
                <div className="chat-history-title">历史对话</div>
                <div className="chat-history-list">
                  {sessions.length === 0 ? (
                    <div className="chat-history-empty">暂无历史对话</div>
                  ) : (
                    sessions.map((s) => (
                      <div key={s.id} className="chat-history-item group">
                        <button
                          type="button"
                          className="chat-history-main"
                          onClick={() => {
                            void loadHistory(s.id, skillNames);
                            setHistoryOpen(false);
                          }}
                        >
                          <span className="chat-history-name">{s.title || "新对话"}</span>
                        </button>
                        <div className="chat-history-side">
                          <span className="chat-history-time" title={new Date(s.updatedAt).toLocaleString()}>
                            {formatRelative(s.updatedAt)}
                          </span>
                          <button
                            type="button"
                            className="chat-history-del"
                            aria-label={`删除「${s.title || "新对话"}」`}
                            title="删除对话"
                            onClick={() => void deleteChat(s.id)}
                          >
                            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 19.5 21.5" width="14" height="14" aria-hidden="true" role="img">
                              <path d="M11.75 0c.74 0 1.43.36 1.9.84.49.48.85 1.17.85 1.91V4h4.25a.75.75 0 0 1 0 1.5h-1.3l-.95 13.3a2.8 2.8 0 0 1-.84 1.86c-.48.48-1.17.84-1.91.84h-8c-.74 0-1.43-.36-1.9-.84A2.8 2.8 0 0 1 3 18.8L2.05 5.5H.75a.75.75 0 0 1 0-1.5H5V2.75c0-.74.36-1.43.84-1.9A2.8 2.8 0 0 1 7.75 0zM4.5 18.7v.05c0 .26.14.57.4.84.28.27.6.41.85.41h8c.26 0 .57-.14.84-.4a1.3 1.3 0 0 0 .41-.9l.94-13.2H3.56zM7.75 9c.41 0 .75.34.75.75v6a.75.75 0 0 1-1.5 0v-6c0-.41.34-.75.75-.75m4 0c.41 0 .75.34.75.75v6a.75.75 0 0 1-1.5 0v-6c0-.41.34-.75.75-.75m-4-7.5c-.26 0-.57.14-.84.4-.27.28-.41.6-.41.85V4H13V2.75c0-.26-.14-.57-.4-.84-.28-.27-.6-.41-.85-.41z" fill="currentColor"></path>
                            </svg>
                          </button>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            }
            trigger={
              <Tooltip title="历史对话" placement="bottom">
                <button
                  type="button"
                  className="chat-header-btn"
                  aria-label="历史对话"
                  onClick={() => setHistoryOpen((v) => !v)}
                >
                  <HistoryIcon />
                </button>
              </Tooltip>
            }
          />
        </div>
      }
      styles={{
        header: { borderBottom: "none", padding: "12px 16px" },
        body: { padding: 0, display: "flex", flexDirection: "column" },
        section: isDark ? { borderLeft: "1px solid #2c2c31" } : undefined,
      }}
    >
      {/* 消息列表 */}
      <div ref={listRef} className="chat-scroll" style={{ flex: 1, overflowY: "auto", padding: 12 }}>
        {messages.length === 0 ? (
          <div className="chat-empty">
            <div className="chat-empty-title">Noxrea One</div>
            <div className="chat-empty-subtitle">从灵感碎片，到完整世界</div>
          </div>
        ) : (
          messages.map((m) => (
            <div
              key={m.id}
              className={`chat-msg chat-msg-${m.role}`}
              style={{
                marginBottom: 12,
                display: "flex",
                justifyContent: m.role === "user" ? "flex-end" : "flex-start",
              }}
            >
              <div className={`chat-bubble chat-bubble-${m.role}${m.error ? " chat-bubble-error" : ""}`}>
                {m.role === "assistant" ? (
                  <>
                    {m.toolCalls?.length ? (
                      <div className="chat-tool-calls">
                        {m.toolCalls.map((t) => (
                          <div key={t.id} className="chat-tool-call">
                            调用工具：<code>{t.label ?? t.name}</code>
                            {t.args && <div className="chat-tool-args">{t.args}</div>}
                          </div>
                        ))}
                      </div>
                    ) : null}
                    {m.content ? (
                      <div className="cortex-markdown">
                        <ReactMarkdown
                          remarkPlugins={[remarkGfm]}
                          rehypePlugins={[rehypeRaw, [rehypeSanitize, sanitizeSchema]]}
                        >
                          {m.content}
                        </ReactMarkdown>
                      </div>
                    ) : !m.toolCalls?.length ? (
                      <span className="chat-thinking">思考中…</span>
                    ) : null}
                  </>
                ) : m.role === "tool" ? (
                  <span className="chat-tool-result">{m.content}</span>
                ) : (
                  <div className="cortex-markdown">
                    {m.skills?.length ? (
                      <div className="chat-msg-skills">
                        {m.skills.map((s) => (
                          <span key={s.name} className="chat-msg-skill">
                            <ThunderboltOutlined style={{ fontSize: 12, marginRight: 4 }} />
                            {s.displayTitle ?? s.name}
                          </span>
                        ))}
                      </div>
                    ) : null}
                    {m.content ? (
                      <ReactMarkdown
                        remarkPlugins={[remarkGfm]}
                        rehypePlugins={[rehypeRaw, [rehypeSanitize, sanitizeSchema]]}
                      >
                        {m.content}
                      </ReactMarkdown>
                    ) : null}
                  </div>
                )}
              </div>
            </div>
          ))
        )}
        {error ? <div className="chat-error">{error}</div> : null}
      </div>

      {/* 输入区：参照精致输入框结构（附件 / Skill / 模型 / 发送） */}
      <div className="chat-input-bar">
        <input
          ref={fileRef}
          type="file"
          accept=".docx,.txt,.pdf,.jpg,.jpeg,.png,.mp4,.mov,.wav,.mp3"
          multiple
          hidden
          onChange={() => {
            /* 附件上传：后端未提供接口，先占位 */
          }}
        />
        <div className="chat-composer">
          {activeSkill ? (
            <span className="chat-skill-chip">
              {skillNames.find((s) => s.name === activeSkill)?.displayTitle ?? activeSkill}
              <button
                type="button"
                className="chat-skill-chip-x"
                aria-label="移除技能"
                onClick={() => setActiveSkill(null)}
              >
                ×
              </button>
            </span>
          ) : null}
          <div
            ref={composerRef}
            className="chat-composer-input"
            contentEditable
            suppressContentEditableWarning
            data-placeholder={activeSkill ? "补充指令（可留空）" : '描述你的想法，输入"/" + skill 名称使用 Skill'}
            onInput={(e) => {
              const el = e.currentTarget;
              // 删除到仅剩 <br>/空白时，真正清空以恢复占位符
              if (!el.textContent?.trim()) el.innerHTML = "";
              el.style.height = "auto";
              el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
              syncDraft();
            }}
            onPaste={(e) => {
              // 粘贴纯文本，避免带入外部 HTML 样式
              e.preventDefault();
              const text = e.clipboardData.getData("text/plain");
              const sel = window.getSelection();
              if (!sel || sel.rangeCount === 0) {
                document.execCommand("insertText", false, text);
                return;
              }
              const range = sel.getRangeAt(0);
              range.deleteContents();
              const node = document.createTextNode(text);
              range.insertNode(node);
              range.setStartAfter(node);
              range.collapse(true);
              sel.removeAllRanges();
              sel.addRange(range);
              syncDraft();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSend();
              }
              // Shift+Enter 保持默认换行行为
            }}
          />
          <div className="chat-composer-actions">
            <div className="chat-composer-left">
              <Tooltip title="添加附件" placement="top">
                <button
                  type="button"
                  className="chat-composer-icon"
                  aria-label="添加附件或画布引用"
                  onClick={() => fileRef.current?.click()}
                >
                  <AttachIcon />
                </button>
              </Tooltip>
              <SkillPanel onSelect={handleSkillSelect} />
            </div>
            <div className="chat-composer-right">
              <MenuPopover
                open={modelOpen}
                onOpenChange={setModelOpen}
                placement="topRight"
                trigger={
                  <Tooltip title={activeModel} placement="top">
                    <button type="button" className="chat-composer-model" aria-label="选择模型">
                      <span className="chat-composer-model-label">{activeModel}</span>
                      <ChevronDownIcon />
                    </button>
                  </Tooltip>
                }
                content={modelOptions.map((m) => (
                  <MenuItem
                    key={m.value}
                    selected={activeModel === m.value}
                    onClick={() => {
                      setAgentModel(m.value);
                      setModelOpen(false);
                    }}
                  >
                    {m.value}
                  </MenuItem>
                ))}
              />
              <button
                type="button"
                aria-label={isStreaming ? "停止" : "发送"}
                className="flex items-center justify-center flex-shrink-0 transition-all"
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: 10,
                  background: isStreaming ? "#e74c3c" : !canSend ? "var(--canvas-border)" : "var(--canvas-text)",
                  color: isStreaming ? "#fff" : !canSend ? "var(--canvas-text-muted)" : "var(--canvas-bg)",
                  border: "none",
                  cursor: "pointer",
                  opacity: !canSend && !isStreaming ? 0.5 : 1,
                }}
                disabled={!canSend && !isStreaming}
                onClick={isStreaming ? stopStream : handleSend}
              >
                {isStreaming ? (
                  <CloseOutlined style={{ fontSize: 16 }} />
                ) : (
                  <ArrowUpOutlined style={{ fontSize: 16 }} />
                )}
              </button>
            </div>
          </div>
        </div>
      </div>
    </Drawer>
  );
}
