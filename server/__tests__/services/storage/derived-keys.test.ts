/**
 * 派生 key 形态知识单点的往返锁定（specs/file-access-ownership.md 规则 7）。
 * 构造端产物必须被同一模块解析回内嵌源键、被归属解析判得源属主——
 * 构造端格式漂移在此即刻失配，不会被读路由的 fail-closed 静默化为缓存未命中。
 */
import { describe, expect, it } from "vitest";
import { resolveKeyOwner } from "@server/services/storage/ownership";
import {
  cacheKeyOf,
  derivedSourceStemOf,
  posterMasterKey,
  proxyKeyOf,
  spriteKeyOf,
} from "@server/services/storage/derived-keys";

const HASH = "ab".repeat(32);
const UUID = "123e4567-e89b-12d3-a456-426614174000";
const SOURCE = `3/ab/${HASH}.mp4`;
const STEM = `3/ab/${HASH}`;

describe("派生 key 构造 ↔ 解析往返", () => {
  it("四个命名空间：构造产物解析回同一 stem，归属取内嵌源键属主", () => {
    const cases: Array<[string, string, number]> = [
      [cacheKeyOf(SOURCE, 320), STEM, 3],
      [posterMasterKey(SOURCE, 1), STEM, 3],
      [spriteKeyOf(SOURCE, 20, 2), STEM, 3],
      [proxyKeyOf(SOURCE, 480, 3), STEM, 3],
      // staging 源的会话内缓存（_cache 对 staging key 的派生形态）
      [cacheKeyOf(`staging/7/${UUID}`, 64), `staging/7/${UUID}`, 7],
    ];
    for (const [key, stem, owner] of cases) {
      expect(derivedSourceStemOf(key), key).toBe(stem);
      expect(resolveKeyOwner(key), key).toBe(owner);
    }
  });

  it("旧单向哈希形态解析不出内嵌源键（归属 fail-closed 由 ownership 单测覆盖）", () => {
    expect(derivedSourceStemOf(`_sprite/${"c".repeat(32)}.webp`)).toBeNull();
    expect(derivedSourceStemOf(`_proxy/${"c".repeat(32)}.mp4`)).toBeNull();
    expect(derivedSourceStemOf("staging/7/123e4567-e89b-12d3-a456-426614174000")).toBeNull();
  });
});
