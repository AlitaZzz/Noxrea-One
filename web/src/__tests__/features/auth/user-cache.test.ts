/**
 * 用户 cookie 缓存的契约收口测试。
 * 锁定：toUserInfo 只保留契约字段（服务端新增的 email/role/displayName 不透传）；
 * parseUserCookie 把 cookie 当作不可信输入，字段类型不符一律视为无缓存、不补默认值。
 */
import { describe, expect, it } from "vitest";

import { parseUserCookie, toUserInfo } from "@/features/auth/user-cache";

import { PUBLIC_USER } from "./fixtures";

const CONTRACT = { id: 1, username: "alice", avatarUrl: "/a.png", theme: "light", language: "en" };
const encode = (value: unknown) => encodeURIComponent(JSON.stringify(value));

describe("toUserInfo 转换", () => {
  it("只保留契约字段，email/role/displayName 等不透传", () => {
    const info = toUserInfo(PUBLIC_USER);
    expect(info).toEqual(CONTRACT);
    expect(JSON.stringify(info)).not.toContain("email");
    expect(JSON.stringify(info)).not.toContain("role");
  });
});

describe("parseUserCookie 严格校验", () => {
  it("合法 cookie 原样还原（avatarUrl 允许为 null）", () => {
    expect(parseUserCookie(encode(CONTRACT))).toEqual(CONTRACT);
    expect(parseUserCookie(encode({ ...CONTRACT, avatarUrl: null }))).toEqual({ ...CONTRACT, avatarUrl: null });
  });

  it("多余字段不透传", () => {
    expect(parseUserCookie(encode(PUBLIC_USER))).toEqual(CONTRACT);
  });

  it("任一契约字段缺失或类型不符返回 null，不补默认值", () => {
    expect(parseUserCookie(encode({ id: 2, username: "bob" }))).toBeNull();
    expect(parseUserCookie(encode({ ...CONTRACT, id: "1" }))).toBeNull();
    expect(parseUserCookie(encode({ ...CONTRACT, avatarUrl: 5 }))).toBeNull();
    expect(parseUserCookie(encode({ ...CONTRACT, theme: 1 }))).toBeNull();
    expect(parseUserCookie(encode({ ...CONTRACT, language: null }))).toBeNull();
  });

  it("空值、非 JSON、数组与非对象返回 null", () => {
    expect(parseUserCookie(undefined)).toBeNull();
    expect(parseUserCookie("")).toBeNull();
    expect(parseUserCookie(encodeURIComponent("not-json"))).toBeNull();
    expect(parseUserCookie(encode([1, "alice"]))).toBeNull();
    expect(parseUserCookie(encode(null))).toBeNull();
    expect(parseUserCookie(encode("garbage"))).toBeNull();
  });
});
