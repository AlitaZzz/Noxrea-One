/**
 * Agent 会话创建门闸测试。
 *
 * 建模背景：ensureSession 在「await createSession 期间被 newChat / 切项目 / 切会话
 * 重置」时，旧版逻辑只检查 current 是否被"别人设置"，无法识别"已被重置为 null"，
 * 会把旧世代创建的孤儿会话挂到新对话上；同时并发两次 ensureSession 会各创建一个
 * 重复会话。修复方案：世代令牌 + 单飞。
 *
 * 本测试先针对旧逻辑的忠实移植证明缺陷存在（重现 bug，4 红），修复后必须全绿。
 */

import { describe, expect, it, vi } from "vitest";

import { createSessionGate } from "@/features/canvas/agent/hooks/session-gate";

const session = (id: number) => ({ id, title: `s${id}` });

describe("session-gate 基线", () => {
  it("首次 ensure 调用 createSession 并挂载", async () => {
    const createSession = vi.fn().mockResolvedValue(session(7));
    const gate = createSessionGate();

    const ref = await gate.ensure(createSession);
    expect(ref?.id).toBe(7);
    expect(gate.current?.id).toBe(7);
    expect(createSession).toHaveBeenCalledTimes(1);
  });

  it("current 已存在时直接返回，不再创建", async () => {
    const createSession = vi.fn().mockResolvedValue(session(7));
    const gate = createSessionGate();
    gate.adopt({ id: 3, title: "old" });

    const ref = await gate.ensure(createSession);
    expect(ref?.id).toBe(3);
    expect(createSession).not.toHaveBeenCalled();
  });

  it("reset 清空 current，下次 ensure 重新创建", async () => {
    const createSession = vi
      .fn()
      .mockResolvedValueOnce(session(7))
      .mockResolvedValueOnce(session(9));
    const gate = createSessionGate();
    await gate.ensure(createSession);

    gate.reset();
    expect(gate.current).toBeNull();

    const ref = await gate.ensure(createSession);
    expect(ref?.id).toBe(9);
  });
});

describe("session-gate 竞态修复", () => {
  it("并发两次 ensure：单飞，只创建一次，拿到同一会话", async () => {
    let resolveCreate!: (s: { id: number; title?: string | null }) => void;
    const createSession = vi.fn(
      () => new Promise<{ id: number; title?: string | null }>((r) => (resolveCreate = r))
    );
    const gate = createSessionGate();

    const a = gate.ensure(createSession);
    const b = gate.ensure(createSession);
    resolveCreate(session(7));

    expect(createSession).toHaveBeenCalledTimes(1);
    expect((await a)?.id).toBe(7);
    expect((await b)?.id).toBe(7);
  });

  it("ensure 在途期间 reset：不得把旧世代孤儿会话挂到新对话", async () => {
    let resolveCreate!: (s: { id: number; title?: string | null }) => void;
    const createSession = vi.fn(
      () => new Promise<{ id: number; title?: string | null }>((r) => (resolveCreate = r))
    );
    const gate = createSessionGate();

    const pending = gate.ensure(createSession);
    gate.reset(); // 等待期间用户开了新对话
    resolveCreate(session(7));

    expect(await pending).toBeNull();
    expect(gate.current).toBeNull();
  });

  it("ensure 在途期间 adopt 其他会话：不覆盖已切换的会话", async () => {
    let resolveCreate!: (s: { id: number; title?: string | null }) => void;
    const createSession = vi.fn(
      () => new Promise<{ id: number; title?: string | null }>((r) => (resolveCreate = r))
    );
    const gate = createSessionGate();

    const pending = gate.ensure(createSession);
    gate.adopt({ id: 5, title: "switched" });
    resolveCreate(session(7));

    expect(await pending).toBeNull();
    expect(gate.current?.id).toBe(5);
  });

  it("孤儿会话放弃挂载后，单飞槽位清空，新世代 ensure 可正常创建", async () => {
    const resolvers: Array<(s: { id: number; title?: string | null }) => void> = [];
    const createSession = vi.fn(
      () => new Promise<{ id: number; title?: string | null }>((r) => resolvers.push(r))
    );
    const gate = createSessionGate();

    const first = gate.ensure(createSession, "t1");
    gate.reset();
    resolvers[0](session(7));
    expect(await first).toBeNull();

    const second = gate.ensure(createSession, "t2");
    resolvers[1](session(9));
    expect((await second)?.id).toBe(9);
    expect(createSession).toHaveBeenCalledTimes(2);
  });

  it("旧世代创建在途时新世代 ensure 到达：不共享注定放弃的槽位，独立创建", async () => {
    const resolvers: Array<(s: { id: number; title?: string | null }) => void> = [];
    const createSession = vi.fn(
      () => new Promise<{ id: number; title?: string | null }>((r) => resolvers.push(r))
    );
    const gate = createSessionGate();

    const first = gate.ensure(createSession);
    gate.reset(); // 切项目 / 新对话
    const second = gate.ensure(createSession);
    expect(createSession).toHaveBeenCalledTimes(2);

    resolvers[1](session(9));
    expect((await second)?.id).toBe(9);
    expect(gate.current?.id).toBe(9);

    // 旧世代照常放弃
    resolvers[0](session(7));
    expect(await first).toBeNull();
    expect(gate.current?.id).toBe(9);
  });
});
