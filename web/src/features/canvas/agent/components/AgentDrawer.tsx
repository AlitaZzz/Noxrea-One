/**
 * 画布 AI 对话抽屉。
 * 提供多轮会话（新建 / 历史切换）、模型选择，
 * 流式接收回复并以 Markdown 渲染（经 sanitize 白名单放宽后允许有限 HTML）。
 * 消息按回合分组渲染：工具调用以「图标 + intent 一句话」操作行展示，
 * 删除类/整理画布操作先经确认卡批准，回合结束后可在末尾「撤销此轮」。
 */
"use client";

import { ArrowUpOutlined, CloseOutlined } from "@ant-design/icons";
import { Drawer, Tooltip } from "antd";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { HistoryIcon } from "@/components/ui/icons/agent/HistoryIcon";
import { NewChatIcon } from "@/components/ui/icons/agent/NewChatIcon";
import { ChevronDownIcon } from "@/components/ui/icons/common/ChevronDownIcon";
import { MenuItem, MenuPopover } from "@/components/ui/MenuPopover";
import ChatSectionView from "@/features/canvas/agent/components/ChatSectionView";
import ConfirmCard from "@/features/canvas/agent/components/ConfirmCard";
import { useCanvasAgentStream } from "@/features/canvas/agent/hooks/use-canvas-agent-stream";
import { groupSections } from "@/features/canvas/agent/utils/group-sections";
import { hasGeneratingNode, undoAction } from "@/features/canvas/shared/canvas-edit-actions";
import { useCanvasStore } from "@/features/canvas/stores/canvas-store";
import { useHistoryStore } from "@/features/canvas/stores/history-store";
import { showGlobalMessage } from "@/lib/global-message";
import i18n from "@/lib/i18n/config";
import { useModelStore } from "@/lib/model-store";

interface Props {
  open: boolean;
  onClose: () => void;
  projectId?: string;
}

