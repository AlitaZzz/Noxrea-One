/**
 * 派生 key 形态知识单点的往返锁定（specs/file-access-ownership.md 规则 7）。
 * 构造端产物必须被同一模块解析回内嵌源键、被归属解析判得源属主——
 * 构造端格式漂移在此即刻失配，不会被读路由的 fail-closed 静默化为缓存未命中。
 */
import { describe, expect, it } from "vitest";
import { RESIZE_WIDTH_TIERS } from "@noxrea/shared/media-tiers";
import { listDerivedArtifactKeys } from "@server/services/storage/backend";
import { resolveKeyOwner } from "@server/services/storage/ownership";
import {
  cacheKeyOf,
  derivedCandidatesOf,
  derivedSourceStemOf,
  derivedTierOf,
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

  it("旧版无版本 _cache 键不再被解析（v2 单形态，旧键由一次性迁移清理）", () => {
    expect(derivedSourceStemOf(`_cache/320/${STEM}.webp`)).toBeNull();
  });
});

describe("派生档位（指标 tier 标签，specs/observability-baseline.md 规则 3.4）", () => {
  it("档位与命名空间同源：四个构造端各归其位", () => {
    expect(derivedTierOf(cacheKeyOf(SOURCE, 320))).toBe("cache");
    expect(derivedTierOf(posterMasterKey(SOURCE, 1))).toBe("poster");
    expect(derivedTierOf(spriteKeyOf(SOURCE, 20, 2))).toBe("sprite");
    expect(derivedTierOf(proxyKeyOf(SOURCE, 480, 3))).toBe("proxy");
  });

  it("视频的 `_cache` 档位是 cache（不得记成 poster：那是 `_posters` 母版的命名空间）", () => {
    const videoSource = `3/ab/${HASH}.mp4`;
    expect(derivedTierOf(cacheKeyOf(videoSource, 480))).toBe("cache");
    expect(derivedTierOf(posterMasterKey(videoSource, 1))).toBe("poster");
  });

  it("非派生 key 返回 null（档位不可推导时调用方必须拒绝，而不是猜一个）", () => {
    expect(derivedTierOf(SOURCE)).toBeNull();
    expect(derivedTierOf(`staging/7/${UUID}`)).toBeNull();
    expect(derivedTierOf(`_cache/320/${STEM}.webp`)).toBeNull();
  });
});

describe("派生删除联动枚举面（specs/derived-deletion-linkage.md 规则 1/2）", () => {
  /**
   * 经真实 listDerivedArtifactKeys 判定命中：mock backend 持有 universe，
   * 真实循环（isStorageKey 门控 + 候选前缀收窄 list + test 判定）给出命中集。
   */
  function backendOf(universe: string[], posterVersions?: string[]) {
    return {
      list: async (prefix: string) =>
        universe.filter((k) => k.startsWith(prefix)).map((k) => ({ key: k, size: 1, lastModifiedMs: 0 })),
      ...(posterVersions ? { listCommonPrefixes: async () => posterVersions } : {}),
      // 枚举器契约只消费 list / listCommonPrefixes 两个能力
    } as unknown as Parameters<typeof listDerivedArtifactKeys>[0];
  }

  it("构造产物必被候选命中：内容源 × 四命名空间（构造 ↔ 枚举往返锁定）", async () => {
    const backend = backendOf(
      [
        cacheKeyOf(SOURCE, 320),
        posterMasterKey(SOURCE, 1),
        spriteKeyOf(SOURCE, 20, 2),
        proxyKeyOf(SOURCE, 480, 3),
      ],
      ["_posters/v1/"],
    );
    await expect(listDerivedArtifactKeys(backend, SOURCE)).resolves.toEqual([
      cacheKeyOf(SOURCE, 320),
      posterMasterKey(SOURCE, 1),
      spriteKeyOf(SOURCE, 20, 2),
      proxyKeyOf(SOURCE, 480, 3),
    ]);
  });

  it("精准 shard 前缀：tier 静态展开、版本段来自发现结果、sprite/proxy 单前缀", () => {
    const prefixes = derivedCandidatesOf(SOURCE, ["_posters/v1/", "_posters/v2/"]).map((c) => c.prefix);
    expect(prefixes).toEqual([
      ...RESIZE_WIDTH_TIERS.map((tier) => `_cache/v2/${tier}/3/ab/`),
      "_posters/v1/3/ab/",
      "_posters/v2/3/ab/",
      "_sprite/3/ab/",
      "_proxy/3/ab/",
    ]);
  });

  it("命中判定不误伤：他源派生 / 旧单向哈希形态 / 档位域外均不命中", async () => {
    const backend = backendOf(
      [
        spriteKeyOf(`4/ab/${HASH}.mp4`, 20, 2),
        `_sprite/${"c".repeat(32)}.webp`,
        `_cache/v2/100/3/ab/${HASH}.webp`, // 档位域外
        `_cache/320/3/ab/${HASH}.webp`, // 旧版无版本键
        `_posters/v2/${STEM}.webp`, // 版本段未发现（只发现到 v1）
      ],
      ["_posters/v1/"],
    );
    await expect(listDerivedArtifactKeys(backend, SOURCE)).resolves.toEqual([]);
  });

  it("staging / 派生 / 畸形源短路返回空（联动仅对内容源执行，staging 源派生由 TTL 兜底）", () => {
    expect(derivedCandidatesOf(`staging/7/${UUID}`, [])).toEqual([]);
    expect(derivedCandidatesOf(spriteKeyOf(SOURCE, 20, 2), [])).toEqual([]);
    expect(derivedCandidatesOf("../escape.png", [])).toEqual([]);
  });

  it("版本发现不可用（null）：_posters 退化为全前缀候选，锚定正则保语义", () => {
    const poster = derivedCandidatesOf(SOURCE, null).find((c) => c.prefix === "_posters/");
    expect(poster).toBeDefined();
    expect(poster!.test(`_posters/v7/${STEM}.webp`)).toBe(true);
    expect(poster!.test(`_posters/v7/4/ab/${HASH}.webp`)).toBe(false);
  });
});
