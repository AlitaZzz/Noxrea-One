/**
 * shared/url.ts 存储引用值域契约测试。
 * 锁定三个单点规则的输入输出：key 严格形态判别、key → hash 提取、
 * 入库值域（key 或外部 http(s) URL）——资产 fileKey / 头像 avatarKey
 * 的 schema 校验与 crud 层 fail-closed 防线共用这些实现。
 */
import { describe, expect, it } from "vitest";

import {
  hashFromStorageKey,
  isExternalFileUrl,
  isFileRefValue,
  isStorageKey,
} from "@noxrea/shared/url";

const HASH_A = "a".repeat(64);
const key = (hash: string, ext = ".png") => `1/${hash.slice(0, 2)}/${hash}${ext}`;

describe("isStorageKey / hashFromStorageKey（key 严格形态）", () => {
  it("合法 key 判定为 true，并提取末段扩展名前的 64 位 hash", () => {
    expect(isStorageKey(key(HASH_A))).toBe(true);
    expect(isStorageKey(key(HASH_A, ""))).toBe(true);
    expect(isStorageKey(key(HASH_A, ".webp"))).toBe(true);
    expect(hashFromStorageKey(key(HASH_A))).toBe(HASH_A);
    expect(hashFromStorageKey(key(HASH_A, ".webp"))).toBe(HASH_A);
  });

  it("旧托管 URL 形态、伪造段与非法值一律拒绝", () => {
    expect(isStorageKey(`/api/files/1/aa/${HASH_A}.png`)).toBe(false);
    expect(isStorageKey(`1/zz/${HASH_A}.png`)).toBe(false);
    expect(isStorageKey(`1/aa/${"g".repeat(64)}.png`)).toBe(false);
    expect(hashFromStorageKey(`/api/files/1/aa/${HASH_A}.png`)).toBeNull();
    expect(hashFromStorageKey(`1/zz/${HASH_A}.png`)).toBeNull();
    expect(hashFromStorageKey(`1/aa/${"g".repeat(64)}.png`)).toBeNull();
    expect(hashFromStorageKey("https://example.com/a.png")).toBeNull();
  });
});

describe("isFileRefValue（入库值域：key 或外部 http(s) URL）", () => {
  it("存储 key 与外部 http(s) URL 均在值域内", () => {
    expect(isFileRefValue(key(HASH_A))).toBe(true);
    expect(isFileRefValue("https://example.com/a.png")).toBe(true);
    expect(isFileRefValue("http://example.com/a.png")).toBe(true);
  });

  it("data: / blob: / 相对路径 / 旧托管 URL 形态 / 空串不在入库值域", () => {
    expect(isFileRefValue("data:image/png;base64,AAAA")).toBe(false);
    expect(isFileRefValue("blob:https://example.com/uuid")).toBe(false);
    expect(isFileRefValue("/uploads/a.png")).toBe(false);
    expect(isFileRefValue(`/api/files/1/aa/${HASH_A}.png`)).toBe(false);
    expect(isFileRefValue("")).toBe(false);
  });

  it("isExternalFileUrl 仅认 http(s)", () => {
    expect(isExternalFileUrl("https://example.com/a.png")).toBe(true);
    expect(isExternalFileUrl("HTTPS://EXAMPLE.COM/A.PNG")).toBe(true);
    expect(isExternalFileUrl("data:image/png;base64,AAAA")).toBe(false);
    expect(isExternalFileUrl(key(HASH_A))).toBe(false);
  });
});
