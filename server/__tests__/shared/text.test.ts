import { describe, expect, it } from "vitest";

import { truncateUtf16, wellFormedUtf16 } from "@noxrea/shared/text";

describe("truncateUtf16", () => {
  it("未超长原样返回", () => {
    expect(truncateUtf16("abcdef", 6)).toBe("abcdef");
    expect(truncateUtf16("abc", 10)).toBe("abc");
  });

  it("按 UTF-16 码元截断，不劈开代理对", () => {
    // "😀" 占 2 码元：切点落在代理对中间时少留 1 码元
    expect(truncateUtf16("ab😀c", 3)).toBe("ab");
    expect(truncateUtf16("ab😀c", 4)).toBe("ab😀");
    expect(truncateUtf16("😀😀", 3)).toBe("😀");
  });

  it("边界：0 与负数返回空串，非整數向下取整", () => {
    expect(truncateUtf16("abc", 0)).toBe("");
    expect(truncateUtf16("abc", -5)).toBe("");
    expect(truncateUtf16("abcd", 2.9)).toBe("ab");
  });

  it("截断结果永远 well-formed", () => {
    const value = "a".repeat(5) + "😀" + "b".repeat(5);
    for (let width = 0; width <= value.length; width += 1) {
      const cut = truncateUtf16(value, width);
      expect(cut).toBe(cut.toWellFormed());
      expect(() => encodeURIComponent(cut)).not.toThrow();
    }
  });

  it("入参已含孤立代理时原样保留（归一由 wellFormedUtf16 负责）", () => {
    expect(truncateUtf16("a\uD83Db", 3)).toBe("a\uD83Db");
  });
});

describe("wellFormedUtf16", () => {
  it("合法文本原样返回，成对代理保留", () => {
    expect(wellFormedUtf16("abc")).toBe("abc");
    expect(wellFormedUtf16("中文😀")).toBe("中文😀");
  });

  it("孤立代理替换为 U+FFFD", () => {
    expect(wellFormedUtf16("\uD83D")).toBe("�");
    expect(wellFormedUtf16("\uDE00")).toBe("�");
    expect(wellFormedUtf16("a\uD83Db")).toBe("a�b");
    expect(wellFormedUtf16("a\uDE00\uD83Db")).toBe("a��b");
  });

  it("成对代理跨切点、连续孤立代理与末尾孤立代理", () => {
    // 实现按码元扫描，不能把「高位 + 低位」拆开，也不能把整对误判为孤立代理
    expect(wellFormedUtf16("😀😀")).toBe("😀😀");
    expect(wellFormedUtf16("\uD83D\uD83D")).toBe("��"); // 两个连续高位代理各自孤立
    expect(wellFormedUtf16("\uDE00\uDE00")).toBe("��");
    expect(wellFormedUtf16("abc\uD83D")).toBe("abc�");
    expect(wellFormedUtf16("\uD83D😀")).toBe("�😀");
  });

  it("与原生 String.prototype.toWellFormed 语义一致（仅作测试 oracle，实现不依赖它）", () => {
    // 原生方法只在新版 Node 上存在；实现刻意不调用它（旧版 Firefox 缺失会导致下载抛错），
    // 这里用它交叉验证实现语义
    expect(typeof "".toWellFormed).toBe("function");
    for (const value of [
      "",
      "abc",
      "😀",
      "\uD83D",
      "\uDE00",
      "a\uD83D",
      "\uDE00a",
      "😀\uD83D😀",
      "\uD83D😀",
      "\uDE00\uD83D",
    ]) {
      expect(wellFormedUtf16(value), JSON.stringify(value)).toBe(value.toWellFormed());
    }
  });
});
