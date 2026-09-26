import { describe, expect, it } from "vitest";

import {
  extractHashCountsFromCanvas,
  hashCountsEqual,
} from "./extract-hashes";

function canvasWithSrcs(srcs: string[]): Record<string, unknown> {
  return { nodes: srcs.map((src) => ({ id: "n", data: { src } })) };
}

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const url = (hash: string) => `/api/files/1/${hash.slice(0, 2)}/${hash}.png`;

describe("extractHashesFromCanvas", () => {
  it("提取 data.src 中的 64 位 hash，按节点数累加", () => {
    const counts = extractHashCountsFromCanvas(canvasWithSrcs([url(HASH_A), url(HASH_A), url(HASH_B)]));
    expect(Object.fromEntries(counts)).toEqual({ [HASH_A]: 2, [HASH_B]: 1 });
  });

  it("非文件 URL、短 hash 与缺失 src 的节点不计入", () => {
    const counts = extractHashCountsFromCanvas({
      nodes: [
        { data: { src: "https://example.com/a.png" } },
        { data: { src: `/api/files/1/ab/${"a".repeat(10)}.png` } },
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
      { position: { x: 0, y: 0 }, data: { src: url(HASH_A) } },
      { position: { x: 5, y: 5 }, data: { src: url(HASH_A) } },
    ];
    const before = extractHashCountsFromCanvas({ nodes });
    const after = extractHashCountsFromCanvas({ nodes: [...nodes].reverse() });
    expect(hashCountsEqual(before, after)).toBe(true);
  });
});
