import { describe, expect, it } from "vitest";

import { canvasUpdateSchema } from "@server/schemas/canvas";

/** coverKey 入库值域（存储 key 严格形态）——与 fileKey/avatarKey 同一 schema 层 refine 原则。 */
describe("画布更新请求契约", () => {
  // hash 段 64 位 hex：前 2 位 "ab" 与目录段一致
  const KEY = `1/ab/ab${"a".repeat(62)}.png`;

  it("coverKey 接受存储 key、null（清除）与缺省", () => {
    expect(canvasUpdateSchema.safeParse({ coverKey: KEY }).success).toBe(true);
    expect(canvasUpdateSchema.safeParse({ coverKey: null }).success).toBe(true);
    expect(canvasUpdateSchema.safeParse({}).success).toBe(true);
  });

  it("coverKey 拒绝 URL / 托管路径 / 非法 hash 段", () => {
    expect(canvasUpdateSchema.safeParse({ coverKey: "https://evil.example/x.png" }).success).toBe(false);
    expect(canvasUpdateSchema.safeParse({ coverKey: `/api/files/${KEY}` }).success).toBe(false);
    expect(canvasUpdateSchema.safeParse({ coverKey: `1/zz/${"z".repeat(64)}.png` }).success).toBe(false);
  });
});
