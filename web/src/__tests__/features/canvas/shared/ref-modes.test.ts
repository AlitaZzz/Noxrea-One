/**
 * shared/ref-modes 纯函数测试：参考方式可用范围推导与收敛规则。
 * 该模块是视频生成面板与画布 Agent 参数校验的共用规则源。
 */
import { describe, expect, it } from "vitest";

import { allowedRefModesFor, deriveAllowedRefModes, resolveRefMode } from "@/features/canvas/shared/ref-modes";
import type { AnyNode } from "@/features/canvas/types";
import { NODE_TYPE } from "@/lib/constants";

describe("deriveAllowedRefModes", () => {
  const live = (images = 0, videos = 0, audios = 0) => ({
    refOrder: Array.from({ length: images }, (_, i) => `img-${i}`),
    refAudioOrder: Array.from({ length: audios }, (_, i) => `aud-${i}`),
    refVideoOrder: Array.from({ length: videos }, (_, i) => `vid-${i}`),
  });

  it("无参考 → 只能文生视频", () => {
    expect(deriveAllowedRefModes(live())).toEqual(["text"]);
  });

  it("1 张图 → 图生/全能", () => {
    expect(deriveAllowedRefModes(live(1))).toEqual(["image", "full"]);
  });

  it("2 张图 → 首尾帧/全能", () => {
    expect(deriveAllowedRefModes(live(2))).toEqual(["first-last", "full"]);
  });

  it("≥3 张图 → 仅全能", () => {
    expect(deriveAllowedRefModes(live(3))).toEqual(["full"]);
  });

  it("有视频或音频参考 → 仅全能", () => {
    expect(deriveAllowedRefModes(live(1, 0, 1))).toEqual(["full"]);
    expect(deriveAllowedRefModes(live(0, 1, 0))).toEqual(["full"]);
  });
});

describe("resolveRefMode", () => {
  const ALL = ["text", "image", "first-last", "full"];

  it("desired 合法（模型与参考都允许）→ 原样保留无说明", () => {
    expect(resolveRefMode("image", ALL, ["image", "full"])).toEqual({ value: "image", note: null });
  });

  it("desired 不在上游参考范围 → 收敛到 full 并说明", () => {
    const r = resolveRefMode("first-last", ALL, ["image", "full"]);
    expect(r.value).toBe("full");
    expect(r.note).toContain("当前上游参考不支持 first-last");
  });

  it("desired 不在模型能力声明 → 收敛并说明模型不支持", () => {
    const r = resolveRefMode("first-last", ["image", "full"], ["first-last", "full"]);
    expect(r.value).toBe("full");
    expect(r.note).toContain("当前模型不支持 first-last");
  });

  it("desired 非标准值 → 收敛并说明无效", () => {
    const r = resolveRefMode("whatever", ALL, ["full"]);
    expect(r.value).toBe("full");
    expect(r.note).toContain("whatever 不是有效的参考方式");
  });

  it("模型未声明选项（空数组）→ 只受上游参考约束", () => {
    expect(resolveRefMode("image", [], ["image", "full"])).toEqual({ value: "image", note: null });
    expect(resolveRefMode("image", [], ["text"]).value).toBe("text");
  });

  it("full 被模型排除但有其他合法项 → 收敛到该合法项", () => {
    const r = resolveRefMode("text", ["image"], ["image", "full"]);
    expect(r.value).toBe("image");
    expect(r.note).toContain("当前模型不支持 text");
  });

  it("无交集且参考只允许 text → 回退 text", () => {
    expect(resolveRefMode("full", ["image"], ["text"]).value).toBe("text");
  });

  it("desired 未提供 → 直接给回退值", () => {
    expect(resolveRefMode(undefined, ALL, ["image", "full"])).toEqual({ value: "full", note: null });
  });

  it("幂等：收敛结果再次收敛不再变化", () => {
    const first = resolveRefMode("first-last", ALL, ["image", "full"]);
    const second = resolveRefMode(first.value, ALL, ["image", "full"]);
    expect(second).toEqual({ value: first.value, note: null });
  });
});

describe("allowedRefModesFor", () => {
  const node = (id: string, type: string, src?: string): AnyNode =>
    ({ id, type, data: src ? { src } : {} }) as unknown as AnyNode;

  it("按连线统计上游参考推导可用范围", () => {
    const nodes = [
      node("img1", NODE_TYPE.IMAGE, "a.png"),
      node("img2", NODE_TYPE.IMAGE, "b.png"),
      node("img-nosrc", NODE_TYPE.IMAGE), // 无 src 不计数
      node("vid1", NODE_TYPE.VIDEO, "c.mp4"),
    ];
    const edges = [
      { source: "img1", target: "video1" },
      { source: "img2", target: "video1" },
      { source: "img-nosrc", target: "video1" },
      { source: "vid1", target: "video1" },
    ];
    // 图片 2 张但存在视频参考 → 仅全能
    expect(allowedRefModesFor("video1", nodes, edges)).toEqual(["full"]);
  });

  it("1 张有 src 的图片上游 → 图生/全能", () => {
    const nodes = [node("img1", NODE_TYPE.IMAGE, "a.png")];
    expect(allowedRefModesFor("video1", nodes, [{ source: "img1", target: "video1" }])).toEqual(["image", "full"]);
  });

  it("只有文本上游 → 只能文生视频", () => {
    const nodes = [node("txt1", NODE_TYPE.TEXT)];
    expect(allowedRefModesFor("video1", nodes, [{ source: "txt1", target: "video1" }])).toEqual(["text"]);
  });

  it("无上游 → 只能文生视频", () => {
    expect(allowedRefModesFor("video1", [], [])).toEqual(["text"]);
  });
});
