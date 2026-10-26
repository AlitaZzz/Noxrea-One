/**
 * 存储 key 归属解析（specs/file-access-ownership.md 业务规则 3）：
 * 全命名空间归属可解析 + 畸形/旧形态一律 null（fail-closed）。
 */
import { describe, expect, it } from "vitest";
import { resolveKeyOwner } from "@server/services/storage/ownership";

const HASH = "ab".repeat(32); // 64 位十六进制
const UUID = "123e4567-e89b-12d3-a456-426614174000";

describe("resolveKeyOwner", () => {
  it("内容 key：首段即属主（含/不含扩展名）", () => {
    expect(resolveKeyOwner(`1/${HASH.slice(0, 2)}/${HASH}`)).toBe(1);
    expect(resolveKeyOwner(`999/${HASH.slice(0, 2)}/${HASH}.png`)).toBe(999);
    // userId 0 是合法结构段：结构解析返回 0 而非「无归属」（调用方以 !== userId 判拒绝）
    expect(resolveKeyOwner(`0/${HASH.slice(0, 2)}/${HASH}`)).toBe(0);
  });

  it("staging key：第二段即属主", () => {
    expect(resolveKeyOwner(`staging/7/${UUID}`)).toBe(7);
  });

  it("_cache/_posters：内嵌源键首段（内容键去扩展名形态）", () => {
    const stem = `1/${HASH.slice(0, 2)}/${HASH}`;
    expect(resolveKeyOwner(`_cache/v2/320/${stem}.webp`)).toBe(1);
    expect(resolveKeyOwner(`_posters/v2/${stem}.webp`)).toBe(1);
  });

  it("_cache：staging 源的会话内缓存形态，归属取 staging 第二段", () => {
    expect(resolveKeyOwner(`_cache/v2/64/staging/7/${UUID}.webp`)).toBe(7);
  });

  it("旧版无版本 _cache 键不再解析归属（fail-closed，由一次性迁移清理）", () => {
    const stem = `1/${HASH.slice(0, 2)}/${HASH}`;
    expect(resolveKeyOwner(`_cache/320/${stem}.webp`)).toBeNull();
  });

  it("改造后 _sprite/_proxy：参数段后缀形态，归属取内嵌源键首段", () => {
    const stem = `3/${HASH.slice(0, 2)}/${HASH}`;
    expect(resolveKeyOwner(`_sprite/${stem}_c20v2.webp`)).toBe(3);
    expect(resolveKeyOwner(`_proxy/${stem}_w480v3.mp4`)).toBe(3);
  });

  it("旧单向哈希形态（32 位 hex 文件名）解析不出属主", () => {
    const oldHash = "c".repeat(32);
    expect(resolveKeyOwner(`_sprite/${oldHash}.webp`)).toBeNull();
    expect(resolveKeyOwner(`_proxy/${oldHash}.mp4`)).toBeNull();
  });

  it("畸形 / 非托管命名空间 key 一律 null（fail-closed）", () => {
    expect(resolveKeyOwner("u1/ab/ok.png")).toBeNull();
    expect(resolveKeyOwner(`1/ab/${"zz".repeat(32)}.png`)).toBeNull(); // hash 段非 hex
    expect(resolveKeyOwner("staging/notanumber/123e4567-e89b-12d3-a456-426614174000")).toBeNull();
    expect(resolveKeyOwner("_unknown/1/foo.webp")).toBeNull();
    expect(resolveKeyOwner("../etc/passwd")).toBeNull();
    expect(resolveKeyOwner("")).toBeNull();
  });

  it("派生 key 内嵌段非法（非内容键非 staging）→ null", () => {
    expect(resolveKeyOwner(`_cache/v2/320/u1/ab/ok.webp`)).toBeNull();
    expect(resolveKeyOwner(`_cache/v2/320/1/../../etc.webp`)).toBeNull();
    // 参数段缺失：内嵌段会带上尾部垃圾，不是合法源键
    expect(resolveKeyOwner(`_sprite/1/${HASH.slice(0, 2)}/${HASH}.webp`)).toBeNull();
    expect(resolveKeyOwner(`_proxy/1/${HASH.slice(0, 2)}/${HASH}.mp4`)).toBeNull();
  });
});
