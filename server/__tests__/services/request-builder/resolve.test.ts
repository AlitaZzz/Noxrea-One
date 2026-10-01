/**
 * resolve 纯函数单元测试。
 * 锁定槽位派生（refMode → first/last/full）、kind 组装、transform 换算与嵌套写入。
 */
import { describe, expect, it } from "vitest";

import {
  applyTransform,
  resolveByKind,
  resolveRefSlots,
  setNested,
  type RefSlots,
} from "@server/services/request-builder/resolve";

const slots = (o: Partial<RefSlots> = {}): RefSlots => ({
  firstFrame: null,
  lastFrame: null,
  refImages: [],
  ...o,
});

describe("resolveRefSlots", () => {
  it("image 能力：无首尾帧语义，全量参考", () => {
    expect(resolveRefSlots("first-last", ["a", "b"], "image")).toEqual({
      firstFrame: null,
      lastFrame: null,
      refImages: ["a", "b"],
    });
  });

  it("video 按模式取位：image 取首帧、first-last 取首尾、full 全量、text 清空", () => {
    expect(resolveRefSlots("image", ["a", "b"], "video")).toEqual({
      firstFrame: "a", lastFrame: null, refImages: ["a", "b"],
    });
    expect(resolveRefSlots("first-last", ["a", "b"], "video")).toEqual({
      firstFrame: "a", lastFrame: "b", refImages: ["a", "b"],
    });
    expect(resolveRefSlots("full", ["a"], "video")).toEqual({
      firstFrame: null, lastFrame: null, refImages: ["a"],
    });
    expect(resolveRefSlots("text", ["a"], "video")).toEqual({
      firstFrame: null, lastFrame: null, refImages: [],
    });
  });
});

describe("resolveByKind", () => {
  it("role:first-last 输出带角色对象数组", () => {
    const [field, value] = resolveByKind(
      { field: "image_with_roles", kind: "role:first-last" },
      slots({ firstFrame: "a", lastFrame: "b" }),
    );
    expect(field).toBe("image_with_roles");
    expect(value).toEqual([
      { url: "a", role: "first_frame" },
      { url: "b", role: "last_frame" },
    ]);
  });

  it("slot:first / slot:last 取单值", () => {
    expect(resolveByKind({ field: "first_frame", kind: "slot:first" }, slots({ firstFrame: "a" }))[1]).toBe("a");
    expect(resolveByKind({ field: "last_frame", kind: "slot:last" }, slots({ lastFrame: "b" }))[1]).toBe("b");
    expect(resolveByKind({ field: "first_frame", kind: "slot:first" }, slots())[1]).toBeUndefined();
  });

  it("array / single / array[].k 组装", () => {
    const s = slots({ refImages: ["a", "b"] });
    expect(resolveByKind({ field: "image_urls", kind: "array" }, s)[1]).toEqual(["a", "b"]);
    expect(resolveByKind({ field: "image", kind: "single" }, s)[1]).toBe("a");
    expect(resolveByKind({ field: "images", kind: "array[].url" }, s)[1]).toEqual([{ url: "a" }, { url: "b" }]);
  });
});

describe("applyTransform", () => {
  it("stringify 转字符串", () => {
    expect(applyTransform({ type: "stringify" }, 5, {})).toBe("5");
  });

  it("wrap 包装对象数组", () => {
    expect(applyTransform({ type: "wrap", key: "url" }, ["v1", "v2"], {})).toEqual([
      { url: "v1" }, { url: "v2" },
    ]);
  });

  it("map 命中换算、未命中保留原值", () => {
    const t = { type: "map" as const, table: { text: "t2t" } };
    expect(applyTransform(t, "text", {})).toBe("t2t");
    expect(applyTransform(t, "other", {})).toBe("other");
  });

  it("lookup 组合查表大小写归一、未命中丢弃字段", () => {
    const t = {
      type: "lookup" as const,
      composite: ["ratio", "resolution"],
      table: { "1:1|1k": "1024x1024", "16:9|2K": "2048x1152" },
    };
    expect(applyTransform(t, "", { ratio: "1:1", resolution: "1k" })).toBe("1024x1024");
    expect(applyTransform(t, "", { ratio: "16:9", resolution: "2k" })).toBe("2048x1152");
    expect(applyTransform(t, "", { ratio: "5:4", resolution: "1k" })).toBeUndefined();
  });

  it("ratio 像素尺寸反推比例", () => {
    expect(applyTransform({ type: "ratio" }, "1024x1024", {})).toBe("1:1");
    expect(applyTransform({ type: "ratio" }, "2048x1152", {})).toBe("16:9");
    expect(applyTransform({ type: "ratio" }, "not-a-size", {})).toBe("not-a-size");
  });
});

describe("setNested", () => {
  it("写入嵌套路径并复用中间对象", () => {
    const out: Record<string, unknown> = {};
    setNested(out, "a.b.c", 1);
    expect(out).toEqual({ a: { b: { c: 1 } } });
  });

  it("顶层键直接写入", () => {
    const out: Record<string, unknown> = {};
    setNested(out, "size", "16:9");
    expect(out).toEqual({ size: "16:9" });
  });
});
