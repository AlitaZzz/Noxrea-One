import { describe, expect, it } from "vitest";

import {
  extractHashCountsFromCanvas,
  hashCountsEqual,
} from "@server/utils/canvas-hashes";

function canvasWithSrcs(srcs: string[]): Record<string, unknown> {
  return { nodes: srcs.map((src) => ({ id: "n", data: { src } })) };
}

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
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

  it("多图结果 multiResultKeys 计入，同一节点内重复引用只计一次", () => {
    const counts = extractHashCountsFromCanvas({
      nodes: [
        { data: { src: key(HASH_A), multiResultKeys: [key(HASH_A), key(HASH_B), key(HASH_B)] } },
        { data: { src: key(HASH_B) } },
      ],
    });
    expect(Object.fromEntries(counts)).toEqual({ [HASH_A]: 1, [HASH_B]: 2 });
  });

  it("同一 hash 的不同 key 形态在同一节点内只计一次", () => {
    const counts = extractHashCountsFromCanvas({
      nodes: [
        {
          data: {
            src: key(HASH_A, ".png"),
            multiResultKeys: [key(HASH_A, ".jpg"), key(HASH_A, ".png")],
          },
        },
      ],
    });
    expect(Object.fromEntries(counts)).toEqual({ [HASH_A]: 1 });
  });

  it("畸形节点、multiResultKeys 与 directorState 结构不抛错且不计入", () => {
    const counts = extractHashCountsFromCanvas({
      nodes: [
        null,
        "node",
        { data: null },
        { data: { multiResultKeys: { 0: key(HASH_A) } } },
        { data: { multiResultKeys: [null, 42, { key: key(HASH_B) }] } },
        { data: { directorState: "x" } },
        { data: { directorState: { shots: { 0: { ref: key(HASH_C) } }, entities: "x" } } },
        {
          data: {
            directorState: {
              shots: [null, 1],
              entities: [
                null,
                { srcUrl: 7, members: [null, "x"] },
                { srcUrl: 7, members: "x" },
              ],
            },
          },
        },
      ],
    });
    expect(counts.size).toBe(0);
  });

  it("导演镜头与实体引用计入，实体 members 嵌套，失效值不计入", () => {
    const counts = extractHashCountsFromCanvas({
      nodes: [
        {
          data: {
            directorState: {
              shots: [
                { ref: key(HASH_A) },
                { ref: key(HASH_A) },
                { ref: "https://example.com/shot.png" },
              ],
              entities: [
                { srcUrl: key(HASH_B) },
                { members: [{ srcUrl: key(HASH_C) }, { srcUrl: "blob:https://x/y" }] },
              ],
            },
          },
        },
      ],
    });
    expect(Object.fromEntries(counts)).toEqual({ [HASH_A]: 1, [HASH_B]: 1, [HASH_C]: 1 });
  });

  it("不同节点引用同一 hash 分别累加", () => {
    const counts = extractHashCountsFromCanvas({
      nodes: [
        { data: { src: key(HASH_A) } },
        { data: { directorState: { shots: [{ ref: key(HASH_A) }] } } },
        { data: { multiResultKeys: [key(HASH_A)] } },
      ],
    });
    expect(Object.fromEntries(counts)).toEqual({ [HASH_A]: 3 });
  });

  it("深层 members 嵌套不耗尽调用栈", () => {
    let entities: unknown[] = [{ srcUrl: key(HASH_A) }];
    for (let depth = 0; depth < 50_000; depth += 1) {
      entities = [{ members: entities }];
    }
    const counts = extractHashCountsFromCanvas({
      nodes: [{ data: { directorState: { entities } } }],
    });
    expect(Object.fromEntries(counts)).toEqual({ [HASH_A]: 1 });
  });

  it("排序偏好、上传预览与自由文本不因形似 key 计入（显式字段清单）", () => {
    const counts = extractHashCountsFromCanvas({
      nodes: [
        {
          data: {
            label: key(HASH_A),
            content: key(HASH_B),
            genSettings: {
              refOrder: [key(HASH_C)],
              refAudioOrder: [key(HASH_A)],
              refVideoOrder: [key(HASH_B)],
            },
            upload: { previewUrl: `blob:https://x/${key(HASH_A)}` },
          },
        },
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
