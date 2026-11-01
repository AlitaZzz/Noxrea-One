import { describe, expect, it, vi } from "vitest";

import { applySelection, updateSelection } from "@/features/canvas/shared/selection";

interface Item {
  id: string;
  selected?: boolean;
}

describe("updateSelection", () => {
  it("选区未变时返回原数组（引用相等）", () => {
    const items: Item[] = [{ id: "a", selected: true }, { id: "b", selected: false }];
    expect(updateSelection(items, (item) => item.id === "a")).toBe(items);
  });

  it("只克隆选中态变化的条目，其余条目保持引用", () => {
    const a: Item = { id: "a" };
    const b: Item = { id: "b", selected: true };
    const c: Item = { id: "c" };
    const next = updateSelection([a, b, c], (item) => item.id === "a");

    // 新选中的节点：必须是新对象，React Flow 才能看到 selected 变化
    expect(next[0]).not.toBe(a);
    expect(next[0]).toEqual({ id: "a", selected: true });
    // 被取消选中的节点：同样换成新对象
    expect(next[1]).not.toBe(b);
    expect(next[1]).toEqual({ id: "b", selected: false });
    // 选中态未变的节点保持原引用：React Flow 复用内部实例，不重渲染
    expect(next[2]).toBe(c);
  });

  it("以选中态而非键是否存在判定：undefined 视为未选中", () => {
    const items: Item[] = [{ id: "a" }, { id: "b", selected: false }];
    expect(updateSelection(items, () => false)).toBe(items);
  });

  it("空数组同样返回原引用", () => {
    const items: Item[] = [];
    expect(updateSelection(items, () => true)).toBe(items);
  });

  it("全选时只克隆尚未选中的条目", () => {
    const a: Item = { id: "a", selected: true };
    const b: Item = { id: "b" };
    const next = updateSelection([a, b], () => true);
    expect(next[0]).toBe(a);
    expect(next[1]).toEqual({ id: "b", selected: true });
  });
});

describe("applySelection", () => {
  it("选区未变时不写入，返回 false", () => {
    const items: Item[] = [{ id: "a", selected: true }];
    const write = vi.fn();
    expect(applySelection(items, (item) => item.id === "a", write)).toBe(false);
    expect(write).not.toHaveBeenCalled();
  });

  it("选区变化时写入新数组并返回 true", () => {
    const items: Item[] = [{ id: "a" }, { id: "b", selected: true }];
    const write = vi.fn();
    expect(applySelection(items, (item) => item.id === "a", write)).toBe(true);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0][0]).toEqual([
      { id: "a", selected: true },
      { id: "b", selected: false },
    ]);
  });
});
