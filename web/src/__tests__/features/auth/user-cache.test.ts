/**
 * 用户 cookie 缓存的契约收口测试。
 * 锁定 toUserInfo 投影：服务端新增字段（email/role/displayName 等）不得进入
 * 持久 cookie；历史 cookie 中已泄漏的字段在读入时被剥离。
 */
import { describe, expect, it } from "vitest";

import { parseUserCookie, toUserInfo } from "@/features/auth/user-cache";

import { PUBLIC_USER } from "./fixtures";

describe("toUserInfo 投影", () => {
  it("只保留 cookie 契约字段，email/role/displayName 等不落入结果", () => {
    const info = toUserInfo(PUBLIC_USER);
    expect(info).toEqual({
      id: 1,
      username: "alice",
      avatarUrl: "/a.png",
      theme: "light",
      language: "en",
    });
    expect(JSON.stringify(info)).not.toContain("email");
    expect(JSON.stringify(info)).not.toContain("role");
  });

  it("可选字段缺失或类型不对时补默认值（avatarUrl null / theme dark / language zh）", () => {
    expect(toUserInfo({ id: 2, username: "bob" })).toEqual({
      id: 2, username: "bob", avatarUrl: null, theme: "dark", language: "zh",
    });
    expect(toUserInfo({ id: 2, username: "bob", avatarUrl: 5, theme: 1, language: null })).toEqual({
      id: 2, username: "bob", avatarUrl: null, theme: "dark", language: "zh",
    });
  });

  it("结构不对（缺 id/username）、数组与非对象输入返回 null", () => {
    expect(toUserInfo({ username: "no-id" })).toBeNull();
    // 数组可被 typeof 判为 object 且索引访问合法：必须显式拒绝，否则产出假 UserInfo
    expect(toUserInfo([1, "alice"])).toBeNull();
    expect(toUserInfo(null)).toBeNull();
    expect(toUserInfo("garbage")).toBeNull();
  });
});

describe("parseUserCookie 收口", () => {
  it("历史泄漏字段在解析时被剥离", () => {
    const leaked = encodeURIComponent(JSON.stringify(PUBLIC_USER));
    expect(parseUserCookie(leaked)).toEqual({
      id: 1, username: "alice", avatarUrl: "/a.png", theme: "light", language: "en",
    });
  });

  it("非法内容返回 null", () => {
    expect(parseUserCookie(undefined)).toBeNull();
    expect(parseUserCookie(encodeURIComponent("not-json"))).toBeNull();
    expect(parseUserCookie(encodeURIComponent('{"username":1}'))).toBeNull();
  });
});
