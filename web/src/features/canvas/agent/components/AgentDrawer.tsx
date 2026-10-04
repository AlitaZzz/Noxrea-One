/**
 * 画布 AI 对话抽屉。
 * 提供多轮会话（新建 / 历史切换）、模型选择，
 * 流式接收回复并以 Markdown 渲染（经 sanitize 白名单放宽后允许有限 HTML）。
 * 消息按回合分组渲染：工具调用以「图标 + intent 一句话」操作行展示，
 * 删除类/整理画布操作先经确认卡批准，回合结束后可在末尾「撤销此轮」。
 */

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { ArrowUpOutlined, CloseOutlined, DeleteOutlined } from "@/components/ui/AppIcon";
import { HistoryIcon } from "@/components/ui/AppIcon";
import { NewChatIcon } from "@/components/ui/AppIcon";
import { ChevronDownIcon } from "@/components/ui/AppIcon";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useAppFeedback } from "@/components/ui/use-app-feedback";
import ChatSectionView from "@/features/canvas/agent/components/ChatSectionView";
import ConfirmCard from "@/features/canvas/agent/components/ConfirmCard";
import { useCanvasAgentStream } from "@/features/canvas/agent/hooks/use-canvas-agent-stream";
import { groupSections } from "@/features/canvas/agent/utils/group-sections";
import { hasGeneratingNode, undoAction } from "@/features/canvas/shared/canvas-edit-actions";
import { useCanvasStore } from "@/features/canvas/stores/canvas-store";
import { useHistoryStore } from "@/features/canvas/stores/history-store";
import i18n from "@/lib/i18n/config";
import { useModelStore } from "@/lib/model-store";

interface Props {
  open: boolean;
  onClose: () => void;
  projectId?: string;
}

