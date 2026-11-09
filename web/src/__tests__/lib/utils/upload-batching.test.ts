/**
 * 上传批次拆分（画布节点上传与资产原始上传共用）的边界契约。
 */
import { describe, expect, it } from "vitest";

import { oversizeUploadErrorBody, splitUploadBatches } from "@/lib/utils/upload";

interface Item {
  name: string;
  size: number;
}

const sizes = (items: Item[]) => items.map((item) => item.name);

describe("splitUploadBatches", () => {
  it("按文件数上限拆分并保持原顺序", () => {
    const items: Item[] = Array.from({ length: 5 }, (_, index) => ({ name: `${index}`, size: 1 }));

    const batches = splitUploadBatches(items, (item) => item.size, 2, 1024);

    expect(batches.map(sizes)).toEqual([["0", "1"], ["2", "3"], ["4"]]);
  });

  it("按累计字节上限拆分，等于上限时仍可入批", () => {
    const items: Item[] = Array.from({ length: 6 }, (_, index) => ({ name: `${index}`, size: 3 }));

    const batches = splitUploadBatches(items, (item) => item.size, 20, 6);

    expect(batches.map(sizes)).toEqual([["0", "1"], ["2", "3"], ["4", "5"]]);
  });

  it("文件数上限优先触发，且空输入返回空批次", () => {
    const items: Item[] = Array.from({ length: 3 }, (_, index) => ({ name: `${index}`, size: 1 }));

    expect(splitUploadBatches(items, (item) => item.size, 1, 1024).map(sizes))
      .toEqual([["0"], ["1"], ["2"]]);
    expect(splitUploadBatches([], (item: Item) => item.size, 20, 1024)).toEqual([]);
  });

  it("单文件超过字节上限时独占一批（调用方须先剔除）", () => {
    const items: Item[] = [{ name: "ok", size: 1 }, { name: "big", size: 10 }, { name: "tail", size: 1 }];

    const batches = splitUploadBatches(items, (item) => item.size, 20, 6);

    expect(batches.map(sizes)).toEqual([["ok"], ["big"], ["tail"]]);
  });
});

describe("oversizeUploadErrorBody", () => {
  const MB = 1024 * 1024;

  it("两条上限都超过时优先报告单文件体积超限", () => {
    expect(oversizeUploadErrorBody(2 * MB, 1, MB)).toEqual({
      error: "upload.file_too_large",
      ctx: { limit: 1 },
    });
  });

  it("仅超过批次字节上限时报告批次超限", () => {
    expect(oversizeUploadErrorBody(2 * MB, 4, MB)).toEqual({ error: "upload.batch_too_large" });
  });

  it("严格大于上限才算超限：两条上限同时取等号不报错", () => {
    expect(oversizeUploadErrorBody(MB, 1, MB)).toBeNull();
    expect(oversizeUploadErrorBody(MB + 1, 1, MB)).toEqual({
      error: "upload.file_too_large",
      ctx: { limit: 1 },
    });
    expect(oversizeUploadErrorBody(MB + 1, 4, MB)).toEqual({ error: "upload.batch_too_large" });
  });

  it("两条上限内返回 null", () => {
    expect(oversizeUploadErrorBody(1024, 1, MB)).toBeNull();
  });
});
