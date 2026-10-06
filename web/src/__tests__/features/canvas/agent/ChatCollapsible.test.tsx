// @vitest-environment jsdom
import { cleanup, fireEvent, render as renderView, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";
import { ChatActionRow } from "@/features/canvas/agent/components/ChatActionRow";
import { ChatToolRound } from "@/features/canvas/agent/components/ChatToolRound";
import type { ChatMessage, ToolCallView } from "@/features/canvas/agent/types";
import type { ChatRound } from "@/features/canvas/agent/utils/group-sections";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { count: number }) =>
      key === "agent.executedCount" ? `Operations ${options?.count}` : key,
  }),
}));

vi.mock("@/features/canvas/agent/tools/Meta", () => ({
  TOOL_META: {},
  actionRowText: (call: ToolCallView) => call.label ?? call.name,
}));

afterEach(cleanup);

function render(ui: ReactNode) {
  return renderView(ui, { wrapper: TooltipProvider });
}

const calls: ToolCallView[] = [
  { id: "c1", name: "create_node", label: "Create", args: '{"kind":"text"}' },
  { id: "c2", name: "connect_nodes", label: "Connect", args: "{}" },
];

function round(completed: boolean): ChatRound {
  return {
    key: "round-1",
    calls,
    results: new Map(completed ? calls.map((call) => [call.id, {
      id: `result-${call.id}`,
      role: "tool",
      toolCallId: call.id,
      content: `Result ${call.id}`,
    } satisfies ChatMessage]) : []),
  };
}

describe("Agent collapsible interactions", () => {
  it("links the detail trigger to its content and formats the actual call arguments", () => {
    render(<ChatActionRow call={calls[0]} isStreaming={false} />);

    const trigger = screen.getByRole("button", { name: "agent.detail" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText(/"kind": "text"/)).toBeNull();

    fireEvent.click(trigger);
    const content = document.getElementById(trigger.getAttribute("aria-controls")!);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(content).toBeVisible();
    expect(content?.textContent).toBe(JSON.stringify({ kind: "text" }, null, 2));

    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(content).not.toBeVisible();
  });

  it("keeps separate detail controls independent with unique content ids", () => {
    render(<>{calls.map((call) => <ChatActionRow key={call.id} call={call} isStreaming={false} />)}</>);

    const [first, second] = screen.getAllByRole("button", { name: "agent.detail" });
    fireEvent.click(first);
    expect(first).toHaveAttribute("aria-expanded", "true");
    expect(second).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(second);
    expect(first.getAttribute("aria-controls")).toBeTruthy();
    expect(first.getAttribute("aria-controls")).not.toBe(second.getAttribute("aria-controls"));
  });

  it("retains the same focused round trigger when expanding and collapsing", () => {
    render(<ChatToolRound round={round(true)} isStreaming={false} />);

    const trigger = screen.getByRole("button", { name: "Operations 2" });
    trigger.focus();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(trigger);
    expect(screen.getByRole("button", { name: "Operations 2" })).toBe(trigger);
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Create", { exact: true })).toBeVisible();
    expect(screen.getByText("Connect", { exact: true })).toBeVisible();

    fireEvent.click(trigger);
    expect(screen.getByRole("button", { name: "Operations 2" })).toBe(trigger);
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("button", { name: "agent.detail" })).toBeNull();
  });

  it("expands pending operations and automatically collapses after completion", () => {
    const { rerender } = render(<ChatToolRound round={round(false)} isStreaming />);
    const trigger = screen.getByRole("button", { name: "Operations 2" });
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getAllByRole("button", { name: "agent.detail" })).toHaveLength(2);

    rerender(<ChatToolRound round={round(true)} isStreaming={false} />);
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("button", { name: "agent.detail" })).toBeNull();
  });

  it("keeps the user's collapse choice when streaming results arrive", () => {
    const { rerender } = render(<ChatToolRound round={round(false)} isStreaming />);
    const trigger = screen.getByRole("button", { name: "Operations 2" });
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    rerender(<ChatToolRound round={round(true)} isStreaming={false} />);
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getAllByRole("button", { name: "agent.detail" })).toHaveLength(2);
  });

  it("opens a nested result detail without toggling the outer round", () => {
    render(<ChatToolRound round={round(true)} isStreaming={false} />);
    const trigger = screen.getByRole("button", { name: "Operations 2" });
    fireEvent.click(trigger);
    fireEvent.click(screen.getAllByRole("button", { name: "agent.detail" })[0]);

    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Result c1", { selector: "pre", exact: true })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "common.collapse" }));
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getAllByRole("button", { name: "agent.detail" })).toHaveLength(2);
  });

  it("keeps an explicitly expanded round open after execution completes", () => {
    const { rerender } = render(<ChatToolRound round={round(false)} isStreaming />);
    const trigger = screen.getByRole("button", { name: "Operations 2" });
    fireEvent.click(trigger);
    fireEvent.click(trigger);

    rerender(<ChatToolRound round={round(true)} isStreaming={false} />);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getAllByRole("button", { name: "agent.detail" })).toHaveLength(2);
  });

  it("renders a single operation directly with an accessible detail control", () => {
    render(<ChatToolRound round={{ ...round(true), calls: [calls[0]] }} isStreaming={false} />);
    expect(screen.queryByRole("button", { name: /Operations/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "agent.detail" }));
    expect(screen.getByText("Result c1", { selector: "pre", exact: true })).toBeVisible();
  });
});
