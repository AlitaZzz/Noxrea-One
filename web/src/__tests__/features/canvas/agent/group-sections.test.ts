/**
 * groupSections 分组规则测试：
 * - user 开新回合；assistant 带工具调用 → round；纯文字 → texts
 * - tool 按 toolCallId 归 round；system → confirmResult
 * - 旧消息（无 turnId）独立回合；message_user 调用不渲染操作行
 */
import { describe, expect, it } from "vitest";

import { groupSections } from "@/features/canvas/agent/utils/group-sections";
import type { ChatMessage } from "@/features/canvas/agent/types";

function user(id: string, content: string, turnId?: string): ChatMessage {
  return { id, role: "user", content, ...(turnId ? { turnId } : {}) };
}

function assistant(
  id: string,
  content: string,
  toolCalls?: ChatMessage["toolCalls"],
  turnId?: string
): ChatMessage {
  return { id, role: "assistant", content, ...(toolCalls ? { toolCalls } : {}), ...(turnId ? { turnId } : {}) };
}

function tool(id: string, toolCallId: string, content = "ok", failed?: boolean): ChatMessage {
  return { id, role: "tool", content, toolCallId, ...(failed !== undefined ? { failed } : {}) };
}

describe("groupSections", () => {
  it("用户消息开启新回合，工具轮次与文字归入同一回合", () => {
    const messages: ChatMessage[] = [
      user("u1", "画三个节点", "t1"),
      assistant("a1", "", [
        { id: "c1", name: "create_node", args: "{}" },
      ], "t1"),
      tool("r1", "c1"),
      assistant("a2", "已完成", undefined, "t1"),
    ];
    const sections = groupSections(messages);
    expect(sections).toHaveLength(1);
    expect(sections[0].turnId).toBe("t1");
    expect(sections[0].userMsg?.id).toBe("u1");
    expect(sections[0].rounds).toHaveLength(1);
    expect(sections[0].rounds[0].calls).toHaveLength(1);
    expect(sections[0].rounds[0].results.get("c1")?.content).toBe("ok");
    expect(sections[0].texts.map((m) => m.id)).toEqual(["a2"]);
  });

  it("多轮工具调用按 assistant 消息拆成多个 round，tool 结果各归其位", () => {
    const messages: ChatMessage[] = [
      user("u1", "hi", "t1"),
      assistant("a1", "", [{ id: "c1", name: "create_node", args: "{}" }], "t1"),
      tool("r1", "c1"),
      assistant("a2", "", [{ id: "c2", name: "connect_nodes", args: "{}" }], "t1"),
      tool("r2", "c2", "ok", true),
    ];
    const sections = groupSections(messages);
    expect(sections).toHaveLength(1);
    expect(sections[0].rounds).toHaveLength(2);
    expect(sections[0].rounds[0].results.has("c1")).toBe(true);
    expect(sections[0].rounds[1].results.get("c2")?.failed).toBe(true);
  });

  it("system 消息写入 confirmResult", () => {
    const messages: ChatMessage[] = [
      user("u1", "删掉", "t1"),
      { id: "s1", role: "system", content: "", turnId: "t1", confirmResult: { approved: true, executedCount: 2, skippedCount: 1 } },
    ];
    const sections = groupSections(messages);
    expect(sections[0].confirmResult?.approved).toBe(true);
    expect(sections[0].confirmResult?.executedCount).toBe(2);
  });

  it("message_user 调用不出现在操作行里", () => {
    const messages: ChatMessage[] = [
      user("u1", "hi", "t1"),
      assistant("a1", "总结", [
        { id: "m1", name: "message_user", args: "{}" },
      ], "t1"),
    ];
    const sections = groupSections(messages);
    expect(sections[0].rounds).toHaveLength(0);
    expect(sections[0].texts.map((m) => m.id)).toEqual(["a1"]);
  });

  it("无 turnId 的旧消息：user 开回合，tool 结果尽力归入对应 round", () => {
    const messages: ChatMessage[] = [
      user("u1", "旧消息"),
      assistant("a1", "", [{ id: "c1", name: "create_node", args: "{}" }]),
      tool("r1", "c1"),
      assistant("a2", "旧回复"),
      user("u2", "另一轮旧消息"),
    ];
    const sections = groupSections(messages);
    expect(sections).toHaveLength(2);
    expect(sections.every((s) => s.turnId === null)).toBe(true);
    expect(sections[0].rounds).toHaveLength(1);
    expect(sections[0].rounds[0].results.has("c1")).toBe(true);
    expect(sections[0].texts.map((m) => m.id)).toEqual(["a2"]);
    expect(sections[1].userMsg?.id).toBe("u2");
  });

  it("空 assistant 占位（无内容无调用）标记 thinking", () => {
    const messages: ChatMessage[] = [
      user("u1", "hi", "t1"),
      assistant("a1", "", undefined, "t1"),
    ];
    const sections = groupSections(messages);
    expect(sections[0].thinking).toBe(true);
  });
});
