/**
 * history-store version 计数测试：任何改变栈的动作都 +1（单调递增），
 * 供回合撤销按钮判定记录有效性。
 */
import { beforeEach, describe, expect, it } from "vitest";

import { useHistoryStore } from "@/features/canvas/stores/history-store";

const snap = (label: string) => ({ label }) as never;

describe("useHistoryStore version", () => {
  beforeEach(() => {
    useHistoryStore.getState().clear();
  });

  it("push / undo / redo 各 +1", () => {
    const v0 = useHistoryStore.getState().version;
    const s = useHistoryStore.getState();
    s.push(snap("a"));
    expect(useHistoryStore.getState().version).toBe(v0 + 1);
    const restored = useHistoryStore.getState().undo(snap("live"));
    expect(restored).not.toBeNull();
    expect(useHistoryStore.getState().version).toBe(v0 + 2);
    useHistoryStore.getState().redo(snap("live2"));
    expect(useHistoryStore.getState().version).toBe(v0 + 3);
  });

  it("popIfTop 成功 +1，失败不变", () => {
    const v0 = useHistoryStore.getState().version;
    const s = useHistoryStore.getState();
    const a = snap("a");
    s.push(a);
    expect(useHistoryStore.getState().version).toBe(v0 + 1);
    const foreign = snap("foreign");
    expect(useHistoryStore.getState().popIfTop(foreign)).toBe(false);
    expect(useHistoryStore.getState().version).toBe(v0 + 1);
    expect(useHistoryStore.getState().popIfTop(a)).toBe(true);
    expect(useHistoryStore.getState().version).toBe(v0 + 2);
  });

  it("clear 也 +1（清空撤销记录后按钮应失效）", () => {
    const s = useHistoryStore.getState();
    s.push(snap("a"));
    const before = useHistoryStore.getState().version;
    s.clear();
    expect(useHistoryStore.getState().version).toBe(before + 1);
  });
});
