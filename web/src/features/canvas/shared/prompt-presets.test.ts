/**
 * 预设目录回归测试：
 * - textToDoc 语法制解析（令牌不依赖目录数据建 chip，修复目录晚到时令牌停留明文的 bug）
 * - filterCatalogByTarget 的 target 投影（镜像服务端过滤规则）
 */
import { describe, expect, it } from "vitest";

import { textToDoc } from "./MentionPrompt";
import { filterCatalogByTarget, type PromptTemplateCatalog } from "./prompt-presets";
import type { ReferenceItem } from "./reference";

const ref: ReferenceItem = {
  kind: "image",
  src: "/img/a.png",
  thumbnail: "/img/a.thumb.png",
  index: 0,
};

function mentionNodes(doc: ReturnType<typeof textToDoc>) {
  return doc.content!.flatMap((p) => p.content ?? []).filter((n) => n.type === "mention");
}

describe("textToDoc 预设令牌语法制", () => {
  it("令牌还原为 preset mention 节点（无目录输入）", () => {
    const doc = textToDoc("前置 @[preset:expand] 后置", [ref]);
    const mentions = mentionNodes(doc);
    expect(mentions).toHaveLength(1);
    expect(mentions[0].attrs).toEqual({ kind: "preset", presetId: "expand" });
  });

  it("未知 id 的令牌同样是 mention 节点（预设被删除的旧数据不留明文）", () => {
    const doc = textToDoc("@[preset:gone]", []);
    expect(mentionNodes(doc)[0].attrs).toEqual({ kind: "preset", presetId: "gone" });
  });

  it("素材 mention 解析不受影响", () => {
    const doc = textToDoc("图片1 @[preset:expand]", [ref]);
    const mentions = mentionNodes(doc);
    expect(mentions).toHaveLength(2);
    expect(mentions[0].attrs).toMatchObject({ kind: "image", src: "/img/a.png" });
    expect(mentions[1].attrs).toEqual({ kind: "preset", presetId: "expand" });
  });

  it("无引用时素材占位文本保持纯文本", () => {
    const doc = textToDoc("图片1", []);
    const nodes = doc.content!.flatMap((p) => p.content ?? []);
    expect(nodes.some((n) => n.type === "mention")).toBe(false);
  });
});

describe("filterCatalogByTarget", () => {
  const catalog: PromptTemplateCatalog = {
    groups: [
      { id: "g-both", label: { zh: "两用", en: "Both" }, order: 1 },
      { id: "g-text", label: { zh: "文本", en: "Text" }, order: 2 },
      { id: "g-image", label: { zh: "图片", en: "Image" }, order: 3 },
    ],
    entries: [
      { id: "img-1", kind: "preset", target: "image", group: "g-image", label: { zh: "一", en: "1" }, description: { zh: "", en: "" }, order: 1, template: "t" },
      { id: "txt-1", kind: "preset", target: "text", group: "g-both", label: { zh: "二", en: "2" }, description: { zh: "", en: "" }, order: 2, template: "t" },
      { id: "img-2", kind: "preset", target: "image", group: "g-both", label: { zh: "三", en: "3" }, description: { zh: "", en: "" }, order: 3, template: "t" },
    ],
  };

  it("条目按 target 过滤且保序，分组只保留含当前条目的", () => {
    const image = filterCatalogByTarget(catalog, "image");
    expect(image.entries.map((e) => e.id)).toEqual(["img-1", "img-2"]);
    expect(image.groups.map((g) => g.id)).toEqual(["g-both", "g-image"]);

    const text = filterCatalogByTarget(catalog, "text");
    expect(text.entries.map((e) => e.id)).toEqual(["txt-1"]);
    expect(text.groups.map((g) => g.id)).toEqual(["g-both"]);
  });
});
