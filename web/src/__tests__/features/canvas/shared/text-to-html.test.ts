/**
 * textToTiptapHtml 单源回归测试。
 * 锁定三处调用（SSE 回填 / Agent 写入 / 剪贴板粘贴）统一后的语义：
 * 转义集合含双引号、<br> 写法、空行分段、空段不滤除（基准=剪贴板粘贴分支）。
 */
import { describe, expect, it } from "vitest";

import { textToTiptapHtml } from "@/features/canvas/shared/text-to-html";

describe("textToTiptapHtml", () => {
  it("转义 HTML 特殊字符（含双引号）", () => {
    expect(textToTiptapHtml('<b> & "x"')).toBe("<p>&lt;b&gt; &amp; &quot;x&quot;</p>");
  });

  it("段内单换行转 <br>", () => {
    expect(textToTiptapHtml("a\nb")).toBe("<p>a<br>b</p>");
  });

  it("空行分段为多个 <p>", () => {
    expect(textToTiptapHtml("p1\n\np2")).toBe("<p>p1</p><p>p2</p>");
  });

  it("尾随空段不滤除（统一后与粘贴分支一致，此前 monitor 版返回空串）", () => {
    expect(textToTiptapHtml("hi\n\n")).toBe("<p>hi</p><p></p>");
  });

  it("统一后使用 <br>（此前 monitor 版为 <br/>）", () => {
    expect(textToTiptapHtml("a\nb")).not.toContain("<br/>");
  });

  it("空串产出空段落序列", () => {
    expect(textToTiptapHtml("")).toBe("<p></p>");
  });
});
