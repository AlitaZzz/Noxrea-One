import { describe, expect, it } from "vitest";

import {
  parseJsonArray,
  parseJsonObject,
  parseJsonObjectArray,
  stringifyJson,
} from "@server/crud/json-column";

describe("json-column", () => {
  it("对象列：合法对象原样返回", () => {
    expect(parseJsonObject('{"nodes":[],"viewport":{"x":1}}')).toEqual({
      nodes: [],
      viewport: { x: 1 },
    });
  });

  it("对象列：null / 数组 / 标量形状不符时降级为空对象", () => {
    expect(parseJsonObject("null")).toEqual({});
    expect(parseJsonObject("[]")).toEqual({});
    expect(parseJsonObject("42")).toEqual({});
  });

  it("数组列：合法数组原样返回，非数组形状降级为空数组", () => {
    expect(parseJsonArray('["a","b"]')).toEqual(["a", "b"]);
    expect(parseJsonArray("null")).toEqual([]);
    expect(parseJsonArray("{}")).toEqual([]);
    expect(parseJsonObjectArray<{ id: number }>('{"id":1}')).toEqual([]);
  });

  it("非法 JSON、缺失值与非字符串降级为空值", () => {
    expect(parseJsonObject("{")).toEqual({});
    expect(parseJsonObject(null)).toEqual({});
    expect(parseJsonArray(undefined)).toEqual([]);
  });

  it("stringifyJson 序列化对象与数组", () => {
    expect(stringifyJson({ a: 1 })).toBe('{"a":1}');
    expect(stringifyJson([1, 2])).toBe("[1,2]");
  });
});
