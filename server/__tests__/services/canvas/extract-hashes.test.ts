import { describe, expect, it } from "vitest";

import {
  extractHashCountsFromCanvas,
  hashCountsEqual,
} from "@server/services/canvas/extract-hashes";

function canvasWithSrcs(srcs: string[]): Record<string, unknown> {
  return { nodes: srcs.map((src) => ({ id: "n", data: { src } })) };
}

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const key = (hash: string, ext = ".png") => `1/${hash.slice(0, 2)}/${hash}${ext}`;

describe("extractHashCountsFromCanvas", () => {
  it("提取存储 key 中的 64 位 hash，按节点数累加", () => {
    const counts = extractHashCountsFromCanvas(canvasWithSrcs([key(HASH_A), key(HASH_A), key(HASH_B)]));
    expect(Object.fromEntries(counts)).toEqual({ [HASH_A]: 2, [HASH_B]: 1 });
  });

  it("外部 URL、短 hash、非法段与缺失 src 的节点不计入", () => {
    const counts = extractHashCountsFromCanvas({
      nodes: [
        { data: { src: "https://example.com/a.png" } },
        { data: { src: `1/ab/${"a".repeat(10)}.png` } },
        { data: { src: `/api/files/1/ab/${HASH_A}.png` } },
        { data: {} },
      ],
    });
    expect(counts.size).toBe(0);
  });
});

describe("hashCountsEqual", () => {
  it("集合与数量完全一致才相等", () => {
    const a = new Map([[HASH_A, 1]]);
    expect(hashCountsEqual(a, new Map([[HASH_A, 1]]))).toBe(true);
    expect(hashCountsEqual(a, new Map([[HASH_A, 2]]))).toBe(false);
    expect(hashCountsEqual(a, new Map([[HASH_A, 1], [HASH_B, 1]]))).toBe(false);
    expect(hashCountsEqual(new Map(), new Map())).toBe(true);
  });

  it("节点仅位置变化（引用集合与数量不变）时判定相等", () => {
    const nodes = [
      { position: { x: 0, y: 0 }, data: { src: key(HASH_A) } },
      { position: { x: 5, y: 5 }, data: { src: key(HASH_A) } },
    ];
    const before = extractHashCountsFromCanvas({ nodes });
    const after = extractHashCountsFromCanvas({ nodes: [...nodes].reverse() });
    expect(hashCountsEqual(before, after)).toBe(true);
  });
});