/** 右侧 Agent 对话抽屉（antd Drawer 外壳 + markdown 渲染 + 工具续轮） */
export default function CanvasAgentDrawer({ open, onClose, projectId }: Props) {
  const providers = useModelStore((s) => s.providers);
  const initialize = useModelStore((s) => s.initialize);
  // 稳定键 providerId/modelName，与生成面板的 ModelOption 约定一致，
  // 避免同名模型在不同供应商间选错渠道
  const modelOptions = providers.flatMap((c) =>
    c.models
      .filter((m) => m.capabilities?.includes("text"))
      .map((m) => ({ value: `${c.id}/${m.name}`, label: `${c.name}/${m.name}`, providerId: c.id, name: m.name }))
  );

  const agentModel = useCanvasStore((s) => s.agentModel);
  const setAgentModel = useCanvasStore((s) => s.setAgentModel);
  const activeOption = modelOptions.find((o) => o.value === agentModel) ?? modelOptions[0];
  const {
    messages, isStreaming, sendChat, stopStream, newChat,
    chatTitle, renameChat, sessions, loadSessions, loadHistory, deleteChat,
    pendingConfirm, respondToConfirm, lastTurnUndo,
  } = useCanvasAgentStream(activeOption?.name ?? "", projectId, activeOption?.providerId);
  const isDark = useCanvasStore((s) => s.theme) === "dark";
  const historyVersion = useHistoryStore((s) => s.version);
  const listRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState("");

  const sections = useMemo(() => groupSections(messages), [messages]);

  // 「撤销此轮」仅在最后一个回合且其历史记录仍然有效（版本号未变）时可用
  const lastSectionIndex = sections.length - 1;
  const canUndoSection = useCallback(
    (index: number, turnId: string | null) =>
      index === lastSectionIndex &&
      !!turnId &&
      turnId === lastTurnUndo?.turnId &&
      historyVersion === lastTurnUndo.version,
    [lastSectionIndex, lastTurnUndo, historyVersion]
  );

  const handleUndoTurn = useCallback(() => {
    if (hasGeneratingNode()) {
      showGlobalMessage().info(i18n.t("shortcuts.undoBlocked"));
      return;
    }
    if (undoAction()) {
      showGlobalMessage().success("已撤销本轮操作");
    }
  }, []);

  useEffect(() => {
    void initialize();
  }, [initialize]);

  useEffect(() => {
    if (modelOptions.length && !modelOptions.some((m) => m.value === agentModel)) {
      setAgentModel(modelOptions[0].value);
    }
  }, [modelOptions, agentModel, setAgentModel]);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, pendingConfirm]);

  const syncDraft = useCallback(() => {
    setDraft(composerRef.current?.innerText ?? "");
  }, []);

  const canSend = !!draft.trim();

  const handleSend = useCallback(() => {
    const text = composerRef.current?.innerText ?? "";
    if (!text.trim() || isStreaming) return;
    void sendChat(text);
    if (composerRef.current) composerRef.current.innerText = "";
    setDraft("");
  }, [isStreaming, sendChat]);

  const [modelOpen, setModelOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);

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
              if (e.nativeEvent.isComposing) return;
              if (e.key === "Enter") commitRename();
              if (e.key === "Escape") setEditing(false);
            }}
          />
        ) : (
          <Tooltip title="点击重命名" placement="bottom">
            <span className="chat-title" onClick={startRename}>{chatTitle ?? "新对话"}</span>
          </Tooltip>
        )
      }
      extra={
        <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
          <Tooltip title="新对话" placement="bottom">
            <button type="button" className="chat-header-btn" aria-label="新对话" onClick={() => newChat()}>
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
                            void loadHistory(s.id);
                            setHistoryOpen(false);
                          }}
                        >
                          <span className="chat-history-name">{s.title || "新对话"}</span>
                        </button>
                        <div className="chat-history-side">
                          <Tooltip title={new Date(s.updatedAt).toLocaleString()} placement="top">
                            <span className="chat-history-time">{formatRelative(s.updatedAt)}</span>
                          </Tooltip>
                          <Tooltip title="删除对话" placement="top">
                          <button
                            type="button"
                            className="chat-history-del"
                            aria-label={`删除「${s.title || "新对话"}」`}
                            onClick={() => void deleteChat(s.id)}
                          >
                            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 19.5 21.5" width="14" height="14" aria-hidden="true" role="img">
                              <path d="M11.75 0c.74 0 1.43.36 1.9.84.49.48.85 1.17.85 1.91V4h4.25a.75.75 0 0 1 0 1.5h-1.3l-.95 13.3a2.8 2.8 0 0 1-.84 1.86c-.48.48-1.17.84-1.91.84h-8c-.74 0-1.43-.36-1.9-.84A2.8 2.8 0 0 1 3 18.8L2.05 5.5H.75a.75.75 0 0 1 0-1.5H5V2.75c0-.74.36-1.43.84-1.9A2.8 2.8 0 0 1 7.75 0zM4.5 18.7v.05c0 .26.14.57.4.84.28.27.6.41.85.41h8c.26 0 .57-.14.84-.4a1.3 1.3 0 0 0 .41-.9l.94-13.2H3.56zM7.75 9c.41 0 .75.34.75.75v6a.75.75 0 0 1-1.5 0v-6c0-.41.34-.75.75-.75m4 0c.41 0 .75.34.75.75v6a.75.75 0 0 1-1.5 0v-6c0-.41.34-.75.75-.75m-4-7.5c-.26 0-.57.14-.84.4-.27.28-.41.6-.41.85V4H13V2.75c0-.26-.14-.57-.4-.84-.28-.27-.6-.41-.85-.41z" fill="currentColor"></path>
                            </svg>
                          </button>
                          </Tooltip>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            }
            trigger={
              <Tooltip title="历史对话" placement="bottom">
                <button type="button" className="chat-header-btn" aria-label="历史对话" onClick={() => setHistoryOpen((v) => !v)}>
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
      <div ref={listRef} className="chat-scroll" style={{ flex: 1, overflowY: "auto", padding: 12 }}>
        {messages.length === 0 ? (
          <div className="chat-empty">
            <div className="chat-empty-title">Noxrea One</div>
            <div className="chat-empty-subtitle">从灵感碎片，到完整世界</div>
          </div>
        ) : (
          sections.map((section, index) => (
            <ChatSectionView
              key={section.key}
              section={section}
              isStreaming={isStreaming}
              canUndo={canUndoSection(index, section.turnId)}
              onUndo={handleUndoTurn}
            />
          ))
        )}

        {pendingConfirm && <ConfirmCard pending={pendingConfirm} onResolve={respondToConfirm} />}
      </div>

      <div className="chat-input-bar">
        <div className="chat-composer">
          <div
            ref={composerRef}
            className="chat-composer-input"
            contentEditable
            suppressContentEditableWarning
            data-placeholder="描述你的想法，例如「画布上建三个文本节点连起来」"
            onInput={(e) => {
              const el = e.currentTarget;
              if (!el.textContent?.trim()) el.innerHTML = "";
              el.style.height = "auto";
              el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
              syncDraft();
            }}
            onPaste={(e) => {
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
              // 输入法组合态的 Enter（确认候选词）不触发发送
              if (e.nativeEvent.isComposing) return;
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSend();
              }
            }}
          />
          <div className="chat-composer-actions">
            <div className="chat-composer-left" />
            <div className="chat-composer-right">
              <MenuPopover
                open={modelOpen}
                onOpenChange={setModelOpen}
                placement="topRight"
                trigger={
                  <button type="button" className="chat-composer-model" aria-label="选择模型">
                    <span className="chat-composer-model-label">{activeOption?.label ?? activeOption?.value}</span>
                    <ChevronDownIcon />
                  </button>
                }
                content={modelOptions.map((m) => (
                  <MenuItem
                    key={m.value}
                    selected={activeOption?.value === m.value}
                    onClick={() => {
                      setAgentModel(m.value);
                      setModelOpen(false);
                    }}
                  >
                    {m.label}
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