/** 右侧 Agent 对话抽屉（项目 Drawer 外壳 + markdown 渲染 + 工具续轮） */
export default function CanvasAgentDrawer({ open, onClose, projectId }: Props) {
  const { t } = useTranslation();
  const { message } = useAppFeedback();
  const providers = useModelStore((s) => s.providers);
  const initialize = useModelStore((s) => s.initialize);
  const initializeFailed = useModelStore((s) => s.initializeFailed);
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
      message.info(i18n.t("shortcuts.undoBlocked"));
      return;
    }
    if (undoAction()) {
      message.success(i18n.t("agent.undoTurnSuccess"));
    }
  }, [message]);

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
    const title = titleDraft.trim();
    if (title) void renameChat(title);
    setEditing(false);
  }, [titleDraft, renameChat]);

  const formatRelative = useCallback((iso: string) => {
    const diff = Date.now() - new Date(iso).getTime();
    const min = Math.floor(diff / 60000);
    if (min < 1) return i18n.t("agent.timeJustNow");
    if (min < 60) return i18n.t("agent.timeMinutes", { n: min });
    const hr = Math.floor(min / 60);
    if (hr < 24) return i18n.t("agent.timeHours", { n: hr });
    const day = Math.floor(hr / 24);
    if (day < 7) return i18n.t("agent.timeDays", { n: day });
    const d = new Date(iso);
    const p = (n: number) => `${n}`.padStart(2, "0");
    return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())}`;
  }, []);

  return (
    <Sheet
      open={open}
      modal={false}
      onOpenChange={(nextOpen) => { if (!nextOpen) onClose(); }}
    >
      <SheetContent
        side="right"
        showOverlay={false}
        className="w-[min(420px,100vw)] !max-w-[min(420px,100vw)] gap-0 border-l border-border p-0"
      >
        <SheetHeader className="h-16 shrink-0 flex-row items-center gap-2 border-0 py-0 pl-3 pr-14">
          <SheetTitle className="min-w-0 flex-1">
            {editing ? (
          <Input
            autoFocus
            className="h-8 min-w-40 max-w-60 text-sm font-medium"
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
          <Tooltip><TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-auto max-w-60 min-w-0 justify-start truncate px-1 text-sm font-medium text-foreground"
                onClick={startRename}
              >
                {chatTitle ?? t("agent.newChat")}
              </Button>
            </TooltipTrigger><TooltipContent side="bottom">{t("agent.renameTooltip")}</TooltipContent></Tooltip>
            )}
          </SheetTitle>
          <SheetDescription className="sr-only">{t("agent.drawerDescription")}</SheetDescription>
          <div className="ml-auto flex items-center gap-1">
          <Tooltip><TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                className="text-muted-foreground"
                aria-label={t("agent.newChat")}
                onClick={() => newChat()}
              >
                <NewChatIcon />
              </Button>
            </TooltipTrigger><TooltipContent side="bottom">{t("agent.newChat")}</TooltipContent></Tooltip>
          <Popover
            open={historyOpen}
            onOpenChange={(o) => {
              setHistoryOpen(o);
              if (o) void loadSessions();
            }}
          >
            <Tooltip open={historyOpen ? false : undefined}>
              <TooltipTrigger asChild>
                <PopoverTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="text-muted-foreground"
                    aria-label={t("agent.historyTitle")}
                  >
                    <HistoryIcon />
                  </Button>
                </PopoverTrigger>
              </TooltipTrigger>
              <TooltipContent side="bottom">{t("agent.historyTitle")}</TooltipContent>
            </Tooltip>
            <PopoverContent side="bottom" align="end" className="z-[1050] w-[320px] p-0">
              <div className="flex flex-col overflow-hidden">
                <div className="px-4 pb-2 pt-3.5 text-base font-semibold leading-5 text-foreground">{t("agent.historyTitle")}</div>
                <div className="max-h-[260px] overflow-y-auto px-2 pb-2 pt-1">
                  {sessions.length === 0 ? (
                    <div className="px-3 py-6 text-center text-[13px] text-muted-foreground">{t("agent.historyEmpty")}</div>
                  ) : (
                    sessions.map((s) => (
                      <div key={s.id} className="group flex w-full min-w-0 items-center rounded-md transition-colors hover:bg-accent">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="min-w-0 flex-1 justify-start px-3 text-[13px] font-normal text-foreground"
                          onClick={() => {
                            void loadHistory(s.id);
                            setHistoryOpen(false);
                          }}
                        >
                          <span className="block truncate">{s.title || t("agent.newChat")}</span>
                        </Button>
                        <div className="relative h-8 min-w-11 shrink-0">
                          <Tooltip><TooltipTrigger asChild>
                              <span className="absolute inset-0 flex items-center justify-end pr-1.5 text-xs tabular-nums text-muted-foreground transition-opacity group-hover:opacity-0 group-focus-within:opacity-0">{formatRelative(s.updatedAt)}</span>
                            </TooltipTrigger><TooltipContent side="top">{new Date(s.updatedAt).toLocaleString()}</TooltipContent></Tooltip>
                          <Tooltip><TooltipTrigger asChild>
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon-xs"
                                className="pointer-events-none absolute inset-0 flex items-center justify-end pr-1.5 p-0 text-muted-foreground opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100"
                                aria-label={t("agent.deleteChatAria", { title: s.title || t("agent.newChat") })}
                                onClick={() => void deleteChat(s.id)}
                              >
                                <DeleteOutlined className="size-3.5" />
                              </Button>
                            </TooltipTrigger><TooltipContent side="top">{t("agent.deleteChatTooltip")}</TooltipContent></Tooltip>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </PopoverContent>
          </Popover>
          </div>
        </SheetHeader>
        <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto p-3 [scrollbar-width:thin] [scrollbar-color:var(--input)_transparent]">
        {messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2.5 text-center">
            <div className="text-[22px] font-semibold tracking-wide text-foreground">Noxrea One</div>
            <div className="text-[13px] text-muted-foreground">{t("agent.emptySubtitle")}</div>
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

        <SheetFooter className="mt-0 flex shrink-0 flex-col gap-0 bg-card p-2.5">
        <div className="rounded-2xl border border-border bg-popover px-3 py-2.5 transition-colors focus-within:border-input">
          <div
            ref={composerRef}
            className="min-h-[60px] max-h-[200px] w-full resize-none overflow-y-auto whitespace-pre-wrap break-words bg-transparent text-sm leading-6 text-foreground outline-none empty:before:pointer-events-none empty:before:text-muted-foreground empty:before:content-[attr(data-placeholder)]"
            contentEditable
            suppressContentEditableWarning
            data-placeholder={t("agent.composerPlaceholder")}
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
          <div className="mt-1.5 flex items-center justify-between">
            <div />
            <div className="flex items-center gap-1.5">
              {initializeFailed && !modelOptions.length ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="max-w-[180px] justify-between text-muted-foreground"
                  onClick={() => void initialize()}
                >
                  <span className="truncate">{t("agent.modelLoadFailed")}</span>
                </Button>
              ) : (
                <DropdownMenu
                  open={modelOpen}
                  onOpenChange={setModelOpen}
                >
                  <DropdownMenuTrigger asChild>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="max-w-[180px] justify-between text-muted-foreground"
                      aria-label={t("agent.selectModelAria")}
                    >
                      <span className="truncate">{activeOption?.label ?? activeOption?.value}</span>
                      <ChevronDownIcon />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent side="top" align="end">
                    {modelOptions.map((option) => (
                      <DropdownMenuItem
                        key={option.value}
                        className={option.value === activeOption?.value ? "bg-accent text-accent-foreground" : undefined}
                        onSelect={() => setAgentModel(option.value)}
                      >
                        {option.label}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
              <Button
                type="button"
                size="icon"
                variant={isStreaming ? "destructive" : "default"}
                aria-label={isStreaming ? t("agent.stopAria") : t("agent.sendAria")}
                disabled={!canSend && !isStreaming}
                onClick={isStreaming ? stopStream : handleSend}
              >
                {isStreaming ? (
                  <CloseOutlined style={{ fontSize: 16 }} />
                ) : (
                  <ArrowUpOutlined style={{ fontSize: 16 }} />
                )}
              </Button>
            </div>
          </div>
        </div>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
